import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { FanSessionRecord, MemoryRecord } from "@matchsense/db";

import type {
  MatchMemoryPayload,
  MatchMemoryService,
} from "./memory-service.js";
import { registerMemoryRoutes } from "./memory-routes.js";

const session: FanSessionRecord = {
  csrfHash: "b".repeat(64),
  expiresAt: "2026-08-17T12:00:00.000Z",
  fan: {
    avatarVariant: null,
    createdAt: "2026-07-17T12:00:00.000Z",
    deletedAt: null,
    favoriteTeam: "ARG",
    handle: "Abhinav",
    handleNormalized: "abhinav",
    id: "fan-1",
    preferences: {},
    profile: {},
    updatedAt: "2026-07-17T12:00:00.000Z",
  },
  lastSeenAt: "2026-07-17T12:00:00.000Z",
  revokedAt: null,
  sessionHash: "a".repeat(64),
};

const memory: MemoryRecord<MatchMemoryPayload> = {
  createdAt: "2026-07-17T15:00:00.000Z",
  fanId: "fan-1",
  fixtureId: "fixture-live",
  mode: "live",
  payload: {
    awayTeam: "FRA",
    decidedBy: "regulation",
    finalizedAt: "2026-07-17T15:00:00.000Z",
    fixtureId: "fixture-live",
    homeTeam: "ARG",
    keyMoments: [],
    kickoffAt: "2026-07-17T12:00:00.000Z",
    mode: "live",
    provenance: "live_txline",
    replay: {
      available: false,
      fixtureRoute: "/matches/fixture-live/memory",
      kind: "canonical_timeline",
      momentRouteTemplate: "/matches/fixture-live/moments/{identity}",
      restartable: false,
      runId: null,
      templateId: null,
      templateVersion: null,
    },
    revision: 7,
    schemaVersion: 1,
    score: { away: 1, home: 2 },
    sourceLabel: "TXLINE · DEVNET SOURCE",
    stats: null,
    summary: "ARG 2–1 FRA",
  },
  revision: 7,
};

function harness(found: MemoryRecord<MatchMemoryPayload> | null = memory) {
  const service = {
    getForFan: vi.fn(async () => found),
    listForFan: vi.fn(async () => (found ? [found] : [])),
    projectFixture: vi.fn(async () => []),
    projectForFan: vi.fn(async () => found),
  } satisfies MatchMemoryService;
  const sessions = {
    createGuest: vi.fn(),
    hash: vi.fn(),
    resolve: vi.fn(async (token: string) =>
      token === "valid" ? session : null,
    ),
    verifyCsrf: vi.fn(),
  };
  return { service, sessions };
}

describe("authenticated Match Memory routes", () => {
  it("lists the current fan's durable match history", async () => {
    const dependencies = harness();
    const app = Fastify();
    registerMemoryRoutes(app, dependencies);

    const response = await app.inject({
      headers: { cookie: "matchsense_session=valid" },
      method: "GET",
      url: "/api/v1/memories",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      memories: [{ fanId: "fan-1", fixtureId: "fixture-live" }],
    });
    expect(dependencies.service.listForFan).toHaveBeenCalledWith("fan-1");
    await app.close();
  });

  it("loads one owned memory without accepting a fan id from the client", async () => {
    const dependencies = harness();
    const app = Fastify();
    registerMemoryRoutes(app, dependencies);

    const response = await app.inject({
      headers: { cookie: "matchsense_session=valid" },
      method: "GET",
      url: "/api/v1/memories/live/fixture-live",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      memory: { fanId: "fan-1", fixtureId: "fixture-live" },
    });
    expect(dependencies.service.getForFan).toHaveBeenCalledWith({
      fanId: "fan-1",
      fixtureId: "fixture-live",
      mode: "live",
    });
    await app.close();
  });

  it("resolves the public memory id route across live and Experience modes", async () => {
    const dependencies = harness();
    dependencies.service.getForFan
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...memory, mode: "demo" });
    const app = Fastify();
    registerMemoryRoutes(app, dependencies);

    const response = await app.inject({
      headers: { cookie: "matchsense_session=valid" },
      method: "GET",
      url: "/api/v1/memories/experience%3Arun-1",
    });

    expect(response.statusCode).toBe(200);
    expect(dependencies.service.getForFan).toHaveBeenNthCalledWith(1, {
      fanId: "fan-1",
      fixtureId: "experience:run-1",
      mode: "live",
    });
    expect(dependencies.service.getForFan).toHaveBeenNthCalledWith(2, {
      fanId: "fan-1",
      fixtureId: "experience:run-1",
      mode: "demo",
    });
    await app.close();
  });

  it("rejects unauthenticated, malformed, and missing memory requests", async () => {
    const dependencies = harness(null);
    const app = Fastify();
    registerMemoryRoutes(app, dependencies);

    const unauthenticated = await app.inject({
      method: "GET",
      url: "/api/v1/memories",
    });
    expect(unauthenticated.statusCode).toBe(401);

    const malformed = await app.inject({
      headers: { cookie: "matchsense_session=valid" },
      method: "GET",
      url: "/api/v1/memories/archive/fixture-live",
    });
    expect(malformed.statusCode).toBe(400);

    const missing = await app.inject({
      headers: { cookie: "matchsense_session=valid" },
      method: "GET",
      url: "/api/v1/memories/live/fixture-live",
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });
});
