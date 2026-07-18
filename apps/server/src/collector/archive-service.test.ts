import type {
  ArchiveManifest,
  ArchiveRepository,
  DurableSourceDelivery,
  SourceFence,
} from "@matchsense/db";
import { describe, expect, it, vi } from "vitest";

import {
  createArchiveService,
  type ArchiveFixtureDefinition,
} from "./archive-service.js";

const fixture: ArchiveFixtureDefinition = {
  awayTeam: "ESP",
  fixtureId: "fx-archive",
  homeTeam: "FRA",
  kickoffAt: "2026-07-18T18:00:00.000Z",
  participant1IsHome: true,
};

const liveFence: SourceFence = {
  fencingToken: 4,
  holderId: "collector-a",
  source: "txline",
  streamKey: "scores:mainnet",
};

const recordedFence: SourceFence = {
  fencingToken: 7,
  holderId: "archive-worker-a",
  source: "txline_historical",
  streamKey: "archive-imports",
};

function delivery(
  id: string,
  orderingKey: string,
  payload: Record<string, unknown>,
  mode: "live" | "recorded" = "live",
): DurableSourceDelivery {
  return {
    canonicalEligible: true,
    deliveryIntent: "reconcile",
    deliveryKey: `${id.padEnd(64, "0")}`.slice(0, 64),
    fixtureId: fixture.fixtureId,
    id,
    mode,
    orderingKey,
    payload,
    payloadHash: "a".repeat(64),
    rawRetention: "authorised_raw",
    receivedAt: "2026-07-18T18:20:00.000Z",
    responseHash: "b".repeat(64),
    rightsGrantId: "grant-archive",
    source: "txline",
    sourcePath: "/api/scores/historical/fx-archive",
    sourceRecordId: id,
    sourceSequence: orderingKey,
    streamKey: "scores:mainnet",
  };
}

function archiveManifest(
  projectionHash: string,
  mode: "live" | "recorded" = "live",
): ArchiveManifest {
  return {
    createdAt: "2026-07-18T19:00:00.000Z",
    deliveryManifestHash: "c".repeat(64),
    fixtureId: fixture.fixtureId,
    id: "archive-fx-archive",
    invalidatedAt: null,
    invalidationReason: null,
    mode,
    projectionHash,
    reducerVersion: "durable-txline-v1",
    rightsGrantId: "grant-archive",
    status: "REPLAY_READY",
    terminalDeliveryId: "final-2",
    updatedAt: "2026-07-18T19:00:00.000Z",
    verifiedAt: "2026-07-18T19:00:00.000Z",
  };
}

