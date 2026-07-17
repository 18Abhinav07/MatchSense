import { describe, expect, it, vi } from "vitest";

import { createRoomApi } from "./room-api.js";

const markets = [
  {
    id: "winner",
    label: "Who wins?",
    selections: [
      { id: "HOME", label: "Home", price: 2.7 },
      { id: "DRAW", label: "Draw", price: 2.7 },
      { id: "AWAY", label: "Away", price: 2.7 },
    ],
    sourceLabel: "MatchSense pricing",
  },
  {
    id: "goals_2_5",
    label: "Goals",
    selections: [
      { id: "OVER", label: "Over", price: 1.9 },
      { id: "UNDER", label: "Under", price: 1.9 },
    ],
    sourceLabel: "MatchSense pricing",
  },
  {
    id: "cards_4_5",
    label: "Cards",
    selections: [
      { id: "OVER", label: "Over", price: 1.9 },
      { id: "UNDER", label: "Under", price: 1.9 },
    ],
    sourceLabel: "MatchSense pricing",
  },
  {
    id: "corners_9_5",
    label: "Corners",
    selections: [
      { id: "OVER", label: "Over", price: 1.9 },
      { id: "UNDER", label: "Under", price: 1.9 },
    ],
    sourceLabel: "MatchSense pricing",
  },
  {
    id: "btts",
    label: "BTTS",
    selections: [
      { id: "YES", label: "Yes", price: 1.9 },
      { id: "NO", label: "No", price: 1.9 },
    ],
    sourceLabel: "MatchSense pricing",
  },
] as const;

function rawRoom() {
  return {
    currentMoment: null,
    fixture: {
      awayTeam: "FRA",
      fixtureId: "fixture-1",
      homeTeam: "ARG",
      kickoffAt: "2026-07-19T19:00:00.000Z",
      provenance: "live_txline",
      score: { away: 0, home: 0 },
    },
    hostParticipantId: "fan-one",
    id: "room-one",
    members: [
      {
        hasCalls: false,
        hasPicks: false,
        id: "fan-one",
        isHost: true,
        joinedAt: 1,
        lockedAt: null,
        nickname: "Abhinav",
        role: "PLAYER",
        teamCode: "ARG",
      },
    ],
    name: "Final night",
    reactions: [],
    sense: {
      currencyLabel: "FRIEND SENSE · NO MONEY · NO PRIZES",
      leaderboard: [],
      markets,
      mySlate: null,
      phase: "DRAFT",
      revealedSlates: [],
      total: 100,
    },
    viewerParticipantId: "fan-one",
  };
}

describe("100-Sense browser API", () => {
  it("creates a friends Experience through the dedicated orchestration endpoint", async () => {
    const persisted = new Map<string, string>();
    const inviteStorage = {
      getItem: (key: string) => persisted.get(key) ?? null,
      setItem: (key: string, value: string) => persisted.set(key, value),
    };
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) =>
        new Response(
          JSON.stringify(
            new URL(String(input)).pathname === "/api/v1/experience/rooms"
              ? {
                  fixtureId: "fixture-1",
                  inviteCode: "abcdefghijklmnopqrstuv",
                  invitePath: "/rooms/join/abcdefghijklmnopqrstuv",
                  room: rawRoom(),
                  runId: "run-one",
                }
              : rawRoom(),
          ),
          { headers: { "Content-Type": "application/json" }, status: 201 },
        ),
    );
    const api = createRoomApi({
      cookieSource: () => "matchsense_csrf=room%20csrf",
      fanId: "fan-one",
      favoriteTeam: "ARG",
      fetchImpl: fetchImpl as typeof fetch,
      inviteStorage,
      origin: "https://matchsense.test",
    });

    const created = await api.createExperienceRoom({
      awayTeam: "FRA",
      homeTeam: "ARG",
      name: "Rivals night",
      nickname: "Abhinav",
    });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe("/api/v1/experience/rooms");
    expect(JSON.parse(String(init?.body))).toEqual({
      awayTeam: "FRA",
      homeTeam: "ARG",
      name: "Rivals night",
      nickname: "Abhinav",
    });
    expect(created.runId).toBe("run-one");
    expect(created.fixtureId).toBe("fixture-1");
    expect(created.room.inviteUrl).toBe(
      "https://matchsense.test/rooms/join/abcdefghijklmnopqrstuv",
    );
    expect(persisted.get("matchsense.room-invite.room-one")).toBe(
      created.inviteUrl,
    );

    const remountedApi = createRoomApi({
      fanId: "fan-one",
      favoriteTeam: "ARG",
      fetchImpl: fetchImpl as typeof fetch,
      inviteStorage,
      origin: "https://matchsense.test",
    });
    await expect(remountedApi.getRoom(created.room.id)).resolves.toMatchObject({
      inviteUrl: created.inviteUrl,
    });
  });

  it("uses the stable fan header and exact create/open/save happy path", async () => {
    const calls: {
      body: unknown;
      headers: Headers;
      method: string;
      path: string;
    }[] = [];
    const fetchImpl = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        calls.push({
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
          {
            headers: { "Content-Type": "application/json" },
            status: url.pathname === "/api/v1/rooms" ? 201 : 200,
          },
        );
      },
    );
    const api = createRoomApi({
      cookieSource: () => "matchsense_csrf=room%20csrf",
      fanId: "fan-one",
      favoriteTeam: "ARG",
      fetchImpl: fetchImpl as typeof fetch,
      origin: "https://matchsense.test",
    });

    const created = await api.createRoom({
      fixtureId: "fixture-1",
      name: "Final night",
      nickname: "Abhinav",
    });
    await api.openPicks(created.room.id);
    await api.savePicks(created.room.id, [
      { allocation: 20, marketId: "winner", selection: "HOME" },
      { allocation: 20, marketId: "goals_2_5", selection: "OVER" },
      { allocation: 20, marketId: "cards_4_5", selection: "UNDER" },
      { allocation: 20, marketId: "corners_9_5", selection: "OVER" },
      { allocation: 20, marketId: "btts", selection: "YES" },
    ]);
    await api.startExperience(created.room.id);

    expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /api/v1/rooms",
      "POST /api/v1/rooms/room-one/picks/open",
      "PUT /api/v1/rooms/room-one/picks",
      "POST /api/v1/rooms/room-one/start",
    ]);
    expect(
      calls.every(({ headers }) => {
        return (
          headers.get("x-matchsense-fan-id") === null &&
          headers.get("x-matchsense-csrf") === "room csrf"
        );
      }),
    ).toBe(true);
    expect(calls[0]?.body).toEqual({
      fixtureId: "fixture-1",
      host: { nickname: "Abhinav", teamCode: "ARG" },
      name: "Final night",
    });
    expect(created.inviteUrl).toBe(
      "https://matchsense.test/rooms/join/abcdefghijklmnopqrstuv",
    );
  });
});
