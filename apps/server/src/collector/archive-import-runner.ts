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
const RETRY_DELAY_MS = 30_000;

const recordedLeaseKey = {
  mode: "recorded" as const,
  source: "txline_historical",
  streamKey: "archive-imports",
};

const rejectedHistoricalImportMessages = new Set([
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
    "commitCollectorFrame" | "get" | "upsert"
  >;
  rightsGrantId: string;
  sourceState: Pick<SourceStateRepository, "acquireLease" | "releaseLease">;
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
  runOnce(now?: Date): Promise<ArchiveImportRunResult>;
}

function isoAt(now: Date, offsetMs: number) {
  return new Date(now.valueOf() + offsetMs).toISOString();
}

function frozenFixture(job: ArchiveImportJob): DurableTxlineFixture {
  return {
    awayTeam: job.awayTeamId,
    fixtureId: job.fixtureId,
    homeTeam: job.homeTeamId,
    kickoffAt: job.kickoffAt,
    participant1IsHome: job.participant1IsHome,
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
    if (error.status === 400 || error.status === 404 || error.status === 422) {
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

  return {
    async runOnce(now = new Date()) {
      const job = await options.archiveImportJobs.claim(options.workerId, now);
      if (!job) return { kind: "idle" };

      let lease: SourceLeaseRecord | null;
      try {
        lease = await options.sourceState.acquireLease({
          ...recordedLeaseKey,
          holderId: options.workerId,
          leaseUntil: isoAt(now, RECORDED_LEASE_DURATION_MS),
        });
      } catch (error) {
        await retry(job, now, errorMessage(error));
        return { fixtureId: job.fixtureId, kind: "retry_wait" };
      }
      if (!lease) {
        await retry(job, now, "recorded archive import lease is held");
        return { fixtureId: job.fixtureId, kind: "lease_conflict" };
      }

      try {
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
          });
          imported = await importer.importFixture({
            fixture: frozenFixture(job),
            records,
          });
        } catch (error) {
          const kind = failureKind(error);
          if (kind === "blocked_rights") {
            await options.archiveImportJobs.markBlockedRights({
              ...workerClaim(job, options.workerId),
              error: errorMessage(error),
            });
            return { fixtureId: job.fixtureId, kind };
          }
          if (kind === "rejected") {
            await options.archiveImportJobs.markRejected({
              ...workerClaim(job, options.workerId),
              error: errorMessage(error),
            });
            return { fixtureId: job.fixtureId, kind };
          }
          await retry(job, now, errorMessage(error));
          return { fixtureId: job.fixtureId, kind };
        }

        if (imported.kind !== "replay_ready") {
          await retry(
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
          await options.archiveImportJobs.markRejected({
            ...workerClaim(job, options.workerId),
            error:
              "Recorded importer returned replay_ready without a replay-ready manifest",
          });
          return { fixtureId: job.fixtureId, kind: "rejected" };
        }
        await options.archiveImportJobs.bindVerifiedArchiveOutput({
          ...workerClaim(job, options.workerId),
          archiveManifestHash: manifest.deliveryManifestHash,
          archiveManifestId: manifest.id,
        });
        await options.archiveImportJobs.markReplayReady(
          workerClaim(job, options.workerId),
        );
        return { fixtureId: job.fixtureId, kind: "replay_ready" };
      } finally {
        await options.sourceState.releaseLease({
          ...recordedLeaseKey,
          fencingToken: lease.fencingToken,
          holderId: lease.holderId,
        });
      }
    },
  };
}
