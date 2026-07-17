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
    ];

    const catalog = serverModule.teamCatalogFromTxline(schedule);

    expect(catalog).toHaveLength(4);
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

  it("uses the tournament view for all teams while bounding fixtures and live ingest to the current view", async () => {
    const webDistPath = await temporaryWebShell();
    const database = {
      check: vi.fn(async () => ({
        databaseReachable: true,
        migrationsCurrent: true,
      })),
      close: vi.fn(async () => undefined),
      migrate: vi.fn(async () => undefined),
      outbox: {},
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
    const sourceOptions: Array<{ fixtures?: readonly unknown[] }> = [];
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
      expect(fixtures.fixtures.map(({ fixtureId }) => fixtureId)).toEqual([
        "18257865",
        "18257739",
      ]);
      expect(sourceOptions[0]?.fixtures).toHaveLength(2);
      expect(requestedDays).toEqual(
        expect.arrayContaining([
          Math.floor(Date.UTC(2026, 5, 11) / 86_400_000),
        ]),
      );
    } finally {
      if (app) await app.close();
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

  it("migrates before HTTP, outbox, and TxLINE startup, then closes in dependency order", async () => {
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
        httpListen: async () => {
          order.push("http.listen");
        },
        listen: true,
        outboxWorker,
        productRuntime,
        signalSource,
        txlineSourceFactory,
        webDistPath,
      });

      expect(order).toEqual([
        "database.migrate",
        "http.listen",
        "outbox.start",
        "txline.start",
      ]);
      await app.close();
      expect(order).toEqual([
        "database.migrate",
        "http.listen",
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
