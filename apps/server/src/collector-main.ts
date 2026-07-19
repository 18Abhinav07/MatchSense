import { randomUUID } from "node:crypto";

import { createCommentaryPipeline } from "@matchsense/commentary";
import {
  createPostgresDatabase,
  type ApplicationDatabase,
  type MemoryRepository,
  type OutboxRepository,
  type RoomAggregateRepository,
  type SourceLeaseRecord,
} from "@matchsense/db";
import type { FixtureSnapshot } from "@matchsense/contracts";
import {
  createTxlineAuthenticatedClient,
  createTxlineRawScoreSource,
  fetchTxlineWorldCupSchedule,
  type TxlineAuthenticatedClient,
  type TxlineScheduleFixture,
} from "@matchsense/txline-adapter";

import type { ServerConfig } from "./config.js";
import {
  createCommentaryJobWorker,
  createPipelineCommentaryGenerator,
  type CommentaryJobWorker,
} from "./commentary-job-worker.js";
import {
  createArchiveImportPoller,
  type ArchiveImportPoller,
} from "./collector/archive-import-poller.js";
import {
  createArchiveImportRunner,
  type ArchiveImportRunner,
  type ArchiveImportRunnerOptions,
} from "./collector/archive-import-runner.js";
import { createArchiveService } from "./collector/archive-service.js";
import {
  createScheduleSync,
  durableCollectorFixtureFromSchedule,
  durableTeamCatalogFromSchedule,
} from "./collector/schedule-sync.js";
import { createTxlineCollector } from "./collector/txline-collector.js";
import { transcodeWavToStreamMp3 } from "./audio-transcoder.js";
import {
  createDurablePushService,
  pushInputFromRealtimeMoment,
  type DurablePushService,
} from "./durable-push.js";
import {
  createDurableRoomService,
  type DurableRoomAggregate,
  type DurableRoomService,
} from "./durable-room-service.js";
import { createExperienceDelivery } from "./experience-delivery.js";
import {
  experienceRoomFanIdsForRun,
  type ExperienceRoomAggregate,
} from "./experience-room-service.js";
import { type Mp3Contract } from "./mp3.js";
import {
  createMatchMemoryService,
  type MatchMemoryPayload,
  type MatchMemoryService,
} from "./memory-service.js";
import {
  createOutboxWorker,
  type OutboxHandler,
  type OutboxWorker,
} from "./outbox-worker.js";
import { createPushSubscriptionCipher } from "./push-crypto.js";
import {
  createShutdownFailureReporter,
  registerShutdownSignals,
  type ShutdownSignalSource,
} from "./start.js";
import { createVapidWebPushSender } from "./web-push-sender.js";

export type CollectorDatabaseRuntime = Pick<
  ApplicationDatabase,
  | "archive"
  | "archiveImportJobs"
  | "close"
  | "commentaryJobs"
  | "experiences"
  | "fans"
  | "fixtureTruth"
  | "migrate"
  | "memories"
  | "outbox"
  | "pushDevices"
  | "rooms"
  | "sourceState"
  | "teamCatalog"
>;

export interface CollectorSourceLifecycle {
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
}

