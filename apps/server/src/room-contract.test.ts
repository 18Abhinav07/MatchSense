import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { createProductRuntime } from "./product-runtime.js";
import { createRoomService } from "./room-service.js";

let webDistPath: string;

beforeAll(async () => {
  webDistPath = await mkdtemp(path.join(tmpdir(), "matchsense-rooms-"));
  await mkdir(path.join(webDistPath, "assets"));
  await writeFile(path.join(webDistPath, "index.html"), "MatchSense");
});

afterAll(async () => {
  await rm(webDistPath, { force: true, recursive: true });
});

const readinessProbe = {
  check: async () => ({ databaseReachable: true, migrationsCurrent: true }),
};

const calls = (
  goals: "YES" | "NO" = "YES",
  cards: "YES" | "NO" = "NO",
  corners: "YES" | "NO" = "YES",
) => [
  { answer: goals, category: "goals", confidence: 3 },
  { answer: cards, category: "cards", confidence: 2 },
  { answer: corners, category: "corners", confidence: 1 },
];

async function readSseEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  expectedEvent: string,
) {
  const decoder = new TextDecoder();
  let buffered = "";
  const expiresAt = Date.now() + 3_000;
  while (Date.now() < expiresAt) {
    const remaining = expiresAt - Date.now();
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("SSE event timed out")), remaining),
      ),
    ]);
    if (chunk.done) throw new Error("SSE stream ended early");
    buffered += decoder.decode(chunk.value, { stream: true });
    const frames = buffered.split("\n\n");
    buffered = frames.pop() ?? "";
    for (const frame of frames) {
      const event = frame
        .split("\n")
        .find((line) => line.startsWith("event: "))
        ?.slice(7);
      if (event !== expectedEvent) continue;
      const data = frame
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6);
      if (!data) throw new Error("SSE event did not include data");
      return JSON.parse(data) as Record<string, unknown>;
    }
  }
  throw new Error(`SSE event was not received: ${expectedEvent}`);
}

function sessionCookie(response: {
  readonly headers: Record<string, number | string | string[] | undefined>;
}) {
  const raw = response.headers["set-cookie"];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (typeof header !== "string") {
    throw new Error("Room session cookie was not issued");
  }
  return header.split(";", 1)[0] ?? "";
}

