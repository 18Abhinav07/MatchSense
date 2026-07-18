import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import * as serverModule from "./main.js";

interface TestDatabaseRuntime {
  check(): Promise<{
    databaseReachable: boolean;
    migrationsCurrent: boolean;
  }>;
  close(): Promise<void>;
  migrate(): Promise<unknown>;
  outbox: Record<string, unknown>;
}

type StartServerContract = (options: {
  databaseFactory: (databaseUrl: string) => TestDatabaseRuntime;
  environment: Record<string, string | undefined>;
  httpListen?: () => Promise<void>;
  listen: boolean;
  outboxWorker?: {
    start(): void;
    stop(): Promise<void>;
  };
  outboxWorkerFactory?: (mode: "live" | "demo") => {
    start(): void;
    stop(): Promise<void>;
  };
  productRuntime?: { close(): unknown; fixtures(): readonly unknown[] };
  shutdownTimeoutMs?: number;
  signalSource: EventEmitter;
  txlineScheduleFetcher?: (
    apiToken: string,
    options?: { startEpochDay?: number },
  ) => Promise<readonly unknown[]>;
  txlineSourceFactory?: (options?: {
    fixtures?: readonly unknown[];
    onEvent?: (event: unknown) => Promise<void> | void;
    onState?: (state: { attempt: number; state: "live" }) => void;
  }) => {
    run(signal: AbortSignal): Promise<void>;
  };
  webDistPath: string;
}) => Promise<{
  close(): Promise<void>;
  inject(options: { url: string }): Promise<{
    json(): unknown;
    statusCode: number;
  }>;
}>;

async function temporaryWebShell() {
  const directory = await mkdtemp(path.join(tmpdir(), "matchsense-main-"));
  await mkdir(path.join(directory, "assets"));
  await writeFile(
    path.join(directory, "index.html"),
    "<!doctype html><title>MatchSense</title>",
  );
  return directory;
}

