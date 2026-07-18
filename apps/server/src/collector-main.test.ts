import { describe, expect, it, vi } from "vitest";

import { parseServerEnv } from "./config.js";
import {
  createCollectorOutboxHandlers,
  startCollector,
} from "./collector-main.js";

describe("collector-only runtime", () => {
  it("projects only realtime live TxLINE snapshots into durable Rooms", async () => {
    const rooms = {
      projectFixture: vi.fn(async () => 1),
    };
    const handlers = createCollectorOutboxHandlers({ rooms });
    const snapshot = {
      awayTeam: "FRA",
      fixtureId: "fixture-arg-fra",
      homeTeam: "ARG",
      kickoffAt: "2026-07-18T18:00:00.000Z",
      lastEvent: null,
      minute: "23'",
      phase: "first_half",
      provenance: "live_txline",
      revision: 3,
      score: { away: 0, home: 1 },
      sourceLabel: "TXLINE · DEVNET SOURCE",
      updatedAt: "2026-07-18T18:23:00.000Z",
    };
    const payload = {
      deliveryIntent: "realtime",
      event: { event: "snapshot", id: "fixture-arg-fra:revision:3", snapshot },
      mode: "live",
    };

    expect(handlers["room.project"]).toEqual(expect.any(Function));
    await handlers["room.project"]?.(
      { mode: "live", payload, topic: "room.project" } as never,
      new AbortController().signal,
    );
    await handlers["room.project"]?.(
      {
        mode: "recorded",
        payload: { ...payload, mode: "recorded" },
        topic: "room.project",
      } as never,
      new AbortController().signal,
    );
    await handlers["room.project"]?.(
      {
        mode: "live",
        payload: { ...payload, deliveryIntent: "reconcile" },
        topic: "room.project",
      } as never,
      new AbortController().signal,
    );
    await handlers["room.project"]?.(
      {
        mode: "live",
        payload: {
          ...payload,
          event: {
            ...payload.event,
            snapshot: {
              ...snapshot,
              provenance: "recorded_txline_authorised",
            },
          },
        },
        topic: "room.project",
      } as never,
      new AbortController().signal,
    );

    expect(rooms.projectFixture).toHaveBeenCalledTimes(1);
    expect(rooms.projectFixture).toHaveBeenCalledWith(snapshot);
  });

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
      archive: { ensureRightsGrant: vi.fn(async () => ({})) },
      archiveImportJobs: {},
      close: vi.fn(async () => undefined),
      fixtureTruth: {},
      migrate: vi.fn(async () => undefined),
      outbox: {},
      sourceState: {},
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
        TXLINE_API_TOKEN: "fixture-collector-only-token",
      }),
      {
        archiveImportPoller: {
          start: vi.fn(),
          stop: vi.fn(async () => undefined),
        } as never,
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

  it("preserves a revoked bootstrap grant before wiring a durable archive poller", async () => {
    const events: string[] = [];
    const revokedGrant = {
      active: false,
      expiresAt: "2026-08-01T12:00:00.000Z",
      id: "txline-world-cup-hackathon-2026",
      rawRetentionUntil: "2026-07-25T12:00:00.000Z",
      revokedAt: "2026-07-18T11:00:00.000Z",
      scopes: ["replay"],
    };
    const ensureRightsGrant = vi.fn(async () => {
      events.push("rights");
      return revokedGrant;
    });
    const upsertRightsGrant = vi.fn(async () => {
      events.push("admin:upsert");
      return {
        ...revokedGrant,
        active: true,
        revokedAt: null,
        scopes: ["audio", "raw_retention", "replay"],
      };
    });
    const database = {
      archive: { ensureRightsGrant, upsertRightsGrant },
      archiveImportJobs: {},
      close: vi.fn(async () => {
        events.push("database:close");
      }),
      commentaryJobs: {},
      fans: {},
      fixtureTruth: {},
      migrate: vi.fn(async () => undefined),
      outbox: {},
      pushDevices: {},
      rooms: {},
      sourceState: {},
      teamCatalog: {},
    };
    const txlineClient = { prepare: vi.fn() };
    const sourceLifecycle = {
      start: vi.fn(async () => {
        events.push("live:start");
      }),
      stop: vi.fn(async () => {
        events.push("live:stop");
      }),
    };
    const archiveRunner = {
      runOnce: vi.fn(async () => ({ kind: "idle" as const })),
    };
    const archivePoller = {
      start: vi.fn(() => {
        events.push("archive:start");
      }),
      stop: vi.fn(async () => {
        events.push("archive:stop");
      }),
    };
    const archiveImportRunnerFactory = vi.fn(() => archiveRunner);
    const archiveImportPollerFactory = vi.fn(() => archivePoller);
    const commentaryWorker = {
      handleOutbox: vi.fn(async () => ({ kind: "ignored" as const })),
      runOnce: vi.fn(async () => ({ kind: "idle" as const })),
      start: vi.fn(() => {
        events.push("commentary:start");
      }),
      stop: vi.fn(async () => {
        events.push("commentary:stop");
      }),
    };
    const outboxWorker = {
      start: vi.fn(() => {
        events.push("outbox:start");
      }),
      stop: vi.fn(async () => {
        events.push("outbox:stop");
      }),
    };

    const runtime = await startCollector(
      parseServerEnv({
        DATABASE_URL: "postgresql://db.example/matchsense",
        ROLE: "worker",
        TXLINE_API_TOKEN: "fixture-collector-only-token",
      }),
      {
        archiveImportPollerFactory,
        archiveImportRunnerFactory,
        commentaryWorker: commentaryWorker as never,
        databaseRuntime: database as never,
        outboxWorker: outboxWorker as never,
        sourceLifecycle,
        txlineClientFactory: vi.fn(() => txlineClient) as never,
      },
    );

    expect(archiveImportRunnerFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        archiveImportJobs: database.archiveImportJobs,
        client: txlineClient,
        fixtureTruth: database.fixtureTruth,
        rightsGrantId: "txline-world-cup-hackathon-2026",
        sourceState: database.sourceState,
        workerId: expect.stringMatching(/^collector:/),
      }),
    );
    expect(archiveImportPollerFactory).toHaveBeenCalledWith(archiveRunner);
    expect(ensureRightsGrant).toHaveBeenCalledWith({
      active: true,
      id: "txline-world-cup-hackathon-2026",
      reference: "TxLINE World Cup Hackathon 2026",
      scopes: ["audio", "raw_retention", "replay"],
    });
    expect(upsertRightsGrant).not.toHaveBeenCalled();
    expect(revokedGrant).toEqual({
      active: false,
      expiresAt: "2026-08-01T12:00:00.000Z",
      id: "txline-world-cup-hackathon-2026",
      rawRetentionUntil: "2026-07-25T12:00:00.000Z",
      revokedAt: "2026-07-18T11:00:00.000Z",
      scopes: ["replay"],
    });
    expect(events.slice(0, 3)).toEqual([
      "rights",
      "live:start",
      "archive:start",
    ]);

    await runtime.close();
    expect(events.slice(-5)).toEqual([
      "archive:stop",
      "live:stop",
      "outbox:stop",
      "commentary:stop",
      "database:close",
    ]);
  });

  it("owns migration, TxLINE credentials, source lifecycle, and outbox processing without an HTTP listener", async () => {
    const database = {
      archive: { ensureRightsGrant: vi.fn(async () => ({})) },
      archiveImportJobs: {},
      close: vi.fn(async () => undefined),
      fixtureTruth: {},
      migrate: vi.fn(async () => undefined),
      outbox: {},
      sourceState: {},
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
        TXLINE_API_TOKEN: "fixture-collector-only-token",
      }),
      {
        archiveImportPoller: {
          start: vi.fn(),
          stop: vi.fn(async () => undefined),
        } as never,
        databaseRuntime: database as never,
        commentaryWorker: commentaryWorker as never,
        outboxWorker: outboxWorker as never,
        sourceLifecycle,
        txlineClientFactory,
      },
    );

    expect(database.migrate).toHaveBeenCalledOnce();
    expect(txlineClientFactory).toHaveBeenCalledWith({
      apiToken: "fixture-collector-only-token",
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