describe("Rooms HTTP product contract", () => {
  it("runs create, invite, Call Three, live room updates, reactions, and final scoring", async () => {
    const runtime = createProductRuntime({
      cueBytes: Buffer.from("cue"),
      fixture: {
        awayTeam: "FRA",
        fixtureId: "room-fixture",
        homeTeam: "ARG",
        kickoffAt: "2099-07-16T18:00:00.000Z",
        provenance: "synthetic_txline_shaped",
      },
      now: () => "2026-07-16T12:00:00.000Z",
      silenceBytes: Buffer.from("silence"),
      writeIntervalMs: 60_000,
    });
    const app = buildApp({ readinessProbe, runtime, webDistPath });
    const streamAbort = new AbortController();

    try {
      const missingFixture = await app.inject({
        method: "POST",
        payload: {
          fixtureId: "missing-fixture",
          host: {
            nickname: "Alice",
            teamCode: "ARG",
          },
          name: "Finals Night",
        },
        url: "/api/v1/rooms",
      });
      expect(missingFixture.statusCode).toBe(404);
      expect(missingFixture.json()).toEqual({
        error: { code: "FIXTURE_NOT_FOUND", message: "Fixture not found" },
      });

      const created = await app.inject({
        method: "POST",
        payload: {
          fixtureId: "room-fixture",
          host: {
            nickname: "Alice",
            teamCode: "ARG",
          },
          name: "Finals Night",
        },
        url: "/api/v1/rooms",
      });
      expect(created.statusCode).toBe(201);
      const creation = created.json() as {
        inviteCode: string;
        room: { id: string; viewerParticipantId: string };
      };
      const aliceCookie = sessionCookie(created);
      const aliceId = creation.room.viewerParticipantId;
      expect(created.headers["set-cookie"]).toContain("HttpOnly");
      expect(created.headers["set-cookie"]).toContain("SameSite=Lax");
      expect(created.headers["set-cookie"]).toContain("Path=/");
      expect(created.headers["set-cookie"]).not.toContain("Max-Age");
      expect(creation.inviteCode).toMatch(/^[A-Za-z0-9_-]{22}$/u);
      expect(aliceId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(creation.room).toMatchObject({
        fixture: { fixtureId: "room-fixture" },
        leaderboard: [],
        members: [
          {
            id: aliceId,
            isHost: true,
            nickname: "Alice",
            role: "PLAYER",
            teamCode: "ARG",
          },
        ],
        hostParticipantId: aliceId,
        myCalls: null,
        name: "Finals Night",
        reactions: [],
        status: "PRE_KICKOFF",
      });

      const preview = await app.inject({
        url: `/api/v1/rooms/invites/${creation.inviteCode}/preview`,
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.json()).toMatchObject({
        fixture: { fixtureId: "room-fixture" },
        callsLocked: false,
        expiresAt: expect.any(Number),
        hostNickname: "Alice",
        memberCount: 1,
        memberNicknames: ["Alice"],
        name: "Finals Night",
      });
      expect(preview.body).not.toContain(aliceId);

      const joined = await app.inject({
        method: "POST",
        payload: {
          inviteCode: creation.inviteCode,
          nickname: "Bob",
          teamCode: "FRA",
        },
        url: "/api/v1/rooms/join",
      });
      expect(joined.statusCode).toBe(200);
      const bobCookie = sessionCookie(joined);
      const joinedRoom = joined.json() as {
        members: { id: string; nickname: string }[];
        viewerParticipantId: string;
      };
      const bobId = joinedRoom.viewerParticipantId;
      expect(bobId).not.toBe(aliceId);
      expect(joined.json()).toMatchObject({
        members: [
          {
            id: aliceId,
            isHost: true,
            nickname: "Alice",
            role: "PLAYER",
            teamCode: "ARG",
          },
          {
            id: bobId,
            isHost: false,
            nickname: "Bob",
            role: "PLAYER",
            teamCode: "FRA",
          },
        ],
        myCalls: null,
        viewerParticipantId: bobId,
      });

      const unauthenticatedRead = await app.inject({
        url: `/api/v1/rooms/${creation.room.id}`,
      });
      expect(unauthenticatedRead.statusCode).toBe(401);
      expect(unauthenticatedRead.json()).toEqual({
        error: {
          code: "ROOM_SESSION_REQUIRED",
          message: "Room session is required",
        },
      });

      const spoofedRead = await app.inject({
        headers: { cookie: bobCookie },
        url: `/api/v1/rooms/${creation.room.id}?participantId=${aliceId}`,
      });
      expect(spoofedRead.statusCode).toBe(400);

      const bobRead = await app.inject({
        headers: { cookie: bobCookie },
        url: `/api/v1/rooms/${creation.room.id}`,
      });
      expect(bobRead.statusCode).toBe(200);
      expect(bobRead.json()).toMatchObject({
        myCalls: null,
        viewerParticipantId: bobId,
      });

      const spoofedWrite = await app.inject({
        headers: { cookie: bobCookie },
        method: "PUT",
        payload: {
          calls: calls(),
          lock: false,
          participantId: aliceId,
        },
        url: `/api/v1/rooms/${creation.room.id}/calls`,
      });
      expect(spoofedWrite.statusCode).toBe(400);

      const aliceBeforeCalls = await app.inject({
        headers: { cookie: aliceCookie },
        url: `/api/v1/rooms/${creation.room.id}`,
      });
      expect(aliceBeforeCalls.json()).toMatchObject({ myCalls: null });

      await app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.server.address();
      if (!address || typeof address === "string") {
        throw new Error("Rooms test server address is unavailable");
      }
      const streamResponse = await fetch(
        `http://127.0.0.1:${address.port}/api/v1/rooms/${creation.room.id}/stream`,
        {
          headers: { Cookie: aliceCookie },
          signal: streamAbort.signal,
        },
      );
      expect(streamResponse.status).toBe(200);
      const streamReader = streamResponse.body?.getReader();
      if (!streamReader) throw new Error("Rooms SSE stream is unavailable");
      const snapshotEvent = await readSseEvent(streamReader, "room.snapshot");
      expect(snapshotEvent).toMatchObject({
        revision: 2,
        room: { id: creation.room.id, status: "PRE_KICKOFF" },
      });

      const firstCalls = await app.inject({
        headers: { cookie: aliceCookie },
        method: "PUT",
        payload: {
          calls: calls(),
          lock: false,
        },
        url: `/api/v1/rooms/${creation.room.id}/calls`,
      });
      expect(firstCalls.statusCode).toBe(200);
      expect(firstCalls.json()).toMatchObject({
        myCalls: { calls: { goals: { answer: "YES", confidence: 3 } } },
      });

      const editedAndLocked = await app.inject({
        headers: { cookie: aliceCookie },
        method: "PUT",
        payload: {
          calls: calls("NO", "YES", "NO"),
          lock: true,
        },
        url: `/api/v1/rooms/${creation.room.id}/calls`,
      });
      expect(editedAndLocked.statusCode).toBe(200);
      expect(editedAndLocked.json()).toMatchObject({
        myCalls: {
          calls: { goals: { answer: "NO" } },
          lockedAt: expect.any(Number),
        },
      });

      const bobLocked = await app.inject({
        headers: { cookie: bobCookie },
        method: "PUT",
        payload: {
          calls: calls(),
          lock: true,
        },
        url: `/api/v1/rooms/${creation.room.id}/calls`,
      });
      expect(bobLocked.statusCode).toBe(200);

      const updatedEvent = await readSseEvent(streamReader, "room.updated");
      expect(updatedEvent).toMatchObject({
        room: {
          members: expect.arrayContaining([
            expect.objectContaining({ hasCalls: true, id: aliceId }),
          ]),
        },
      });

      const memberTriedToStartReplay = await app.inject({
        headers: { cookie: bobCookie },
        method: "POST",
        url: `/api/v1/rooms/${creation.room.id}/demo/start`,
      });
      expect(memberTriedToStartReplay.statusCode).toBe(403);
      expect(memberTriedToStartReplay.json()).toEqual({
        error: {
          code: "DEMO_HOST_REQUIRED",
          message: "Only the room host can control the replay",
        },
      });

      const started = await app.inject({
        headers: { cookie: aliceCookie },
        method: "POST",
        url: `/api/v1/rooms/${creation.room.id}/demo/start`,
      });
      expect(started.statusCode).toBe(200);
      expect(started.json()).toMatchObject({ status: "LIVE" });

      const resolvedStats = await app.inject({
        headers: { cookie: aliceCookie },
        method: "POST",
        payload: {
          cards: "NO",
          corners: "YES",
          goals: "YES",
          revision: 1,
        },
        url: `/api/v1/rooms/${creation.room.id}/demo/resolve-stats`,
      });
      expect(resolvedStats.statusCode).toBe(200);
      expect(resolvedStats.json()).toMatchObject({
        leaderboard: [
          {
            correctCalls: 3,
            nickname: "Bob",
            provisional: true,
            score: 600,
          },
          {
            correctCalls: 0,
            nickname: "Alice",
            provisional: true,
            score: 0,
          },
        ],
        stats: {
          cards: { answer: "NO", total: 4 },
          corners: { answer: "YES", total: 10 },
          goals: { answer: "YES", total: 3 },
        },
      });

      const registeredMoment = await app.inject({
        headers: { cookie: aliceCookie },
        method: "POST",
        payload: { momentId: "goal-1", revision: 7, varState: "HOLD" },
        url: `/api/v1/rooms/${creation.room.id}/demo/register-moment`,
      });
      expect(registeredMoment.statusCode).toBe(200);

      const reaction = await app.inject({
        headers: { cookie: bobCookie },
        method: "POST",
        payload: {
          kind: "CALLED_IT",
          momentId: "goal-1",
          recipientParticipantId: aliceId,
          revision: 7,
        },
        url: `/api/v1/rooms/${creation.room.id}/reactions`,
      });
      expect(reaction.statusCode).toBe(201);
      expect(reaction.json()).toMatchObject({
        reaction: {
          kind: "CALLED_IT",
          momentId: "goal-1",
          recipientParticipantId: aliceId,
          recipientTeamCode: "ARG",
          revision: 7,
          senderParticipantId: bobId,
          senderTeamCode: "FRA",
          status: "HELD",
        },
      });

      const resolvedMoment = await app.inject({
        headers: { cookie: aliceCookie },
        method: "POST",
        payload: {
          momentId: "goal-1",
          resolution: "CONFIRMED",
          revision: 7,
        },
        url: `/api/v1/rooms/${creation.room.id}/demo/resolve-moment`,
      });
      expect(resolvedMoment.statusCode).toBe(200);
      expect(resolvedMoment.json()).toMatchObject({
        reactions: [{ momentId: "goal-1", revision: 7, status: "VISIBLE" }],
      });

      const finalised = await app.inject({
        headers: { cookie: aliceCookie },
        method: "POST",
        url: `/api/v1/rooms/${creation.room.id}/demo/finalise`,
      });
      expect(finalised.statusCode).toBe(200);
      expect(finalised.json()).toMatchObject({
        leaderboard: [
          {
            correctCalls: 3,
            nickname: "Bob",
            provisional: false,
            score: 600,
          },
          {
            correctCalls: 0,
            nickname: "Alice",
            provisional: false,
            score: 0,
          },
        ],
        status: "FINAL",
      });

      const lockedConflict = await app.inject({
        headers: { cookie: aliceCookie },
        method: "PUT",
        payload: {
          calls: calls(),
          lock: true,
        },
        url: `/api/v1/rooms/${creation.room.id}/calls`,
      });
      expect(lockedConflict.statusCode).toBe(409);
      expect(lockedConflict.json()).toEqual({
        error: { code: "ROOM_FINAL", message: "Room is already final" },
      });
      expect(lockedConflict.body).not.toContain("participant");
    } finally {
      streamAbort.abort();
      runtime.close();
      await app.close();
    }
  });

  it("rejects replay controls for live TxLINE fixtures", async () => {
    const runtime = createProductRuntime({
      cueBytes: Buffer.from("cue"),
      fixture: {
        awayTeam: "ESP",
        fixtureId: "live-fixture",
        homeTeam: "FRA",
        kickoffAt: "2099-07-16T18:00:00.000Z",
        provenance: "live_txline",
      },
      now: () => "2026-07-16T12:00:00.000Z",
      silenceBytes: Buffer.from("silence"),
      writeIntervalMs: 60_000,
    });
    const app = buildApp({ readinessProbe, runtime, webDistPath });
    try {
      const created = await app.inject({
        method: "POST",
        payload: {
          fixtureId: "live-fixture",
          host: {
            nickname: "Alice",
            teamCode: "FRA",
          },
          name: "Live Room",
        },
        url: "/api/v1/rooms",
      });
      const roomId = created.json().room.id as string;
      const cookie = sessionCookie(created);
      const control = await app.inject({
        headers: { cookie },
        method: "POST",
        url: `/api/v1/rooms/${roomId}/demo/start`,
      });
      expect(control.statusCode).toBe(409);
      expect(control.json()).toEqual({
        error: {
          code: "DEMO_CONTROL_DISABLED",
          message: "Demo controls are unavailable for live fixtures",
        },
      });
    } finally {
      runtime.close();
      await app.close();
    }
  });

  it("keeps a replay room creatable after the sample fixture kickoff", async () => {
    const currentTime = Date.parse("2026-07-20T12:00:00.000Z");
    const runtime = createProductRuntime({
      cueBytes: Buffer.from("cue"),
      fixture: {
        awayTeam: "FRA",
        fixtureId: "past-replay-fixture",
        homeTeam: "ARG",
        kickoffAt: "2026-07-16T18:00:00.000Z",
        provenance: "synthetic_txline_shaped",
      },
      now: () => "2026-07-20T12:00:00.000Z",
      silenceBytes: Buffer.from("silence"),
      writeIntervalMs: 60_000,
    });
    const rooms = createRoomService({
      fixture: (fixtureId) => runtime.fixture(fixtureId),
      now: () => currentTime,
    });
    const app = buildApp({ readinessProbe, rooms, runtime, webDistPath });
    try {
      const created = await app.inject({
        method: "POST",
        payload: {
          fixtureId: "past-replay-fixture",
          host: {
            nickname: "Alice",
            teamCode: "ARG",
          },
          name: "Replay Night",
        },
        url: "/api/v1/rooms",
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({
        room: {
          fixture: { kickoffAt: "2026-07-16T18:00:00.000Z" },
          kickoffAt: currentTime + 5 * 60 * 1_000,
          status: "PRE_KICKOFF",
        },
      });
    } finally {
      runtime.close();
      await app.close();
    }
  });
});
