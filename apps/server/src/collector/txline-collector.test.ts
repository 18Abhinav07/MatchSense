import type { FixtureTruthRepository } from "@matchsense/db";
import type { TxlineRawRecord } from "@matchsense/txline-adapter";
import { describe, expect, it, vi } from "vitest";

import type { ArchiveService } from "./archive-service.js";
import { createTxlineCollector } from "./txline-collector.js";

const fixture = {
  awayTeam: "ESP",
  fixtureId: "fx-collector",
  homeTeam: "FRA",
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

  it("passes its held live source fence into archive rebuilds", async () => {
    const repository: Pick<FixtureTruthRepository, "commitCollectorFrame"> = {
      commitCollectorFrame: vi.fn(async () => ({
        deliveries: [
          {
            eventSequences: [1],
            kind: "committed" as const,
            revisions: [1],
          },
        ],
        kind: "committed" as const,
      })),
    };
    const archive: ArchiveService = {
      rebuild: vi.fn(async () => ({
        manifest: null,
        projectionHash: "a".repeat(64),
        status: "REPLAY_READY" as const,
        terminalDeliveryId: "final-2",
      })),
    };
    const collector = createTxlineCollector({
      archive,
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
          Id: "final-2",
          StatusId: 100,
        }),
      ),
    ).resolves.toMatchObject({ kind: "committed" });
    expect(archive.rebuild).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "live",
        sourceFence: fence,
      }),
    );
  });

  it("returns fenced when archive rebuild loses the held live source fence", async () => {
    const repository: Pick<FixtureTruthRepository, "commitCollectorFrame"> = {
      commitCollectorFrame: vi.fn(async () => ({
        deliveries: [
          {
            eventSequences: [1],
            kind: "committed" as const,
            revisions: [1],
          },
        ],
        kind: "committed" as const,
      })),
    };
    const archive: ArchiveService = {
      rebuild: vi.fn(async () => ({
        manifest: null,
        projectionHash: null,
        status: "FENCED" as never,
        terminalDeliveryId: null,
      })),
    };
    const collector = createTxlineCollector({
      archive,
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
          Id: "final-2",
          StatusId: 100,
        }),
      ),
    ).resolves.toEqual({ effects: [], kind: "fenced" });
  });
});
