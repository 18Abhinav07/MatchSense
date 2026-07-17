import path from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { createCommentaryPipeline } from "@matchsense/commentary";
import {
  createPostgresDatabase,
  type OutboxRepository,
  type PersistenceMode,
} from "@matchsense/db";
import type { TeamCode } from "@matchsense/contracts";
import {
  createTxlineAuthenticatedClient,
  createTxlineLiveScoreSource,
  fetchTxlineWorldCupSchedule,
  type TxlineFixtureContext,
  type TxlineScheduleFixture,
} from "@matchsense/txline-adapter";
import type { FastifyInstance } from "fastify";

import { buildApp, type ReadinessProbe } from "./app.js";
import { transcodeWavToStreamMp3 } from "./audio-transcoder.js";
import { parseServerEnv } from "./config.js";
import { inspectMp3 } from "./mp3.js";
import { createOutboxWorker, type OutboxWorker } from "./outbox-worker.js";
import { deliverMomentPush } from "./push-delivery.js";
import { InMemoryPushSubscriptionStore } from "./push-subscriptions.js";
import {
  createProductRuntime,
  type ProductRuntime,
} from "./product-runtime.js";
import {
  createShutdownFailureReporter,
  registerShutdownSignals,
  type ShutdownSignalSource,
} from "./start.js";
import { createVapidWebPushSender } from "./web-push-sender.js";

interface ServerDatabaseRuntime extends ReadinessProbe {
  close(): Promise<void>;
  migrate(): Promise<unknown>;
  outbox: OutboxRepository;
}

const TEAM_CODES_BY_NAME: Readonly<Record<string, TeamCode>> = {
  argentina: "ARG",
  brazil: "BRA",
  england: "ENG",
  france: "FRA",
  japan: "JPN",
  spain: "ESP",
};

function teamCodeFor(name: string) {
  return TEAM_CODES_BY_NAME[name.trim().toLowerCase()] ?? null;
}

export function productFixtureFromTxline(fixture: TxlineScheduleFixture) {
  const participant1Code = teamCodeFor(fixture.participant1.name);
  const participant2Code = teamCodeFor(fixture.participant2.name);
  if (!participant1Code || !participant2Code) return null;
  return {
    context: {
      fixtureId: fixture.fixtureId,
      participant1: fixture.participant1,
      participant1IsHome: fixture.participant1IsHome,
      participant2: fixture.participant2,
    } satisfies TxlineFixtureContext,
    product: {
      awayTeam: fixture.participant1IsHome
        ? participant2Code
        : participant1Code,
      fixtureId: fixture.fixtureId,
      homeTeam: fixture.participant1IsHome
        ? participant1Code
        : participant2Code,
      kickoffAt: new Date(fixture.startTimeMs).toISOString(),
      participant1IsHome: fixture.participant1IsHome,
      provenance: "live_txline" as const,
    },
  };
}

export interface StartServerOptions {
  databaseFactory?: (databaseUrl: string) => ServerDatabaseRuntime;
  databaseRuntime?: ServerDatabaseRuntime;
  environment?: Record<string, string | undefined>;
  httpListen?: (
    app: FastifyInstance,
    address: { host: string; port: number },
  ) => Promise<unknown>;
  listen?: boolean;
  outboxWorker?: OutboxWorker;
  outboxWorkerFactory?: (mode: PersistenceMode) => OutboxWorker;
  readinessProbe?: ReadinessProbe;
  shutdownTimeoutMs?: number;
  productRuntime?: ProductRuntime;
  signalSource?: ShutdownSignalSource;
  txlineScheduleFetcher?: (
    apiToken: string,
  ) => Promise<readonly TxlineScheduleFixture[]>;
  txlineSourceFactory?: typeof createTxlineLiveScoreSource;
  webDistPath?: string;
}

