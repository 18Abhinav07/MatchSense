import { hashArchiveImportSourceContext } from "@matchsense/db";
import type {
  ArchiveImportJob,
  ArchiveImportJobRepository,
  FixtureTruthRepository,
  SourceFence,
  SourceLeaseRecord,
  SourceStateRepository,
} from "@matchsense/db";
import {
  TxlineHttpError,
  fetchTxlineHistoricalRecords,
  type DurableTxlineFixture,
  type FetchTxlineHistoricalRecordsOptions,
  type TxlineAuthenticatedClient,
  type TxlineRawRecord,
} from "@matchsense/txline-adapter";

import type { ArchiveService } from "./archive-service.js";
import {
  createHistoricalArchiveImporter,
  type HistoricalArchiveImporter,
  type HistoricalArchiveImporterOptions,
} from "./historical-importer.js";

const RECORDED_LEASE_DURATION_MS = 2 * 60_000;
const OWNERSHIP_RENEWAL_MS = RECORDED_LEASE_DURATION_MS / 2;
const RETRY_DELAY_MS = 30_000;
const SHUTDOWN_RETRY_ERROR = "archive import worker is shutting down";

const recordedLeaseKey = {
  mode: "recorded" as const,
  source: "txline_historical",
  streamKey: "archive-imports",
};

const rejectedHistoricalImportMessages = new Set([
  "Archive import job frozen schedule context is inconsistent",
  "Archive import job frozen schedule context hash is invalid",
  "Archive import job is missing frozen schedule context",
  "Historical import requires reconciliation records",
  "Historical record does not match the requested fixture",
  "Historical record did not originate from the TxLINE historical path",
  "Historical record payload does not match the requested fixture",
]);

const blockedRightsMessages = new Set([
  "Archive replay grant is inactive, expired, revoked, or missing replay scope",
  "Authorised raw retention grant is inactive, expired, revoked, or missing raw-retention scope",
]);

export interface ArchiveImportRunnerOptions {
  archive: ArchiveService;
  archiveImportJobs: Pick<
    ArchiveImportJobRepository,
    | "bindVerifiedArchiveOutput"
    | "claim"
    | "markBlockedRights"
    | "markRejected"
    | "markReplayReady"
    | "markRetry"
    | "recoverExpiredClaims"
    | "renewClaim"
  >;
  client: TxlineAuthenticatedClient;
  createHistoricalArchiveImporter?: (
    options: HistoricalArchiveImporterOptions,
  ) => HistoricalArchiveImporter;
  fetchHistoricalRecords?: (
    options: FetchTxlineHistoricalRecordsOptions,
  ) => Promise<TxlineRawRecord[]>;
  fixtureTruth: Pick<
    FixtureTruthRepository,
    "commitCollectorFrame" | "commitFencedFixtureUpsert" | "get"
  >;
  rightsGrantId: string;
  sourceState: Pick<
    SourceStateRepository,
    "acquireLease" | "releaseLease" | "renewLease"
  >;
  workerId: string;
}

export type ArchiveImportRunResult =
  | { kind: "idle" }
  | {
      fixtureId: string;
      kind:
        | "blocked_rights"
        | "lease_conflict"
        | "rejected"
        | "replay_ready"
        | "retry_wait";
    };

export interface ArchiveImportRunner {
  runOnce(
    now?: Date,
    shutdownSignal?: AbortSignal,
  ): Promise<ArchiveImportRunResult>;
}

function isoAt(now: Date, offsetMs: number) {
  return new Date(now.valueOf() + offsetMs).toISOString();
}