describe("server entrypoint", () => {
  it("is safe to import without parsing environment or opening a listener", async () => {
    const entrypoint = await import("./main.js");

    expect(entrypoint.startServer).toBeTypeOf("function");
  });

  it("refuses to bind HTTP from the legacy combined runtime", async () => {
    const startServer =
      serverModule.startServer as unknown as StartServerContract;
    const databaseFactory = vi.fn(() => {
      throw new Error("legacy runtime must fail before creating a database");
    });

    await expect(
      startServer({
        databaseFactory,
        environment: {
          DATABASE_URL: "postgresql://db.example/matchsense",
          DATA_RIGHTS_MODE: "txline_hackathon",
          TXLINE_API_TOKEN: "fixture-collector-only-token",
        },
        listen: true,
        signalSource: new EventEmitter(),
        webDistPath: "not-used",
      }),
    ).rejects.toThrow(
      "Legacy combined MatchSense server is test-only; use the role entrypoint",
    );
    expect(databaseFactory).not.toHaveBeenCalled();
  });

  it("maps verified schedule participants to home/away product fixtures without inventing identity", () => {
    expect(
      serverModule.productFixtureFromTxline({
        competition: "World Cup",
        competitionId: "72",
        fixtureGroupId: "10115676",
        fixtureId: "18257739",
        gameState: 1,
        participant1: { id: "3021", name: "Spain" },
        participant1IsHome: false,
        participant2: { id: "1489", name: "Argentina" },
        sourceTimestampMs: 1_784_000_000_002,
        startTimeMs: 1_784_487_600_000,
      }),
    ).toMatchObject({
      context: {
        fixtureId: "18257739",
        participant1IsHome: false,
      },
      product: {
        awayTeam: "ESP",
        fixtureId: "18257739",
        homeTeam: "ARG",
        participant1IsHome: false,
        provenance: "live_txline",
      },
    });
    expect(
      serverModule.productFixtureFromTxline({
        competition: "World Cup",
        competitionId: "72",
        fixtureGroupId: "unsupported",
        fixtureId: "unsupported",
        gameState: 1,
        participant1: { id: "1", name: "Unknown FC" },
        participant1IsHome: true,
        participant2: { id: "2", name: "France" },
        sourceTimestampMs: 0,
        startTimeMs: 0,
      }),
    ).toMatchObject({
      context: { fixtureId: "unsupported" },
      product: {
        awayTeam: "FRA",
        fixtureId: "unsupported",
        homeTeam: expect.stringMatching(/^[A-Z0-9-]+$/),
      },
    });
  });

  it("builds an authoritative dynamic catalog with stable known palettes and collision-safe codes", () => {
    const schedule = [
      {
        competition: "World Cup",
        competitionId: "72",
        fixtureGroupId: "1",
        fixtureId: "101",
        gameState: 1,
        participant1: { id: "10", name: "Argentina" },
        participant1IsHome: true,
        participant2: { id: "20", name: "United Alpha" },
        sourceTimestampMs: 1,
        startTimeMs: 2,
      },
      {
        competition: "World Cup",
        competitionId: "72",
        fixtureGroupId: "1",
        fixtureId: "102",
        gameState: 1,
        participant1: { id: "30", name: "United Alps" },
        participant1IsHome: true,
        participant2: { id: "40", name: "Cote d'Ivoire" },
        sourceTimestampMs: 1,
        startTimeMs: 3,
      },
      {
        competition: "World Cup",
        competitionId: "72",
        fixtureGroupId: "1",
        fixtureId: "103",
        gameState: 1,
        participant1: { id: "50", name: "Bosnia & Herzegovina" },
        participant1IsHome: true,
        participant2: { id: "60", name: "USA" },
        sourceTimestampMs: 1,
        startTimeMs: 4,
      },
      {
        competition: "World Cup",
        competitionId: "72",
        fixtureGroupId: "1",
        fixtureId: "104",
        gameState: 1,
        participant1: { id: "70", name: "Congo DR" },
        participant1IsHome: true,
        participant2: { id: "10", name: "Argentina" },
        sourceTimestampMs: 1,
        startTimeMs: 5,
      },
    ];

    const catalog = serverModule.teamCatalogFromTxline(schedule);

    expect(catalog).toHaveLength(7);
    expect(catalog).toContainEqual({
      code: "ARG",
      colors: { primary: "#75AADB", secondary: "#F3EFE4" },
      name: "Argentina",
      participantId: "10",
    });
    const colliding = catalog.filter(({ name }) => name.startsWith("United"));
    expect(new Set(colliding.map(({ code }) => code)).size).toBe(2);
    expect(colliding.every(({ code }) => /^[A-Z0-9-]{3,20}$/.test(code))).toBe(
      true,
    );
    expect(catalog).toContainEqual(
      expect.objectContaining({ code: "CIV", name: "Cote d'Ivoire" }),
    );
    expect(catalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "BIH", name: "Bosnia & Herzegovina" }),
        expect.objectContaining({ code: "COD", name: "Congo DR" }),
        expect.objectContaining({ code: "USA", name: "USA" }),
      ]),
    );
    expect(serverModule.teamCatalogFromTxline([...schedule].reverse())).toEqual(
      catalog,
    );
  });

  it("boots live mode from the TxLINE schedule and exposes every supported fixture", async () => {
    const webDistPath = await temporaryWebShell();
    const signalSource = new EventEmitter();
    const database = {
      check: vi.fn(async () => ({
        databaseReachable: true,
        migrationsCurrent: true,
      })),
      close: vi.fn(async () => undefined),
      migrate: vi.fn(async () => undefined),
      outbox: {},
    };
    const sourceOptions: Array<{ fixtures?: readonly unknown[] }> = [];
    const sourceFactory = vi.fn(
      (options?: { fixtures?: readonly unknown[] }) => {
        sourceOptions.push(options ?? {});
        return {
          run: async (signal: AbortSignal) =>
            new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => resolve(), { once: true });
            }),
        };
      },
    );
    const startServer =
      serverModule.startServer as unknown as StartServerContract;
    let app: Awaited<ReturnType<StartServerContract>> | undefined;

    try {
      app = await startServer({
        databaseFactory: () => database,
        environment: {
          DATABASE_URL: "postgresql://db.example/matchsense",
          DATA_RIGHTS_MODE: "txline_hackathon",
          TXLINE_API_TOKEN: "fixture-server-only-token",
        },
        listen: false,
        outboxWorker: {
          start: vi.fn(),
          stop: vi.fn(async () => undefined),
        },
        signalSource,
        txlineScheduleFetcher: async () => [
          {
            competition: "World Cup",
            competitionId: "72",
            fixtureGroupId: "10115771",
            fixtureId: "18257865",
            gameState: 1,
            participant1: { id: "1999", name: "France" },
            participant1IsHome: true,
            participant2: { id: "1888", name: "England" },
            sourceTimestampMs: 1_784_000_000_001,
            startTimeMs: 1_784_408_400_000,
          },
          {
            competition: "World Cup",
            competitionId: "72",
            fixtureGroupId: "10115676",
            fixtureId: "18257739",
            gameState: 1,
            participant1: { id: "3021", name: "Spain" },
            participant1IsHome: true,
            participant2: { id: "1489", name: "Argentina" },
            sourceTimestampMs: 1_784_000_000_002,
            startTimeMs: 1_784_487_600_000,
          },
        ],
        txlineSourceFactory: sourceFactory,
        webDistPath,
      });

      const response = await app.inject({ url: "/api/v1/fixtures" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        fixtures: [
          { fixtureId: "18257865", homeTeam: "FRA", awayTeam: "ENG" },
          { fixtureId: "18257739", homeTeam: "ESP", awayTeam: "ARG" },
        ],
      });
      expect(sourceOptions[0]?.fixtures).toHaveLength(2);
    } finally {
      if (app) await app.close();
      await rm(webDistPath, { force: true, recursive: true });
    }
  });

  it("hydrates live fixture truth before starting the TxLINE source", async () => {
    const webDistPath = await temporaryWebShell();
    const signalSource = new EventEmitter();
    const hydratedAt = "2026-07-17T18:45:00.000Z";
    const projectionRecord = {
      fixtureId: "18257865",
      mode: "live" as const,
      payload: {
        appliedSourceEnvelopeIds: ["txline:18257865:goal:7"],
        eventEffects: {},
        lastEvent: null,
        minute: "67'",
        phase: "second_half",
        score: { away: 1, home: 2 },
        scores: {
          extraTime: { away: 0, home: 0 },
          regulation: { away: 1, home: 2 },
          shootout: { away: 0, home: 0 },
        },
        stats: {
          away: { corners: 2, redCards: 0, yellowCards: 1 },
          home: { corners: 5, redCards: 0, yellowCards: 2 },
        },
        updatedAt: hydratedAt,
      },
      revision: 7,
      updatedAt: hydratedAt,
    };
    const getLatestProjection = vi.fn(async () => projectionRecord);
    const eventsAfter = vi.fn(async () => []);
    const upsert = vi.fn(async () => undefined);
    let persistenceAttempt = 0;
    const processSourceEnvelope = vi.fn(
      async (input: {
        derive(current: typeof projectionRecord): {
          projection: { revision: number };
        } | null;
      }) => {
        persistenceAttempt += 1;
        if (persistenceAttempt === 1) return { kind: "duplicate" as const };
        const derived = input.derive(projectionRecord);
        return derived
          ? {
              eventSequence: 8,
              kind: "committed" as const,
              revision: derived.projection.revision,
            }
          : { kind: "accepted_no_change" as const };
      },
    );
    const database = {
      check: vi.fn(async () => ({
        databaseReachable: true,
        migrationsCurrent: true,
      })),
      close: vi.fn(async () => undefined),
      fixtureTruth: {
        eventsAfter,
        getLatestProjection,
        processSourceEnvelope,
        upsert,
      },
      migrate: vi.fn(async () => undefined),
      outbox: {},
    };
    let onLiveEvent: ((event: unknown) => Promise<void> | void) | undefined;
    const sourceFactory = vi.fn(
      (options?: { onEvent?: (event: unknown) => Promise<void> | void }) => {
        onLiveEvent = options?.onEvent;
        return {
          run: async (signal: AbortSignal) =>
            new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => resolve(), { once: true });
            }),
        };
      },
    );
    const startServer =
      serverModule.startServer as unknown as StartServerContract;
    let app: Awaited<ReturnType<StartServerContract>> | undefined;

    try {
      app = await startServer({
        databaseFactory: () => database,
        environment: {
          DATABASE_URL: "postgresql://db.example/matchsense",
          DATA_RIGHTS_MODE: "txline_hackathon",
          TXLINE_API_TOKEN: "fixture-server-only-token",
        },
        listen: false,
        outboxWorker: {
          start: vi.fn(),
          stop: vi.fn(async () => undefined),
        },
        signalSource,
        txlineScheduleFetcher: async () => [
          {
            competition: "World Cup",
            competitionId: "72",
            fixtureGroupId: "10115771",
            fixtureId: "18257865",
            gameState: 1,
            participant1: { id: "1999", name: "France" },
            participant1IsHome: true,
            participant2: { id: "1888", name: "England" },
            sourceTimestampMs: 1_784_000_000_001,
            startTimeMs: 1_784_408_400_000,
          },
        ],
        txlineSourceFactory: sourceFactory,
        webDistPath,
      });

      expect(getLatestProjection).toHaveBeenCalledWith({
        fixtureId: "18257865",
        mode: "live",
      });
      expect(eventsAfter).toHaveBeenCalledWith({
        afterSequence: 0,
        fixtureId: "18257865",
        limit: 1_000,
        mode: "live",
      });
      expect(upsert).not.toHaveBeenCalled();
      expect(
        (await app.inject({ url: "/api/v1/fixtures/18257865" })).json(),
      ).toMatchObject({
        minute: "67'",
        revision: 7,
        score: { away: 1, home: 2 },
        updatedAt: hydratedAt,
      });

      const liveGoal = (actionId: string, observedSeq: string) => ({
        action: "goal",
        actionId,
        clockSeconds: 4_200,
        confirmed: true,
        delivery: "live",
        fixtureId: "18257865",
        participant: 1,
        participantScore: { participant1: 3, participant2: 1 },
        playerId: "player-9",
        provenance: "live_txline",
        receivedAt: "2026-07-17T18:46:00.000Z",
        revision: 8,
        score: { away: 1, home: 3 },
        source: {
          actionId,
          observedSeq,
          payloadHash: `${actionId}-hash`,
          sourceTimestampMs: 1_784_314_760_000,
          sseEventId: observedSeq,
        },
        statusId: 4,
        supersedesRevision: null,
        varOutcome: null,
        varReviewType: null,
      });
      if (!onLiveEvent) throw new Error("TxLINE event handler was not started");
      await onLiveEvent(liveGoal("already-persisted", "8"));
      expect(
        (await app.inject({ url: "/api/v1/fixtures/18257865" })).json(),
      ).toMatchObject({ revision: 7, score: { away: 1, home: 2 } });

      await onLiveEvent(liveGoal("new-goal", "9"));
      expect(
        (await app.inject({ url: "/api/v1/fixtures/18257865" })).json(),
      ).toMatchObject({ revision: 8, score: { away: 1, home: 3 } });
    } finally {
      if (app) await app.close();
      await rm(webDistPath, { force: true, recursive: true });
    }
  });

  it("uses the tournament view for all teams while bounding fixtures and live ingest to the current view", async () => {
    const webDistPath = await temporaryWebShell();
    const processSourceEnvelope = vi.fn(
      async (input: {
        derive(current: null): {
          projection: { revision: number };
        } | null;
      }) => {
        const derived = input.derive(null);
        return derived
          ? {
              eventSequence: 1,
              kind: "committed" as const,
              revision: derived.projection.revision,
            }
          : { kind: "duplicate" as const };
      },
    );
    const fixtureFenceGeneration = 7;
    const sourceLease = {
      fencingToken: fixtureFenceGeneration,
      holderId: "matchsense-test-holder",
      leaseUntil: "2099-01-01T00:01:00.000Z",
      mode: "live" as const,
      source: "txline_live",
      streamKey: "world-cup-live-scores",
      updatedAt: "2026-07-17T12:00:00.000Z",
    };
    const database = {
      check: vi.fn(async () => ({
        databaseReachable: true,
        migrationsCurrent: true,
      })),
      close: vi.fn(async () => undefined),
      migrate: vi.fn(async () => undefined),
      outbox: {},
      fixtureTruth: {
        processSourceEnvelope,
        upsert: vi.fn(async () => undefined),
      },
      sourceState: {
        acquireLease: vi.fn(async () => sourceLease),
        releaseLease: vi.fn(async () => true),
        renewLease: vi.fn(async () => sourceLease),
      },
    };
    const tournamentTeams = [
      { id: "1999", name: "France" },
      { id: "1888", name: "England" },
      { id: "3021", name: "Spain" },
      { id: "1489", name: "Argentina" },
      ...Array.from({ length: 25 }, (_, index) => ({
        id: String(1_000 + index),
        name: `Nation ${index + 1}`,
      })),
    ];
    const tournament = tournamentTeams.map((participant1, index) => ({
      competition: "World Cup",
      competitionId: "72",
      fixtureGroupId: "101",
      fixtureId: String(18_000_000 + index),
      gameState: 3,
      participant1,
      participant1IsHome: true,
      participant2: tournamentTeams[(index + 1) % tournamentTeams.length]!,
      sourceTimestampMs: 1_784_000_000_000 + index,
      startTimeMs: 1_783_000_000_000 + index,
    }));
    const current = [
      {
        competition: "World Cup",
        competitionId: "72",
        fixtureGroupId: "102",
        fixtureId: "18257865",
        gameState: 1,
        participant1: { id: "1999", name: "France" },
        participant1IsHome: true,
        participant2: { id: "1888", name: "England" },
        sourceTimestampMs: 1_784_000_000_001,
        startTimeMs: 1_784_408_400_000,
      },
      {
        competition: "World Cup",
        competitionId: "72",
        fixtureGroupId: "102",
        fixtureId: "18257739",
        gameState: 1,
        participant1: { id: "3021", name: "Spain" },
        participant1IsHome: true,
        participant2: { id: "1489", name: "Argentina" },
        sourceTimestampMs: 1_784_000_000_002,
        startTimeMs: 1_784_487_600_000,
      },
    ];
    const requestedDays: Array<number | undefined> = [];
    const sourceOptions: Array<{
      fixtures?: readonly unknown[];
      onEvent?: (event: unknown) => Promise<void> | void;
    }> = [];
    const startServer =
      serverModule.startServer as unknown as StartServerContract;
    let app: Awaited<ReturnType<StartServerContract>> | undefined;

    try {
      app = await startServer({
        databaseFactory: () => database,
        environment: {
          DATABASE_URL: "postgresql://db.example/matchsense",
          DATA_RIGHTS_MODE: "txline_hackathon",
          TXLINE_API_TOKEN: "fixture-server-only-token",
        },
        listen: false,
        outboxWorker: { start: vi.fn(), stop: vi.fn(async () => undefined) },
        signalSource: new EventEmitter(),
        txlineScheduleFetcher: async (_token, options) => {
          requestedDays.push(options?.startEpochDay);
          return options?.startEpochDay ===
            Math.floor(Date.UTC(2026, 5, 11) / 86_400_000)
            ? tournament
            : current;
        },
        txlineSourceFactory: (options) => {
          sourceOptions.push(options ?? {});
          return {
            run: async (signal: AbortSignal) =>
              new Promise<void>((resolve) =>
                signal.addEventListener("abort", () => resolve(), {
                  once: true,
                }),
              ),
          };
        },
        webDistPath,
      });

      const catalog = (await app.inject({ url: "/api/v1/catalog" })).json() as {
        teams: Array<{ code: string; name: string }>;
      };
      const fixtures = (
        await app.inject({ url: "/api/v1/fixtures" })
      ).json() as {
        fixtures: Array<{ fixtureId: string }>;
      };
      expect(catalog.teams).toHaveLength(29);
      expect(catalog.teams).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "Nation 25" }),
          expect.objectContaining({ code: "ENG", name: "England" }),
          expect.objectContaining({ code: "ESP", name: "Spain" }),
          expect.objectContaining({ code: "ARG", name: "Argentina" }),
        ]),
      );
      expect(fixtures.fixtures).toHaveLength(31);
      expect(fixtures.fixtures.map(({ fixtureId }) => fixtureId)).toEqual(
        expect.arrayContaining([
          "18000000",
          "18000028",
          "18257865",
          "18257739",
        ]),
      );
      expect(sourceOptions[0]?.fixtures).toHaveLength(2);
      await sourceOptions[0]?.onEvent?.({
        action: "goal",
        actionId: "goal-1",
        clockSeconds: 720,
        confirmed: true,
        delivery: "live",
        fixtureId: "18257865",
        participant: 1,
        participantScore: { participant1: 1, participant2: 0 },
        participantStats: {
          participant1: {
            corners: 1,
            goals: 1,
            redCards: 0,
            yellowCards: 0,
          },
          participant2: {
            corners: 0,
            goals: 0,
            redCards: 0,
            yellowCards: 0,
          },
        },
        playerId: "player-1",
        provenance: "live_txline",
        receivedAt: "2026-07-17T18:12:00.000Z",
        revision: 1,
        score: { away: 0, home: 1 },
        source: {
          actionId: "goal-1",
          observedSeq: "1",
          payloadHash: "goal-hash",
          sourceTimestampMs: 1_784_314_320_000,
          sseEventId: "1",
        },
        statusId: 4,
        supersedesRevision: null,
        varOutcome: null,
        varReviewType: null,
      });
      expect(database.fixtureTruth.upsert).toHaveBeenCalledTimes(31);
      // implicit kickoff + confirmed goal + the aggregate corner delta
      expect(processSourceEnvelope).toHaveBeenCalledTimes(3);
      expect(processSourceEnvelope).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceFence: {
            fencingToken: fixtureFenceGeneration,
            holderId: "matchsense-test-holder",
            source: "txline_live",
            streamKey: "world-cup-live-scores",
          },
        }),
      );
      expect(requestedDays).toEqual(
        expect.arrayContaining([
          Math.floor(Date.UTC(2026, 5, 11) / 86_400_000),
        ]),
      );
    } finally {
      if (app) await app.close();
      expect(database.sourceState.releaseLease).toHaveBeenCalledWith({
        fencingToken: fixtureFenceGeneration,
        holderId: "matchsense-test-holder",
        mode: "live",
        source: "txline_live",
        streamKey: "world-cup-live-scores",
      });
      await rm(webDistPath, { force: true, recursive: true });
    }
  });

  it("uses real database readiness by default and closes HTTP plus DB once", async () => {
    const webDistPath = await temporaryWebShell();
    const signalSource = new EventEmitter();
    const runtime = {
      check: vi.fn(async () => ({
        databaseReachable: true,
        migrationsCurrent: true,
      })),
      close: vi.fn(async () => undefined),
      migrate: vi.fn(async () => ({ appliedVersions: [2] })),
      outbox: {},
    };
    const outboxWorker = {
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
    };
    const databaseFactory = vi.fn(() => runtime);
    const startServer =
      serverModule.startServer as unknown as StartServerContract;
    let app: Awaited<ReturnType<StartServerContract>> | undefined;

    try {
      app = await startServer({
        databaseFactory,
        environment: {
          DATABASE_URL: "postgresql://db.example/matchsense",
          DATA_RIGHTS_MODE: "synthetic_demo",
        },
        listen: false,
        outboxWorker,
        signalSource,
        webDistPath,
      });

      expect(databaseFactory).toHaveBeenCalledExactlyOnceWith(
        "postgresql://db.example/matchsense",
      );
      expect(runtime.migrate).toHaveBeenCalledTimes(1);
      const ready = await app.inject({ url: "/health/ready" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toEqual({
        checks: { database: "reachable", migrations: "current" },
        status: "ready",
      });

      signalSource.emit("SIGTERM");
      signalSource.emit("SIGINT");
      await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledTimes(1));
      expect(outboxWorker.stop).toHaveBeenCalledTimes(1);
      await app.close();
      expect(runtime.close).toHaveBeenCalledTimes(1);
      expect(signalSource.listenerCount("SIGINT")).toBe(0);
      expect(signalSource.listenerCount("SIGTERM")).toBe(0);
    } finally {
      if (app) {
        await app.close();
      }
      await rm(webDistPath, { force: true, recursive: true });
    }
  });

  it("migrates before outbox and TxLINE startup in the test-only runtime, then closes in dependency order", async () => {
    const webDistPath = await temporaryWebShell();
    const signalSource = new EventEmitter();
    const order: string[] = [];
    const runtime = {
      check: vi.fn(async () => ({
        databaseReachable: true,
        migrationsCurrent: true,
      })),
      close: vi.fn(async () => {
        order.push("database.close");
      }),
      migrate: vi.fn(async () => {
        order.push("database.migrate");
      }),
      outbox: {},
    };
    const outboxWorker = {
      start: vi.fn(() => {
        order.push("outbox.start");
      }),
      stop: vi.fn(async () => {
        order.push("outbox.stop");
      }),
    };
    const productRuntime = {
      close: vi.fn(() => {
        order.push("product.close");
      }),
      fixtures: vi.fn(() => []),
    };
    const txlineSourceFactory = vi.fn(() => ({
      run: async (signal: AbortSignal) => {
        order.push("txline.start");
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              order.push("txline.abort");
              resolve();
            },
            { once: true },
          );
        });
      },
    }));
    const startServer =
      serverModule.startServer as unknown as StartServerContract;
    let app: Awaited<ReturnType<StartServerContract>> | undefined;

    try {
      app = await startServer({
        databaseFactory: () => runtime,
        environment: {
          DATABASE_URL: "postgresql://db.example/matchsense",
          DATA_RIGHTS_MODE: "txline_hackathon",
          TXLINE_API_TOKEN: "fixture-server-only-token",
        },
        listen: false,
        outboxWorker,
        productRuntime,
        signalSource,
        txlineSourceFactory,
        webDistPath,
      });

      expect(order).toEqual([
        "database.migrate",
        "outbox.start",
        "txline.start",
      ]);
      await app.close();
      expect(order).toEqual([
        "database.migrate",
        "outbox.start",
        "txline.start",
        "txline.abort",
        "outbox.stop",
        "product.close",
        "database.close",
      ]);
    } finally {
      if (app) await app.close();
      await rm(webDistPath, { force: true, recursive: true });
    }
  });

  it("closes the database and prevents all startup when migration fails", async () => {
    const webDistPath = await temporaryWebShell();
    const migrationFailure = new Error("migration failed");
    const runtime = {
      check: vi.fn(async () => ({
        databaseReachable: true,
        migrationsCurrent: false,
      })),
      close: vi.fn(async () => undefined),
      migrate: vi.fn(async () => Promise.reject(migrationFailure)),
      outbox: {},
    };
    const outboxWorker = {
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
    };
    const productRuntime = { close: vi.fn(), fixtures: vi.fn(() => []) };
    const httpListen = vi.fn(async () => undefined);
    const txlineSourceFactory = vi.fn(() => ({
      run: vi.fn(async () => undefined),
    }));
    const startServer =
      serverModule.startServer as unknown as StartServerContract;

    try {
      await expect(
        startServer({
          databaseFactory: () => runtime,
          environment: {
            DATABASE_URL: "postgresql://db.example/matchsense",
            DATA_RIGHTS_MODE: "txline_hackathon",
            TXLINE_API_TOKEN: "fixture-server-only-token",
          },
          httpListen,
          listen: false,
          outboxWorker,
          productRuntime,
          signalSource: new EventEmitter(),
          txlineSourceFactory,
          webDistPath,
        }),
      ).rejects.toBe(migrationFailure);
      expect(runtime.close).toHaveBeenCalledTimes(1);
      expect(httpListen).not.toHaveBeenCalled();
      expect(outboxWorker.start).not.toHaveBeenCalled();
      expect(outboxWorker.stop).not.toHaveBeenCalled();
      expect(productRuntime.close).not.toHaveBeenCalled();
      expect(txlineSourceFactory).not.toHaveBeenCalled();
    } finally {
      await rm(webDistPath, { force: true, recursive: true });
    }
  });

  it("preserves a pre-app startup failure while bounding runtime cleanup and still closing the database", async () => {
    const webDistPath = await temporaryWebShell();
    const startupFailure = new Error("worker factory failed");
    const runtime = {
      check: vi.fn(async () => ({
        databaseReachable: true,
        migrationsCurrent: true,
      })),
      close: vi.fn(async () => undefined),
      migrate: vi.fn(async () => undefined),
      outbox: {},
    };
    const productRuntime = {
      close: vi.fn(async () => new Promise<void>(() => undefined)),
      fixtures: vi.fn(() => []),
    };
    const startServer =
      serverModule.startServer as unknown as StartServerContract;

    try {
      const outcome = await Promise.race([
        startServer({
          databaseFactory: () => runtime,
          environment: {
            DATABASE_URL: "postgresql://db.example/matchsense",
            DATA_RIGHTS_MODE: "synthetic_demo",
          },
          listen: false,
          outboxWorkerFactory: () => {
            throw startupFailure;
          },
          productRuntime,
          shutdownTimeoutMs: 25,
          signalSource: new EventEmitter(),
          webDistPath,
        }).then(
          () => ({ kind: "resolved" as const }),
          (error: unknown) => ({ error, kind: "rejected" as const }),
        ),
        new Promise<{ kind: "timed-out" }>((resolve) => {
          setTimeout(() => resolve({ kind: "timed-out" }), 100);
        }),
      ]);

      expect(outcome.kind).toBe("rejected");
      if (outcome.kind !== "rejected") return;
      expect(outcome.error).toMatchObject({
        errors: expect.arrayContaining([
          startupFailure,
          expect.objectContaining({
            message: "product runtime shutdown timed out",
          }),
        ]),
      });
      expect(productRuntime.close).toHaveBeenCalledTimes(1);
      expect(runtime.close).toHaveBeenCalledTimes(1);
    } finally {
      await rm(webDistPath, { force: true, recursive: true });
    }
  });

  it("starts and drains independent live and demo outbox workers", async () => {
    const webDistPath = await temporaryWebShell();
    const order: string[] = [];
    const runtime = {
      check: vi.fn(async () => ({
        databaseReachable: true,
        migrationsCurrent: true,
      })),
      close: vi.fn(async () => {
        order.push("database.close");
      }),
      migrate: vi.fn(async () => undefined),
      outbox: {},
    };
    const productRuntime = {
      close: vi.fn(() => {
        order.push("product.close");
      }),
      fixtures: vi.fn(() => []),
    };
    const factory = vi.fn((mode: "live" | "demo") => ({
      start: () => {
        order.push(`${mode}.start`);
      },
      stop: async () => {
        order.push(`${mode}.stop`);
      },
    }));
    const startServer =
      serverModule.startServer as unknown as StartServerContract;
    let app: Awaited<ReturnType<StartServerContract>> | undefined;

    try {
      app = await startServer({
        databaseFactory: () => runtime,
        environment: {
          DATABASE_URL: "postgresql://db.example/matchsense",
          DATA_RIGHTS_MODE: "synthetic_demo",
        },
        listen: false,
        outboxWorkerFactory: factory,
        productRuntime,
        signalSource: new EventEmitter(),
        webDistPath,
      });
      expect(factory.mock.calls.map(([mode]) => mode)).toEqual([
        "live",
        "demo",
      ]);
      expect(order).toEqual(["live.start", "demo.start"]);

      await app.close();
      expect(order).toEqual([
        "live.start",
        "demo.start",
        "live.stop",
        "demo.stop",
        "product.close",
        "database.close",
      ]);
    } finally {
      if (app) await app.close();
      await rm(webDistPath, { force: true, recursive: true });
    }
  });

  it("aggregates a failed first worker stop after closing the second worker, runtime, and database", async () => {
    const webDistPath = await temporaryWebShell();
    const firstFailure = new Error("live worker failed to stop");
    const runtime = {
      check: vi.fn(async () => ({
        databaseReachable: true,
        migrationsCurrent: true,
      })),
      close: vi.fn(async () => undefined),
      migrate: vi.fn(async () => undefined),
      outbox: {},
    };
    const productRuntime = {
      close: vi.fn(async () => undefined),
      fixtures: vi.fn(() => []),
    };
    const liveWorker = {
      start: vi.fn(),
      stop: vi.fn(async () => Promise.reject(firstFailure)),
    };
    const demoWorker = {
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
    };
    const startServer =
      serverModule.startServer as unknown as StartServerContract;
    let app: Awaited<ReturnType<StartServerContract>> | undefined;

    try {
      app = await startServer({
        databaseFactory: () => runtime,
        environment: {
          DATABASE_URL: "postgresql://db.example/matchsense",
          DATA_RIGHTS_MODE: "synthetic_demo",
        },
        listen: false,
        outboxWorkerFactory: (mode) =>
          mode === "live" ? liveWorker : demoWorker,
        productRuntime,
        shutdownTimeoutMs: 100,
        signalSource: new EventEmitter(),
        webDistPath,
      });

      await expect(app.close()).rejects.toMatchObject({
        errors: expect.arrayContaining([firstFailure]),
      });
      expect(liveWorker.stop).toHaveBeenCalledTimes(1);
      expect(demoWorker.stop).toHaveBeenCalledTimes(1);
      expect(productRuntime.close).toHaveBeenCalledTimes(1);
      expect(runtime.close).toHaveBeenCalledTimes(1);
    } finally {
      if (app) await app.close().catch(() => undefined);
      await rm(webDistPath, { force: true, recursive: true });
    }
  });
});
