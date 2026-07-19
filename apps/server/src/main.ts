import { randomUUID } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";

import { createCommentaryPipeline } from "@matchsense/commentary";
import {
  createPostgresDatabase,
  type ExperienceRepository,
  type FanRepository,
  type FixtureReadRepository,
  type FixtureTruthRepository,
  type MemoryRepository,
  type OutboxRepository,
  type PersistenceMode,
  type PushDeviceRepository,
  type RoomAggregateRepository,
  type SourceFence,
  type SourceLeaseRecord,
  type SourceStateRepository,
} from "@matchsense/db";
import type {
  FixtureStreamEvent,
  TeamCode,
  TeamSummary,
} from "@matchsense/contracts";
import {
  createTxlineAuthenticatedClient,
  createTxlineLiveScoreSource,
  fetchTxlineWorldCupSchedule,
  type TxlineCanonicalEvent,
  type TxlineFixtureContext,
  type TxlineScheduleFixture,
} from "@matchsense/txline-adapter";
import type { FastifyInstance } from "fastify";

import { buildApp, type ReadinessProbe } from "./app.js";
import { transcodeWavToStreamMp3 } from "./audio-transcoder.js";
import { parseServerEnv } from "./config.js";
import { createDurablePushService } from "./durable-push.js";
import {
  createDurableRoomService,
  type DurableRoomAggregate,
} from "./durable-room-service.js";
import {
  createExperienceRuntime,
  type ExperienceRuntime,
} from "./experience-runtime.js";
import {
  createFixtureProcessor,
  restoreFixtureProjection,
} from "./fixture-processor.js";
import { createFanSessionService } from "./fan-session.js";
import { inspectMp3, resolveMp3WriteIntervalMs } from "./mp3.js";
import {
  createMatchMemoryService,
  type MatchMemoryPayload,
} from "./memory-service.js";
import { createOutboxWorker, type OutboxWorker } from "./outbox-worker.js";
import { deliverMomentPush } from "./push-delivery.js";
import { createPushSubscriptionCipher } from "./push-crypto.js";
import { InMemoryPushSubscriptionStore } from "./push-subscriptions.js";
import {
  DEFAULT_TEAMS,
  createProductRuntime,
  type ProductFixture,
  type ProductRuntime,
} from "./product-runtime.js";
import { productFactsFromTxlineEvent } from "./txline-product-facts.js";
import {
  createShutdownFailureReporter,
  registerShutdownSignals,
  type ShutdownSignalSource,
} from "./start.js";
import { createVapidWebPushSender } from "./web-push-sender.js";

// New production starts must resolve the role before loading either runtime.
// Keep this export for callers that historically imported the server surface
// from `main`, while `startServer` below remains an in-memory integration harness.
export { startByRole } from "./entry.js";

interface ServerDatabaseRuntime extends ReadinessProbe {
  close(): Promise<void>;
  experiences?: ExperienceRepository;
  fans?: FanRepository;
  fixtureReads?: Pick<FixtureReadRepository, "getFixture">;
  fixtureTruth?: FixtureTruthRepository;
  memories?: MemoryRepository<MatchMemoryPayload>;
  migrate(): Promise<unknown>;
  outbox: OutboxRepository;
  pushDevices?: PushDeviceRepository;
  rooms?: RoomAggregateRepository<DurableRoomAggregate>;
  sourceState?: SourceStateRepository;
}

const TXLINE_LEASE_DURATION_MS = 60_000;
const TXLINE_LEASE_RENEW_MS = 20_000;
const TXLINE_LEASE_RETRY_MS = 5_000;
const TXLINE_STREAM = {
  mode: "live" as const,
  source: "txline_live",
  streamKey: "world-cup-live-scores",
};

const WORLD_CUP_CATALOG_START_EPOCH_DAY = Math.floor(
  Date.UTC(2026, 5, 11) / 86_400_000,
);

function fixtureStreamEventsFrom(
  records: readonly { payload: unknown }[],
): FixtureStreamEvent[] {
  return records.flatMap(({ payload }) => {
    if (
      !payload ||
      typeof payload !== "object" ||
      typeof (payload as { event?: unknown }).event !== "string" ||
      typeof (payload as { id?: unknown }).id !== "string" ||
      !(payload as { snapshot?: unknown }).snapshot
    ) {
      return [];
    }
    return [payload as FixtureStreamEvent];
  });
}

