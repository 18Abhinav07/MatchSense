import {
  createPostgresDatabase,
  type ApplicationDatabase,
  type OutboxRepository,
} from "@matchsense/db";
import { createTxlineAuthenticatedClient } from "@matchsense/txline-adapter";

import type { ServerConfig } from "./config.js";
import type { OutboxWorker } from "./outbox-worker.js";
import {
  createShutdownFailureReporter,
  registerShutdownSignals,
  type ShutdownSignalSource,
} from "./start.js";

export type CollectorDatabaseRuntime = Pick<
  ApplicationDatabase,
  "close" | "migrate" | "outbox"
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
  sourceLifecycle?: CollectorSourceLifecycle;
  signalSource?: ShutdownSignalSource;
  txlineClientFactory?: (options: { apiToken: string }) => unknown;
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
  const sourceLifecycle = options.sourceLifecycle;
  if (
    !sourceLifecycle ||
    (!options.outboxWorker && !options.outboxWorkerFactory)
  ) {
    throw new Error(
      "Collector runtime is not wired: provide a source lifecycle and outbox worker",
    );
  }
  const databaseRuntime =
    options.databaseRuntime ??
    (options.databaseFactory ?? createPostgresDatabase)(config.databaseUrl);
  let closed = false;
  let unregisterSignals: () => void = () => undefined;
  let outboxWorker: OutboxWorker | null = null;
  let sourceStarted = false;

  const close = async () => {
    if (closed) return;
    closed = true;
    unregisterSignals();
    if (sourceStarted) await sourceLifecycle.stop();
    await outboxWorker?.stop();
    await databaseRuntime.close();
  };

  try {
    await databaseRuntime.migrate();
    const txlineClient = (
      options.txlineClientFactory ?? createTxlineAuthenticatedClient
    )({ apiToken: txlineApiToken });
    void txlineClient;
    outboxWorker =
      options.outboxWorker ??
      options.outboxWorkerFactory!(databaseRuntime.outbox);
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
