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
  HistoricalFixtureImportInput,
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

function deferred<T>() {
  let reject!: (error: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function harness(
  input: {
    bindError?: Error;
    claim?: ArchiveImportJob | null;
    fetchError?: Error;
    fetchImpl?: (
      input: FetchTxlineHistoricalRecordsOptions,
    ) => Promise<TxlineRawRecord[]>;
    importerError?: Error;
    importerImpl?: (
      input: HistoricalFixtureImportInput,
    ) => Promise<
      | { kind: "empty" }
      | { kind: "fenced" }
      | { archive: ArchiveRebuildResult; kind: "replay_ready" }
      | { archive: ArchiveRebuildResult; kind: "terminal_pending" }
    >;
    importerResult?:
      | { kind: "empty" }
      | { kind: "fenced" }
      | { archive: ArchiveRebuildResult; kind: "replay_ready" }
      | { archive: ArchiveRebuildResult; kind: "terminal_pending" };
    leaseError?: Error;
    lease?: SourceLeaseRecord | null;
    renewClaimError?: Error;
    renewClaimResult?: ArchiveImportJob | null;
    renewLeaseError?: Error;
    renewLeaseResult?: SourceLeaseRecord | null;
    readyError?: Error;
    recoveryError?: Error;
    releaseError?: Error;
  } = {},
) {
  const calls: string[] = [];
  const operationOrder: string[] = [];
  const recoveryInputs: Date[] = [];
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
    | "recoverExpiredClaims"
    | "renewClaim"
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
      if (input.bindError) throw input.bindError;
      return verifiedOutput();
    }),
    claim: vi.fn(async () => {
      calls.push("claim");
      operationOrder.push("claim");
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
      if (input.readyError) throw input.readyError;
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
    renewClaim: vi.fn(async (value) => {
      calls.push("renew_claim");
      expect(value).toMatchObject({
        claimGeneration: claimed.claimGeneration,
        fixtureId: claimed.fixtureId,
        workerId,
      });
      if (input.renewClaimError) throw input.renewClaimError;
      return input.renewClaimResult === undefined
        ? claimed
        : input.renewClaimResult;
    }),
    recoverExpiredClaims: vi.fn(async (value) => {
      operationOrder.push("recover");
      recoveryInputs.push(value);
      if (input.recoveryError) throw input.recoveryError;
      return 1;
    }),
  };
  const sourceState: Pick<
    SourceStateRepository,
    "acquireLease" | "releaseLease" | "renewLease"
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
      if (input.releaseError) throw input.releaseError;
      return true;
    }),
    renewLease: vi.fn(async (value) => {
      calls.push("renew_lease");
      expect(value).toMatchObject({
        fencingToken: sourceLease.fencingToken,
        holderId: sourceLease.holderId,
        mode: "recorded",
        source: "txline_historical",
        streamKey: "archive-imports",
      });
      if (input.renewLeaseError) throw input.renewLeaseError;
      return input.renewLeaseResult === undefined
        ? sourceLease
        : input.renewLeaseResult;
    }),
  };
  const fetchHistoricalRecords = vi.fn(
    async (value: FetchTxlineHistoricalRecordsOptions) => {
      calls.push("fetch");
      expect(value.fixtureId).toBe(claimed.fixtureId);
      expect(value.now?.()).toBe(now.toISOString());
      if (input.fetchError) throw input.fetchError;
      if (input.fetchImpl) return input.fetchImpl(value);
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
      if (input.importerImpl) return input.importerImpl(value);
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
  return {
    calls,
    jobs,
    operationOrder,
    recoveryInputs,
    retryInputs,
    runner,
    sourceState,
  };
}

describe("archive import runner", () => {
  it("recovers expired claims before claiming and processing due archive work", async () => {
    const test = harness();

    await expect(test.runner.runOnce(now)).resolves.toEqual({
      fixtureId,
      kind: "replay_ready",
    });

    expect(test.recoveryInputs).toEqual([now]);
    expect(test.operationOrder).toEqual(["recover", "claim"]);
  });

  it("fails explicitly without claiming when expired-claim recovery fails", async () => {
    const test = harness({
      recoveryError: new Error("durable store unavailable"),
    });

    await expect(test.runner.runOnce(now)).rejects.toThrow(
      "Archive import recovery failed: durable store unavailable",
    );
    expect(test.operationOrder).toEqual(["recover"]);
    expect(test.calls).not.toContain("claim");
  });

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

  it.each([400, 422])(
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

  it("retries a historical 404 because archive publication can lag the terminal", async () => {
    const test = harness({
      fetchError: new TxlineHttpError(404, "/api/scores/historical/18237038"),
    });

    await expect(test.runner.runOnce(now)).resolves.toEqual({
      fixtureId,
      kind: "retry_wait",
    });

    expect(test.calls).toContain("retry");
    expect(test.calls).not.toContain("rejected");
    expect(test.calls).toContain("release");
  });

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

  it("retries without publishing when the post-import binding is stale or invalid", async () => {
    const test = harness({
      bindError: new Error(
        "Archive import job claim or current archive output is invalid",
      ),
    });

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
      "bind",
      "retry",
      "release",
    ]);
    expect(test.calls).not.toContain("ready");
  });

  it("marks an owned import blocked when binding discovers a revoked replay grant", async () => {
    const test = harness({
      bindError: new Error(
        "Archive replay grant is inactive, expired, revoked, or missing replay scope",
      ),
    });

    await expect(test.runner.runOnce(now)).resolves.toEqual({
      fixtureId,
      kind: "blocked_rights",
    });

    expect(test.calls).toEqual([
      "claim",
      "lease",
      "create_importer",
      "fetch",
      "import",
      "bind",
      "blocked_rights",
      "release",
    ]);
    expect(test.calls).not.toContain("ready");
  });

  it("retries without publishing when readying the bound output loses its generation", async () => {
    const test = harness({
      readyError: new Error(
        "Archive import job claim or verified archive output is invalid",
      ),
    });

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
      "bind",
      "ready",
      "retry",
      "release",
    ]);
  });

  it("does not let release failure mask an already-safe replay-ready outcome", async () => {
    const test = harness({
      releaseError: new Error("recorded lease release transport failure"),
    });

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

  it("renews both fenced ownerships while a finite historical fetch is still in flight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const fetch = deferred<TxlineRawRecord[]>();
    const test = harness({ fetchImpl: async () => fetch.promise });
    const run = test.runner.runOnce(now);

    try {
      await vi.advanceTimersByTimeAsync(60_000);

      expect(test.calls).toContain("renew_lease");
      expect(test.calls).toContain("renew_claim");

      fetch.resolve([historicalRecord]);
      await expect(run).resolves.toEqual({
        fixtureId,
        kind: "replay_ready",
      });
    } finally {
      fetch.resolve([historicalRecord]);
      await run.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("aborts the finite fetch and never imports when a renewed archive claim is lost", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const fetchStarted = deferred<void>();
    const fallback = deferred<TxlineRawRecord[]>();
    const test = harness({
      fetchImpl: async ({ signal }) => {
        fetchStarted.resolve();
        return new Promise<TxlineRawRecord[]>((resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
          fallback.promise.then(resolve, reject);
        });
      },
      renewClaimResult: null,
    });
    const run = test.runner.runOnce(now);

    try {
      await fetchStarted.promise;
      await vi.advanceTimersByTimeAsync(60_000);

      expect(test.calls).toContain("renew_lease");
      expect(test.calls).toContain("renew_claim");
      await expect(run).resolves.toEqual({
        fixtureId,
        kind: "retry_wait",
      });
      expect(test.calls).not.toContain("import");
      expect(test.calls).not.toContain("bind");
      expect(test.calls).not.toContain("ready");
    } finally {
      fallback.resolve([historicalRecord]);
      await run.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("never binds or publishes when source ownership is lost during a non-cancellable import", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const importerStarted = deferred<void>();
    const importerResult = deferred<{
      archive: ArchiveRebuildResult;
      kind: "replay_ready";
    }>();
    const test = harness({
      importerImpl: async () => {
        importerStarted.resolve();
        return importerResult.promise;
      },
      renewLeaseResult: null,
    });
    const run = test.runner.runOnce(now);

    try {
      await importerStarted.promise;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(test.calls).toContain("renew_lease");

      importerResult.resolve({
        archive: replayReadyArchive,
        kind: "replay_ready",
      });
      await expect(run).resolves.toEqual({
        fixtureId,
        kind: "retry_wait",
      });
      expect(test.calls).not.toContain("bind");
      expect(test.calls).not.toContain("ready");
    } finally {
      importerResult.resolve({
        archive: replayReadyArchive,
        kind: "replay_ready",
      });
      await run.catch(() => undefined);
      vi.useRealTimers();
    }
  });
});