const KNOWN_TEAMS_BY_NAME = new Map(
  DEFAULT_TEAMS.map((team) => [team.name.trim().toLowerCase(), team] as const),
);

const FIFA_CODE_BY_NAME = new Map<string, string>(
  Object.entries({
    Algeria: "ALG",
    Australia: "AUS",
    Austria: "AUT",
    Belgium: "BEL",
    Bolivia: "BOL",
    "Bosnia & Herzegovina": "BIH",
    Cameroon: "CMR",
    Canada: "CAN",
    "Cape Verde": "CPV",
    Chile: "CHI",
    Colombia: "COL",
    "Costa Rica": "CRC",
    "Cote d'Ivoire": "CIV",
    Croatia: "CRO",
    Curacao: "CUW",
    Curaçao: "CUW",
    Denmark: "DEN",
    "Democratic Republic of the Congo": "COD",
    "Congo DR": "COD",
    "DR Congo": "COD",
    Ecuador: "ECU",
    Egypt: "EGY",
    Finland: "FIN",
    Germany: "GER",
    Ghana: "GHA",
    Haiti: "HAI",
    Iceland: "ISL",
    Iran: "IRN",
    Iraq: "IRQ",
    "Ivory Coast": "CIV",
    Jamaica: "JAM",
    Jordan: "JOR",
    "Korea Republic": "KOR",
    Mexico: "MEX",
    Morocco: "MAR",
    Netherlands: "NED",
    "New Zealand": "NZL",
    Nigeria: "NGA",
    Norway: "NOR",
    Panama: "PAN",
    Paraguay: "PAR",
    Poland: "POL",
    Portugal: "POR",
    Qatar: "QAT",
    "Saudi Arabia": "KSA",
    Scotland: "SCO",
    Senegal: "SEN",
    Serbia: "SRB",
    "South Africa": "RSA",
    "South Korea": "KOR",
    Sweden: "SWE",
    Switzerland: "SUI",
    Tunisia: "TUN",
    Turkey: "TUR",
    Türkiye: "TUR",
    Ukraine: "UKR",
    "United States": "USA",
    USA: "USA",
    Uruguay: "URU",
    Uzbekistan: "UZB",
    Wales: "WAL",
  }).map(([name, code]) => [name.toLowerCase(), code]),
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
  const knownCodes = new Set([
    ...DEFAULT_TEAMS.map(({ code }) => code),
    ...FIFA_CODE_BY_NAME.values(),
  ]);
  const bases = new Map<string, number>();
  for (const participant of entries) {
    const name = participant.name.trim().toLowerCase();
    if (KNOWN_TEAMS_BY_NAME.has(name) || FIFA_CODE_BY_NAME.has(name)) continue;
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
    const fifaCode = FIFA_CODE_BY_NAME.get(
      participant.name.trim().toLowerCase(),
    );
    if (fifaCode) {
      return {
        code: fifaCode,
        colors: deterministicColors(participant.id),
        name: participant.name,
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
  experienceRuntime?: ExperienceRuntime;
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
  if (options.listen !== false) {
    throw new Error(
      "Legacy combined MatchSense server is test-only; use the role entrypoint",
    );
  }
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
  let experienceRuntime: ExperienceRuntime | undefined;
  let app: FastifyInstance | undefined;
  let outboxWorkers: OutboxWorker[] = [];
  let txlineAbort: AbortController | null = null;
  let txlineTask: Promise<void> | null = null;
  let txlineLease: SourceLeaseRecord | null = null;
  let txlineLeaseRenewal: ReturnType<typeof setInterval> | null = null;
  let txlineLeaseRetry: ReturnType<typeof setInterval> | null = null;
  let txlineFixtureContexts: readonly TxlineFixtureContext[] = [];
  let txlineProductFixtures = new Map<string, ProductFixture>();
  let txlineScheduleError: string | null = null;
  let txlineSourceDetail: string | null = null;
  let unregisterSignals: () => void = () => undefined;
  let closing = false;

  try {
    await databaseRuntime.migrate();
    const fanSessions = databaseRuntime.fans
      ? createFanSessionService({ repository: databaseRuntime.fans })
      : null;
    const pushSender = config.vapid
      ? createVapidWebPushSender(config.vapid)
      : null;
    const durablePushService =
      pushSender && databaseRuntime.fans && databaseRuntime.pushDevices
        ? createDurablePushService({
            cipher: createPushSubscriptionCipher({
              secret: config.pushSubscriptionEncryptionSecret!,
            }),
            devices: databaseRuntime.pushDevices,
            fans: databaseRuntime.fans,
            sender: pushSender,
          })
        : null;
    const push =
      config.vapid && pushSender && !durablePushService
        ? {
            applicationServerKey: config.vapid.publicKey,
            sender: pushSender,
            store: new InMemoryPushSubscriptionStore(),
          }
        : null;
    productRuntime = options.productRuntime;
    if (!productRuntime) {
      const cueBytes = await readFile(
        path.resolve(import.meta.dirname, "../assets/goal-cue.mp3"),
      );
      const streamContract = inspectMp3(cueBytes);
      const silenceBytes = await readFile(
        path.resolve(import.meta.dirname, "../assets/silence.mp3"),
      );
      let liveFixtures: ReturnType<typeof productFixtureFromTxline>[] = [];
      let currentLiveFixtureIds = new Set<string>();
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
        currentLiveFixtureIds = new Set(
          currentSchedule.map(({ fixtureId }) => fixtureId),
        );
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
          liveFixtures = [...mergedSchedule.values()]
            .sort(
              (left, right) =>
                left.startTimeMs - right.startTimeMs ||
                left.fixtureId.localeCompare(right.fixtureId),
            )
            .map((fixture) =>
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
      txlineProductFixtures = new Map(
        supportedLiveFixtures.map(({ product }) => [
          product.fixtureId,
          product,
        ]),
      );
      txlineFixtureContexts = supportedLiveFixtures
        .filter(({ product }) => currentLiveFixtureIds.has(product.fixtureId))
        .map(({ context }) => context);
      if (databaseRuntime.fixtureTruth) {
        const projectionReader = databaseRuntime.fixtureTruth as Partial<
          Pick<FixtureTruthRepository, "getLatestProjection">
        >;
        await Promise.all(
          supportedLiveFixtures.map(async ({ product }) => {
            // Never let a schedule refresh downgrade canonical match truth
            // (for example, full-time back to scheduled) after a restart.
            const existingProjection =
              typeof projectionReader.getLatestProjection === "function"
                ? await projectionReader.getLatestProjection({
                    fixtureId: product.fixtureId,
                    mode: "live",
                  })
                : null;
            if (existingProjection) return;
            await databaseRuntime.fixtureTruth!.upsert({
              awayTeamId: product.awayTeam,
              homeTeamId: product.homeTeam,
              id: product.fixtureId,
              metadata: { source: "txline_world_cup_schedule" },
              mode: "live",
              provenance: "live_txline",
              scheduledAt: product.kickoffAt,
              status: "scheduled",
            });
          }),
        );
      }
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
                const eventTeam = moment.eventTeam;
                const eventTeamLabel =
                  eventTeam === null
                    ? "MATCH"
                    : (teamNameByCode.get(eventTeam) ?? eventTeam);
                const input = {
                  body: `${eventTeamLabel} change the match. Tap to feel the Moment and hear the live call.`,
                  eventKind: "goal" as const,
                  fixtureId: moment.fixtureId,
                  momentId: moment.id,
                  occurredAt: fixtureSnapshot.updatedAt,
                  revision: moment.revision,
                  title: `⚽ GOAL — ${eventTeamLabel} ${moment.score.home}–${moment.score.away}, ${moment.minute}`,
                };
                await deliverMomentPush(input, push);
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
        silenceBytes,
        transcodeCommentary: (wavBytes) =>
          transcodeWavToStreamMp3(wavBytes, { expected: streamContract }),
        writeIntervalMs: resolveMp3WriteIntervalMs(inspectMp3(silenceBytes)),
      });
      const hydrationRepository = databaseRuntime.fixtureTruth as unknown as
        | Partial<
            Pick<FixtureTruthRepository, "eventsAfter" | "getLatestProjection">
          >
        | undefined;
      if (
        hydrationRepository &&
        typeof hydrationRepository.getLatestProjection === "function" &&
        typeof hydrationRepository.eventsAfter === "function"
      ) {
        const getLatestProjection =
          hydrationRepository.getLatestProjection.bind(hydrationRepository);
        const eventsAfter =
          hydrationRepository.eventsAfter.bind(hydrationRepository);
        await Promise.all(
          supportedLiveFixtures.map(async ({ product }) => {
            const [projectionRecord, eventRecords] = await Promise.all([
              getLatestProjection({
                fixtureId: product.fixtureId,
                mode: "live",
              }),
              eventsAfter({
                afterSequence: 0,
                fixtureId: product.fixtureId,
                limit: 1_000,
                mode: "live",
              }),
            ]);
            if (!projectionRecord) return;
            productRuntime!.registerFixture(product, {
              events: fixtureStreamEventsFrom(eventRecords),
              projection: restoreFixtureProjection({
                fixture: product,
                provenance: "live_txline",
                record: projectionRecord,
              }),
              public: true,
            });
          }),
        );
      }
      if (txlineScheduleError) {
        productRuntime.setSourceHealth("error", txlineScheduleError);
      } else if (txlineSourceDetail) {
        productRuntime.setSourceHealth("scheduled", txlineSourceDetail);
      }
    }
    const runtime = productRuntime;
    const liveFixtureProcessor = databaseRuntime.fixtureTruth
      ? createFixtureProcessor({ repository: databaseRuntime.fixtureTruth })
      : null;
    experienceRuntime =
      options.experienceRuntime ??
      (databaseRuntime.experiences && databaseRuntime.fixtureTruth
        ? createExperienceRuntime({
            countdownMs: 10_000,
            persistFixture: async (fixture) => {
              await databaseRuntime.fixtureTruth!.upsert({
                awayTeamId: fixture.awayTeam,
                homeTeamId: fixture.homeTeam,
                id: fixture.fixtureId,
                metadata: {
                  journey: "experience_match",
                  template: "five-minute-match",
                },
                mode: "demo",
                provenance: "synthetic_txline_shaped",
                scheduledAt: fixture.kickoffAt,
                status: "scheduled",
              });
            },
            processor: createFixtureProcessor({
              repository: databaseRuntime.fixtureTruth,
            }),
            productRuntime: runtime,
            recoverRun: async (run) => {
              const fixtureRecord = await databaseRuntime.fixtureTruth!.get({
                fixtureId: run.fixtureId,
                mode: "demo",
              });
              if (!fixtureRecord) return null;
              const fixture = {
                awayTeam: fixtureRecord.awayTeamId,
                fixtureId: fixtureRecord.id,
                homeTeam: fixtureRecord.homeTeamId,
                kickoffAt: fixtureRecord.scheduledAt,
                provenance: "synthetic_txline_shaped" as const,
              };
              const [projectionRecord, eventRecords] = await Promise.all([
                databaseRuntime.fixtureTruth!.getLatestProjection({
                  fixtureId: run.fixtureId,
                  mode: "demo",
                }),
                databaseRuntime.fixtureTruth!.eventsAfter({
                  afterSequence: 0,
                  fixtureId: run.fixtureId,
                  limit: 100,
                  mode: "demo",
                }),
              ]);
              const events = fixtureStreamEventsFrom(eventRecords);
              return {
                events,
                fixture,
                projection: projectionRecord
                  ? restoreFixtureProjection({
                      fixture,
                      provenance: "synthetic_txline_shaped",
                      record: projectionRecord,
                    })
                  : null,
              };
            },
            repository: databaseRuntime.experiences,
          })
        : undefined);
    const durableRoomService =
      databaseRuntime.rooms && fanSessions
        ? createDurableRoomService({
            fixture: (fixtureId) => runtime.fixture(fixtureId),
            followFixture: (input) => databaseRuntime.fans!.upsertFollow(input),
            repository:
              databaseRuntime.rooms as RoomAggregateRepository<DurableRoomAggregate>,
            ...(experienceRuntime
              ? {
                  startFixture: async ({ fixture, ownerFanId }) => {
                    const runId = fixture.fixtureId.startsWith("experience:")
                      ? fixture.fixtureId.slice("experience:".length)
                      : "";
                    if (!runId) {
                      throw new Error("Experience fixture id is invalid");
                    }
                    const run = await experienceRuntime!.startRun({
                      awayTeam: fixture.awayTeam,
                      homeTeam: fixture.homeTeam,
                      ownerFanId,
                      runId,
                    });
                    const startedFixture = runtime.fixture(run.fixtureId);
                    if (!startedFixture) {
                      throw new Error("Started Experience fixture is missing");
                    }
                    return startedFixture;
                  },
                }
              : {}),
          })
        : null;
    const memoryService =
      databaseRuntime.experiences &&
      databaseRuntime.fans &&
      databaseRuntime.fixtureTruth &&
      databaseRuntime.memories &&
      fanSessions
        ? createMatchMemoryService({
            experiences: databaseRuntime.experiences,
            fans: databaseRuntime.fans,
            fixtureTruth: databaseRuntime.fixtureTruth,
            memories:
              databaseRuntime.memories as MemoryRepository<MatchMemoryPayload>,
          })
        : null;
    const persistedEvent = (payload: unknown) => {
      if (!payload || typeof payload !== "object") return null;
      const value = payload as {
        celebratesGoal?: unknown;
        event?: unknown;
      };
      const event = value.event;
      if (
        !event ||
        typeof event !== "object" ||
        typeof (event as { id?: unknown }).id !== "string" ||
        !(event as { snapshot?: unknown }).snapshot
      ) {
        return null;
      }
      return {
        celebratesGoal: value.celebratesGoal === true,
        event: event as FixtureStreamEvent,
      };
    };
    const publishPersisted = (
      persisted: NonNullable<ReturnType<typeof persistedEvent>>,
    ) => {
      runtime.publishPersistedEvent(persisted.event, persisted);
    };
    const workerFactory =
      options.outboxWorkerFactory ??
      ((mode: PersistenceMode) =>
        createOutboxWorker({
          batchSize: 50,
          consumer: "product",
          handlers: {
            "commentary.prepare": async (message) => {
              const persisted = persistedEvent(message.payload);
              if (persisted) publishPersisted(persisted);
            },
            "fixture.broadcast": async (message) => {
              const persisted = persistedEvent(message.payload);
              if (persisted) publishPersisted(persisted);
            },
            "fixture.reconcile": async (message) => {
              const persisted = persistedEvent(message.payload);
              if (persisted) publishPersisted(persisted);
            },
            ...(memoryService
              ? {
                  "memory.project": async (message) => {
                    const persisted = persistedEvent(message.payload);
                    if (!persisted) return;
                    await memoryService.projectFixture({
                      fixtureId: persisted.event.snapshot.fixtureId,
                      mode,
                    });
                  },
                  "memory.reconcile": async (message) => {
                    const persisted = persistedEvent(message.payload);
                    if (!persisted) return;
                    await memoryService.projectFixture({
                      fixtureId: persisted.event.snapshot.fixtureId,
                      mode,
                    });
                  },
                }
              : {}),
            ...(durableRoomService
              ? {
                  "room.project": async (message) => {
                    const persisted = persistedEvent(message.payload);
                    if (persisted) {
                      await durableRoomService.projectFixture(
                        persisted.event.snapshot,
                      );
                    }
                  },
                  "room.reconcile": async (message) => {
                    const persisted = persistedEvent(message.payload);
                    if (persisted) {
                      await durableRoomService.projectFixture(
                        persisted.event.snapshot,
                      );
                    }
                  },
                }
              : {}),
            ...(durablePushService
              ? {
                  "push.candidate": async (message) => {
                    const persisted = persistedEvent(message.payload);
                    const moment = persisted?.event.moment;
                    if (!persisted || !moment) return;
                    const eventKind = moment.celebratesGoal
                      ? ("goal" as const)
                      : moment.kind === "card.red"
                        ? ("card.red" as const)
                        : moment.kind === "phase.full_time"
                          ? ("phase.full_time" as const)
                          : null;
                    if (!eventKind) return;
                    const team = moment.eventTeam ?? "MATCH";
                    const title =
                      eventKind === "goal"
                        ? `⚽ GOAL — ${team} ${moment.score.home}–${moment.score.away}, ${moment.minute}`
                        : eventKind === "card.red"
                          ? `🟥 RED CARD — ${team}, ${moment.minute}`
                          : `FULL TIME — ${moment.score.home}–${moment.score.away}`;
                    const body =
                      eventKind === "phase.full_time"
                        ? "The result is final. Tap for your Match Memory."
                        : `${team} change the match. Tap to feel the Moment and hear the live call.`;
                    await durablePushService.deliverToFixture(
                      {
                        body,
                        eventKind,
                        fixtureId: moment.fixtureId,
                        momentId: moment.id,
                        occurredAt: persisted.event.snapshot.updatedAt,
                        revision: moment.revision,
                        title,
                      },
                      mode,
                    );
                  },
                }
              : {}),
          },
          mode,
          outbox: databaseRuntime.outbox,
          pollIntervalMs: 250,
        }));
    outboxWorkers = options.outboxWorker
      ? [options.outboxWorker]
      : (["live", "demo"] as const).map(workerFactory);
    app = buildApp({
      ...(durablePushService && config.vapid && fanSessions
        ? {
            durablePush: {
              applicationServerKey: config.vapid.publicKey,
              service: durablePushService,
              sessions: fanSessions,
            },
          }
        : {}),
      ...(push ? { push } : {}),
      ...(durableRoomService && fanSessions
        ? {
            durableRooms: {
              ...(experienceRuntime
                ? {
                    prepareExperienceRoom: async (input: {
                      awayTeam: string;
                      fanId: string;
                      homeTeam: string;
                      name: string;
                      nickname: string;
                    }) => {
                      const prepared = await experienceRuntime!.prepareFixture({
                        awayTeam: input.awayTeam,
                        homeTeam: input.homeTeam,
                        ownerFanId: input.fanId,
                      });
                      const created = await durableRoomService.create({
                        fixtureId: prepared.fixture.fixtureId,
                        host: {
                          fanId: input.fanId,
                          nickname: input.nickname,
                          teamCode: input.homeTeam,
                        },
                        name: input.name,
                      });
                      return {
                        ...created,
                        fixtureId: prepared.fixture.fixtureId,
                        runId: prepared.runId,
                      };
                    },
                  }
                : {}),
              service: durableRoomService,
              sessions: fanSessions,
            },
          }
        : {}),
      ...(experienceRuntime ? { experience: experienceRuntime } : {}),
      ...(databaseRuntime.fans && databaseRuntime.fixtureReads && fanSessions
        ? {
            fan: {
              fixtureReads: databaseRuntime.fixtureReads,
              repository: databaseRuntime.fans,
              sessions: fanSessions,
            },
          }
        : {}),
      ...(memoryService && fanSessions
        ? { memory: { service: memoryService, sessions: fanSessions } }
        : {}),
      manageRuntimeLifecycle: false,
      readinessProbe: options.readinessProbe ?? databaseRuntime,
      runtime,
      webDistPath,
    });
    app.addHook("onClose", async () => {
      closing = true;
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
      if (txlineLeaseRenewal) {
        clearInterval(txlineLeaseRenewal);
        txlineLeaseRenewal = null;
      }
      if (txlineLeaseRetry) {
        clearInterval(txlineLeaseRetry);
        txlineLeaseRetry = null;
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
          [
            { action: () => runtime.close(), label: "product runtime" },
            ...(txlineLease && databaseRuntime.sourceState
              ? [
                  {
                    action: () =>
                      databaseRuntime.sourceState!.releaseLease({
                        fencingToken: txlineLease!.fencingToken,
                        holderId: txlineLease!.holderId,
                        ...TXLINE_STREAM,
                      }),
                    label: "TxLINE source lease",
                  },
                ]
              : []),
          ],
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
    await experienceRuntime?.start();
    if (
      config.dataRightsMode === "txline_hackathon" &&
      (txlineFixtureContexts.length > 0 || options.productRuntime !== undefined)
    ) {
      const sourceFactory =
        options.txlineSourceFactory ?? createTxlineLiveScoreSource;
      const startSource = () => {
        if (closing || txlineTask || txlineAbort) return;
        txlineAbort = new AbortController();
        const source = sourceFactory({
          apiToken: config.txlineApiToken!,
          fixtures: txlineFixtureContexts,
          onEvent: async (event: TxlineCanonicalEvent) => {
            const fixture = txlineProductFixtures.get(event.fixtureId);
            const current = runtime.fixture(event.fixtureId);
            if (liveFixtureProcessor && fixture && current) {
              const sourceFence: SourceFence | undefined = txlineLease
                ? {
                    fencingToken: txlineLease.fencingToken,
                    holderId: txlineLease.holderId,
                    source: TXLINE_STREAM.source,
                    streamKey: TXLINE_STREAM.streamKey,
                  }
                : undefined;
              const facts = productFactsFromTxlineEvent(
                event,
                fixture,
                current,
              );
              for (const [index, fact] of facts.entries()) {
                const persisted = await liveFixtureProcessor.process({
                  deliveryIntent:
                    event.delivery === "reconciliation"
                      ? "reconcile"
                      : "realtime",
                  fact,
                  fixture,
                  mode: "live",
                  ...(sourceFence ? { sourceFence } : {}),
                  raw: {
                    dedupeKey: fact.sourceEnvelopeId,
                    id: fact.sourceEnvelopeId,
                    payload: event,
                    payloadHash: event.source.payloadHash,
                    receivedAt: event.receivedAt,
                    source: "txline_live",
                    sourceRecordId:
                      event.actionId ?? event.source.actionId ?? null,
                    sourceSequence: `${event.source.observedSeq ?? event.revision}:${index}`,
                  },
                });
                if (persisted.kind === "fenced") {
                  throw new Error("TxLINE fixture persistence was fenced");
                }
                if (persisted.kind === "committed") {
                  if (!persisted.event) {
                    throw new Error("Committed TxLINE event is unavailable");
                  }
                  runtime.publishPersistedEvent(persisted.event, {
                    celebratesGoal:
                      persisted.event.moment?.celebratesGoal === true,
                  });
                }
              }
            }
          },
          onState: ({ state }) => {
            runtime.setSourceHealth(
              state === "replay" ? "live" : state,
              txlineSourceDetail,
            );
          },
        });
        const sourceSignal = txlineAbort.signal;
        txlineTask = source
          .run(sourceSignal)
          .catch(() => {
            if (!sourceSignal.aborted) {
              runtime.setSourceHealth(
                "error",
                "TxLINE live updates are temporarily unavailable",
              );
            }
          })
          .finally(() => {
            txlineTask = null;
            txlineAbort = null;
          });
      };

      const sourceState = databaseRuntime.sourceState;
      const leaseHolderId = `matchsense:${randomUUID()}`;
      let leaseAttemptInFlight = false;
      const acquireLeaseAndStart = async () => {
        if (closing || leaseAttemptInFlight || txlineLease) {
          if (txlineLease && !txlineTask) startSource();
          return;
        }
        if (!sourceState) {
          startSource();
          return;
        }
        leaseAttemptInFlight = true;
        try {
          txlineLease = await sourceState.acquireLease({
            holderId: leaseHolderId,
            leaseUntil: new Date(
              Date.now() + TXLINE_LEASE_DURATION_MS,
            ).toISOString(),
            ...TXLINE_STREAM,
          });
          if (txlineLease) {
            startSource();
          } else {
            runtime.setSourceHealth(
              "reconnecting",
              "Another healthy MatchSense instance currently owns the TxLINE stream",
            );
          }
        } finally {
          leaseAttemptInFlight = false;
        }
      };

      if (sourceState) {
        let renewalInFlight = false;
        txlineLeaseRenewal = setInterval(() => {
          if (closing || renewalInFlight || !txlineLease) return;
          renewalInFlight = true;
          void sourceState
            .renewLease({
              fencingToken: txlineLease.fencingToken,
              holderId: txlineLease.holderId,
              leaseUntil: new Date(
                Date.now() + TXLINE_LEASE_DURATION_MS,
              ).toISOString(),
              ...TXLINE_STREAM,
            })
            .then((renewed) => {
              if (renewed) {
                txlineLease = renewed;
                return;
              }
              txlineLease = null;
              txlineAbort?.abort();
              runtime.setSourceHealth(
                "reconnecting",
                "TxLINE stream ownership changed; reconnecting safely",
              );
            })
            .catch(() => {
              txlineLease = null;
              txlineAbort?.abort();
              runtime.setSourceHealth(
                "error",
                "TxLINE stream lease renewal failed",
              );
            })
            .finally(() => {
              renewalInFlight = false;
            });
        }, TXLINE_LEASE_RENEW_MS);
        txlineLeaseRenewal.unref?.();
      }

      await acquireLeaseAndStart().catch(() => {
        runtime.setSourceHealth(
          "error",
          "TxLINE stream ownership is temporarily unavailable",
        );
      });
      txlineLeaseRetry = setInterval(() => {
        if (!txlineLease || !txlineTask) {
          void acquireLeaseAndStart().catch(() => {
            runtime.setSourceHealth(
              "error",
              "TxLINE stream ownership is temporarily unavailable",
            );
          });
        }
      }, TXLINE_LEASE_RETRY_MS);
      txlineLeaseRetry.unref?.();
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
