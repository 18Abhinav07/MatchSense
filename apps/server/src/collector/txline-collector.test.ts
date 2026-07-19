import {
  hashArchiveImportSourceContext,
  type ArchiveImportSourceContext,
  type FixtureTruthRepository,
  type SourceEnvelopeCommitPlan,
} from "@matchsense/db";
import type { TxlineRawRecord } from "@matchsense/txline-adapter";
import { describe, expect, it, vi } from "vitest";

import { createTxlineCollector } from "./txline-collector.js";

const archiveSourceContext: ArchiveImportSourceContext = {
  fixtureGroupId: "group-1",
  fixtureId: "fx-collector",
  gameState: 2,
  kickoffAt: "2026-07-18T18:00:00.000Z",
  participant1: {
    code: "ALP-provider-101",
    id: "provider-101",
    name: "Alpha United",
  },
  participant1IsHome: true,
  participant2: {
    code: "BRV-provider-202",
    id: "provider-202",
    name: "Bravo City",
  },
  schedule: {
    competition: "World Cup",
    competitionId: "72",
    responseHash: "a".repeat(64),
    source: "txline_world_cup_schedule",
    sourcePath: "/api/fixtures/snapshot?competitionId=72",
    sourceTimestampMs: 1_784_403_000_000,
  },
};

const fixture = {
  archiveImport: {
    contextHash: hashArchiveImportSourceContext(archiveSourceContext),
    sourceContext: archiveSourceContext,
  },
  awayTeam: "BRV-provider-202",
  fixtureId: "fx-collector",
  homeTeam: "ALP-provider-101",
  kickoffAt: "2026-07-18T18:00:00.000Z",
  participant1IsHome: true,
};

const fence = {
  fencingToken: 4,
  holderId: "collector-a",
  source: "txline",
  streamKey: "scores:mainnet",
};

function raw(
  payload: Record<string, unknown>,
  delivery: "live" | "reconciliation" = "live",
): TxlineRawRecord {
  return {
    metadata: {
      delivery,
      receivedAt: "2026-07-18T18:21:00.000Z",
      requestedFixtureId: null,
      sourcePath: "/api/scores/stream",
      sseEventId: "cursor:12",
    },
    payload,
  };
}

function goalPayload() {
  return {
    Action: "goal",
    Confirmed: true,
    FixtureId: fixture.fixtureId,
    Id: "goal-1",
    Participant: 1,
    Score: {
      Participant1: {
        Total: { Corners: 0, Goals: 1, RedCards: 0, YellowCards: 0 },
      },
      Participant2: {
        Total: { Corners: 0, Goals: 0, RedCards: 0, YellowCards: 0 },
      },
    },
    Seq: "12",
    Ts: 1_784_403_000_000,
  };
}