function frozenFixture(job: ArchiveImportJob): DurableTxlineFixture {
  const sourceContext = job.sourceContext;
  if (!sourceContext) {
    throw new Error("Archive import job is missing frozen schedule context");
  }
  if (hashArchiveImportSourceContext(sourceContext) !== job.contextHash) {
    throw new Error(
      "Archive import job frozen schedule context hash is invalid",
    );
  }
  const homeTeam = sourceContext.participant1IsHome
    ? sourceContext.participant1.code
    : sourceContext.participant2.code;
  const awayTeam = sourceContext.participant1IsHome
    ? sourceContext.participant2.code
    : sourceContext.participant1.code;
  if (
    sourceContext.fixtureId !== job.fixtureId ||
    sourceContext.kickoffAt !== job.kickoffAt ||
    sourceContext.participant1IsHome !== job.participant1IsHome ||
    homeTeam !== job.homeTeamId ||
    awayTeam !== job.awayTeamId
  ) {
    throw new Error(
      "Archive import job frozen schedule context is inconsistent",
    );
  }
  return {
    awayTeam,
    fixtureId: sourceContext.fixtureId,
    homeTeam,
    kickoffAt: sourceContext.kickoffAt,
    participant1IsHome: sourceContext.participant1IsHome,
  };
}

