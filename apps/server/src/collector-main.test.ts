import { describe, expect, it, vi } from "vitest";

import { parseServerEnv } from "./config.js";
import {
  createCollectorOutboxHandlers,
  startCollector,
} from "./collector-main.js";

describe("collector-only runtime", () => {
  it("fans out only confirmed realtime canonical work into commentary and push", async () => {
    const commentary = {
      handleOutbox: vi.fn(async () => ({ kind: "ignored" as const })),
    };
    const push = {
      deliverToFixture: vi.fn(async () => ({ accepted: 0, attempted: 0 })),
    };
    const handlers = createCollectorOutboxHandlers({ commentary, push });
    const payload = {
      deliveryIntent: "realtime",
      event: {
        event: "moment.created",
        moment: {
          celebratesGoal: true,
          eventTeam: "ARG",
          familyId: "txline:fixture-1:action:goal-23",
          fixtureId: "fixture-1",
          kind: "goal",
          minute: "23'",
          occurredAt: "2026-07-18T12:23:00.000Z",
          provenance: "live_txline",
          revision: 3,
          score: { away: 0, home: 1 },
          status: "confirmed",
        },
        snapshot: { updatedAt: "2026-07-18T12:23:00.000Z" },
      },
      mode: "live",
    };
    const message = { mode: "live", payload };

    await handlers["fixture.broadcast"]?.(
      message as never,
      new AbortController().signal,
    );
    await handlers["commentary.prepare"]?.(
      { ...message, topic: "commentary.prepare" } as never,
      new AbortController().signal,
    );
    await handlers["push.candidate"]?.(
      { ...message, topic: "push.candidate" } as never,
      new AbortController().signal,
    );
    await handlers["push.candidate"]?.(
      {
        mode: "recorded",
        payload: { ...payload, mode: "recorded" },
        topic: "push.candidate",
      } as never,
      new AbortController().signal,
    );

    expect(commentary.handleOutbox).toHaveBeenCalledTimes(2);
    expect(push.deliverToFixture).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: "txline:fixture-1:action:goal-23",
        fixtureId: "fixture-1",
      }),
      "live",
    );
    expect(push.deliverToFixture).toHaveBeenCalledOnce();
  });

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
    const commentaryWorker = {
      handleOutbox: vi.fn(async () => ({ kind: "ignored" as const })),
      runOnce: vi.fn(async () => ({ kind: "idle" as const })),
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
        commentaryWorker: commentaryWorker as never,
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
    expect(commentaryWorker.start).toHaveBeenCalledOnce();
    expect(outboxWorker.start).toHaveBeenCalledOnce();
    await runtime.close();
    expect(sourceLifecycle.stop).toHaveBeenCalledOnce();
    expect(outboxWorker.stop).toHaveBeenCalledOnce();
    expect(commentaryWorker.stop).toHaveBeenCalledOnce();
    expect(database.close).toHaveBeenCalledOnce();
  });
});
