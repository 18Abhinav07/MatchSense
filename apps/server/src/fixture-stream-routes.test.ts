import { describe, expect, it, vi } from "vitest";

import type {
  FixtureReadRepository,
  FixtureReadSnapshot,
} from "@matchsense/db";

import {
  createFixtureStreamSession,
  resolveFixtureStreamCursor,
} from "./fixture-stream-routes.js";

const fixture: FixtureReadSnapshot = {
  archiveManifestId: null,
  bucket: "live" as const,
  fixtureId: "fx-live",
  lifecycle: "live",
  metadata: {},
  mode: "live" as const,
  projection: {
    payload: { score: { away: 0, home: 1 } },
    revision: 4,
    sourceSequence: null,
    updatedAt: "2026-07-18T12:03:00.000Z",
  },
  provenance: "live_txline" as const,
  replayReady: false,
  scheduledAt: "2026-07-18T12:00:00.000Z",
  teams: { away: "FRA", home: "ARG" },
};

function reads(): FixtureReadRepository {
  return {
    getFixture: vi.fn(),
    getReplayReady: vi.fn(),
    listFixtures: vi.fn(),
    readFixtureFeed: vi.fn(async () => ({
      events: [
        {
          createdAt: "2026-07-18T12:03:00.000Z",
          eventId: "fx-live:4",
          eventType: "moment.created",
          payload: { event: "moment.created" },
          sequence: 4,
        },
      ],
      highWaterSequence: 4,
      reset: true,
      snapshot: fixture,
    })),
    readHistory: vi.fn(),
    readMemory: vi.fn(),
    readMoment: vi.fn(),
  };
}

describe("durable fixture SSE", () => {
  it("gives Last-Event-ID precedence over a query cursor and resets invalid headers", () => {
    expect(
      resolveFixtureStreamCursor({
        fixtureId: "fx-live",
        header: "fx-live:not-a-sequence",
        query: "3",
      }),
    ).toEqual({ afterSequence: null, forceReset: true });
  });

  it("writes a durable snapshot, reset marker, and strictly sequenced events", async () => {
    const writes: string[] = [];
    const session = await createFixtureStreamSession({
      afterSequence: 3,
      fixtureId: "fx-live",
      heartbeatMs: 60_000,
      pollMs: 60_000,
      reads: reads(),
      write: (value) => writes.push(value),
    });

    expect(writes.join("\n")).toContain("event: snapshot");
    expect(writes.join("\n")).toContain("event: stream.reset");
    expect(writes.join("\n")).toContain("id: fx-live:4");
    if (!session) throw new Error("Fixture stream did not open");
    session.close();
  });
});
