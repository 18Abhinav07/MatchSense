import type {
  ArchiveImportJob,
  ArchiveImportJobRepository,
  ArchiveImportVerifiedOutput,
  SourceLeaseRecord,
  SourceStateRepository,
} from "@matchsense/db";
import type {
  DurableTxlineFixture,
  FetchTxlineHistoricalRecordsOptions,
  TxlineAuthenticatedClient,
  TxlineRawRecord,
} from "@matchsense/txline-adapter";
import { TxlineHttpError } from "@matchsense/txline-adapter";
import { describe, expect, it, vi } from "vitest";

import type {
  ArchiveService,
  ArchiveRebuildResult,
} from "./archive-service.js";
import type {
  HistoricalArchiveImporter,
  HistoricalArchiveImporterOptions,
} from "./historical-importer.js";
import { createArchiveImportRunner } from "./archive-import-runner.js";

const now = new Date("2026-07-18T12:00:00.000Z");
const fixtureId = "18237038";
const workerId = "archive-import-worker-a";
const rightsGrantId = "txline-world-cup-hackathon-2026";

const expectedFixture: DurableTxlineFixture = {
  awayTeam: "ESP",
  fixtureId,
  homeTeam: "FRA",
  kickoffAt: "2026-07-18T18:00:00.000Z",
  participant1IsHome: true,
};

const historicalRecord: TxlineRawRecord = {
  metadata: {
    delivery: "reconciliation",
    receivedAt: now.toISOString(),
    requestedFixtureId: fixtureId,
    sourcePath: `/api/scores/historical/${fixtureId}`,
    sseEventId: "history:1026",
  },
  payload: {
    Action: "game_finalised",
    Confirmed: true,
    FixtureId: fixtureId,
    Id: "provider-final-1026",
    Seq: "1026",
    StatusId: 100,
  },
};

const archiveManifest = {
  createdAt: now.toISOString(),
  deliveryManifestHash: "a".repeat(64),
  fixtureId,
  id: `archive:recorded:${fixtureId}`,
  invalidatedAt: null,
  invalidationReason: null,
  mode: "recorded" as const,
  projectionHash: "b".repeat(64),
  reducerVersion: "durable-txline-v1",
  rightsGrantId,
  status: "REPLAY_READY" as const,
  terminalDeliveryId: "recorded-raw-final-1026",
  updatedAt: now.toISOString(),
  verifiedAt: now.toISOString(),
};

const replayReadyArchive: ArchiveRebuildResult = {
  manifest: archiveManifest,
  projectionHash: archiveManifest.projectionHash,
  status: "REPLAY_READY",
  terminalDeliveryId: archiveManifest.terminalDeliveryId,
};

const sourceLease: SourceLeaseRecord = {
  fencingToken: 7,
  holderId: workerId,
  leaseUntil: "2026-07-18T12:02:00.000Z",
  mode: "recorded",
  source: "txline_historical",
  streamKey: "archive-imports",
  updatedAt: now.toISOString(),
};

function job(overrides: Partial<ArchiveImportJob> = {}): ArchiveImportJob {
  return {
    archiveManifestHash: null,
    archiveManifestId: null,
    attemptCount: 1,
    availableAt: now.toISOString(),
    awayTeamId: expectedFixture.awayTeam,
    claimExpiresAt: "2026-07-18T12:02:00.000Z",
    claimGeneration: 3,
    claimStartedAt: now.toISOString(),
    claimedBy: workerId,
    contextHash: "c".repeat(64),
    createdAt: now.toISOString(),
    fixtureId,
    homeTeamId: expectedFixture.homeTeam,
    kickoffAt: expectedFixture.kickoffAt,
    lastError: null,
    participant1IsHome: expectedFixture.participant1IsHome,
    reason: "featured_bootstrap",
    sourceTerminalRecordId: "live-terminal-1026",
    state: "claimed",
    updatedAt: now.toISOString(),
    ...overrides,
  };
}

