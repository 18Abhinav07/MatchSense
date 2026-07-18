import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type {
  FixtureReadRepository,
  FixtureReadSnapshot,
} from "@matchsense/db";

import { registerFixtureReadRoutes } from "./fixture-read-routes.js";

const fixture: FixtureReadSnapshot = {
  archiveManifestId: null,
  bucket: "final" as const,
  fixtureId: "fx-final",
  lifecycle: "final",
  metadata: {},
  mode: "live" as const,
  projection: {
    payload: { score: { away: 1, home: 2 } },
    revision: 8,
    sourceSequence: null,
    updatedAt: "2026-07-18T15:00:00.000Z",
  },
  provenance: "live_txline" as const,
  replayReady: false,
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
  it("serves final history and a verified fixture memory without elapsed-time inference", async () => {
    const reads = repository();
    const app = Fastify();
    registerFixtureReadRoutes(app, { reads });

    const history = await app.inject({ method: "GET", url: "/api/v1/history" });
    const memory = await app.inject({
      method: "GET",
      url: "/api/v1/fixtures/fx-final/memory",
    });

    expect(history.statusCode).toBe(200);
    expect(history.json()).toEqual({ fixtures: [fixture] });
    expect(memory.statusCode).toBe(200);
    expect(memory.json()).toEqual({ memory: { fixture, timeline: [] } });
    expect(reads.readHistory).toHaveBeenCalledOnce();
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
