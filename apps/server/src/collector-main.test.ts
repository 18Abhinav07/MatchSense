import { describe, expect, it, vi } from "vitest";

import { parseServerEnv } from "./config.js";
import { startCollector } from "./collector-main.js";

describe("collector-only runtime", () => {
  it("fails before migration when no real source lifecycle and outbox handlers are wired", async () => {
    const database = {
      close: vi.fn(async () => undefined),
      migrate: vi.fn(async () => undefined),
      outbox: {},
    };

    await expect(
      startCollector(
        parseServerEnv({
          DATABASE_URL: "postgresql://db.example/matchsense",
          ROLE: "worker",
          TXLINE_API_TOKEN: "collector-only-token",
        }),
        { databaseRuntime: database as never },
      ),
    ).rejects.toThrow(
      "Collector runtime is not wired: provide a source lifecycle and outbox worker",
    );
    expect(database.migrate).not.toHaveBeenCalled();
    expect(database.close).not.toHaveBeenCalled();
  });

  it("owns migration, TxLINE credentials, source lifecycle, and outbox processing without an HTTP listener", async () => {
    const database = {
      close: vi.fn(async () => undefined),
      migrate: vi.fn(async () => undefined),
      outbox: {},
    };
    const txlineClientFactory = vi.fn(() => ({ prepare: vi.fn() }));
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
