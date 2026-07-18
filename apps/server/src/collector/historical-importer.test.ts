import type {
  SourceEnvelopeCommitPlan,
  FixtureTruthRepository,
  SourceFence,
} from "@matchsense/db";
import type {
  DurableTxlineFixture,
  TxlineRawRecord,
} from "@matchsense/txline-adapter";
import { describe, expect, it, vi } from "vitest";

import type { ArchiveService } from "./archive-service.js";
import { createHistoricalArchiveImporter } from "./historical-importer.js";

const fixture: DurableTxlineFixture = {
  awayTeam: "ESP",
  fixtureId: "fx-history",
  homeTeam: "FRA",
  kickoffAt: "2026-07-18T18:00:00.000Z",
  participant1IsHome: true,
};

const fence: SourceFence = {
  fencingToken: 1,
  holderId: "historical-importer",
  source: "txline_historical",
  streamKey: "history:fx-history",
};

function record(
  payload: Record<string, unknown>,
  overrides: Partial<TxlineRawRecord["metadata"]> = {},
): TxlineRawRecord {
  return {
    metadata: {
      delivery: "reconciliation",
      receivedAt: "2026-07-18T22:00:00.000Z",
      requestedFixtureId: fixture.fixtureId,
      sourcePath: `/api/scores/historical/${fixture.fixtureId}`,
      sseEventId: null,
      ...overrides,
    },
    payload,
  };
}

function score(goals: number) {
  return {
    Participant1: {
      Total: { Corners: 0, Goals: goals, RedCards: 0, YellowCards: 0 },
    },
    Participant2: {
      Total: { Corners: 0, Goals: 0, RedCards: 0, YellowCards: 0 },
    },
  };
}

const goal = {
  Action: "goal",
  Confirmed: true,
  FixtureId: fixture.fixtureId,
  Id: "goal-1",
  Participant: 1,
  Score: score(1),
  Seq: "1",
  Ts: 1_784_403_000_000,
};

const final = {
  ...goal,
  Action: "game_finalised",
  Id: "final-2",
  Seq: "2",
  StatusId: 100,
};

