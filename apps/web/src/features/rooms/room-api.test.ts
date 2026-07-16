import { afterEach, describe, expect, it, vi } from "vitest";

import { createRoomApi, type RoomEventSource } from "./room-api.js";

const fixture = {
  awayTeam: "BRA",
  fixtureId: "arg-bra-final",
  homeTeam: "ARG",
  kickoffAt: "2026-07-19T16:00:00.000Z",
  minute: "67'",
  provenance: "synthetic_txline_shaped",
  score: { away: 0, home: 1 },
};

function rawRoom(overrides: Record<string, unknown> = {}) {
  return {
    currentMoment: {
      label: "Goal · Argentina",
      minute: "67'",
      momentId: "arg-bra-final:goal:67",
      revision: 7,
      score: { away: 0, home: 1 },
      varState: "CONFIRMED",
    },
    fixture,
    id: "room-finals-night",
    leaderboard: [
      {
        correctCalls: 1,
        lockedAt: Date.parse("2026-07-19T15:40:00.000Z"),
        nickname: "Abhinav",
        participantId: "fan-device-1",
        provisional: true,
        rank: 1,
        score: 300,
      },
    ],
    members: [
      {
        hasCalls: true,
        id: "fan-device-1",
        isHost: true,
        lockedAt: Date.parse("2026-07-19T15:40:00.000Z"),
        nickname: "Abhinav",
        role: "PLAYER",
        teamCode: "ARG",
      },
      {
        hasCalls: true,
        id: "friend-device-2",
        isHost: false,
        lockedAt: Date.parse("2026-07-19T15:42:00.000Z"),
        nickname: "Pratik",
        role: "PLAYER",
        teamCode: "BRA",
      },
    ],
    myCalls: {
      calls: {
        cards: { answer: "NO", category: "cards", confidence: 2 },
        corners: { answer: "YES", category: "corners", confidence: 1 },
        goals: { answer: "YES", category: "goals", confidence: 3 },
      },
      changedAt: Date.parse("2026-07-19T15:39:00.000Z"),
      lockedAt: Date.parse("2026-07-19T15:40:00.000Z"),
      participantId: "fan-device-1",
    },
    name: "Finals Night",
    reactions: [
      {
        createdAt: Date.parse("2026-07-19T16:28:00.000Z"),
        id: '["fan-device-1","arg-bra-final:goal:67",7]',
        kind: "ROAR",
        momentId: "arg-bra-final:goal:67",
        recipientParticipantId: "friend-device-2",
        revision: 7,
        senderParticipantId: "fan-device-1",
        status: "VISIBLE",
      },
    ],
    revision: 9,
    stats: {
      cards: { revision: 1, state: "RELIABLE", total: 4 },
      corners: { revision: 1, state: "RELIABLE", total: 7 },
      goals: { revision: 1, state: "RELIABLE", total: 1 },
    },
    status: "LIVE",
    viewerParticipantId: "fan-device-1",
    ...overrides,
  };
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

class FakeEventSource implements RoomEventSource {
  readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>();
  closed = false;
  onerror: ((event: Event) => void) | null = null;

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  close() {
    this.closed = true;
  }

  emit(type: "room.snapshot" | "room.updated", value: unknown) {
    const event = { data: JSON.stringify(value) } as MessageEvent;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe("browser RoomApi", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates a room without sending caller identity and maps the server viewer", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse(
          {
            inviteCode: "abcdefghijklmnopqrstuv",
            room: rawRoom({
              currentMoment: {
                momentId: "arg-bra-final:goal:67",
                revision: 7,
                varState: "CONFIRMED",
              },
            }),
          },
          201,
        ),
    );
    const api = createRoomApi({
      eventSourceFactory: () => new FakeEventSource(),
      fanId: "caller-controlled-id",
      favoriteTeam: "ARG",
      fetchImpl,
      origin: "https://matchsense.test",
    });

    const created = await api.createRoom({
      fixtureId: "arg-bra-final",
      name: "Finals Night",
      nickname: "Abhinav",
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://matchsense.test/api/v1/rooms",
      expect.objectContaining({
        body: JSON.stringify({
          fixtureId: "arg-bra-final",
          host: {
            nickname: "Abhinav",
            teamCode: "ARG",
          },
          name: "Finals Night",
        }),
        credentials: "same-origin",
        method: "POST",
      }),
    );
    expect(created.inviteUrl).toBe(
      "https://matchsense.test/rooms/join/abcdefghijklmnopqrstuv",
    );
    expect(created.room).toMatchObject({
      calls: {
        locked: true,
        pointsOnly: true,
        progress: { cards: 4, corners: 7, goals: 1 },
        viewerEntry: {
          picks: [
            { answer: "yes", confidence: 3, stat: "goals" },
            { answer: "no", confidence: 2, stat: "cards" },
            { answer: "yes", confidence: 1, stat: "corners" },
          ],
          points: 300,
          status: "provisional",
        },
      },
      currentMoment: {
        minute: "67'",
        momentId: "arg-bra-final:goal:67",
        score: { away: 0, home: 1 },
        state: "confirmed",
      },
      fixture: {
        awayTeam: { code: "BRA", name: "Brazil" },
        homeTeam: { code: "ARG", name: "Argentina" },
        id: "arg-bra-final",
      },
      inviteUrl: created.inviteUrl,
      members: [
        { id: "fan-device-1", role: "host", teamCode: "ARG" },
        { id: "friend-device-2", role: "member", teamCode: "BRA" },
      ],
      phase: "live",
      reactions: [
        {
          recipient: { id: "friend-device-2", nickname: "Pratik" },
          sender: { id: "fan-device-1", nickname: "Abhinav" },
          state: "delivered",
          type: "roar",
        },
      ],
      viewerMemberId: "fan-device-1",
    });
  });

  it("uses the exact invite, join, get, calls, and reaction HTTP contracts", async () => {
    const responses = [
      {
        callsLocked: false,
        expiresAt: Date.parse("2026-07-19T17:00:00.000Z"),
        fixture,
        hostNickname: "Abhinav",
        memberNicknames: ["Abhinav"],
        name: "Finals Night",
      },
      { lateJoin: false, room: rawRoom({ status: "PRE_KICKOFF" }) },
      rawRoom(),
      rawRoom(),
      {
        reaction: {
          id: '["fan-device-1","arg-bra-final:goal:67",7]',
        },
        room: rawRoom(),
      },
    ];
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse(responses.shift()),
    );
    const api = createRoomApi({
      eventSourceFactory: () => new FakeEventSource(),
      fanId: "caller-controlled-id",
      favoriteTeam: "ARG",
      fetchImpl,
      origin: "https://matchsense.test/app/ignored",
    });

    const preview = await api.previewInvite("abcdefghijklmnopqrstuv");
    const joined = await api.joinRoom({
      inviteCode: "abcdefghijklmnopqrstuv",
      nickname: "Abhinav",
      teamCode: "ARG",
    });
    await api.getRoom("room-finals-night");
    await api.saveCalls("room-finals-night", {
      lock: true,
      picks: [
        { answer: "yes", confidence: 3, stat: "goals" },
        { answer: "no", confidence: 2, stat: "cards" },
        { answer: "yes", confidence: 1, stat: "corners" },
      ],
      targetVersions: { cards: 1, corners: 1, goals: 1 },
    });
    const reaction = await api.sendReaction("room-finals-night", {
      momentId: "arg-bra-final:goal:67",
      momentRevision: 7,
      recipientMemberId: "friend-device-2",
      type: "called_it",
    });

    expect(preview).toMatchObject({
      callsLocked: false,
      expiresAt: "2026-07-19T17:00:00.000Z",
      hostNickname: "Abhinav",
      memberNicknames: ["Abhinav"],
      roomName: "Finals Night",
    });
    expect(joined.lateJoin).toBe(false);
    expect(reaction.receiptId).toBe(
      '["fan-device-1","arg-bra-final:goal:67",7]',
    );
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://matchsense.test/api/v1/rooms/invites/abcdefghijklmnopqrstuv/preview",
      "https://matchsense.test/api/v1/rooms/join",
      "https://matchsense.test/api/v1/rooms/room-finals-night",
      "https://matchsense.test/api/v1/rooms/room-finals-night/calls",
      "https://matchsense.test/api/v1/rooms/room-finals-night/reactions",
    ]);
    expect(JSON.parse(fetchImpl.mock.calls[1]?.[1]?.body as string)).toEqual({
      inviteCode: "abcdefghijklmnopqrstuv",
      nickname: "Abhinav",
      teamCode: "ARG",
    });
    expect(JSON.parse(fetchImpl.mock.calls[3]?.[1]?.body as string)).toEqual({
      calls: [
        { answer: "YES", category: "goals", confidence: 3 },
        { answer: "NO", category: "cards", confidence: 2 },
        { answer: "YES", category: "corners", confidence: 1 },
      ],
      lock: true,
    });
    expect(JSON.parse(fetchImpl.mock.calls[4]?.[1]?.body as string)).toEqual({
      kind: "CALLED_IT",
      momentId: "arg-bra-final:goal:67",
      recipientParticipantId: "friend-device-2",
      revision: 7,
    });
  });

  it("maps fixture provenance into an explicit replay capability", async () => {
    const responses = [
      rawRoom(),
      rawRoom({
        fixture: { ...fixture, provenance: "live_txline" },
        id: "room-live-match",
      }),
    ];
    const api = createRoomApi({
      eventSourceFactory: () => new FakeEventSource(),
      fanId: "fan-device-1",
      favoriteTeam: "ARG",
      fetchImpl: vi.fn(async () => jsonResponse(responses.shift())),
      origin: "https://matchsense.test",
    });

    await expect(api.getRoom("room-finals-night")).resolves.toMatchObject({
      fixture: { isReplay: true },
    });
    await expect(api.getRoom("room-live-match")).resolves.toMatchObject({
      fixture: { isReplay: false },
    });
  });

  it("plays the host replay through every guarded endpoint with visible pacing", async () => {
    const responses = [
      rawRoom({ currentMoment: null, status: "LIVE" }),
      rawRoom({ currentMoment: null, status: "LIVE" }),
      rawRoom({
        currentMoment: {
          momentId: "arg-bra-final:replay:goal",
          revision: 7,
          varState: "HOLD",
        },
        status: "LIVE",
      }),
      rawRoom({
        currentMoment: {
          momentId: "arg-bra-final:replay:goal",
          revision: 7,
          varState: "CONFIRMED",
        },
        status: "LIVE",
      }),
      rawRoom({ status: "FINAL" }),
    ];
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse(responses.shift()),
    );
    const wait = vi.fn(async (_milliseconds: number) => undefined);
    const api = createRoomApi({
      eventSourceFactory: () => new FakeEventSource(),
      fanId: "fan-device-1",
      favoriteTeam: "ARG",
      fetchImpl,
      origin: "https://matchsense.test",
      wait,
    });
    const updates: string[] = [];

    const finalRoom = await api.playReplay("room-finals-night", (update) =>
      updates.push(update.stage),
    );

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://matchsense.test/api/v1/rooms/room-finals-night/demo/start",
      "https://matchsense.test/api/v1/rooms/room-finals-night/demo/resolve-stats",
      "https://matchsense.test/api/v1/rooms/room-finals-night/demo/register-moment",
      "https://matchsense.test/api/v1/rooms/room-finals-night/demo/resolve-moment",
      "https://matchsense.test/api/v1/rooms/room-finals-night/demo/finalise",
    ]);
    expect(
      fetchImpl.mock.calls.map(([, init]) => JSON.parse(init?.body as string)),
    ).toEqual([
      {},
      { cards: "NO", corners: "YES", goals: "YES", revision: 1 },
      {
        momentId: "arg-bra-final:replay:goal",
        revision: 7,
        varState: "HOLD",
      },
      {
        momentId: "arg-bra-final:replay:goal",
        resolution: "CONFIRMED",
        revision: 7,
      },
      {},
    ]);
    expect(wait.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
      700, 800, 1_400, 650,
    ]);
    expect(updates).toEqual([
      "kickoff",
      "calls_resolved",
      "under_review",
      "confirmed",
      "final",
    ]);
    expect(finalRoom.phase).toBe("final");
  });

  it("keeps the raw invite only in adapter memory and uses cookie-authenticated SSE", async () => {
    const source = new FakeEventSource();
    const eventSourceUrls: string[] = [];
    const localSetItem = vi.fn();
    const sessionSetItem = vi.fn();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(),
      setItem: localSetItem,
    });
    vi.stubGlobal("sessionStorage", {
      getItem: vi.fn(),
      setItem: sessionSetItem,
    });
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse(
          {
            invitePath: "/rooms/join/abcdefghijklmnopqrstuv",
            room: rawRoom({ revision: 1, status: "PRE_KICKOFF" }),
          },
          201,
        ),
    );
    const api = createRoomApi({
      eventSourceFactory: (url) => {
        eventSourceUrls.push(url);
        return source;
      },
      fanId: "fan-device-1",
      favoriteTeam: "ARG",
      fetchImpl,
      origin: "https://matchsense.test",
    });
    const created = await api.createRoom({
      fixtureId: "arg-bra-final",
      name: "Finals Night",
      nickname: "Abhinav",
    });
    const onRoom = vi.fn();
    const onError = vi.fn();

    const unsubscribe = api.subscribeRoom(
      created.room.id,
      created.room.viewerMemberId,
      onRoom,
      onError,
    );
    source.emit("room.snapshot", {
      event: "room.snapshot",
      revision: 2,
      room: rawRoom({ revision: 2 }),
    });
    source.emit("room.updated", {
      event: "room.updated",
      revision: 3,
      room: rawRoom({ revision: 3, status: "FINAL" }),
    });
    unsubscribe();
    source.emit("room.updated", {
      event: "room.updated",
      revision: 4,
      room: rawRoom({ revision: 4 }),
    });

    expect(onRoom).toHaveBeenCalledTimes(2);
    expect(onRoom.mock.calls[0]?.[0]).toMatchObject({
      inviteUrl: created.inviteUrl,
      phase: "live",
    });
    expect(onRoom.mock.calls[1]?.[0]).toMatchObject({
      inviteUrl: created.inviteUrl,
      phase: "final",
    });
    expect(onError).not.toHaveBeenCalled();
    expect(source.closed).toBe(true);
    expect(eventSourceUrls).toEqual([
      "https://matchsense.test/api/v1/rooms/room-finals-night/stream",
    ]);
    expect(localSetItem).not.toHaveBeenCalled();
    expect(sessionSetItem).not.toHaveBeenCalled();
  });

  it("exposes only fixed safe errors and rejects malformed core room data", async () => {
    const responses = [
      jsonResponse(
        {
          error: {
            code: "NICKNAME_TAKEN",
            message: "postgresql://user:secret@internal/room",
          },
        },
        409,
      ),
      jsonResponse(rawRoom({ fixture: { ...fixture, homeTeam: null } })),
    ];
    const api = createRoomApi({
      eventSourceFactory: () => new FakeEventSource(),
      fanId: "fan-device-1",
      favoriteTeam: "ARG",
      fetchImpl: vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
        responses.shift()!,
      ),
      origin: "https://matchsense.test",
    });

    await expect(
      api.joinRoom({
        inviteCode: "abcdefghijklmnopqrstuv",
        nickname: "Abhinav",
        teamCode: "ARG",
      }),
    ).rejects.toThrow("That nickname is already in use.");
    await expect(api.getRoom("room-finals-night")).rejects.toThrow(
      "Room data was invalid. Try again.",
    );
  });
});
