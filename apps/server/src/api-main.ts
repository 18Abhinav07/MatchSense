import { readFile } from "node:fs/promises";
import path from "node:path";

import { createCommentaryPipeline } from "@matchsense/commentary";

import {
  createPostgresDatabase,
  type ApplicationDatabase,
  type FixtureTruthRepository,
  type RoomAggregateRepository,
} from "@matchsense/db";
import type { TeamCode } from "@matchsense/contracts";
import {
  createFixtureProjection,
  toFixtureSnapshot,
} from "@matchsense/event-engine";
import type { FastifyInstance } from "fastify";

import { buildApp } from "./app.js";
import { transcodeWavToStreamMp3 } from "./audio-transcoder.js";
import type { ServerConfig } from "./config.js";
import {
  createDurableRoomService,
  type DurableRoomAggregate,
} from "./durable-room-service.js";
import { createDurablePushRegistrationService } from "./durable-push.js";
import { createExperienceRuntime } from "./experience-runtime.js";
import { createFanSessionService } from "./fan-session.js";
import {
  createFixtureProcessor,
  restoreFixtureProjection,
} from "./fixture-processor.js";
import { inspectMp3 } from "./mp3.js";
import { createProductRuntime } from "./product-runtime.js";
import { createPushSubscriptionCipher } from "./push-crypto.js";
import {
  createShutdownFailureReporter,
  registerShutdownSignals,
  type ShutdownSignalSource,
} from "./start.js";

export type ApiDatabaseRuntime = Pick<
  ApplicationDatabase,
  | "check"
  | "close"
  | "commentaryArtifacts"
  | "experiences"
  | "fans"
  | "fixtureReads"
  | "fixtureTruth"
  | "pushDevices"
  | "rooms"
  | "teamCatalog"
>;

export interface StartApiOptions {
  databaseFactory?: (databaseUrl: string) => ApiDatabaseRuntime;
  databaseRuntime?: ApiDatabaseRuntime;
  httpListen?: (
    app: FastifyInstance,
    address: { host: string; port: number },
  ) => Promise<unknown>;
  listen?: boolean;
  signalSource?: ShutdownSignalSource;
  webDistPath?: string;
}

function assertApiRole(config: ServerConfig) {
  if (config.role !== "api") {
    throw new Error("API runtime requires ROLE=api");
  }
}

/**
 * Call Three eligibility is read from canonical live fixture truth. Schedule
 * rows have no projection yet, so they become an honest scheduled snapshot.
 */
async function liveFixtureForRoom(
  fixtureTruth: Pick<FixtureTruthRepository, "get" | "getLatestProjection">,
  fixtureId: string,
) {
  const fixture = await fixtureTruth.get({ fixtureId, mode: "live" });
  if (
    !fixture ||
    fixture.mode !== "live" ||
    fixture.provenance !== "live_txline"
  ) {
    return null;
  }
  const definition = {
    awayTeam: fixture.awayTeamId as TeamCode,
    fixtureId: fixture.id,
    homeTeam: fixture.homeTeamId as TeamCode,
    kickoffAt: fixture.scheduledAt,
  };
  const projection = await fixtureTruth.getLatestProjection({
    fixtureId,
    mode: "live",
  });
  return projection
    ? toFixtureSnapshot(
        restoreFixtureProjection({
          fixture: definition,
          provenance: "live_txline",
          record: projection,
        }),
      )
    : toFixtureSnapshot(
        createFixtureProjection({
          ...definition,
          observedAt: fixture.updatedAt,
          provenance: "live_txline",
        }),
      );
}