describe("durable TxLINE collector", () => {
  it("attaches one transaction-local archive intent for a realtime authoritative terminal with omitted Confirmed", async () => {
    const repository: Pick<FixtureTruthRepository, "commitCollectorFrame"> = {
      commitCollectorFrame: vi.fn(async (input) => {
        const delivery = input.deliveries[0]!;
        expect(delivery.archiveImportJob).toEqual({
          awayTeamId: fixture.awayTeam,
          contextHash: fixture.archiveImport.contextHash,
          fixtureId: fixture.fixtureId,
          homeTeamId: fixture.homeTeam,
          kickoffAt: fixture.kickoffAt,
          participant1IsHome: fixture.participant1IsHome,
          sourceContext: fixture.archiveImport.sourceContext,
          sourceTerminalRecordId: "provider-terminal-1026",
        });
        expect(delivery).not.toHaveProperty("recordedArchiveInvalidation");
        return {
          deliveries: [
            {
              eventSequences: [1],
              kind: "committed" as const,
              revisions: [1],
            },
          ],
          kind: "committed" as const,
        };
      }),
    };
    const collector = createTxlineCollector({
      fixtureForId: () => fixture,
      fixtureTruth: repository,
      rightsGrantId: "grant-1",
      sourceFence: fence,
    });

    await expect(
      collector.ingest(
        raw({
          ...goalPayload(),
          Action: "game_finalised",
          Id: "provider-terminal-1026",
          StatusId: 100,
          Confirmed: undefined,
        }),
      ),
    ).resolves.toMatchObject({ kind: "committed" });
  });

  it("attaches an archive intent for an authoritative reconciliation terminal without fan effects", async () => {
    const repository: Pick<FixtureTruthRepository, "commitCollectorFrame"> = {
      commitCollectorFrame: vi.fn(async (input) => {
        const delivery = input.deliveries[0]!;
        expect(delivery.raw.deliveryIntent).toBe("reconcile");
        expect(delivery.archiveImportJob).toEqual({
          awayTeamId: fixture.awayTeam,
          contextHash: fixture.archiveImport.contextHash,
          fixtureId: fixture.fixtureId,
          homeTeamId: fixture.homeTeam,
          kickoffAt: fixture.kickoffAt,
          participant1IsHome: fixture.participant1IsHome,
          sourceContext: fixture.archiveImport.sourceContext,
          sourceTerminalRecordId: "provider-terminal-recovery",
        });
        const plans = delivery.derive?.(null) ?? [];
        expect(plans.length).toBeGreaterThan(0);
        expect(
          plans.every(
            (plan: SourceEnvelopeCommitPlan) =>
              plan.moment === undefined && plan.outbox.length === 0,
          ),
        ).toBe(true);
        return {
          deliveries: [
            {
              eventSequences: [1],
              kind: "committed" as const,
              revisions: [1],
            },
          ],
          kind: "committed" as const,
        };
      }),
    };
    const collector = createTxlineCollector({
      fixtureForId: () => fixture,
      fixtureTruth: repository,
      rightsGrantId: "grant-1",
      sourceFence: fence,
    });

    await expect(
      collector.ingest(
        raw(
          {
            ...goalPayload(),
            Action: "game_finalised",
            Confirmed: true,
            Id: "provider-terminal-recovery",
            StatusId: 100,
          },
          "reconciliation",
        ),
      ),
    ).resolves.toEqual({ effects: [], kind: "committed" });
  });

  it("uses a stable recovery identity for an authoritative historical terminal", async () => {
    const identities: Array<{ dedupeKey: string; id: string }> = [];
    const repository: Pick<FixtureTruthRepository, "commitCollectorFrame"> = {
      commitCollectorFrame: vi.fn(async (input) => {
        const delivery = input.deliveries[0]!;
        identities.push({
          dedupeKey: delivery.raw.dedupeKey,
          id: delivery.raw.id,
        });
        return {
          deliveries: [{ kind: "accepted_no_change" as const }],
          kind: "committed" as const,
        };
      }),
    };
    const collector = createTxlineCollector({
      fixtureForId: () => fixture,
      fixtureTruth: repository,
      rightsGrantId: "grant-1",
      sourceFence: fence,
    });
    const terminal = {
      ...goalPayload(),
      Action: "game_finalised",
      Confirmed: undefined,
      Id: "provider-terminal-1026",
      StatusId: 100,
    };

    await collector.ingest(raw(terminal));
    await collector.ingest(raw(terminal, "reconciliation"));
    await collector.ingest(raw(terminal, "reconciliation"));

    expect(identities[0]).not.toEqual(identities[1]);
    expect(identities[1]).toEqual(identities[2]);
    expect(identities[1]?.id).toContain("terminal-recovery");
    expect(identities[1]?.dedupeKey).toContain("terminal-recovery");
  });

  it("persists a realtime raw goal before deriving its fan-facing canonical outbox work", async () => {
    const repository: Pick<FixtureTruthRepository, "commitCollectorFrame"> = {
      commitCollectorFrame: vi.fn(async (input) => {
        const delivery = input.deliveries[0]!;
        const plans = delivery.derive?.(null) ?? [];
        expect(plans).toHaveLength(2);
        expect(plans.at(-1)).toMatchObject({
          outbox: expect.arrayContaining([
            expect.objectContaining({ topic: "fixture.broadcast" }),
            expect.objectContaining({ topic: "commentary.prepare" }),
          ]),
        });
        return {
          deliveries: [
            {
              eventSequences: [1, 2],
              kind: "committed" as const,
              revisions: [1, 2],
            },
          ],
          kind: "committed" as const,
        };
      }),
    };
    const collector = createTxlineCollector({
      fixtureForId: (id) => (id === fixture.fixtureId ? fixture : null),
      fixtureTruth: repository,
      rightsGrantId: "grant-1",
      sourceFence: fence,
    });

    await expect(collector.ingest(raw(goalPayload()))).resolves.toEqual({
      effects: ["fixture_event"],
      kind: "committed",
    });
    expect(repository.commitCollectorFrame).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveries: [
          expect.objectContaining({
            raw: expect.objectContaining({
              canonicalEligible: true,
              deliveryIntent: "realtime",
              rawRetention: "authorised_raw",
            }),
          }),
        ],
        mode: "live",
        sourceFence: fence,
      }),
    );
  });

  it("records telemetry as source-only and never invokes the canonical plan builder", async () => {
    const repository: Pick<FixtureTruthRepository, "commitCollectorFrame"> = {
      commitCollectorFrame: vi.fn(async (input) => {
        const delivery = input.deliveries[0]!;
        expect(delivery.raw.canonicalEligible).toBe(false);
        expect(delivery.derive).toBeUndefined();
        return {
          deliveries: [{ kind: "accepted_no_change" as const }],
          kind: "committed" as const,
        };
      }),
    };
    const collector = createTxlineCollector({
      fixtureForId: () => fixture,
      fixtureTruth: repository,
      rightsGrantId: "grant-1",
      sourceFence: fence,
    });

    await expect(
      collector.ingest(raw({ ...goalPayload(), Action: "coverage_update" })),
    ).resolves.toEqual({ effects: [], kind: "committed" });
  });

  it("commits every known delivery and the SSE cursor as one collector frame", async () => {
    const repository: Pick<FixtureTruthRepository, "commitCollectorFrame"> = {
      commitCollectorFrame: vi.fn(async (input) => {
        expect(input.cursor).toEqual({
          expectedCursor: "cursor:11",
          nextCursor: "cursor:12",
        });
        expect(input.deliveries).toHaveLength(2);
        return {
          cursor: {
            cursorValue: "cursor:12",
            fencingToken: fence.fencingToken,
            mode: "live" as const,
            source: fence.source,
            streamKey: fence.streamKey,
            updatedAt: "2026-07-18T18:21:00.000Z",
          },
          deliveries: [
            { kind: "accepted_no_change" as const },
            { kind: "accepted_no_change" as const },
          ],
          kind: "advanced" as const,
        };
      }),
    };
    const collector = createTxlineCollector({
      fixtureForId: () => fixture,
      fixtureTruth: repository,
      rightsGrantId: "grant-1",
      sourceFence: fence,
    });

    await expect(
      collector.ingestLiveFrame({
        expectedCursor: "cursor:11",
        nextCursor: "cursor:12",
        records: [
          raw({ ...goalPayload(), Action: "coverage_update" }),
          raw({ ...goalPayload(), Action: "corner", Seq: "13" }),
        ],
      }),
    ).resolves.toBe(true);
  });

  it.each([
    {
      action: "action_amend",
      payload: { ...goalPayload(), Action: "action_amend" },
    },
    {
      action: "action_discarded",
      payload: { ...goalPayload(), Action: "action_discarded" },
    },
    {
      action: "score_adjustment",
      payload: { ...goalPayload(), Action: "score_adjustment" },
    },
    {
      action: "var_end",
      payload: {
        ...goalPayload(),
        Action: "var_end",
        Data: { Outcome: "Overturned", ReviewType: "Goal" },
      },
    },
  ])(
    "attaches a recorded replay invalidation without an archive job or fan-out for canonical $action",
    async ({ action, payload }) => {
      const repository: Pick<FixtureTruthRepository, "commitCollectorFrame"> = {
        commitCollectorFrame: vi.fn(async (input) => {
          const delivery = input.deliveries[0]!;
          expect(delivery.archiveImportJob).toBeUndefined();
          expect(delivery).toMatchObject({
            recordedArchiveInvalidation: {
              action,
            },
          });
          const plans = delivery.derive?.(null) ?? [];
          expect(plans).not.toHaveLength(0);
          expect(
            plans.flatMap(
              (plan: { outbox: readonly unknown[] }) => plan.outbox,
            ),
          ).toEqual([]);
          return {
            deliveries: [
              {
                eventSequences: [1],
                kind: "committed" as const,
                revisions: [1],
              },
            ],
            kind: "committed" as const,
          };
        }),
      };
      const collector = createTxlineCollector({
        fixtureForId: () => fixture,
        fixtureTruth: repository,
        rightsGrantId: "grant-1",
        sourceFence: fence,
      });

      await expect(
        collector.ingest(
          raw({
            ...payload,
            Id: `provider-${action}-1027`,
          }),
        ),
      ).resolves.toEqual({ effects: [], kind: "committed" });
    },
  );

  it("attaches no archive job or recorded invalidation for rejected terminals, corrections, or source-only records", async () => {
    const archiveIntents: unknown[] = [];
    const recordedInvalidations: unknown[] = [];
    const repository: Pick<FixtureTruthRepository, "commitCollectorFrame"> = {
      commitCollectorFrame: vi.fn(
        async (
          input: Parameters<FixtureTruthRepository["commitCollectorFrame"]>[0],
        ) => {
          archiveIntents.push(
            ...input.deliveries.map((delivery) => delivery.archiveImportJob),
          );
          recordedInvalidations.push(
            ...input.deliveries.map(
              (delivery) =>
                (delivery as { recordedArchiveInvalidation?: unknown })
                  .recordedArchiveInvalidation,
            ),
          );
          return {
            deliveries: input.deliveries.map(() => ({
              kind: "accepted_no_change" as const,
            })),
            kind: "committed" as const,
          };
        },
      ),
    };
    const collector = createTxlineCollector({
      fixtureForId: () => fixture,
      fixtureTruth: repository,
      rightsGrantId: "grant-1",
      sourceFence: fence,
    });

    const terminal = {
      ...goalPayload(),
      Action: "game_finalised",
      Id: "provider-terminal-1026",
      StatusId: 100,
    };
    for (const record of [
      raw({ ...terminal, Confirmed: false }),
      raw({ ...terminal, Action: "halftime_finalised" }),
      raw({ ...terminal, StatusId: 99 }),
      raw({ ...terminal, Id: undefined }),
      raw({ ...terminal, Action: "coverage_update" }),
      raw(
        { ...goalPayload(), Action: "action_amend", Id: "provider-amend-1027" },
        "reconciliation",
      ),
    ]) {
      await expect(collector.ingest(record)).resolves.toEqual({
        effects: [],
        kind: "committed",
      });
    }
    expect(archiveIntents).toEqual(Array(6).fill(undefined));
    expect(recordedInvalidations).toEqual(Array(6).fill(undefined));
  });
});