export interface StartCollectorOptions {
  archiveImportPoller?: ArchiveImportPoller;
  archiveImportPollerFactory?: (
    runner: ArchiveImportRunner,
  ) => ArchiveImportPoller;
  archiveImportRunnerFactory?: (
    options: ArchiveImportRunnerOptions,
  ) => ArchiveImportRunner;
  commentaryWorker?: CommentaryJobWorker;
  databaseFactory?: (databaseUrl: string) => CollectorDatabaseRuntime;
  databaseRuntime?: CollectorDatabaseRuntime;
  experienceOutboxWorker?: OutboxWorker;
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
const LEASE_ACQUIRE_RETRY_MS = 1_000;
const SCHEDULE_REFRESH_INTERVAL_MS = 60_000;
const FINISHED_FIXTURE_RECOVERY_WINDOW_MS = 24 * 60 * 60 * 1_000;
const HACKATHON_RIGHTS_GRANT_ID = "txline-world-cup-hackathon-2026";
const processCollectorWorkerId = `collector:${randomUUID()}`;
const WORLD_CUP_CATALOG_START_EPOCH_DAY = Math.floor(
  Date.UTC(2026, 5, 11) / 86_400_000,
);
const COMMENTARY_MP3_CONTRACT: Mp3Contract = {
  bitrateKbps: 48,
  byteLength: 0,
  channels: 1,
  durationMs: 0,
  frameCount: 0,
  layer: 3,
  sampleRateHz: 24_000,
  samplesPerFrame: 576,
  version: 2,
};

function newestScheduleFixtures(fixtures: readonly TxlineScheduleFixture[]) {
  const merged = new Map<string, TxlineScheduleFixture>();
  for (const fixture of fixtures) {
    const existing = merged.get(fixture.fixtureId);
    if (!existing || fixture.sourceTimestampMs > existing.sourceTimestampMs) {
      merged.set(fixture.fixtureId, fixture);
    }
  }
  return [...merged.values()].sort(
    (left, right) =>
      left.startTimeMs - right.startTimeMs ||
      left.fixtureId.localeCompare(right.fixtureId),
  );
}

async function fetchTournamentSchedule(client: TxlineAuthenticatedClient) {
  const now = Date.now();
  const currentEpochDay = Math.floor(now / 86_400_000);
  const [catalogue, current] = await Promise.allSettled([
    fetchTxlineWorldCupSchedule(client, {
      startEpochDay: WORLD_CUP_CATALOG_START_EPOCH_DAY,
    }),
    fetchTxlineWorldCupSchedule(client, { startEpochDay: currentEpochDay }),
  ]);
  if (current.status === "rejected") throw current.reason;
  const catalogueFixtures =
    catalogue.status === "fulfilled" ? catalogue.value : null;
  const recentlyFinished = (catalogueFixtures ?? []).filter(
    (fixture) =>
      fixture.gameState === 3 &&
      fixture.startTimeMs <= now &&
      fixture.startTimeMs >= now - FINISHED_FIXTURE_RECOVERY_WINDOW_MS,
  );
  return {
    catalogue: catalogueFixtures,
    current: newestScheduleFixtures([...recentlyFinished, ...current.value]),
  };
}

export interface CollectorOutboxEffects {
  commentary?: Pick<CommentaryJobWorker, "handleOutbox">;
  experience?: { deliver(payload: unknown): Promise<unknown> };
  memory?: Pick<MatchMemoryService, "projectFixture">;
  push?: Pick<DurablePushService, "deliverToFixture">;
  rooms?: Pick<DurableRoomService, "projectFixture">;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonemptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function roomFixtureFromRealtimePayload(
  payload: unknown,
): FixtureSnapshot | null {
  const envelope = object(payload);
  const event = object(envelope?.event);
  const snapshot = object(event?.snapshot);
  const score = object(snapshot?.score);
  if (
    envelope?.mode !== "live" ||
    envelope.deliveryIntent !== "realtime" ||
    snapshot?.provenance !== "live_txline" ||
    !nonemptyString(snapshot.fixtureId) ||
    !nonemptyString(snapshot.homeTeam) ||
    !nonemptyString(snapshot.awayTeam) ||
    !nonemptyString(snapshot.kickoffAt) ||
    !nonemptyString(snapshot.minute) ||
    !nonemptyString(snapshot.phase) ||
    !nonemptyString(snapshot.updatedAt) ||
    nonnegativeInteger(snapshot.revision) === null ||
    nonnegativeInteger(score?.home) === null ||
    nonnegativeInteger(score?.away) === null
  ) {
    return null;
  }
  return snapshot as unknown as FixtureSnapshot;
}

function memoryFixtureIdFromRealtimePayload(payload: unknown): string | null {
  const fixture = roomFixtureFromRealtimePayload(payload);
  return fixture?.phase === "full_time" ? fixture.fixtureId : null;
}

/**
 * The collector is the only process allowed to turn a committed source event
 * into external work. These handlers defend the source boundary again so an
 * archived/reconciliation row cannot become audible or visible to a fan.
 */
export function createCollectorOutboxHandlers(
  effects: CollectorOutboxEffects,
): Readonly<Record<string, OutboxHandler>> {
  const handlers: Record<string, OutboxHandler> = {};
  if (effects.commentary) {
    handlers["fixture.broadcast"] = async (message) => {
      await effects.commentary?.handleOutbox(message);
    };
    handlers["commentary.prepare"] = async (message) => {
      await effects.commentary?.handleOutbox(message);
    };
  }
  if (effects.push || effects.experience) {
    handlers["push.candidate"] = async (message) => {
      if (message.mode === "demo") {
        await effects.experience?.deliver(message.payload);
        return;
      }
      if (message.mode === "live") {
        const candidate = pushInputFromRealtimeMoment(message.payload);
        if (!candidate) return;
        await effects.push?.deliverToFixture(candidate, "live");
      }
    };
  }
  if (effects.rooms) {
    handlers["room.project"] = async (message) => {
      if (message.mode !== "live") return;
      const fixture = roomFixtureFromRealtimePayload(message.payload);
      if (!fixture) return;
      await effects.rooms?.projectFixture(fixture);
    };
  }
  if (effects.memory) {
    handlers["memory.project"] = async (message) => {
      if (message.mode !== "live") return;
      const fixtureId = memoryFixtureIdFromRealtimePayload(message.payload);
      if (!fixtureId) return;
      await effects.memory?.projectFixture({ fixtureId, mode: "live" });
    };
  }
  return handlers;
}

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

async function establishCollectorRights(
  database: Pick<CollectorDatabaseRuntime, "archive">,
) {
  await database.archive.ensureRightsGrant({
    active: true,
    id: HACKATHON_RIGHTS_GRANT_ID,
    reference: "TxLINE World Cup Hackathon 2026",
    scopes: ["audio", "raw_retention", "replay"],
  });
}

/**
 * The deployed worker's real TxLINE lifecycle. It acquires the only source
 * lease, writes schedule observations, then keeps raw SSE ownership isolated
 * from the API process. All stream cursor movement is delegated to the
 * collector frame transaction.
 */
export function createDurableCollectorLifecycle(input: {
  database: CollectorDatabaseRuntime;
  scheduleRefreshIntervalMs?: number;
  txlineClient: TxlineAuthenticatedClient;
}): CollectorSourceLifecycle {
  const holderId = `collector:${randomUUID()}`;
  const scheduleRefreshIntervalMs =
    input.scheduleRefreshIntervalMs ?? SCHEDULE_REFRESH_INTERVAL_MS;
  if (
    !Number.isSafeInteger(scheduleRefreshIntervalMs) ||
    scheduleRefreshIntervalMs < 50 ||
    scheduleRefreshIntervalMs > 300_000
  ) {
    throw new Error("Collector schedule refresh interval is invalid");
  }

  let activeLease: SourceLeaseRecord | null = null;
  let liveConfiguration: string | null = null;
  let liveController: AbortController | null = null;
  let refreshTask: Promise<void> | null = null;
  let renewTimer: ReturnType<typeof setInterval> | null = null;
  let scheduleRefreshTimer: ReturnType<typeof setInterval> | null = null;
  let sourceTask: Promise<void> | null = null;
  let started = false;
  let stopping = false;
  let lifecycleGeneration = 0;
  let renewalTask: Promise<void> | null = null;

  const stopLiveSource = async () => {
    const controller = liveController;
    const task = sourceTask;
    controller?.abort();
    if (task) await task.catch(() => undefined);
    if (sourceTask === task) {
      sourceTask = null;
      liveController = null;
      liveConfiguration = null;
    }
  };

  const configurationFor = (fixtures: readonly TxlineScheduleFixture[]) =>
    fixtures
      .map((fixture) =>
        [
          fixture.fixtureId,
          fixture.participant1.id,
          fixture.participant2.id,
          fixture.participant1IsHome ? "home" : "away",
          fixture.startTimeMs,
          fixture.gameState,
        ].join(":"),
      )
      .join("|");

  const startLiveSource = (
    schedule: readonly TxlineScheduleFixture[],
    fence: ReturnType<typeof sourceFence>,
    configuration: string,
  ) => {
    const fixtures = new Map(
      schedule.map((fixture) => [
        fixture.fixtureId,
        durableCollectorFixtureFromSchedule(fixture),
      ]),
    );
    const collector = createTxlineCollector({
      fixtureForId: (fixtureId) => fixtures.get(fixtureId) ?? null,
      fixtureTruth: input.database.fixtureTruth,
      rightsGrantId: HACKATHON_RIGHTS_GRANT_ID,
      sourceFence: fence,
    });
    const source = createTxlineRawScoreSource({
      client: input.txlineClient,
      fixtureIds: schedule.map(({ fixtureId }) => fixtureId),
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
      onState: ({ attempt, state }) => {
        process.stderr.write(
          `TxLINE collector source state=${state} attempt=${attempt}\n`,
        );
      },
      onWarning: (warning) => {
        process.stderr.write(
          `TxLINE collector ${warning.code}: ${warning.message}\n`,
        );
      },
    });
    const controller = new AbortController();
    const task = source.run(controller.signal);
    liveConfiguration = configuration;
    liveController = controller;
    sourceTask = task;
    void task.then(
      () => {
        if (sourceTask !== task) return;
        sourceTask = null;
        liveController = null;
        liveConfiguration = null;
      },
      (error: unknown) => {
        process.stderr.write(
          `TxLINE collector stopped: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
        if (sourceTask !== task) return;
        sourceTask = null;
        liveController = null;
        liveConfiguration = null;
      },
    );
  };

  const refreshSchedule = async () => {
    if (refreshTask) return refreshTask;
    const task = (async () => {
      const schedule = await fetchTournamentSchedule(input.txlineClient);
      process.stderr.write(
        `TxLINE collector schedule current=${schedule.current.length} catalogue=${schedule.catalogue?.length ?? 0}\n`,
      );
      const lease = activeLease;
      if (stopping || !lease) return;
      if (schedule.catalogue && schedule.catalogue.length > 0) {
        await input.database.teamCatalog.upsert(
          durableTeamCatalogFromSchedule([
            ...schedule.catalogue,
            ...schedule.current,
          ]),
        );
      } else if ((await input.database.teamCatalog.list()).length === 0) {
        throw new Error(
          "TxLINE tournament roster is unavailable and durable roster is empty",
        );
      } else {
        process.stderr.write(
          "TxLINE tournament roster refresh unavailable; using durable roster\n",
        );
      }
      if (stopping || !activeLease) return;
      if (schedule.current.length === 0) {
        await stopLiveSource();
        return;
      }
      const fence = sourceFence(activeLease);
      await createScheduleSync({
        repository: input.database.fixtureTruth,
        rightsGrantId: HACKATHON_RIGHTS_GRANT_ID,
        sourceFence: fence,
      }).sync(schedule.current);
      if (stopping || !activeLease) return;
      const configuration = configurationFor(schedule.current);
      if (sourceTask && liveConfiguration === configuration) return;
      await stopLiveSource();
      if (stopping || !activeLease) return;
      startLiveSource(
        schedule.current,
        sourceFence(activeLease),
        configuration,
      );
    })();
    refreshTask = task;
    try {
      await task;
    } finally {
      if (refreshTask === task) refreshTask = null;
    }
  };

  const stop = async () => {
    stopping = true;
    started = false;
    lifecycleGeneration += 1;
    renewalTask = null;
    if (scheduleRefreshTimer) {
      clearInterval(scheduleRefreshTimer);
      scheduleRefreshTimer = null;
    }
    if (renewTimer) {
      clearInterval(renewTimer);
      renewTimer = null;
    }
    await refreshTask?.catch(() => undefined);
    await stopLiveSource();
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

  const stopAfterFenceLoss = () => {
    void stop().catch((error: unknown) => {
      process.stderr.write(
        `TxLINE collector fence shutdown failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    });
  };

  const renewActiveLease = () => {
    const current = activeLease;
    if (stopping || !current || renewalTask) return;
    const generation = lifecycleGeneration;
    const task = (async () => {
      try {
        const renewed = await input.database.sourceState.renewLease({
          fencingToken: current.fencingToken,
          holderId: current.holderId,
          leaseUntil: leaseUntil(),
          mode: current.mode,
          source: current.source,
          streamKey: current.streamKey,
        });
        if (
          stopping ||
          generation !== lifecycleGeneration ||
          activeLease !== current
        ) {
          return;
        }
        if (!renewed) stopAfterFenceLoss();
        else activeLease = renewed;
      } catch {
        if (
          stopping ||
          generation !== lifecycleGeneration ||
          activeLease !== current
        ) {
          return;
        }
        stopAfterFenceLoss();
      }
    })();
    renewalTask = task;
    void task.finally(() => {
      if (renewalTask === task) renewalTask = null;
    });
  };

  return {
    async start() {
      if (started) return;
      started = true;
      stopping = false;
      const generation = ++lifecycleGeneration;
      let lease: SourceLeaseRecord | null = null;
      try {
        while (!stopping && generation === lifecycleGeneration && !lease) {
          lease = await input.database.sourceState.acquireLease({
            holderId,
            leaseUntil: leaseUntil(),
            mode: "live",
            source: STREAM_SOURCE,
            streamKey: STREAM_KEY,
          });
          if (!lease) {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, LEASE_ACQUIRE_RETRY_MS);
            });
          }
        }
      } catch (error) {
        if (generation === lifecycleGeneration) started = false;
        throw error;
      }
      if (!lease) {
        if (generation === lifecycleGeneration) started = false;
        return;
      }
      if (stopping || generation !== lifecycleGeneration) {
        await input.database.sourceState.releaseLease({
          fencingToken: lease.fencingToken,
          holderId: lease.holderId,
          mode: lease.mode,
          source: lease.source,
          streamKey: lease.streamKey,
        });
        return;
      }
      activeLease = lease;
      process.stderr.write("TxLINE collector source lease acquired\n");
      renewTimer = setInterval(renewActiveLease, LEASE_RENEWAL_MS);
      try {
        await refreshSchedule();
        if (stopping) return;
        scheduleRefreshTimer = setInterval(() => {
          void refreshSchedule().catch((error: unknown) => {
            process.stderr.write(
              `TxLINE schedule refresh failed: ${
                error instanceof Error ? error.message : String(error)
              }\n`,
            );
          });
        }, scheduleRefreshIntervalMs);
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
    config.dataRightsMode !== "txline_hackathon"
  ) {
    throw new Error("Collector runtime requires ROLE=worker");
  }
}

export async function startCollector(
  config: ServerConfig,
  options: StartCollectorOptions = {},
): Promise<{ close(): Promise<void> }> {
  assertCollectorRole(config);
  const txlineApiToken = config.txlineApiToken;
  const databaseRuntime =
    options.databaseRuntime ??
    (options.databaseFactory ?? createPostgresDatabase)(config.databaseUrl);
  let closed = false;
  let unregisterSignals: () => void = () => undefined;
  let outboxWorker: OutboxWorker | null = null;
  let experienceOutboxWorker: OutboxWorker | null = null;
  let commentaryWorker: CommentaryJobWorker | null = null;
  let archiveImportPoller: ArchiveImportPoller | null = null;
  let sourceLifecycle: CollectorSourceLifecycle | null = null;
  let archiveImportPollerStarted = false;
  let sourceStarted = false;

  const close = async () => {
    if (closed) return;
    closed = true;
    unregisterSignals();
    if (archiveImportPollerStarted) await archiveImportPoller?.stop();
    if (sourceStarted) await sourceLifecycle?.stop();
    await outboxWorker?.stop();
    await experienceOutboxWorker?.stop();
    await commentaryWorker?.stop();
    await databaseRuntime.close();
  };

  try {
    await databaseRuntime.migrate();
    commentaryWorker =
      options.commentaryWorker ??
      (databaseRuntime.commentaryJobs && databaseRuntime.fixtureTruth
        ? createCommentaryJobWorker({
            generator: createPipelineCommentaryGenerator({
              pipeline: createCommentaryPipeline({ env: process.env }),
              transcode: (wavBytes) =>
                transcodeWavToStreamMp3(wavBytes, {
                  expected: COMMENTARY_MP3_CONTRACT,
                }),
            }),
            jobs: databaseRuntime.commentaryJobs,
            truth: databaseRuntime.fixtureTruth,
          })
        : null);
    const durablePush =
      config.vapid &&
      config.pushSubscriptionEncryptionSecret &&
      databaseRuntime.fans &&
      databaseRuntime.pushDevices
        ? createDurablePushService({
            cipher: createPushSubscriptionCipher({
              secret: config.pushSubscriptionEncryptionSecret,
            }),
            devices: databaseRuntime.pushDevices,
            fans: databaseRuntime.fans,
            sender: createVapidWebPushSender(config.vapid),
          })
        : null;
    // This role only projects existing Rooms. Room creation uses the API
    // runtime's fan session and live-fixture resolver.
    const durableRooms = databaseRuntime.rooms
      ? createDurableRoomService({
          fixture: () => null,
          repository:
            databaseRuntime.rooms as RoomAggregateRepository<DurableRoomAggregate>,
        })
      : null;
    const memoryService =
      databaseRuntime.experiences &&
      databaseRuntime.fans &&
      databaseRuntime.fixtureTruth &&
      databaseRuntime.memories
        ? createMatchMemoryService({
            experiences: databaseRuntime.experiences,
            fans: databaseRuntime.fans,
            fixtureTruth: databaseRuntime.fixtureTruth,
            memories:
              databaseRuntime.memories as MemoryRepository<MatchMemoryPayload>,
          })
        : null;
    outboxWorker =
      options.outboxWorker ??
      (
        options.outboxWorkerFactory ??
        ((outbox) =>
          createOutboxWorker({
            consumer: "collector",
            handlers: createCollectorOutboxHandlers({
              ...(commentaryWorker ? { commentary: commentaryWorker } : {}),
              ...(durablePush ? { push: durablePush } : {}),
              ...(durableRooms ? { rooms: durableRooms } : {}),
              ...(memoryService ? { memory: memoryService } : {}),
            }),
            mode: "live",
            outbox,
          }))
      )(databaseRuntime.outbox);
    experienceOutboxWorker =
      options.experienceOutboxWorker ??
      (durablePush && databaseRuntime.experiences
        ? createOutboxWorker({
            consumer: "collector-experience",
            handlers: createCollectorOutboxHandlers({
              experience: createExperienceDelivery({
                experiences: databaseRuntime.experiences,
                push: durablePush,
                ...(databaseRuntime.rooms
                  ? {
                      roomFanIds: (runId: string) =>
                        experienceRoomFanIdsForRun(
                          databaseRuntime.rooms as RoomAggregateRepository<ExperienceRoomAggregate>,
                          runId,
                        ),
                    }
                  : {}),
              }),
            }),
            mode: "demo",
            outbox: databaseRuntime.outbox,
          })
        : null);

    // Durable fan effects are independent from the live TxLINE transport.
    // Starting these first keeps the private Experience usable when the live
    // source is temporarily unavailable or no token is configured.
    commentaryWorker?.start();
    outboxWorker.start();
    experienceOutboxWorker?.start();
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

    if (txlineApiToken) {
      try {
        await establishCollectorRights(databaseRuntime);
        const txlineClient = (
          options.txlineClientFactory ?? createTxlineAuthenticatedClient
        )({ apiToken: txlineApiToken });
        const archiveImportRunner = (
          options.archiveImportRunnerFactory ?? createArchiveImportRunner
        )({
          archive: createArchiveService({ archive: databaseRuntime.archive }),
          archiveImportJobs: databaseRuntime.archiveImportJobs,
          client: txlineClient,
          fixtureTruth: databaseRuntime.fixtureTruth,
          rightsGrantId: HACKATHON_RIGHTS_GRANT_ID,
          sourceState: databaseRuntime.sourceState,
          workerId: processCollectorWorkerId,
        });
        archiveImportPoller =
          options.archiveImportPoller ??
          (
            options.archiveImportPollerFactory ??
            ((runner) =>
              createArchiveImportPoller({
                onError: (error) => {
                  process.stderr.write(
                    `Archive import poll failed: ${
                      error instanceof Error ? error.message : String(error)
                    }\n`,
                  );
                },
                runner,
              }))
          )(archiveImportRunner);
        sourceLifecycle =
          options.sourceLifecycle ??
          (options.sourceLifecycleFactory ?? createDurableCollectorLifecycle)({
            database: databaseRuntime,
            txlineClient,
          });
        await sourceLifecycle.start();
        sourceStarted = true;
        archiveImportPoller.start();
        archiveImportPollerStarted = true;
      } catch (error) {
        await Promise.resolve(sourceLifecycle?.stop()).catch(() => undefined);
        sourceLifecycle = null;
        process.stderr.write(
          `TxLINE source unavailable; Experience delivery remains active: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      }
    } else {
      process.stderr.write(
        "TxLINE token unavailable; Experience delivery remains active\n",
      );
    }
    return { close };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}