function fenceFor(lease: SourceLeaseRecord) {
  return {
    fencingToken: lease.fencingToken,
    holderId: lease.holderId,
    source: lease.source,
    streamKey: lease.streamKey,
  } satisfies SourceFence;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function failureKind(
  error: unknown,
): "blocked_rights" | "rejected" | "retry_wait" {
  if (error instanceof TxlineHttpError) {
    if (error.status === 401 || error.status === 403) {
      return "blocked_rights";
    }
    if (error.status === 400 || error.status === 422) {
      return "rejected";
    }
    return "retry_wait";
  }
  if (error instanceof SyntaxError) return "rejected";

  const message = errorMessage(error);
  if (blockedRightsMessages.has(message)) return "blocked_rights";
  if (rejectedHistoricalImportMessages.has(message)) return "rejected";
  return "retry_wait";
}

function workerClaim(job: ArchiveImportJob, workerId: string) {
  return {
    claimGeneration: job.claimGeneration,
    fixtureId: job.fixtureId,
    workerId,
  };
}

/**
 * Consumes one durable archive-import job. It intentionally owns no schedule
 * lookup and never invokes the live stream: the job's frozen context is the
 * only fixture definition allowed to reach the recorded importer.
 */
export function createArchiveImportRunner(
  options: ArchiveImportRunnerOptions,
): ArchiveImportRunner {
  const createImporter =
    options.createHistoricalArchiveImporter ?? createHistoricalArchiveImporter;
  const fetchRecords =
    options.fetchHistoricalRecords ?? fetchTxlineHistoricalRecords;

  const retry = async (job: ArchiveImportJob, now: Date, error: string) => {
    await options.archiveImportJobs.markRetry({
      ...workerClaim(job, options.workerId),
      availableAt: isoAt(now, RETRY_DELAY_MS),
      error,
    });
  };

  const retrySafely = async (
    job: ArchiveImportJob,
    now: Date,
    error: string,
  ) => {
    try {
      await retry(job, now, error);
    } catch {
      // A lost/expired claim cannot be transitioned by this worker. The
      // durable claim recovery path will make it due again; never overwrite a
      // newer generation just to report a retry locally.
    }
  };

  const reject = async (
    job: ArchiveImportJob,
    now: Date,
    error: string,
  ): Promise<ArchiveImportRunResult> => {
    try {
      await options.archiveImportJobs.markRejected({
        ...workerClaim(job, options.workerId),
        error,
      });
      return { fixtureId: job.fixtureId, kind: "rejected" };
    } catch {
      await retrySafely(job, now, error);
      return { fixtureId: job.fixtureId, kind: "retry_wait" };
    }
  };

  const settleFailure = async (
    job: ArchiveImportJob,
    now: Date,
    error: unknown,
  ): Promise<ArchiveImportRunResult> => {
    const kind = failureKind(error);
    if (kind === "blocked_rights") {
      try {
        await options.archiveImportJobs.markBlockedRights({
          ...workerClaim(job, options.workerId),
          error: errorMessage(error),
        });
        return { fixtureId: job.fixtureId, kind };
      } catch {
        await retrySafely(job, now, errorMessage(error));
        return { fixtureId: job.fixtureId, kind: "retry_wait" };
      }
    }
    if (kind === "rejected") {
      return reject(job, now, errorMessage(error));
    }
    await retrySafely(job, now, errorMessage(error));
    return { fixtureId: job.fixtureId, kind: "retry_wait" };
  };

  return {
    async runOnce(now = new Date(), shutdownSignal?: AbortSignal) {
      if (shutdownSignal?.aborted) return { kind: "idle" };
      try {
        await options.archiveImportJobs.recoverExpiredClaims(now);
      } catch (error) {
        throw new Error(
          `Archive import recovery failed: ${errorMessage(error)}`,
        );
      }
      if (shutdownSignal?.aborted) return { kind: "idle" };

      const job = await options.archiveImportJobs.claim(options.workerId, now);
      if (!job) return { kind: "idle" };
      let fixture: DurableTxlineFixture;
      try {
        fixture = frozenFixture(job);
      } catch (error) {
        return settleFailure(job, now, error);
      }
      const retryAfterShutdown = async () => {
        await retrySafely(job, now, SHUTDOWN_RETRY_ERROR);
        return { fixtureId: job.fixtureId, kind: "retry_wait" } as const;
      };
      if (shutdownSignal?.aborted) {
        return retryAfterShutdown();
      }

      let lease: SourceLeaseRecord | null;
      try {
        lease = await options.sourceState.acquireLease({
          ...recordedLeaseKey,
          holderId: options.workerId,
          leaseUntil: isoAt(now, RECORDED_LEASE_DURATION_MS),
        });
      } catch (error) {
        if (shutdownSignal?.aborted) return retryAfterShutdown();
        return settleFailure(job, now, error);
      }
      if (!lease) {
        if (shutdownSignal?.aborted) return retryAfterShutdown();
        await retrySafely(job, now, "recorded archive import lease is held");
        return { fixtureId: job.fixtureId, kind: "lease_conflict" };
      }

      let currentLease = lease;
      let ownershipLost = false;
      let renewalInFlight: Promise<void> | null = null;
      let stopping = false;
      const fetchController = new AbortController();
      const shutdownRequested = () => shutdownSignal?.aborted === true;
      const abortForShutdown = () => {
        if (!fetchController.signal.aborted) {
          fetchController.abort(shutdownSignal?.reason);
        }
      };
      if (shutdownSignal?.aborted) abortForShutdown();
      else {
        shutdownSignal?.addEventListener("abort", abortForShutdown, {
          once: true,
        });
      }

      const recordOwnershipLoss = (error: unknown) => {
        ownershipLost = true;
        // The finite TxLINE fetch accepts an AbortSignal. The importer itself
        // commits through a source fence and cannot be cancelled once its DB
        // transaction starts, so the checks below deliberately prevent any
        // output binding or ready transition after ownership is lost.
        if (!fetchController.signal.aborted) {
          fetchController.abort(error);
        }
      };

      const renewOwnership = async () => {
        const renewalAt = new Date();
        const leaseUntil = isoAt(renewalAt, RECORDED_LEASE_DURATION_MS);
        try {
          const [renewedLease, renewedClaim] = await Promise.all([
            options.sourceState.renewLease({
              ...recordedLeaseKey,
              fencingToken: currentLease.fencingToken,
              holderId: currentLease.holderId,
              leaseUntil,
            }),
            options.archiveImportJobs.renewClaim({
              ...workerClaim(job, options.workerId),
              claimExpiresAt: leaseUntil,
            }),
          ]);

          // Keep the newest lease for final release even if the paired claim
          // was lost. A missing result on either side makes the worker stale.
          if (renewedLease) currentLease = renewedLease;
          if (!renewedLease || !renewedClaim) {
            recordOwnershipLoss(
              new Error("recorded archive import ownership was lost"),
            );
          }
        } catch (error) {
          // A renewal transport failure is not proof that our ownership is
          // still current. Stop work instead of risking a stale publication.
          recordOwnershipLoss(error);
        }
      };

      const startRenewal = () => {
        if (stopping || ownershipLost || renewalInFlight) return;
        const flight = renewOwnership();
        renewalInFlight = flight;
        void flight.finally(() => {
          if (renewalInFlight === flight) renewalInFlight = null;
        });
      };

      const renewalTimer = setInterval(startRenewal, OWNERSHIP_RENEWAL_MS);
      const ownershipIsCurrent = async () => {
        await renewalInFlight;
        return !ownershipLost;
      };
      const retryAfterOwnershipLoss = async () => {
        await retrySafely(
          job,
          new Date(),
          "recorded archive import ownership was lost",
        );
        return { fixtureId: job.fixtureId, kind: "retry_wait" } as const;
      };

      try {
        if (shutdownRequested()) return retryAfterShutdown();
        let imported: Awaited<
          ReturnType<HistoricalArchiveImporter["importFixture"]>
        >;
        try {
          const importer = createImporter({
            archive: options.archive,
            fixtureTruth: options.fixtureTruth,
            rightsGrantId: options.rightsGrantId,
            sourceFence: fenceFor(lease),
          });
          const records = await fetchRecords({
            client: options.client,
            fixtureId: job.fixtureId,
            now: () => now.toISOString(),
            signal: fetchController.signal,
          });
          if (shutdownRequested()) return retryAfterShutdown();
          if (!(await ownershipIsCurrent())) {
            return retryAfterOwnershipLoss();
          }
          if (shutdownRequested()) return retryAfterShutdown();
          imported = await importer.importFixture({
            fixture,
            records,
          });
        } catch (error) {
          if (shutdownRequested()) return retryAfterShutdown();
          if (ownershipLost) return retryAfterOwnershipLoss();
          return settleFailure(job, now, error);
        }

        if (shutdownRequested()) return retryAfterShutdown();
        if (!(await ownershipIsCurrent())) {
          return retryAfterOwnershipLoss();
        }

        if (imported.kind !== "replay_ready") {
          await retrySafely(
            job,
            now,
            imported.kind === "empty"
              ? "TxLINE historical endpoint returned no records"
              : imported.kind === "fenced"
                ? "recorded historical import lost its source fence"
                : "recorded historical archive is awaiting a final terminal",
          );
          return { fixtureId: job.fixtureId, kind: "retry_wait" };
        }

        const manifest = imported.archive.manifest;
        if (!manifest || imported.archive.status !== "REPLAY_READY") {
          return reject(
            job,
            now,
            "Recorded importer returned replay_ready without a replay-ready manifest",
          );
        }
        if (shutdownRequested()) return retryAfterShutdown();
        if (!(await ownershipIsCurrent())) {
          return retryAfterOwnershipLoss();
        }
        if (shutdownRequested()) return retryAfterShutdown();
        try {
          await options.archiveImportJobs.bindVerifiedArchiveOutput({
            ...workerClaim(job, options.workerId),
            archiveManifestHash: manifest.deliveryManifestHash,
            archiveManifestId: manifest.id,
          });
          if (shutdownRequested()) return retryAfterShutdown();
          if (!(await ownershipIsCurrent())) {
            return retryAfterOwnershipLoss();
          }
          if (shutdownRequested()) return retryAfterShutdown();
          await options.archiveImportJobs.markReplayReady(
            workerClaim(job, options.workerId),
          );
          return { fixtureId: job.fixtureId, kind: "replay_ready" };
        } catch (error) {
          if (shutdownRequested()) return retryAfterShutdown();
          return settleFailure(job, now, error);
        }
      } finally {
        stopping = true;
        clearInterval(renewalTimer);
        shutdownSignal?.removeEventListener("abort", abortForShutdown);
        await renewalInFlight;
        try {
          await options.sourceState.releaseLease({
            ...recordedLeaseKey,
            fencingToken: currentLease.fencingToken,
            holderId: currentLease.holderId,
          });
        } catch {
          // Release is best-effort after a fenced terminal transition. Its
          // failure must not lie about the import result or override it.
        }
      }
    },
  };
}