function verifiedOutput(): ArchiveImportVerifiedOutput {
  return {
    archiveManifestHash: archiveManifest.deliveryManifestHash,
    archiveManifestId: archiveManifest.id,
    archiveTerminalDeliveryId: archiveManifest.terminalDeliveryId,
    archiveVerifiedAt: archiveManifest.verifiedAt ?? now.toISOString(),
    claimGeneration: 3,
    claimStartedAt: now.toISOString(),
    fixtureId,
    sourceTerminalRecordId: "live-terminal-1026",
    workerId,
  };
}

function harness(
  input: {
    claim?: ArchiveImportJob | null;
    fetchError?: Error;
    importerError?: Error;
    importerResult?:
      | { kind: "empty" }
      | { kind: "fenced" }
      | { archive: ArchiveRebuildResult; kind: "replay_ready" }
      | { archive: ArchiveRebuildResult; kind: "terminal_pending" };
    leaseError?: Error;
    lease?: SourceLeaseRecord | null;
  } = {},
) {
  const calls: string[] = [];
  const retryInputs: Array<{
    availableAt: string;
    claimGeneration: number;
    error: string;
    fixtureId: string;
    workerId: string;
  }> = [];
  const claimed = input.claim ?? job();
  const jobs: Pick<
    ArchiveImportJobRepository,
    | "bindVerifiedArchiveOutput"
    | "claim"
    | "markBlockedRights"
    | "markRejected"
    | "markReplayReady"
    | "markRetry"
  > = {
    bindVerifiedArchiveOutput: vi.fn(async (value) => {
      calls.push("bind");
      expect(value).toEqual({
        archiveManifestHash: archiveManifest.deliveryManifestHash,
        archiveManifestId: archiveManifest.id,
        claimGeneration: claimed.claimGeneration,
        fixtureId: claimed.fixtureId,
        workerId,
      });
      return verifiedOutput();
    }),
    claim: vi.fn(async () => {
      calls.push("claim");
      return input.claim === null ? null : claimed;
    }),
    markBlockedRights: vi.fn(async (value) => {
      calls.push("blocked_rights");
      expect(value).toMatchObject({
        claimGeneration: claimed.claimGeneration,
        fixtureId: claimed.fixtureId,
        workerId,
      });
      return claimed;
    }),
    markRejected: vi.fn(async (value) => {
      calls.push("rejected");
      expect(value).toMatchObject({
        claimGeneration: claimed.claimGeneration,
        fixtureId: claimed.fixtureId,
        workerId,
      });
      return claimed;
    }),
    markReplayReady: vi.fn(async (value) => {
      calls.push("ready");
      expect(value).toEqual({
        claimGeneration: claimed.claimGeneration,
        fixtureId: claimed.fixtureId,
        workerId,
      });
      return claimed;
    }),
    markRetry: vi.fn(async (value) => {
      calls.push("retry");
      retryInputs.push(value);
      expect(value).toMatchObject({
        claimGeneration: claimed.claimGeneration,
        fixtureId: claimed.fixtureId,
        workerId,
      });
      return claimed;
    }),
  };
  const sourceState: Pick<
    SourceStateRepository,
    "acquireLease" | "releaseLease"
  > = {
    acquireLease: vi.fn(async (value) => {
      calls.push("lease");
      expect(value).toEqual({
        holderId: workerId,
        leaseUntil: "2026-07-18T12:02:00.000Z",
        mode: "recorded",
        source: "txline_historical",
        streamKey: "archive-imports",
      });
      if (input.leaseError) throw input.leaseError;
      return input.lease === undefined ? sourceLease : input.lease;
    }),
    releaseLease: vi.fn(async (value) => {
      calls.push("release");
      expect(value).toEqual({
        fencingToken: sourceLease.fencingToken,
        holderId: sourceLease.holderId,
        mode: "recorded",
        source: "txline_historical",
        streamKey: "archive-imports",
      });
      return true;
    }),
  };
  const fetchHistoricalRecords = vi.fn(
    async (value: FetchTxlineHistoricalRecordsOptions) => {
      calls.push("fetch");
      expect(value.fixtureId).toBe(claimed.fixtureId);
      expect(value.now?.()).toBe(now.toISOString());
      if (input.fetchError) throw input.fetchError;
      return [historicalRecord];
    },
  );
  const importer: HistoricalArchiveImporter = {
    importFixture: vi.fn(async (value) => {
      calls.push("import");
      expect(value).toEqual({
        fixture: expectedFixture,
        records: [historicalRecord],
      });
      if (input.importerError) throw input.importerError;
      return (
        input.importerResult ?? {
          archive: replayReadyArchive,
          kind: "replay_ready" as const,
        }
      );
    }),
  };
  const createImporter = vi.fn((value: HistoricalArchiveImporterOptions) => {
    calls.push("create_importer");
    expect(value.rightsGrantId).toBe(rightsGrantId);
    expect(value.sourceFence).toEqual({
      fencingToken: sourceLease.fencingToken,
      holderId: sourceLease.holderId,
      source: "txline_historical",
      streamKey: "archive-imports",
    });
    return importer;
  });
  const runner = createArchiveImportRunner({
    archive: { rebuild: vi.fn() } as ArchiveService,
    archiveImportJobs: jobs,
    client: {} as TxlineAuthenticatedClient,
    createHistoricalArchiveImporter: createImporter,
    fetchHistoricalRecords,
    fixtureTruth: {} as never,
    rightsGrantId,
    sourceState,
    workerId,
  });
  return { calls, jobs, retryInputs, runner, sourceState };
}

