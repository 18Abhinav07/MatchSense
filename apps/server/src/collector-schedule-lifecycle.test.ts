import { afterEach, describe, expect, it, vi } from "vitest";

const adapter = vi.hoisted(() => ({
  createRawScoreSource: vi.fn(),
  fetchSchedule: vi.fn(),
}));

vi.mock("@matchsense/txline-adapter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@matchsense/txline-adapter")>()),
  createTxlineRawScoreSource: adapter.createRawScoreSource,
  fetchTxlineWorldCupSchedule: adapter.fetchSchedule,
}));

import { createDurableCollectorLifecycle } from "./collector-main.js";

const tournamentStartEpochDay = Math.floor(Date.UTC(2026, 5, 11) / 86_400_000);
const currentEpochDay = Math.floor(Date.UTC(2026, 6, 18) / 86_400_000);

function fixture(input: {
  fixtureId: string;
  gameState?: number;
  participant1?: { id: string; name: string };
  participant2?: { id: string; name: string };
  sourceTimestampMs: number;
}) {
  return {
    competition: "World Cup",
    competitionId: "72",
    fixtureGroupId: "group-a",
    fixtureId: input.fixtureId,
    gameState: input.gameState ?? 1,
    participant1: input.participant1 ?? { id: "team-arg", name: "Argentina" },
    participant1IsHome: true,
    participant2: input.participant2 ?? { id: "team-fra", name: "France" },
    sourceTimestampMs: input.sourceTimestampMs,
    startTimeMs: 1_784_408_400_000,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("durable collector tournament schedule", () => {
  it("keeps the current live collection running when a durable roster survives a refresh error", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T12:00:00.000Z"));
    const current = fixture({
      fixtureId: "fixture-current-only",
      participant1: { id: "team-esp", name: "Spain" },
      participant2: { id: "team-eng", name: "England" },
      sourceTimestampMs: 4,
    });
    adapter.fetchSchedule.mockImplementation(
      async (_client, options?: { startEpochDay?: number }) => {
        if (options?.startEpochDay === tournamentStartEpochDay) {
          throw new Error("roster snapshot unavailable");
        }
        return [current];
      },
    );
    const source = {
      run: vi.fn(
        (signal: AbortSignal) =>
          new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          }),
      ),
    };
    adapter.createRawScoreSource.mockReturnValue(source);
    const database = {
      archive: { upsertRightsGrant: vi.fn(async () => undefined) },
      fixtureTruth: {
        observeFixtureSchedule: vi.fn(async () => ({
          fixture: {} as never,
          kind: "committed" as const,
          metadataUpdated: true,
        })),
      },
      teamCatalog: {
        list: vi.fn(async () => [
          {
            code: "ARG",
            name: "Argentina",
            participantId: "team-arg",
            sourceTimestampMs: 1,
          },
        ]),
        upsert: vi.fn(async () => undefined),
      },
      sourceState: {
        acquireLease: vi.fn(async () => ({
          fencingToken: 1,
          holderId: "collector-test",
          leaseUntil: "2026-07-18T12:01:30.000Z",
          mode: "live",
          source: "txline",
          streamKey: "scores:mainnet",
        })),
        releaseLease: vi.fn(async () => undefined),
        renewLease: vi.fn(async () => null),
      },
    };
    const lifecycle = createDurableCollectorLifecycle({
      database: database as never,
      txlineClient: {} as never,
    });

    try {
      await lifecycle.start();

      expect(database.teamCatalog.list).toHaveBeenCalledOnce();
      expect(database.teamCatalog.upsert).not.toHaveBeenCalled();
      expect(database.fixtureTruth.observeFixtureSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          fixture: expect.objectContaining({ id: "fixture-current-only" }),
        }),
      );
      expect(adapter.createRawScoreSource).toHaveBeenCalledWith(
        expect.objectContaining({ fixtureIds: ["fixture-current-only"] }),
      );
    } finally {
      await lifecycle.stop();
    }
  });

  it("fails honestly before live sync when the first durable roster bootstrap cannot refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T12:00:00.000Z"));
    const current = fixture({
      fixtureId: "fixture-current-only",
      sourceTimestampMs: 4,
    });
    adapter.fetchSchedule.mockImplementation(
      async (_client, options?: { startEpochDay?: number }) => {
        if (options?.startEpochDay === tournamentStartEpochDay) {
          throw new Error("roster snapshot unavailable");
        }
        return [current];
      },
    );
    const database = {
      archive: { upsertRightsGrant: vi.fn(async () => undefined) },
      fixtureTruth: {
        observeFixtureSchedule: vi.fn(async () => ({
          fixture: {} as never,
          kind: "committed" as const,
          metadataUpdated: true,
        })),
      },
      teamCatalog: {
        list: vi.fn(async () => []),
        upsert: vi.fn(async () => undefined),
      },
      sourceState: {
        acquireLease: vi.fn(async () => ({
          fencingToken: 1,
          holderId: "collector-test",
          leaseUntil: "2026-07-18T12:01:30.000Z",
          mode: "live",
          source: "txline",
          streamKey: "scores:mainnet",
        })),
        releaseLease: vi.fn(async () => undefined),
        renewLease: vi.fn(async () => null),
      },
    };
    const lifecycle = createDurableCollectorLifecycle({
      database: database as never,
      txlineClient: {} as never,
    });

    try {
      await expect(lifecycle.start()).rejects.toThrow(
        "TxLINE tournament roster is unavailable and durable roster is empty",
      );
      expect(
        database.fixtureTruth.observeFixtureSchedule,
      ).not.toHaveBeenCalled();
      expect(adapter.createRawScoreSource).not.toHaveBeenCalled();
    } finally {
      await lifecycle.stop();
    }
  });

  it("records the tournament roster without making archived schedule fixtures live", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T12:00:00.000Z"));
    const archived = fixture({
      fixtureId: "fixture-archived",
      gameState: 3,
      participant1: { id: "team-ned", name: "Netherlands" },
      participant2: { id: "team-mar", name: "Morocco" },
      sourceTimestampMs: 1,
    });
    const sharedOlder = fixture({
      fixtureId: "fixture-shared",
      sourceTimestampMs: 2,
    });
    const sharedNewer = fixture({
      fixtureId: "fixture-shared",
      sourceTimestampMs: 3,
    });
    const current = fixture({
      fixtureId: "fixture-current",
      participant1: { id: "team-esp", name: "Spain" },
      participant2: { id: "team-eng", name: "England" },
      sourceTimestampMs: 4,
    });
    adapter.fetchSchedule.mockImplementation(
      async (_client, options?: { startEpochDay?: number }) =>
        options?.startEpochDay === tournamentStartEpochDay
          ? [archived, sharedOlder]
          : [sharedNewer, current],
    );
    const source = {
      run: vi.fn(
        (signal: AbortSignal) =>
          new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          }),
      ),
    };
    adapter.createRawScoreSource.mockReturnValue(source);
    const database = {
      archive: { upsertRightsGrant: vi.fn(async () => undefined) },
      fixtureTruth: {
        observeFixtureSchedule: vi.fn(async () => ({
          fixture: {} as never,
          kind: "committed" as const,
          metadataUpdated: true,
        })),
      },
      teamCatalog: {
        upsert: vi.fn(async () => undefined),
      },
      sourceState: {
        acquireLease: vi.fn(async () => ({
          fencingToken: 1,
          holderId: "collector-test",
          leaseUntil: "2026-07-18T12:01:30.000Z",
          mode: "live",
          source: "txline",
          streamKey: "scores:mainnet",
        })),
        releaseLease: vi.fn(async () => undefined),
        renewLease: vi.fn(async () => null),
      },
    };
    const lifecycle = createDurableCollectorLifecycle({
      database: database as never,
      txlineClient: {} as never,
    });

    try {
      await lifecycle.start();

      expect(adapter.fetchSchedule).toHaveBeenCalledWith(expect.anything(), {
        startEpochDay: tournamentStartEpochDay,
      });
      expect(adapter.fetchSchedule).toHaveBeenCalledWith(expect.anything(), {
        startEpochDay: currentEpochDay,
      });
      expect(database.teamCatalog.upsert).toHaveBeenCalledWith([
        {
          code: "ARG",
          name: "Argentina",
          participantId: "team-arg",
          sourceTimestampMs: 3,
        },
        {
          code: "ENG",
          name: "England",
          participantId: "team-eng",
          sourceTimestampMs: 4,
        },
        {
          code: "ESP",
          name: "Spain",
          participantId: "team-esp",
          sourceTimestampMs: 4,
        },
        {
          code: "FRA",
          name: "France",
          participantId: "team-fra",
          sourceTimestampMs: 3,
        },
        {
          code: "MAR",
          name: "Morocco",
          participantId: "team-mar",
          sourceTimestampMs: 1,
        },
        {
          code: "NED",
          name: "Netherlands",
          participantId: "team-ned",
          sourceTimestampMs: 1,
        },
      ]);
      expect(
        database.fixtureTruth.observeFixtureSchedule,
      ).toHaveBeenCalledTimes(2);
      expect(database.fixtureTruth.observeFixtureSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          fixture: expect.objectContaining({ id: "fixture-shared" }),
        }),
      );
      expect(database.fixtureTruth.observeFixtureSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          fixture: expect.objectContaining({ id: "fixture-current" }),
        }),
      );
      expect(
        database.fixtureTruth.observeFixtureSchedule,
      ).not.toHaveBeenCalledWith(
        expect.objectContaining({
          fixture: expect.objectContaining({ id: "fixture-archived" }),
        }),
      );
      const rawSourceOptions = adapter.createRawScoreSource.mock.calls[0]?.[0];
      expect(rawSourceOptions).toEqual(
        expect.objectContaining({
          fixtureIds: expect.arrayContaining([
            "fixture-shared",
            "fixture-current",
          ]),
        }),
      );
      expect(rawSourceOptions?.fixtureIds).toHaveLength(2);
    } finally {
      await lifecycle.stop();
    }
  });
});
