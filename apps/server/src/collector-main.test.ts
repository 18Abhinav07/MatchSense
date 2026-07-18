import { describe, expect, it, vi } from "vitest";

import { parseServerEnv } from "./config.js";
import { startCollector } from "./collector-main.js";

describe("collector-only runtime", () => {
  it("owns migration, TxLINE credentials, and outbox processing without an HTTP listener", async () => {
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

    const runtime = await startCollector(
      parseServerEnv({
        DATABASE_URL: "postgresql://db.example/matchsense",
        ROLE: "worker",
        TXLINE_API_TOKEN: "collector-only-token",
      }),
      {
        databaseRuntime: database as never,
        outboxWorker: outboxWorker as never,
        txlineClientFactory,
      },
    );

    expect(database.migrate).toHaveBeenCalledOnce();
    expect(txlineClientFactory).toHaveBeenCalledWith({
      apiToken: "collector-only-token",
    });
    expect(outboxWorker.start).toHaveBeenCalledOnce();
    await runtime.close();
    expect(outboxWorker.stop).toHaveBeenCalledOnce();
    expect(database.close).toHaveBeenCalledOnce();
  });
});
