import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import type { FixtureSnapshot } from "@matchsense/contracts";

import { registerRoomRoutes } from "./room-routes.js";
import { createRoomService } from "./room-service.js";

const fixture: FixtureSnapshot = {
  awayTeam: "FRA",
  fixtureId: "fixture-1",
  homeTeam: "ARG",
  kickoffAt: "2026-07-19T19:00:00.000Z",
  lastEvent: null,
  minute: "PRE",
  phase: "scheduled",
  provenance: "synthetic_txline_shaped",
  revision: 0,
  score: { away: 0, home: 0 },
  sourceLabel: "SIMULATION · TXLINE-SHAPED DATA",
  updatedAt: "2026-07-19T18:00:00.000Z",
};

const picks = [
  { allocation: 20, marketId: "winner", selection: "DRAW" },
  { allocation: 20, marketId: "goals_2_5", selection: "UNDER" },
  { allocation: 20, marketId: "cards_4_5", selection: "UNDER" },
  { allocation: 20, marketId: "corners_9_5", selection: "OVER" },
  { allocation: 20, marketId: "btts", selection: "NO" },
] as const;

describe("100-Sense room HTTP happy path", () => {
  it("creates, joins, opens, hides, reveals, and finalises by stable fan IDs", async () => {
    let now = Date.parse("2026-07-19T18:00:00.000Z");
    const service = createRoomService({
      fixture: (fixtureId) =>
        fixtureId === fixture.fixtureId ? fixture : null,
      inviteBytes: () => Buffer.alloc(16, 7),
      now: () => now,
      roomId: () => "room-one",
    });
    const app = Fastify();
    registerRoomRoutes(app, service);
    await app.ready();

    const created = await app.inject({
      headers: { "x-matchsense-fan-id": "fan-host" },
      method: "POST",
      payload: {
        fixtureId: fixture.fixtureId,
        host: { nickname: "Abhinav", teamCode: "ARG" },
        name: "Final night",
      },
      url: "/api/v1/rooms",
    });
    expect(created.statusCode).toBe(201);
    const createdBody = created.json();
    expect(createdBody.room.sense.phase).toBe("DRAFT");

    const joined = await app.inject({
      headers: { "x-matchsense-fan-id": "fan-friend" },
      method: "POST",
      payload: {
        inviteCode: createdBody.inviteCode,
        nickname: "Yash",
        teamCode: "FRA",
      },
      url: "/api/v1/rooms/join",
    });
    expect(joined.statusCode).toBe(200);

    const opened = await app.inject({
      headers: { "x-matchsense-fan-id": "fan-host" },
      method: "POST",
      payload: {},
      url: "/api/v1/rooms/room-one/picks/open",
    });
    expect(opened.json().sense.phase).toBe("OPEN");

    for (const fanId of ["fan-host", "fan-friend"]) {
      const saved = await app.inject({
        headers: { "x-matchsense-fan-id": fanId },
        method: "PUT",
        payload: { picks },
        url: "/api/v1/rooms/room-one/picks",
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().sense.revealedSlates).toEqual([]);
    }

    now = Date.parse(fixture.kickoffAt);
    const kickedOff = await app.inject({
      headers: { "x-matchsense-fan-id": "fan-friend" },
      method: "GET",
      url: "/api/v1/rooms/room-one",
    });
    expect(kickedOff.json().sense.phase).toBe("LOCKED");
    expect(kickedOff.json().sense.revealedSlates).toHaveLength(2);

    await app.inject({
      headers: { "x-matchsense-fan-id": "fan-host" },
      method: "POST",
      payload: {},
      url: "/api/v1/rooms/room-one/demo/start",
    });
    await app.inject({
      headers: { "x-matchsense-fan-id": "fan-host" },
      method: "POST",
      payload: { cards: "NO", corners: "YES", goals: "NO", revision: 1 },
      url: "/api/v1/rooms/room-one/demo/resolve-stats",
    });
    const final = await app.inject({
      headers: { "x-matchsense-fan-id": "fan-host" },
      method: "POST",
      payload: {},
      url: "/api/v1/rooms/room-one/demo/finalise",
    });
    expect(final.json().sense.phase).toBe("FINAL");
    expect(final.json().sense.leaderboard).toHaveLength(2);

    await app.close();
  });
});