async function boundedCleanup(
  label: string,
  timeoutMs: number,
  action: () => unknown,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(action),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} shutdown timed out`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function settleCleanupStage(
  actions: readonly { action: () => unknown; label: string }[],
  timeoutMs: number,
): Promise<unknown[]> {
  const results = await Promise.allSettled(
    actions.map(({ action, label }) =>
      boundedCleanup(label, timeoutMs, action),
    ),
  );
  return results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
}

export async function startServer(options: StartServerOptions = {}) {
  const config = parseServerEnv(options.environment ?? process.env);
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1) {
    throw new Error("Server shutdown timeout is invalid");
  }
  const webDistPath =
    options.webDistPath ?? path.resolve(import.meta.dirname, "../../web/dist");
  const databaseRuntime =
    options.databaseRuntime ??
    (options.databaseFactory ?? createPostgresDatabase)(config.databaseUrl);
  let productRuntime: ProductRuntime | undefined;
  let app: FastifyInstance | undefined;
  let outboxWorkers: OutboxWorker[] = [];
  let txlineAbort: AbortController | null = null;
  let txlineTask: Promise<void> | null = null;
  let txlineFixtureContexts: readonly TxlineFixtureContext[] = [];
  let txlineScheduleError: string | null = null;
  let unregisterSignals: () => void = () => undefined;

  try {
    await databaseRuntime.migrate();
    const push = config.vapid
      ? {
          applicationServerKey: config.vapid.publicKey,
          sender: createVapidWebPushSender(config.vapid),
          store: new InMemoryPushSubscriptionStore(),
        }
      : null;
    productRuntime = options.productRuntime;
    if (!productRuntime) {
      const cueBytes = await readFile(
        path.resolve(import.meta.dirname, "../assets/goal-cue.mp3"),
      );
      const streamContract = inspectMp3(cueBytes);
      let liveFixtures: ReturnType<typeof productFixtureFromTxline>[] = [];
      if (config.dataRightsMode === "txline_hackathon") {
        try {
          const scheduleFetcher =
            options.txlineScheduleFetcher ??
            (async (apiToken: string) => {
              const client = createTxlineAuthenticatedClient({ apiToken });
              return fetchTxlineWorldCupSchedule(client, {
                startEpochDay: Math.floor(Date.now() / 86_400_000),
              });
            });
          const schedule = await scheduleFetcher(config.txlineApiToken!);
          liveFixtures = schedule.map(productFixtureFromTxline);
          if (liveFixtures.every((fixture) => fixture === null)) {
            txlineScheduleError =
              "No supported World Cup fixtures are currently available";
          }
        } catch {
          txlineScheduleError = "TxLINE schedule is temporarily unavailable";
        }
      }
      const supportedLiveFixtures = liveFixtures.filter(
        (fixture): fixture is NonNullable<typeof fixture> => fixture !== null,
      );
      txlineFixtureContexts = supportedLiveFixtures.map(
        ({ context }) => context,
      );
      productRuntime = createProductRuntime({
        commentaryPipeline: createCommentaryPipeline({
          env: options.environment ?? process.env,
        }),
        cueBytes,
        ...(push
          ? {
              notifyMoment: async (moment, fixtureSnapshot) => {
                const teamNames = {
                  ARG: "Argentina",
                  BRA: "Brazil",
                  ESP: "Spain",
                  FRA: "France",
                  ENG: "England",
                  JPN: "Japan",
                } as const;
                await deliverMomentPush(
                  {
                    body: `${teamNames[moment.eventTeam]} change the match. Tap to feel the Moment and hear the live call.`,
                    fixtureId: moment.fixtureId,
                    momentId: moment.id,
                    occurredAt: fixtureSnapshot.updatedAt,
                    revision: moment.revision,
                    title: `⚽ GOAL — ${moment.eventTeam} ${moment.score.home}–${moment.score.away}, ${moment.minute}`,
                  },
                  push,
                );
              },
            }
          : {}),
        ...(config.dataRightsMode === "txline_hackathon"
          ? {
              fixtures: supportedLiveFixtures.map(({ product }) => product),
              includeDemoFixture: true,
              mode: "live" as const,
            }
          : {}),
        silenceBytes: await readFile(
          path.resolve(import.meta.dirname, "../assets/silence.mp3"),
        ),
        transcodeCommentary: (wavBytes) =>
          transcodeWavToStreamMp3(wavBytes, { expected: streamContract }),
        writeIntervalMs: 940,
      });
      if (txlineScheduleError) {
        productRuntime.setSourceHealth("error", txlineScheduleError);
      }
    }
    const runtime = productRuntime;
    const workerFactory =
      options.outboxWorkerFactory ??
      ((mode: PersistenceMode) =>
        createOutboxWorker({
          consumer: "product",
          handlers: {},
          mode,
          outbox: databaseRuntime.outbox,
        }));
    outboxWorkers = options.outboxWorker
      ? [options.outboxWorker]
      : (["live", "demo"] as const).map(workerFactory);
    app = buildApp({
      ...(push ? { push } : {}),
      manageRuntimeLifecycle: false,
      readinessProbe: options.readinessProbe ?? databaseRuntime,
      runtime,
      webDistPath,
    });
    app.addHook("onClose", async () => {
      const failures: unknown[] = [];
      try {
        unregisterSignals();
      } catch (error) {
        failures.push(error);
      }
      try {
        txlineAbort?.abort();
      } catch (error) {
        failures.push(error);
      }
      failures.push(
        ...(await settleCleanupStage(
          [
            ...outboxWorkers.map((worker, index) => ({
              action: () => worker.stop(),
              label: `outbox worker ${index + 1}`,
            })),
            ...(txlineTask
              ? [{ action: () => txlineTask, label: "TxLINE source" }]
              : []),
          ],
          shutdownTimeoutMs,
        )),
      );
      failures.push(
        ...(await settleCleanupStage(
          [{ action: () => runtime.close(), label: "product runtime" }],
          shutdownTimeoutMs,
        )),
      );
      failures.push(
        ...(await settleCleanupStage(
          [{ action: () => databaseRuntime.close(), label: "database" }],
          shutdownTimeoutMs,
        )),
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, "Server shutdown failed");
      }
    });

    if (options.listen !== false) {
      if (options.httpListen) {
        await options.httpListen(app, {
          host: config.host,
          port: config.port,
        });
      } else {
        await app.listen({ host: config.host, port: config.port });
      }
    }
    for (const worker of outboxWorkers) {
      worker.start();
    }
    if (
      config.dataRightsMode === "txline_hackathon" &&
      (txlineFixtureContexts.length > 0 || options.productRuntime !== undefined)
    ) {
      txlineAbort = new AbortController();
      const sourceFactory =
        options.txlineSourceFactory ?? createTxlineLiveScoreSource;
      const source = sourceFactory({
        apiToken: config.txlineApiToken!,
        fixtures: txlineFixtureContexts,
        onEvent: (event) => {
          runtime.acceptTxlineEvent(event);
        },
        onState: ({ state }) => {
          runtime.setSourceHealth(state === "replay" ? "live" : state, null);
        },
      });
      txlineTask = source.run(txlineAbort.signal).catch(() => {
        runtime.setSourceHealth(
          "error",
          "TxLINE live updates are temporarily unavailable",
        );
      });
    }
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    const application = app;
    if (application) {
      cleanupFailures.push(
        ...(await settleCleanupStage(
          [{ action: () => application.close(), label: "HTTP application" }],
          shutdownTimeoutMs,
        )),
      );
    } else {
      const runtimeToClose = productRuntime;
      if (runtimeToClose) {
        cleanupFailures.push(
          ...(await settleCleanupStage(
            [
              {
                action: () => runtimeToClose.close(),
                label: "product runtime",
              },
            ],
            shutdownTimeoutMs,
          )),
        );
      }
      cleanupFailures.push(
        ...(await settleCleanupStage(
          [{ action: () => databaseRuntime.close(), label: "database" }],
          shutdownTimeoutMs,
        )),
      );
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        "Server startup failed and cleanup was incomplete",
      );
    }
    throw error;
  }

  unregisterSignals = registerShutdownSignals(
    options.signalSource ?? process,
    async () => app!.close(),
    createShutdownFailureReporter({
      setExitCode: (code) => {
        process.exitCode = code;
      },
      writeError: (message) => process.stderr.write(message),
    }),
  );
  return app!;
}

const entryPath = process.argv[1];
const isDirectExecution =
  entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href;

if (isDirectExecution) {
  void startServer().catch(() => {
    process.stderr.write("MatchSense server failed to start\n");
    process.exitCode = 1;
  });
}
