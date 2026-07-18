import { describe, expect, it, vi } from "vitest";

import * as roomApi from "./room-api.js";

function rawRoom() {
  return {
    createdAt: 1,
    currentMoment: null,
    finalisedAt: null,
    fixture: {
      awayTeam: "FRA",
      fixtureId: "fixture-1",
      homeTeam: "ARG",
      kickoffAt: "2026-07-19T19:00:00.000Z",
      minute: "—",
      phase: "scheduled",
      provenance: "live_txline",
      revision: 1,
      score: { away: 0, home: 0 },
      sourceLabel: "TXLINE MATCH DATA",
      updatedAt: "2026-07-18T19:00:00.000Z",
    },
    hostParticipantId: "fan-one",
    id: "room-one",
    kickoffAt: Date.parse("2026-07-19T19:00:00.000Z"),
    leaderboard: [],
    members: [
      {
        hasCalls: false,
        id: "fan-one",
        isHost: true,
        joinedAt: 1,
        lockedAt: null,
        nickname: "Abhinav",
        role: "PLAYER",
        teamCode: "ARG",
      },
    ],
    moments: [],
    myCalls: null,
    name: "Final night",
    points: {
      label: "MATCHSENSE POINTS · NON-TRANSFERABLE",
      lifetimeTotal: 0,
      roomPoints: 0,
    },
    reactions: [],
    revision: 1,
    status: "PRE_KICKOFF",
    targets: { cards: null, goals: null, result: null },
    viewerParticipantId: "fan-one",
  };
}

describe("Call Three browser API", () => {
  it("exposes the durable Call Three transport instead of the retired allocation API", () => {
    const createApi = (roomApi as Record<string, unknown>)[
      "createCallThreeRoomApi"
    ];

    expect(createApi).toBeTypeOf("function");
    expect(roomApi).not.toHaveProperty("createRoomApi");
  });

  it("uses the durable create, calls, and lock endpoints with session CSRF", async () => {
    const requests: {
      body: unknown;
      headers: Headers;
      method: string;
      path: string;
    }[] = [];
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        requests.push({
          body: init?.body ? JSON.parse(String(init.body)) : null,
          headers: new Headers(init?.headers),
          method: init?.method ?? "GET",
          path: url.pathname,
        });
        return new Response(
          JSON.stringify(
            url.pathname === "/api/v1/rooms"
              ? {
                  inviteCode: "abcdefghijklmnopqrstuv",
                  invitePath: "/rooms/join/abcdefghijklmnopqrstuv",
                  room: rawRoom(),
                }
              : rawRoom(),
          ),
          { headers: { "Content-Type": "application/json" }, status: 200 },
        );
      },
    );
    const api = roomApi.createCallThreeRoomApi({
      cookieSource: () => "matchsense_csrf=room%20csrf",
      fetchImpl: fetchImpl as typeof fetch,
      origin: "https://matchsense.test",
    });

    const created = await api.create({
      fixtureId: "fixture-1",
      name: "Final night",
      nickname: "Abhinav",
      teamCode: "ARG",
    });
    await api.setCalls(created.room.id, [
      { answer: "HOME", confidence: 3, target: "result" },
      { answer: "YES", confidence: 2, target: "goals" },
      { answer: "NO", confidence: 1, target: "cards" },
    ]);
    await api.lockCalls(created.room.id);

    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /api/v1/rooms",
      "PUT /api/v1/rooms/room-one/calls",
      "POST /api/v1/rooms/room-one/calls/lock",
    ]);
    expect(requests[0]?.body).toEqual({
      fixtureId: "fixture-1",
      host: { nickname: "Abhinav", teamCode: "ARG" },
      name: "Final night",
    });
    expect(requests[1]?.body).toEqual({
      calls: [
        { answer: "HOME", confidence: 3, target: "result" },
        { answer: "YES", confidence: 2, target: "goals" },
        { answer: "NO", confidence: 1, target: "cards" },
      ],
    });
    expect(
      requests.every(
        ({ headers }) =>
          headers.get("x-matchsense-csrf") === "room csrf" &&
          headers.get("x-matchsense-fan-id") === null,
      ),
    ).toBe(true);
  });

  it("rejects a non-live fixture rather than rendering a synthetic or recorded Room", () => {
    expect(() =>
      roomApi.parseCallThreeRoom({
        ...rawRoom(),
        fixture: {
          ...rawRoom().fixture,
          provenance: "recorded_txline_authorised",
        },
      }),
    ).toThrow("Room data was invalid");
  });
});
