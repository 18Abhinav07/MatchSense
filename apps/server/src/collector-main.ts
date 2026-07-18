import { randomUUID } from "node:crypto";

import {
  createPostgresDatabase,
  type ApplicationDatabase,
  type OutboxRepository,
  type SourceLeaseRecord,
} from "@matchsense/db";
import {
  createTxlineAuthenticatedClient,
  createTxlineRawScoreSource,
  fetchTxlineWorldCupSchedule,
  type TxlineAuthenticatedClient,
} from "@matchsense/txline-adapter";

import type { ServerConfig } from "./config.js";
import { createArchiveService } from "./collector/archive-service.js";
import {
  createScheduleSync,
  durableFixtureFromSchedule,
} from "./collector/schedule-sync.js";
import { createTxlineCollector } from "./collector/txline-collector.js";
import { createOutboxWorker, type OutboxWorker } from "./outbox-worker.js";
import {
  createShutdownFailureReporter,
  registerShutdownSignals,
  type ShutdownSignalSource,
} from "./start.js";

export type CollectorDatabaseRuntime = Pick<
  ApplicationDatabase,
  "archive" | "close" | "fixtureTruth" | "migrate" | "outbox" | "sourceState"
>;

export interface CollectorSourceLifecycle {
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
}

export interface StartCollectorOptions {
  databaseFactory?: (databaseUrl: string) => CollectorDatabaseRuntime;
  databaseRuntime?: CollectorDatabaseRuntime;
  outboxWorker?: OutboxWorker;
  outboxWorkerFactory?: (outbox: OutboxRepository) => OutboxWorker;
  sourceLifecycleFactory?: (input: {
    database: CollectorDatabaseRuntime;
    txlineClient: TxlineAuthenticatedClient;
  }) => CollectorSourceLifecycle;
  sourceLifecycle?: CollectorSourceLifecycle;
  signalSource?: ShutdownSignalSource;
  txlineClientFactory?: (options: {
    apiToken: string;
  }) => TxlineAuthenticatedClient;
}

const STREAM_SOURCE = "txline";
const STREAM_KEY = "scores:mainnet";
const LEASE_DURATION_MS = 90_000;
const LEASE_RENEWAL_MS = 30_000;
const HACKATHON_RIGHTS_GRANT_ID = "txline-world-cup-hackathon-2026";

function leaseUntil() {
  return new Date(Date.now() + LEASE_DURATION_MS).toISOString();
}

function sourceFence(lease: SourceLeaseRecord) {
  return {
    fencingToken: lease.fencingToken,
    holderId: lease.holderId,
    source: lease.source,
    streamKey: lease.streamKey,
  };
}

/**
 * The deployed worker's real TxLINE lifecycle. It acquires the only source
 * lease, writes schedule observations, then keeps raw SSE ownership isolated
 * from the API process. All stream cursor movement is delegated to the
 * collector frame transaction.
 */
