import { describe, expect, it, vi } from "vitest";

import { parseServerEnv } from "./config.js";
import { startCollector } from "./collector-main.js";

describe("collector-only runtime", () => {
  it("creates the real worker lifecycle after migration when no test lifecycle is injected", async () => {
    const database = {
      close: vi.fn(async () => undefined),
      migrate: vi.fn(async () => undefined),
      outbox: {},
    };
    const sourceLifecycle = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const outboxWorker = {
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
    };
    const txlineClient = { prepare: vi.fn() };
    const sourceLifecycleFactory = vi.fn(() => sourceLifecycle);

    const runtime = await startCollector(
      parseServerEnv({
        DATABASE_URL: "postgresql://db.example/matchsense",
        ROLE: "worker",
        TXLINE_API_TOKEN: "collector-only-token",
      }),
      {
        databaseRuntime: database as never,
        outboxWorker: outboxWorker as never,
        sourceLifecycleFactory,
        txlineClientFactory: vi.fn(() => txlineClient) as never,
      },
    );
    expect(database.migrate).toHaveBeenCalledOnce();
    expect(sourceLifecycleFactory).toHaveBeenCalledWith({
      database,
      txlineClient,
    });
    expect(sourceLifecycle.start).toHaveBeenCalledOnce();
    await runtime.close();
    expect(sourceLifecycle.stop).toHaveBeenCalledOnce();
  });

  it("owns migration, TxLINE credentials, source lifecycle, and outbox processing without an HTTP listener", async () => {
    const database = {
      close: vi.fn(async () => undefined),
      migrate: vi.fn(async () => undefined),
      outbox: {},
    };
    const txlineClientFactory = vi.fn(() => ({ prepare: vi.fn() })) as never;
    const outboxWorker = {
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
    };
    const sourceLifecycle = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };

    const runtime = await startCollector(
      parseServerEnv({
        DATABASE_URL: "postgresql://db.example/matchsense",
        ROLE: "worker",
        TXLINE_API_TOKEN: "collector-only-token",
      }),
      {
        databaseRuntime: database as never,
        outboxWorker: outboxWorker as never,
        sourceLifecycle,
        txlineClientFactory,
      },
    );

    expect(database.migrate).toHaveBeenCalledOnce();
    expect(txlineClientFactory).toHaveBeenCalledWith({
      apiToken: "collector-only-token",
    });
    expect(sourceLifecycle.start).toHaveBeenCalledOnce();
    expect(outboxWorker.start).toHaveBeenCalledOnce();
    await runtime.close();
    expect(sourceLifecycle.stop).toHaveBeenCalledOnce();
    expect(outboxWorker.stop).toHaveBeenCalledOnce();
    expect(database.close).toHaveBeenCalledOnce();
  });
});
