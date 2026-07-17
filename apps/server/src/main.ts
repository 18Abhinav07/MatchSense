import path from "node:path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { createCommentaryPipeline } from "@matchsense/commentary";
import {
  createPostgresDatabase,
  type OutboxRepository,
  type PersistenceMode,
} from "@matchsense/db";
import type { TeamCode, TeamSummary } from "@matchsense/contracts";
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
  DEFAULT_TEAMS,
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

const WORLD_CUP_CATALOG_START_EPOCH_DAY = Math.floor(
  Date.UTC(2026, 5, 11) / 86_400_000,
);

const KNOWN_TEAMS_BY_NAME = new Map(
  DEFAULT_TEAMS.map((team) => [team.name.trim().toLowerCase(), team] as const),
);

function normalizedCodeBase(name: string) {
  const words = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .match(/[A-Z0-9]+/g);
  const compact = (words ?? []).join("");
  if (compact.length >= 3) return compact.slice(0, 3);
  return `${compact}XXX`.slice(0, 3);
}

function stableNumber(value: string) {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function deterministicColors(participantId: string) {
  const hue = stableNumber(participantId) % 360;
  return {
    primary: `hsl(${hue} 68% 36%)`,
    secondary: `hsl(${(hue + 47) % 360} 78% 72%)`,
  };
}

export function teamCatalogFromTxline(
  schedule: readonly TxlineScheduleFixture[],
): TeamSummary[] {
  const participants = new Map<
    string,
    { id: string; name: string; sourceTimestampMs: number }
  >();
  for (const fixture of schedule) {
    for (const participant of [fixture.participant1, fixture.participant2]) {
      const current = participants.get(participant.id);
      if (
        !current ||
        fixture.sourceTimestampMs > current.sourceTimestampMs ||
        (fixture.sourceTimestampMs === current.sourceTimestampMs &&
          participant.name.localeCompare(current.name) < 0)
      ) {
        participants.set(participant.id, {
          id: participant.id,
          name: participant.name,
          sourceTimestampMs: fixture.sourceTimestampMs,
        });
      }
    }
  }
  const entries = [...participants.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );
  const knownCodes = new Set(DEFAULT_TEAMS.map(({ code }) => code));
  const bases = new Map<string, number>();
  for (const participant of entries) {
    if (KNOWN_TEAMS_BY_NAME.has(participant.name.trim().toLowerCase()))
      continue;
    const base = normalizedCodeBase(participant.name);
    bases.set(base, (bases.get(base) ?? 0) + 1);
  }
  const catalog = entries.map((participant): TeamSummary => {
    const known = KNOWN_TEAMS_BY_NAME.get(
      participant.name.trim().toLowerCase(),
    );
    if (known) {
      return {
        ...known,
        colors: { ...known.colors },
        participantId: participant.id,
      };
    }
    const base = normalizedCodeBase(participant.name);
    const needsTieBreak = (bases.get(base) ?? 0) > 1 || knownCodes.has(base);
    const suffix = participant.id.replace(/[^A-Za-z0-9]/g, "").slice(-12);
    const code = needsTieBreak
      ? `${base}-${suffix || stableNumber(participant.id)}`
      : base;
    return {
      code,
      colors: deterministicColors(participant.id),
      name: participant.name,
      participantId: participant.id,
    };
  });
  return catalog.sort(
    (left, right) =>
      left.code.localeCompare(right.code) ||
      (left.participantId ?? "").localeCompare(right.participantId ?? ""),
  );
}

function teamForParticipant(
  participant: TxlineScheduleFixture["participant1"],
  catalog: readonly TeamSummary[],
) {
  return (
    catalog.find(({ participantId }) => participantId === participant.id) ??
    null
  );
}

export function productFixtureFromTxline(
  fixture: TxlineScheduleFixture,
  catalog: readonly TeamSummary[] = teamCatalogFromTxline([fixture]),
) {
  const participant1 = teamForParticipant(fixture.participant1, catalog);
  const participant2 = teamForParticipant(fixture.participant2, catalog);
  if (!participant1 || !participant2) {
    throw new Error("TxLINE fixture participant is missing from the catalog");
  }
  return {
    context: {
      fixtureId: fixture.fixtureId,
      participant1: fixture.participant1,
      participant1IsHome: fixture.participant1IsHome,
      participant2: fixture.participant2,
    } satisfies TxlineFixtureContext,
    product: {
      awayTeam: fixture.participant1IsHome
        ? participant2.code
        : participant1.code,
      fixtureId: fixture.fixtureId,
      homeTeam: fixture.participant1IsHome
        ? participant1.code
        : participant2.code,
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
    options?: { startEpochDay?: number | undefined },
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
  let txlineSourceDetail: string | null = null;
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
      let liveTeamCatalog: readonly TeamSummary[] | undefined;
      if (config.dataRightsMode === "txline_hackathon") {
        const authenticatedClient = options.txlineScheduleFetcher
          ? null
          : createTxlineAuthenticatedClient({
              apiToken: config.txlineApiToken!,
            });
        const scheduleFetcher =
          options.txlineScheduleFetcher ??
          ((_apiToken: string, fetchOptions?: { startEpochDay?: number }) =>
            fetchTxlineWorldCupSchedule(authenticatedClient!, fetchOptions));
        const currentEpochDay = Math.floor(Date.now() / 86_400_000);
        const [catalogResult, currentResult] = await Promise.allSettled([
          scheduleFetcher(config.txlineApiToken!, {
            startEpochDay: WORLD_CUP_CATALOG_START_EPOCH_DAY,
          }),
          scheduleFetcher(config.txlineApiToken!, {
            startEpochDay: currentEpochDay,
          }),
        ]);
        const catalogSchedule =
          catalogResult.status === "fulfilled" ? catalogResult.value : [];
        const currentSchedule =
          currentResult.status === "fulfilled" ? currentResult.value : [];
        const mergedSchedule = new Map<string, TxlineScheduleFixture>();
        for (const fixture of [...catalogSchedule, ...currentSchedule]) {
          const existing = mergedSchedule.get(fixture.fixtureId);
          if (
            !existing ||
            fixture.sourceTimestampMs >= existing.sourceTimestampMs
          ) {
            mergedSchedule.set(fixture.fixtureId, fixture);
          }
        }
        liveTeamCatalog = teamCatalogFromTxline([...mergedSchedule.values()]);
        if (currentResult.status === "fulfilled") {
          liveFixtures = currentSchedule.map((fixture) =>
            productFixtureFromTxline(fixture, liveTeamCatalog),
          );
          if (currentSchedule.length === 0) {
            txlineScheduleError =
              "No World Cup fixtures are currently available from TxLINE";
          } else if (catalogResult.status === "rejected") {
            txlineSourceDetail =
              "Tournament team catalog is temporarily limited to current fixtures";
          }
        } else {
          txlineScheduleError =
            catalogResult.status === "rejected"
              ? "TxLINE schedules are temporarily unavailable"
              : "TxLINE current fixture schedule is temporarily unavailable";
        }
      }
      const supportedLiveFixtures = liveFixtures;
      txlineFixtureContexts = supportedLiveFixtures.map(
        ({ context }) => context,
      );
      const teamNameByCode = new Map(
        (liveTeamCatalog ?? DEFAULT_TEAMS).map(({ code, name }) => [
          code,
          name,
        ]),
      );
      productRuntime = createProductRuntime({
        commentaryPipeline: createCommentaryPipeline({
          env: options.environment ?? process.env,
        }),
        cueBytes,
        ...(push
          ? {
              notifyMoment: async (moment, fixtureSnapshot) => {
                await deliverMomentPush(
                  {
                    body: `${teamNameByCode.get(moment.eventTeam) ?? moment.eventTeam} change the match. Tap to feel the Moment and hear the live call.`,
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
              ...(liveTeamCatalog ? { teamCatalog: liveTeamCatalog } : {}),
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
      } else if (txlineSourceDetail) {
        productRuntime.setSourceHealth("scheduled", txlineSourceDetail);
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
          runtime.setSourceHealth(
            state === "replay" ? "live" : state,
            txlineSourceDetail,
          );
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
