import path from "node:path";

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
import type { ServerConfig } from "./config.js";
import {
  createDurableRoomService,
  type DurableRoomAggregate,
} from "./durable-room-service.js";
import { createDurablePushRegistrationService } from "./durable-push.js";
import { createFanSessionService } from "./fan-session.js";
import { restoreFixtureProjection } from "./fixture-processor.js";
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

  let app: FastifyInstance | null = null;
  let unregisterSignals: () => void = () => undefined;
  try {
    app = buildApp({
      allowDemoShell: false,
      ...(commentaryArtifacts ? { commentaryArtifacts } : {}),
      demo: false,
      ...(durableRooms ? { durableRooms } : {}),
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