describe("historical archive importer", () => {
  it("persists real TxLINE reconciliation records into recorded mode, then publishes only a replay-ready final", async () => {
    const fixtureTruth: Pick<
      FixtureTruthRepository,
      "commitCollectorFrame" | "commitFencedFixtureUpsert" | "get"
    > = {
      commitCollectorFrame: vi.fn(async (input) => {
        expect(input.mode).toBe("recorded");
        expect(input.sourceFence).toEqual(fence);
        expect(input.deliveries).toHaveLength(2);
        for (const delivery of input.deliveries) {
          expect(delivery.raw).toMatchObject({
            deliveryIntent: "reconcile",
            provenance: "recorded_txline_authorised",
            rawRetention: "authorised_raw",
          });
          expect(
            delivery.derive?.(null).every((plan: SourceEnvelopeCommitPlan) => {
              return plan.moment === undefined && plan.outbox.length === 0;
            }),
          ).toBe(true);
        }
        return {
          deliveries: [
            { eventSequences: [1], kind: "committed" as const, revisions: [1] },
            { eventSequences: [2], kind: "committed" as const, revisions: [2] },
          ],
          kind: "committed" as const,
        };
      }),
      commitFencedFixtureUpsert: vi.fn(async () => ({
        fixture: {} as never,
        kind: "committed" as const,
      })),
      get: vi.fn(async () => null),
    };
    const archive: ArchiveService = {
      rebuild: vi.fn(async () => ({
        manifest: { status: "REPLAY_READY" } as never,
        projectionHash: "a".repeat(64),
        status: "REPLAY_READY" as const,
        terminalDeliveryId: "final-2",
      })),
    };
    const importer = createHistoricalArchiveImporter({
      archive,
      fixtureTruth,
      rightsGrantId: "grant-history",
      sourceFence: fence,
    });

    await expect(
      importer.importFixture({
        fixture,
        records: [record(goal), record(final)],
      }),
    ).resolves.toMatchObject({ kind: "replay_ready" });

    expect(archive.rebuild).toHaveBeenCalledWith(
      expect.objectContaining({
        fixture,
        manifestId: "archive:recorded:fx-history",
        mode: "recorded",
        rightsGrantId: "grant-history",
        sourceFence: fence,
      }),
    );
    expect(fixtureTruth.commitFencedFixtureUpsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        fixture: expect.objectContaining({
          id: fixture.fixtureId,
          mode: "recorded",
          provenance: "recorded_txline_authorised",
          status: "tracking",
        }),
        sourceFence: fence,
      }),
    );
    expect(fixtureTruth.commitFencedFixtureUpsert).toHaveBeenLastCalledWith(
      expect.objectContaining({
        fixture: expect.objectContaining({ status: "final" }),
        sourceFence: fence,
      }),
    );
  });

  it("returns fenced when the archive rebuild loses the recorded source fence", async () => {
    const fixtureTruth: Pick<
      FixtureTruthRepository,
      "commitCollectorFrame" | "commitFencedFixtureUpsert" | "get"
    > = {
      commitCollectorFrame: vi.fn(async () => ({
        deliveries: [{ kind: "accepted_no_change" as const }],
        kind: "committed" as const,
      })),
      commitFencedFixtureUpsert: vi.fn(async () => ({
        fixture: {} as never,
        kind: "committed" as const,
      })),
      get: vi.fn(async () => null),
    };
    const archive: ArchiveService = {
      rebuild: vi.fn(async () => ({
        manifest: null,
        projectionHash: "a".repeat(64),
        status: "FENCED" as never,
        terminalDeliveryId: null,
      })),
    };
    const importer = createHistoricalArchiveImporter({
      archive,
      fixtureTruth,
      rightsGrantId: "grant-history",
      sourceFence: fence,
    });

    await expect(
      importer.importFixture({ fixture, records: [record(final)] }),
    ).resolves.toEqual({ kind: "fenced" });
    expect(archive.rebuild).toHaveBeenCalledWith(
      expect.objectContaining({ sourceFence: fence }),
    );
    expect(fixtureTruth.commitFencedFixtureUpsert).toHaveBeenCalledTimes(1);
  });

  it("returns fenced when the historical source fence is lost before final fixture state", async () => {
    let upsertCount = 0;
    const fixtureTruth: Pick<
      FixtureTruthRepository,
      "commitCollectorFrame" | "commitFencedFixtureUpsert" | "get"
    > = {
      commitCollectorFrame: vi.fn(async () => ({
        deliveries: [{ kind: "accepted_no_change" as const }],
        kind: "committed" as const,
      })),
      commitFencedFixtureUpsert: vi.fn(async () => {
        upsertCount += 1;
        return upsertCount === 1
          ? { fixture: {} as never, kind: "committed" as const }
          : { kind: "fenced" as const };
      }),
      get: vi.fn(async () => null),
    };
    const archive: ArchiveService = {
      rebuild: vi.fn(async () => ({
        manifest: { status: "REPLAY_READY" } as never,
        projectionHash: "a".repeat(64),
        status: "REPLAY_READY" as const,
        terminalDeliveryId: "final-2",
      })),
    };
    const importer = createHistoricalArchiveImporter({
      archive,
      fixtureTruth,
      rightsGrantId: "grant-history",
      sourceFence: fence,
    });

    await expect(
      importer.importFixture({ fixture, records: [record(final)] }),
    ).resolves.toEqual({ kind: "fenced" });
    expect(fixtureTruth.commitFencedFixtureUpsert).toHaveBeenCalledTimes(2);
    expect(fixtureTruth.commitCollectorFrame).toHaveBeenCalledTimes(1);
    expect(archive.rebuild).toHaveBeenCalledTimes(1);
  });

  it("rejects anything other than the requested TxLINE historical reconciliation before persistence", async () => {
    const fixtureTruth: Pick<
      FixtureTruthRepository,
      "commitCollectorFrame" | "commitFencedFixtureUpsert" | "get"
    > = {
      commitCollectorFrame: vi.fn(),
      commitFencedFixtureUpsert: vi.fn(),
      get: vi.fn(),
    };
    const importer = createHistoricalArchiveImporter({
      archive: { rebuild: vi.fn() },
      fixtureTruth,
      rightsGrantId: "grant-history",
      sourceFence: fence,
    });

    await expect(
      importer.importFixture({
        fixture,
        records: [record(goal, { delivery: "live" })],
      }),
    ).rejects.toThrow("Historical import requires reconciliation records");

    expect(fixtureTruth.commitFencedFixtureUpsert).not.toHaveBeenCalled();
    expect(fixtureTruth.commitCollectorFrame).not.toHaveBeenCalled();
  });

  it("does not downgrade an already-final recorded fixture before a replacement archive is ready", async () => {
    const fixtureTruth: Pick<
      FixtureTruthRepository,
      "commitCollectorFrame" | "commitFencedFixtureUpsert" | "get"
    > = {
      commitCollectorFrame: vi.fn(async () => ({
        deliveries: [{ kind: "accepted_no_change" as const }],
        kind: "committed" as const,
      })),
      commitFencedFixtureUpsert: vi.fn(async () => ({
        fixture: {} as never,
        kind: "committed" as const,
      })),
      get: vi.fn(async () => ({ status: "final" }) as never),
    };
    const importer = createHistoricalArchiveImporter({
      archive: {
        rebuild: vi.fn(async () => ({
          manifest: null,
          projectionHash: "a".repeat(64),
          status: "TERMINAL_PENDING" as const,
          terminalDeliveryId: null,
        })),
      },
      fixtureTruth,
      rightsGrantId: "grant-history",
      sourceFence: fence,
    });

    await expect(
      importer.importFixture({ fixture, records: [record(final)] }),
    ).resolves.toMatchObject({ kind: "terminal_pending" });

    expect(fixtureTruth.get).toHaveBeenCalledWith({
      fixtureId: fixture.fixtureId,
      mode: "recorded",
    });
    expect(fixtureTruth.commitFencedFixtureUpsert).not.toHaveBeenCalled();
  });
});