export function createDurableCollectorLifecycle(input: {
  database: CollectorDatabaseRuntime;
  txlineClient: TxlineAuthenticatedClient;
}): CollectorSourceLifecycle {
  const holderId = `collector:${randomUUID()}`;
  let abortController: AbortController | null = null;
  let sourceTask: Promise<void> | null = null;
  let renewTimer: ReturnType<typeof setInterval> | null = null;
  let activeLease: SourceLeaseRecord | null = null;

  const stop = async () => {
    if (renewTimer) {
      clearInterval(renewTimer);
      renewTimer = null;
    }
    abortController?.abort();
    const task = sourceTask;
    sourceTask = null;
    abortController = null;
    if (task) await task.catch(() => undefined);
    const lease = activeLease;
    activeLease = null;
    if (lease) {
      await input.database.sourceState.releaseLease({
        fencingToken: lease.fencingToken,
        holderId: lease.holderId,
        mode: lease.mode,
        source: lease.source,
        streamKey: lease.streamKey,
      });
    }
  };

  return {
    async start() {
      if (abortController) return;
      const lease = await input.database.sourceState.acquireLease({
        holderId,
        leaseUntil: leaseUntil(),
        mode: "live",
        source: STREAM_SOURCE,
        streamKey: STREAM_KEY,
      });
      if (!lease) {
        throw new Error("Collector source lease is held by another worker");
      }
      activeLease = lease;
      const fence = sourceFence(lease);
      try {
        await input.database.archive.upsertRightsGrant({
          active: true,
          id: HACKATHON_RIGHTS_GRANT_ID,
          reference: "TxLINE World Cup Hackathon 2026",
          scopes: ["raw_retention", "replay"],
        });
        const schedule = await fetchTxlineWorldCupSchedule(input.txlineClient);
        if (schedule.length === 0) {
          throw new Error(
            "TxLINE returned no World Cup fixtures for collection",
          );
        }
        await createScheduleSync({
          repository: input.database.fixtureTruth,
          rightsGrantId: HACKATHON_RIGHTS_GRANT_ID,
          sourceFence: fence,
        }).sync(schedule);
        const fixtures = new Map(
          schedule.map((fixture) => [
            fixture.fixtureId,
            durableFixtureFromSchedule(fixture),
          ]),
        );
        const collector = createTxlineCollector({
          archive: createArchiveService({ archive: input.database.archive }),
          fixtureForId: (fixtureId) => fixtures.get(fixtureId) ?? null,
          fixtureTruth: input.database.fixtureTruth,
          rightsGrantId: HACKATHON_RIGHTS_GRANT_ID,
          sourceFence: fence,
        });
        const source = createTxlineRawScoreSource({
          client: input.txlineClient,
          fixtureIds: [...fixtures.keys()],
          loadCursor: async () =>
            (
              await input.database.sourceState.getCursor({
                mode: "live",
                source: STREAM_SOURCE,
                streamKey: STREAM_KEY,
              })
            )?.cursorValue ?? null,
          onLiveFrame: (frame) => collector.ingestLiveFrame(frame),
          onRawRecord: async (record) => {
            await collector.ingest(record);
          },
          onWarning: (warning) => {
            process.stderr.write(
              `TxLINE collector ${warning.code}: ${warning.message}\n`,
            );
          },
        });
        abortController = new AbortController();
        sourceTask = source.run(abortController.signal);
        void sourceTask.catch((error: unknown) => {
          process.stderr.write(
            `TxLINE collector stopped: ${
              error instanceof Error ? error.message : String(error)
            }\n`,
          );
        });
        renewTimer = setInterval(() => {
          const current = activeLease;
          if (!current) return;
          void input.database.sourceState
            .renewLease({
              fencingToken: current.fencingToken,
              holderId: current.holderId,
              leaseUntil: leaseUntil(),
              mode: current.mode,
              source: current.source,
              streamKey: current.streamKey,
            })
            .then((renewed) => {
              if (!renewed) abortController?.abort();
              else activeLease = renewed;
            })
            .catch(() => abortController?.abort());
        }, LEASE_RENEWAL_MS);
      } catch (error) {
        await stop();
        throw error;
      }
    },
    stop,
  };
}

function assertCollectorRole(config: ServerConfig) {
  if (
    config.role !== "worker" ||
    config.dataRightsMode !== "txline_hackathon" ||
    !config.txlineApiToken
  ) {
    throw new Error(
      "Collector runtime requires ROLE=worker and a TxLINE token",
    );
  }
}

export async function startCollector(
  config: ServerConfig,
  options: StartCollectorOptions = {},
): Promise<{ close(): Promise<void> }> {
  assertCollectorRole(config);
  const txlineApiToken = config.txlineApiToken;
  if (!txlineApiToken) {
    throw new Error(
      "Collector runtime requires ROLE=worker and a TxLINE token",
    );
  }
  const databaseRuntime =
    options.databaseRuntime ??
    (options.databaseFactory ?? createPostgresDatabase)(config.databaseUrl);
  let closed = false;
  let unregisterSignals: () => void = () => undefined;
  let outboxWorker: OutboxWorker | null = null;
  let sourceLifecycle: CollectorSourceLifecycle | null = null;
  let sourceStarted = false;

  const close = async () => {
    if (closed) return;
    closed = true;
    unregisterSignals();
    if (sourceStarted) await sourceLifecycle?.stop();
    await outboxWorker?.stop();
    await databaseRuntime.close();
  };

  try {
    await databaseRuntime.migrate();
    const txlineClient = (
      options.txlineClientFactory ?? createTxlineAuthenticatedClient
    )({ apiToken: txlineApiToken });
    sourceLifecycle =
      options.sourceLifecycle ??
      (options.sourceLifecycleFactory ?? createDurableCollectorLifecycle)({
        database: databaseRuntime,
        txlineClient,
      });
    outboxWorker =
      options.outboxWorker ??
      (
        options.outboxWorkerFactory ??
        ((outbox) =>
          createOutboxWorker({
            consumer: "collector",
            handlers: {},
            mode: "live",
            outbox,
          }))
      )(databaseRuntime.outbox);
    await sourceLifecycle.start();
    sourceStarted = true;
    outboxWorker.start();
    unregisterSignals = registerShutdownSignals(
      options.signalSource ?? process,
      close,
      createShutdownFailureReporter({
        setExitCode: (code) => {
          process.exitCode = code;
        },
        writeError: (message) => process.stderr.write(message),
      }),
    );
    return { close };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}
