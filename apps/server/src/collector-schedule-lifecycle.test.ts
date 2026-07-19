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
  startTimeMs?: number;
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
    startTimeMs: input.startTimeMs ?? 1_784_408_400_000,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushMicrotasks(count = 8) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

function liveLease(fencingToken = 1) {
  return {
    fencingToken,
    holderId: "collector-test",
    leaseUntil: "2026-07-18T12:01:30.000Z",
    mode: "live" as const,
    source: "txline",
    streamKey: "scores:mainnet",
  };
}

function abortableSource() {
  return {
    run: vi.fn(
      (signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    ),
  };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("durable collector tournament schedule", () => {
  it("reconciles a recently finished fixture after the UTC schedule day changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T04:30:00.000Z"));
    const finishedYesterday = fixture({
      fixtureId: "fixture-finished-yesterday",
      gameState: 3,
      sourceTimestampMs: 10,
      startTimeMs: Date.parse("2026-07-18T21:00:00.000Z"),
    });
    const current = fixture({
      fixtureId: "fixture-current",
      sourceTimestampMs: 11,
      startTimeMs: Date.parse("2026-07-19T18:00:00.000Z"),
    });
    adapter.fetchSchedule.mockImplementation(
      async (_client, options?: { startEpochDay?: number }) =>
        options?.startEpochDay === tournamentStartEpochDay
          ? [finishedYesterday, current]
          : [current],
    );
    const source = abortableSource();
    adapter.createRawScoreSource.mockReturnValue(source);
    const database = {
      archive: {},
      fixtureTruth: {
        observeFixtureSchedule: vi.fn(async () => ({
          fixture: {} as never,
          kind: "committed" as const,
          metadataUpdated: true,
        })),
      },
      sourceState: {
        acquireLease: vi.fn(async () => liveLease()),
        getCursor: vi.fn(async () => null),
        releaseLease: vi.fn(async () => undefined),
        renewLease: vi.fn(async () => liveLease()),
      },
      teamCatalog: { upsert: vi.fn(async () => undefined) },
    };
    const lifecycle = createDurableCollectorLifecycle({
      database: database as never,
      txlineClient: {} as never,
    });

    try {
      await lifecycle.start();

      expect(adapter.createRawScoreSource).toHaveBeenCalledWith(
        expect.objectContaining({
          fixtureIds: ["fixture-finished-yesterday", "fixture-current"],
        }),
      );
    } finally {
      await lifecycle.stop();
    }
  });

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

  it("boots idle without an empty live SSE source, then starts one source after a schedule refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T12:00:00.000Z"));
    const current = fixture({
      fixtureId: "fixture-appears-after-idle",
      sourceTimestampMs: 5,
    });
    let currentScheduleReads = 0;
    adapter.fetchSchedule.mockImplementation(
      async (_client, options?: { startEpochDay?: number }) => {
        if (options?.startEpochDay === tournamentStartEpochDay) {
          return [current];
        }
        currentScheduleReads += 1;
        return currentScheduleReads === 1 ? [] : [current];
      },
    );
    const source: { run(signal: AbortSignal): Promise<void> } = {
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
      sourceState: {
        acquireLease: vi.fn(async () => ({
          fencingToken: 1,
          holderId: "collector-test",
          leaseUntil: "2026-07-18T12:01:30.000Z",
          mode: "live",
          source: "txline",
          streamKey: "scores:mainnet",
        })),
        getCursor: vi.fn(async () => null),
        releaseLease: vi.fn(async () => undefined),
        renewLease: vi.fn(async () => null),
      },
      teamCatalog: {
        upsert: vi.fn(async () => undefined),
      },
    };
    const lifecycle = createDurableCollectorLifecycle({
      database: database as never,
      scheduleRefreshIntervalMs: 100,
      txlineClient: {} as never,
    });

    try {
      await lifecycle.start();

      expect(adapter.createRawScoreSource).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(100);
      expect(adapter.createRawScoreSource).toHaveBeenCalledTimes(1);
      expect(source.run).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(300);
      expect(adapter.createRawScoreSource).toHaveBeenCalledTimes(1);
      expect(source.run).toHaveBeenCalledOnce();
    } finally {
      await lifecycle.stop();
    }
  });

  it("restarts the source so history is reconciled when a fixture game state changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T12:00:00.000Z"));
    const scheduled = fixture({
      fixtureId: "fixture-finishes",
      gameState: 1,
      sourceTimestampMs: 10,
    });
    const finished = fixture({
      fixtureId: "fixture-finishes",
      gameState: 3,
      sourceTimestampMs: 10,
    });
    let currentScheduleReads = 0;
    adapter.fetchSchedule.mockImplementation(
      async (_client, options?: { startEpochDay?: number }) => {
        if (options?.startEpochDay === tournamentStartEpochDay) {
          return [finished];
        }
        currentScheduleReads += 1;
        return currentScheduleReads === 1 ? [scheduled] : [finished];
      },
    );
    const firstSource = abortableSource();
    const secondSource = abortableSource();
    adapter.createRawScoreSource
      .mockReturnValueOnce(firstSource)
      .mockReturnValueOnce(secondSource);
    const database = {
      archive: {},
      fixtureTruth: {
        observeFixtureSchedule: vi.fn(async () => ({
          fixture: {} as never,
          kind: "committed" as const,
          metadataUpdated: true,
        })),
      },
      sourceState: {
        acquireLease: vi.fn(async () => liveLease()),
        getCursor: vi.fn(async () => null),
        releaseLease: vi.fn(async () => undefined),
        renewLease: vi.fn(async () => liveLease()),
      },
      teamCatalog: { upsert: vi.fn(async () => undefined) },
    };
    const lifecycle = createDurableCollectorLifecycle({
      database: database as never,
      scheduleRefreshIntervalMs: 100,
      txlineClient: {} as never,
    });

    try {
      await lifecycle.start();
      expect(adapter.createRawScoreSource).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(100);

      expect(adapter.createRawScoreSource).toHaveBeenCalledTimes(2);
      expect(firstSource.run).toHaveBeenCalledOnce();
      expect(secondSource.run).toHaveBeenCalledOnce();
    } finally {
      await lifecycle.stop();
    }
  });

  it("does not overlap live lease renewals while a prior renewal is in flight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T12:00:00.000Z"));
    const current = fixture({
      fixtureId: "fixture-renew-single-flight",
      sourceTimestampMs: 6,
    });
    const renewal = deferred<ReturnType<typeof liveLease> | null>();
    const source = abortableSource();
    const renewLease = vi.fn(async () => renewal.promise);
    const releaseLease = vi.fn(async () => undefined);
    adapter.fetchSchedule.mockResolvedValue([current]);
    adapter.createRawScoreSource.mockReturnValue(source);
    const database = {
      archive: {},
      fixtureTruth: {
        observeFixtureSchedule: vi.fn(async () => ({
          fixture: {} as never,
          kind: "committed" as const,
          metadataUpdated: true,
        })),
      },
      sourceState: {
        acquireLease: vi.fn(async () => liveLease()),
        releaseLease,
        renewLease,
      },
      teamCatalog: { upsert: vi.fn(async () => undefined) },
    };
    const lifecycle = createDurableCollectorLifecycle({
      database: database as never,
      txlineClient: {} as never,
    });

    try {
      await lifecycle.start();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(renewLease).toHaveBeenCalledOnce();
      expect(releaseLease).not.toHaveBeenCalled();

      renewal.resolve(liveLease());
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(renewLease).toHaveBeenCalledTimes(2);
    } finally {
      renewal.resolve(liveLease());
      await lifecycle.stop();
    }
  });

  it("ignores a stopped lifecycle's late renewal result after a restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T12:00:00.000Z"));
    const current = fixture({
      fixtureId: "fixture-renew-stale-completion",
      sourceTimestampMs: 7,
    });
    const staleRenewal = deferred<ReturnType<typeof liveLease> | null>();
    const firstLease = liveLease(1);
    const secondLease = liveLease(2);
    const source = abortableSource();
    const releaseLease = vi.fn(async () => undefined);
    adapter.fetchSchedule.mockResolvedValue([current]);
    adapter.createRawScoreSource.mockReturnValue(source);
    const database = {
      archive: {},
      fixtureTruth: {
        observeFixtureSchedule: vi.fn(async () => ({
          fixture: {} as never,
          kind: "committed" as const,
          metadataUpdated: true,
        })),
      },
      sourceState: {
        acquireLease: vi
          .fn()
          .mockResolvedValueOnce(firstLease)
          .mockResolvedValueOnce(secondLease),
        releaseLease,
        renewLease: vi.fn(async () => staleRenewal.promise),
      },
      teamCatalog: { upsert: vi.fn(async () => undefined) },
    };
    const lifecycle = createDurableCollectorLifecycle({
      database: database as never,
      txlineClient: {} as never,
    });

    try {
      await lifecycle.start();
      await vi.advanceTimersByTimeAsync(30_000);
      await lifecycle.stop();
      await lifecycle.start();

      staleRenewal.resolve(null);
      await flushMicrotasks();

      expect(releaseLease).toHaveBeenCalledOnce();
      expect(source.run).toHaveBeenCalledTimes(2);
    } finally {
      staleRenewal.resolve(null);
      await lifecycle.stop();
    }
  });

  it("retries startup after initial live lease acquisition rejects", async () => {
    const current = fixture({
      fixtureId: "fixture-start-retry",
      sourceTimestampMs: 8,
    });
    const source = abortableSource();
    const acquireLease = vi
      .fn()
      .mockRejectedValueOnce(new Error("live lease database unavailable"))
      .mockResolvedValueOnce(liveLease());
    adapter.fetchSchedule.mockResolvedValue([current]);
    adapter.createRawScoreSource.mockReturnValue(source);
    const database = {
      archive: {},
      fixtureTruth: {
        observeFixtureSchedule: vi.fn(async () => ({
          fixture: {} as never,
          kind: "committed" as const,
          metadataUpdated: true,
        })),
      },
      sourceState: {
        acquireLease,
        releaseLease: vi.fn(async () => undefined),
        renewLease: vi.fn(async () => liveLease()),
      },
      teamCatalog: { upsert: vi.fn(async () => undefined) },
    };
    const lifecycle = createDurableCollectorLifecycle({
      database: database as never,
      txlineClient: {} as never,
    });

    try {
      await expect(lifecycle.start()).rejects.toThrow(
        "live lease database unavailable",
      );
      await expect(lifecycle.start()).resolves.toBeUndefined();

      expect(acquireLease).toHaveBeenCalledTimes(2);
      expect(source.run).toHaveBeenCalledOnce();
    } finally {
      await lifecycle.stop();
    }
  });

  it("waits for a rolling deployment lease handoff instead of exiting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T12:00:00.000Z"));
    const current = fixture({
      fixtureId: "fixture-lease-handoff",
      sourceTimestampMs: 10,
    });
    const source = abortableSource();
    const acquireLease = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(liveLease(2));
    adapter.fetchSchedule.mockResolvedValue([current]);
    adapter.createRawScoreSource.mockReturnValue(source);
    const database = {
      archive: {},
      fixtureTruth: {
        observeFixtureSchedule: vi.fn(async () => ({
          fixture: {} as never,
          kind: "committed" as const,
          metadataUpdated: true,
        })),
      },
      sourceState: {
        acquireLease,
        releaseLease: vi.fn(async () => undefined),
        renewLease: vi.fn(async () => liveLease(2)),
      },
      teamCatalog: { upsert: vi.fn(async () => undefined) },
    };
    const lifecycle = createDurableCollectorLifecycle({
      database: database as never,
      txlineClient: {} as never,
    });

    const outcome = Promise.resolve(lifecycle.start()).then(
      () => "started" as const,
      () => "failed" as const,
    );
    await flushMicrotasks();
    expect(acquireLease).toHaveBeenCalledOnce();
    expect(adapter.createRawScoreSource).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(outcome).resolves.toBe("started");
    expect(acquireLease).toHaveBeenCalledTimes(2);
    expect(source.run).toHaveBeenCalledOnce();

    await lifecycle.stop();
  });

  it("releases a lease acquired after stop before a later start", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-18T12:00:00.000Z"));
    const current = fixture({
      fixtureId: "fixture-stop-during-acquire",
      sourceTimestampMs: 9,
    });
    const firstLease = liveLease(1);
    const secondLease = liveLease(2);
    const pendingLease = deferred<ReturnType<typeof liveLease> | null>();
    const source = abortableSource();
    const acquireLease = vi
      .fn()
      .mockImplementationOnce(async () => pendingLease.promise)
      .mockResolvedValueOnce(secondLease);
    const releaseLease = vi.fn(async () => undefined);
    const renewLease = vi.fn(async () => liveLease());
    adapter.fetchSchedule.mockResolvedValue([current]);
    adapter.createRawScoreSource.mockReturnValue(source);
    const database = {
      archive: {},
      fixtureTruth: {
        observeFixtureSchedule: vi.fn(async () => ({
          fixture: {} as never,
          kind: "committed" as const,
          metadataUpdated: true,
        })),
      },
      sourceState: {
        acquireLease,
        releaseLease,
        renewLease,
      },
      teamCatalog: { upsert: vi.fn(async () => undefined) },
    };
    const lifecycle = createDurableCollectorLifecycle({
      database: database as never,
      txlineClient: {} as never,
    });

    try {
      const firstStart = lifecycle.start();
      await flushMicrotasks();
      await lifecycle.stop();
      pendingLease.resolve(firstLease);
      await expect(firstStart).resolves.toBeUndefined();

      expect(releaseLease).toHaveBeenCalledOnce();
      expect(releaseLease).toHaveBeenCalledWith({
        fencingToken: firstLease.fencingToken,
        holderId: firstLease.holderId,
        mode: firstLease.mode,
        source: firstLease.source,
        streamKey: firstLease.streamKey,
      });
      expect(adapter.fetchSchedule).not.toHaveBeenCalled();
      expect(adapter.createRawScoreSource).not.toHaveBeenCalled();
      expect(renewLease).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);

      await expect(lifecycle.start()).resolves.toBeUndefined();
      expect(acquireLease).toHaveBeenCalledTimes(2);
      expect(adapter.createRawScoreSource).toHaveBeenCalledOnce();
      expect(source.run).toHaveBeenCalledOnce();
    } finally {
      pendingLease.resolve(firstLease);
      await lifecycle.stop();
    }
  });
});