describe("archive import runner", () => {
  it("imports one frozen claimed job through a recorded lease before binding and readying its exact output", async () => {
    const test = harness();

    await expect(test.runner.runOnce(now)).resolves.toEqual({
      fixtureId,
      kind: "replay_ready",
    });

    expect(test.calls).toEqual([
      "claim",
      "lease",
      "create_importer",
      "fetch",
      "import",
      "bind",
      "ready",
      "release",
    ]);
  });

  it.each([
    ["empty history", { kind: "empty" }],
    [
      "terminal pending history",
      {
        archive: {
          manifest: null,
          projectionHash: "d".repeat(64),
          status: "TERMINAL_PENDING" as const,
          terminalDeliveryId: null,
        },
        kind: "terminal_pending" as const,
      },
    ],
    ["fenced recorded commit", { kind: "fenced" }],
  ] as const)(
    "retries a claimed job when %s",
    async (_name, importerResult) => {
      const test = harness({ importerResult });

      await expect(test.runner.runOnce(now)).resolves.toEqual({
        fixtureId,
        kind: "retry_wait",
      });

      expect(test.calls).toContain("retry");
      expect(test.calls).not.toContain("ready");
      expect(test.calls).toContain("release");
      expect(test.retryInputs).toHaveLength(1);
      expect(test.retryInputs[0]?.availableAt).toBe("2026-07-18T12:00:30.000Z");
    },
  );

  it.each([
    [
      "malformed historical payload",
      new SyntaxError("TxLINE historical SSE frame was invalid"),
    ],
    [
      "wrong historical fixture",
      new Error(
        "Historical record payload does not match the requested fixture",
      ),
    ],
  ])("rejects a claimed job for %s", async (_name, importerError) => {
    const test = harness({ importerError });

    await expect(test.runner.runOnce(now)).resolves.toEqual({
      fixtureId,
      kind: "rejected",
    });

    expect(test.calls).toContain("rejected");
    expect(test.calls).not.toContain("ready");
    expect(test.calls).toContain("release");
  });

  it("blocks a claimed job when an explicit TxLINE rights failure occurs", async () => {
    const test = harness({
      fetchError: new TxlineHttpError(403, "/api/scores/historical/18237038"),
    });

    await expect(test.runner.runOnce(now)).resolves.toEqual({
      fixtureId,
      kind: "blocked_rights",
    });

    expect(test.calls).toContain("blocked_rights");
    expect(test.calls).not.toContain("ready");
    expect(test.calls).toContain("release");
  });

  it.each([400, 404, 422])(
    "rejects an explicitly invalid historical-provider response (%i)",
    async (status) => {
      const test = harness({
        fetchError: new TxlineHttpError(
          status,
          "/api/scores/historical/18237038",
        ),
      });

      await expect(test.runner.runOnce(now)).resolves.toEqual({
        fixtureId,
        kind: "rejected",
      });

      expect(test.calls).toContain("rejected");
      expect(test.calls).not.toContain("retry");
      expect(test.calls).toContain("release");
    },
  );

  it("retries a finite-history transport error at the fixed bounded retry time", async () => {
    const test = harness({
      fetchError: new Error("provider connection reset"),
    });

    await expect(test.runner.runOnce(now)).resolves.toEqual({
      fixtureId,
      kind: "retry_wait",
    });

    expect(test.retryInputs).toEqual([
      {
        availableAt: "2026-07-18T12:00:30.000Z",
        claimGeneration: 3,
        error: "provider connection reset",
        fixtureId,
        workerId,
      },
    ]);
    expect(test.calls).toEqual([
      "claim",
      "lease",
      "create_importer",
      "fetch",
      "retry",
      "release",
    ]);
  });

  it("retries a same-job recorded fence loss without marking it ready", async () => {
    const test = harness({ importerResult: { kind: "fenced" } });

    await expect(test.runner.runOnce(now)).resolves.toEqual({
      fixtureId,
      kind: "retry_wait",
    });

    expect(test.calls).toEqual([
      "claim",
      "lease",
      "create_importer",
      "fetch",
      "import",
      "retry",
      "release",
    ]);
    expect(test.retryInputs).toEqual([
      {
        availableAt: "2026-07-18T12:00:30.000Z",
        claimGeneration: 3,
        error: "recorded historical import lost its source fence",
        fixtureId,
        workerId,
      },
    ]);
  });

  it("returns idle without acquiring a recorded lease when no job is due", async () => {
    const test = harness({ claim: null });

    await expect(test.runner.runOnce(now)).resolves.toEqual({ kind: "idle" });

    expect(test.calls).toEqual(["claim"]);
  });

  it("retries a claimed job and never marks it ready when the recorded lease is held", async () => {
    const test = harness({ lease: null });

    await expect(test.runner.runOnce(now)).resolves.toEqual({
      fixtureId,
      kind: "lease_conflict",
    });

    expect(test.calls).toEqual(["claim", "lease", "retry"]);
  });

  it("retries a claimed job when recorded lease acquisition has a transport failure", async () => {
    const test = harness({
      leaseError: new Error("database connection reset during lease acquire"),
    });

    await expect(test.runner.runOnce(now)).resolves.toEqual({
      fixtureId,
      kind: "retry_wait",
    });

    expect(test.calls).toEqual(["claim", "lease", "retry"]);
    expect(test.retryInputs).toEqual([
      {
        availableAt: "2026-07-18T12:00:30.000Z",
        claimGeneration: 3,
        error: "database connection reset during lease acquire",
        fixtureId,
        workerId,
      },
    ]);
  });

  it("rejects an impossible replay-ready result without binding or publishing it", async () => {
    const test = harness({
      importerResult: {
        archive: { ...replayReadyArchive, manifest: null },
        kind: "replay_ready",
      },
    });

    await expect(test.runner.runOnce(now)).resolves.toEqual({
      fixtureId,
      kind: "rejected",
    });

    expect(test.calls).toEqual([
      "claim",
      "lease",
      "create_importer",
      "fetch",
      "import",
      "rejected",
      "release",
    ]);
  });
});