const goal = {
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

describe("durable archive service", () => {
  it("rebuilds one deterministic projection and verifies only the authoritative terminal delivery", async () => {
    const archive: Pick<
      ArchiveRepository,
      "orderedDeliveries" | "verifyArchive" | "invalidateArchive"
    > = {
      invalidateArchive: vi.fn(async () => ({ kind: "applied" as const })),
      orderedDeliveries: vi.fn(async () => [
        delivery("goal-1", "0001", goal),
        delivery("final-2", "0002", final),
      ]),
      verifyArchive: vi.fn(async (input) => ({
        kind: "verified" as const,
        manifest: archiveManifest(input.projectionHash),
      })),
    };
    const service = createArchiveService({ archive });

    const first = await service.rebuild({
      fixture,
      manifestId: "archive-fx-archive",
      mode: "live",
      rightsGrantId: "grant-archive",
      sourceFence: liveFence,
    });
    const second = await service.rebuild({
      fixture,
      manifestId: "archive-fx-archive",
      mode: "live",
      rightsGrantId: "grant-archive",
      sourceFence: liveFence,
    });

    expect(first).toMatchObject({
      projectionHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      status: "REPLAY_READY",
      terminalDeliveryId: "final-2",
    });
    expect(second.projectionHash).toBe(first.projectionHash);
    expect(archive.verifyArchive).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sourceFence: liveFence,
        terminalDeliveryId: "final-2",
      }),
    );
  });

  it("invalidates a prior archive before rebuilding after a correction", async () => {
    const calls: string[] = [];
    const archive: Pick<
      ArchiveRepository,
      "orderedDeliveries" | "verifyArchive" | "invalidateArchive"
    > = {
      invalidateArchive: vi.fn(async () => {
        calls.push("invalidate");
        return { kind: "applied" as const };
      }),
      orderedDeliveries: vi.fn(async () => {
        calls.push("deliveries");
        return [
          delivery("amend-1", "0001", {
            ...goal,
            Action: "action_amend",
            Id: "amend-1",
          }),
          delivery("final-2", "0002", final),
        ];
      }),
      verifyArchive: vi.fn(async (input) => {
        calls.push("verify");
        return {
          kind: "verified" as const,
          manifest: archiveManifest(input.projectionHash),
        };
      }),
    };
    const service = createArchiveService({ archive });

    await service.rebuild({
      correctionObserved: true,
      fixture,
      manifestId: "archive-fx-archive",
      mode: "live",
      rightsGrantId: "grant-archive",
      sourceFence: liveFence,
    });

    expect(calls).toEqual(["invalidate", "deliveries", "verify"]);
    expect(archive.invalidateArchive).toHaveBeenCalledWith(
      expect.objectContaining({ sourceFence: liveFence }),
    );
    expect(archive.verifyArchive).toHaveBeenCalledWith(
      expect.objectContaining({ sourceFence: liveFence }),
    );
  });

  it("rebuilds authorised recorded history as replay-ready without treating it as live", async () => {
    const archive: Pick<
      ArchiveRepository,
      "orderedDeliveries" | "verifyArchive" | "invalidateArchive"
    > = {
      invalidateArchive: vi.fn(async () => ({ kind: "applied" as const })),
      orderedDeliveries: vi.fn(async () => [
        delivery("goal-1", "0001", goal, "recorded"),
        delivery("final-2", "0002", final, "recorded"),
      ]),
      verifyArchive: vi.fn(async (input) => ({
        kind: "verified" as const,
        manifest: archiveManifest(input.projectionHash, "recorded"),
      })),
    };
    const service = createArchiveService({ archive });

    await expect(
      service.rebuild({
        fixture,
        manifestId: "archive-recorded-fx-archive",
        mode: "recorded",
        rightsGrantId: "grant-archive",
        sourceFence: recordedFence,
      }),
    ).resolves.toMatchObject({
      status: "REPLAY_READY",
      terminalDeliveryId: "final-2",
    });
    expect(archive.verifyArchive).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "recorded", sourceFence: recordedFence }),
    );
  });

  it("stops before reading deliveries when correction invalidation loses its source fence", async () => {
    const archive: Pick<
      ArchiveRepository,
      "orderedDeliveries" | "verifyArchive" | "invalidateArchive"
    > = {
      invalidateArchive: vi.fn(async () => ({ kind: "fenced" as const })),
      orderedDeliveries: vi.fn(async () => [
        delivery("goal-1", "0001", goal),
        delivery("final-2", "0002", final),
      ]),
      verifyArchive: vi.fn(async () => ({ kind: "fenced" as const })),
    };
    const service = createArchiveService({ archive });

    await expect(
      service.rebuild({
        correctionObserved: true,
        fixture,
        manifestId: "archive-fx-archive",
        mode: "live",
        rightsGrantId: "grant-archive",
        sourceFence: liveFence,
      }),
    ).resolves.toMatchObject({
      manifest: null,
      status: "FENCED",
      terminalDeliveryId: null,
    });
    expect(archive.orderedDeliveries).not.toHaveBeenCalled();
    expect(archive.verifyArchive).not.toHaveBeenCalled();
  });

  it("returns FENCED without publishing a manifest when verification loses its source fence", async () => {
    const archive: Pick<
      ArchiveRepository,
      "orderedDeliveries" | "verifyArchive" | "invalidateArchive"
    > = {
      invalidateArchive: vi.fn(async () => ({ kind: "applied" as const })),
      orderedDeliveries: vi.fn(async () => [
        delivery("goal-1", "0001", goal),
        delivery("final-2", "0002", final),
      ]),
      verifyArchive: vi.fn(async () => ({ kind: "fenced" as const })),
    };
    const service = createArchiveService({ archive });

    await expect(
      service.rebuild({
        fixture,
        manifestId: "archive-fx-archive",
        mode: "live",
        rightsGrantId: "grant-archive",
        sourceFence: liveFence,
      }),
    ).resolves.toMatchObject({
      manifest: null,
      status: "FENCED",
      terminalDeliveryId: null,
    });
  });
});
