import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type {
  FixtureReadRepository,
  FixtureReadSnapshot,
} from "@matchsense/db";

import { registerFixtureReadRoutes } from "./fixture-read-routes.js";

const fixture: FixtureReadSnapshot = {
  archiveManifestId: "archive-ready",
  bucket: "final" as const,
  fixtureId: "fx-final",
  lifecycle: "final",
  metadata: {},
  mode: "recorded" as const,
  projection: {
    payload: { score: { away: 1, home: 2 } },
    revision: 8,
    sourceSequence: null,
    updatedAt: "2026-07-18T15:00:00.000Z",
  },
  provenance: "recorded_txline_authorised" as const,
  replayReady: true,
  scheduledAt: "2026-07-18T12:00:00.000Z",
  teams: { away: "FRA", home: "ARG" },
};

function repository(): FixtureReadRepository {
  return {
    getFixture: vi.fn(async () => fixture),
    getReplayReady: vi.fn(async () => null),
    listFixtures: vi.fn(async () => [fixture]),
    readFixtureFeed: vi.fn(),
    readHistory: vi.fn(async () => [fixture]),
    readMemory: vi.fn(async () => ({ fixture, timeline: [] })),
    readMoment: vi.fn(async () => ({
      latest: null,
      requested: null,
      snapshot: fixture,
      superseded: false,
    })),
  };
}

describe("durable fixture read routes", () => {
  it("keeps recorded Memory and history on the explicit recorded mode key", async () => {
    const reads = repository();
    const app = Fastify();
    registerFixtureReadRoutes(app, { reads });

    const history = await app.inject({ method: "GET", url: "/api/v1/history" });
    const fixtures = await app.inject({
      method: "GET",
      url: "/api/v1/fixtures?mode=recorded&bucket=final",
    });
    const memory = await app.inject({
      method: "GET",
      url: "/api/v1/fixtures/fx-final/memory",
    });

    expect(history.statusCode).toBe(200);
    expect(history.json()).toEqual({ fixtures: [fixture] });
    expect(fixtures.statusCode).toBe(200);
    expect(fixtures.json()).toEqual({ fixtures: [fixture] });
    expect(memory.statusCode).toBe(200);
    expect(memory.json()).toEqual({ memory: { fixture, timeline: [] } });
    expect(reads.readHistory).toHaveBeenCalledOnce();
    expect(reads.listFixtures).toHaveBeenCalledWith({
      bucket: "final",
      mode: "recorded",
    });
    expect(reads.readMemory).toHaveBeenCalledWith({
      fixtureId: "fx-final",
      mode: "recorded",
    });
    await app.close();
  });

  it("defaults live fixture detail to live but forwards an explicit recorded Moment mode", async () => {
    const reads = repository();
    const app = Fastify();
    registerFixtureReadRoutes(app, { reads });

    const detail = await app.inject({
      method: "GET",
      url: "/api/v1/fixtures/fx-final",
    });
    const moment = await app.inject({
      method: "GET",
      url: "/api/v1/fixtures/fx-final/moments/goal-family:2?mode=recorded",
    });

    expect(detail.statusCode).toBe(200);
    expect(moment.statusCode).toBe(200);
    expect(reads.getFixture).toHaveBeenCalledWith({
      fixtureId: "fx-final",
      mode: "live",
    });
    expect(reads.readMoment).toHaveBeenCalledWith({
      familyId: "goal-family",
      fixtureId: "fx-final",
      mode: "recorded",
      revision: 2,
    });
    await app.close();
  });

  it("rejects malformed Moment identities instead of resolving an ambiguous route", async () => {
    const app = Fastify();
    registerFixtureReadRoutes(app, { reads: repository() });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/fixtures/fx-final/moments/no-revision",
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