export async function startApi(
  config: ServerConfig,
  options: StartApiOptions = {},
): Promise<FastifyInstance> {
  assertApiRole(config);
  const databaseRuntime =
    options.databaseRuntime ??
    (options.databaseFactory ?? createPostgresDatabase)(config.databaseUrl);
  const webDistPath =
    options.webDistPath ?? path.resolve(import.meta.dirname, "../../web/dist");
  const sessions = createFanSessionService({
    repository: databaseRuntime.fans,
  });
  const pushRegistration =
    config.vapidPublicKey && config.pushSubscriptionEncryptionSecret
      ? createDurablePushRegistrationService({
          cipher: createPushSubscriptionCipher({
            secret: config.pushSubscriptionEncryptionSecret,
          }),
          devices: databaseRuntime.pushDevices,
        })
      : null;
  const commentaryArtifacts =
    databaseRuntime.commentaryArtifacts && databaseRuntime.fixtureTruth
      ? {
          artifacts: databaseRuntime.commentaryArtifacts,
          truth: databaseRuntime.fixtureTruth,
        }
      : null;
  const durableRooms =
    databaseRuntime.rooms && databaseRuntime.fixtureTruth
      ? {
          service: createDurableRoomService({
            fixture: (fixtureId) =>
              liveFixtureForRoom(databaseRuntime.fixtureTruth, fixtureId),
            followFixture: (input) => databaseRuntime.fans.upsertFollow(input),
            repository:
              databaseRuntime.rooms as RoomAggregateRepository<DurableRoomAggregate>,
          }),
          sessions,
        }
      : null;
  const experienceAssets =
    databaseRuntime.experiences && databaseRuntime.fixtureTruth
      ? await Promise.all([
          readFile(path.resolve(import.meta.dirname, "../assets/goal-cue.mp3")),
          readFile(path.resolve(import.meta.dirname, "../assets/silence.mp3")),
        ])
      : null;
  const experienceProduct = experienceAssets
    ? createProductRuntime({
        commentaryPipeline: createCommentaryPipeline({ env: process.env }),
        cueBytes: experienceAssets[0],
        silenceBytes: experienceAssets[1],
        transcodeCommentary: (wavBytes) =>
          transcodeWavToStreamMp3(wavBytes, {
            expected: inspectMp3(experienceAssets[0]),
          }),
        writeIntervalMs: 940,
      })
    : null;
  const experience =
    experienceProduct &&
    databaseRuntime.experiences &&
    databaseRuntime.fixtureTruth
      ? createExperienceRuntime({
          countdownMs: 10_000,
          persistFixture: async (fixture) => {
            await databaseRuntime.fixtureTruth.upsert({
              awayTeamId: fixture.awayTeam,
              homeTeamId: fixture.homeTeam,
              id: fixture.fixtureId,
              metadata: {
                journey: "experience_match",
                label: "EXPERIENCE · SIMULATED TXLINE-SHAPED DATA",
                template: "five-minute-match-v2",
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
          productRuntime: experienceProduct,
          recoverRun: async (run) => {
            const fixtureRecord = await databaseRuntime.fixtureTruth.get({
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
              databaseRuntime.fixtureTruth.getLatestProjection({
                fixtureId: run.fixtureId,
                mode: "demo",
              }),
              databaseRuntime.fixtureTruth.eventsAfter({
                afterSequence: 0,
                fixtureId: run.fixtureId,
                limit: 100,
                mode: "demo",
              }),
            ]);
            const events = eventRecords.flatMap(({ payload }) => {
              if (
                !payload ||
                typeof payload !== "object" ||
                typeof (payload as { event?: unknown }).event !== "string" ||
                typeof (payload as { id?: unknown }).id !== "string" ||
                !(payload as { snapshot?: unknown }).snapshot
              ) {
                return [];
              }
              return [payload as never];
            });
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
      : null;

  await experience?.start();

  let app: FastifyInstance | null = null;
  let unregisterSignals: () => void = () => undefined;
  try {
    app = buildApp({
      ...(commentaryArtifacts ? { commentaryArtifacts } : {}),
      demo: false,
      ...(durableRooms ? { durableRooms } : {}),
      ...(experience && experienceProduct
        ? { experience, experienceRuntime: experienceProduct }
        : {}),
      ...(pushRegistration && config.vapidPublicKey
        ? {
            durablePush: {
              applicationServerKey: config.vapidPublicKey,
              service: pushRegistration,
              sessions,
            },
          }
        : {}),
      fan: {
        fixtureReads: databaseRuntime.fixtureReads,
        repository: databaseRuntime.fans,
        sessions,
      },
      fixtureRead: {
        reads: databaseRuntime.fixtureReads,
        teamCatalog: databaseRuntime.teamCatalog,
      },
      readinessProbe: databaseRuntime,
      webDistPath,
    });
    app.addHook("onClose", async () => {
      unregisterSignals();
      await databaseRuntime.close();
    });
    unregisterSignals = registerShutdownSignals(
      options.signalSource ?? process,
      async () => {
        await app?.close();
      },
      createShutdownFailureReporter({
        setExitCode: (code) => {
          process.exitCode = code;
        },
        writeError: (message) => process.stderr.write(message),
      }),
    );

    if (options.listen !== false) {
      if (options.httpListen) {
        await options.httpListen(app, { host: config.host, port: config.port });
      } else {
        await app.listen({ host: config.host, port: config.port });
      }
    }
    return app;
  } catch (error) {
    unregisterSignals();
    if (app) {
      await app.close().catch(() => undefined);
    } else {
      await databaseRuntime.close().catch(() => undefined);
    }
    throw error;
  }
}
