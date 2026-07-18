import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type {
  FixtureReadRepository,
  FixtureReadSnapshot,
} from "@matchsense/db";

import { registerReplayRoutes } from "./replay-routes.js";

const fixture: FixtureReadSnapshot = {
  archiveManifestId: "archive-ready",
  bucket: "final" as const,
  fixtureId: "fx-final",
  lifecycle: "final",
  metadata: {},
  mode: "live" as const,
  projection: {
    payload: { score: { away: 1, home: 2 } },
    revision: 9,
    sourceSequence: null,
    updatedAt: "2026-07-18T15:00:00.000Z",
  },
  provenance: "live_txline" as const,
  replayReady: true,
  scheduledAt: "2026-07-18T12:00:00.000Z",
  teams: { away: "FRA", home: "ARG" },
};

function repository(ready = true): FixtureReadRepository {
  return {
    getFixture: vi.fn(),
    getReplayReady: vi.fn(async () =>
      ready ? { archiveManifestId: "archive-ready", fixture } : null,
    ),
    listFixtures: vi.fn(),
    readFixtureFeed: vi.fn(async () => ({
      events: [],
      highWaterSequence: 0,
      reset: false,
      snapshot: fixture,
    })),
    readHistory: vi.fn(),
    readMemory: vi.fn(),
    readMoment: vi.fn(),
  };
}

describe("recorded replay routes", () => {
  it("creates a stateless replay session only for a REPLAY_READY archive and performs no mutation", async () => {
    const reads = repository(true);
    const app = Fastify();
    registerReplayRoutes(app, { reads });

    const response = await app.inject({
      method: "POST",
      payload: { fixtureId: "fx-final" },
      url: "/api/v1/replay/sessions",
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      fixtureId: "fx-final",
      mode: "recorded",
      replaySeq: 0,
    });
    expect(reads.getReplayReady).toHaveBeenCalledWith("fx-final");
    await app.close();
  });

  it("rejects a fixture without a verified replay archive", async () => {
    const app = Fastify();
    registerReplayRoutes(app, { reads: repository(false) });

    const response = await app.inject({
      method: "POST",
      payload: { fixtureId: "fx-final" },
      url: "/api/v1/replay/sessions",
    });

    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
