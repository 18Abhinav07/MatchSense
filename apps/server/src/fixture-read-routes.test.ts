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

function teamCatalog() {
  return {
    list: vi.fn(async () => []),
    upsert: vi.fn(async () => undefined),
  };
}

describe("durable fixture read routes", () => {
  it("serves the durable tournament roster without exposing repository-only identity fields", async () => {
    const reads = repository();
    const teamCatalog = {
      list: vi.fn(async () => [
        {
          code: "ARG",
          name: "Argentina",
          participantId: "team-arg",
          sourceTimestampMs: 1_784_403_000_000,
        },
      ]),
      upsert: vi.fn(async () => undefined),
    };
    const app = Fastify();
    registerFixtureReadRoutes(app, { reads, teamCatalog });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/catalog",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      provenance: "live_txline",
      sourceLabel: "TXLINE · WORLD CUP DATA",
      teams: [{ code: "ARG", name: "Argentina" }],
    });
    expect(teamCatalog.list).toHaveBeenCalledOnce();
    expect(reads.listFixtures).not.toHaveBeenCalled();
    await app.close();
  });

  it("keeps recorded Memory and history on the explicit recorded mode key", async () => {
    const reads = repository();
    const app = Fastify();
    registerFixtureReadRoutes(app, { reads, teamCatalog: teamCatalog() });

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
    registerFixtureReadRoutes(app, { reads, teamCatalog: teamCatalog() });

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
    registerFixtureReadRoutes(app, {
      reads: repository(),
      teamCatalog: teamCatalog(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/fixtures/fx-final/moments/no-revision",
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
