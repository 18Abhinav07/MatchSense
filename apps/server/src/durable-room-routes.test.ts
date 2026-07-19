import Fastify from "fastify";
import type { FanRecord, FanSessionRecord } from "@matchsense/db";
import { RoomsDomainError } from "@matchsense/rooms";
import { describe, expect, it, vi } from "vitest";

import { createFanSessionService } from "./fan-session.js";
import { RoomServiceError } from "./room-service.js";
import {
  registerDurableRoomRoutes,
  type DurableRoomRouteDependencies,
} from "./durable-room-routes.js";

function fanRecord(id: string): FanRecord {
  return {
    avatarVariant: null,
    createdAt: "2026-07-17T10:00:00.000Z",
    deletedAt: null,
    favoriteTeam: null,
    handle: null,
    handleNormalized: null,
    id,
    preferences: {},
    profile: {},
    updatedAt: "2026-07-17T10:00:00.000Z",
  };
}

function fanSessions() {
  const stored = new Map<string, FanSessionRecord>();
  let id = 0;
  return createFanSessionService({
    id: () => `fan-${++id}`,
    now: () => new Date("2026-07-17T10:00:00.000Z"),
    randomBytes: (size) => Buffer.alloc(size, id + 1),
    repository: {
      createGuest: async (input) => {
        const fan = fanRecord(input.fanId);
        stored.set(input.sessionHash, {
          csrfHash: input.csrfHash,
          expiresAt: input.expiresAt,
          fan,
          lastSeenAt: fan.createdAt,
          revokedAt: null,
          sessionHash: input.sessionHash,
        });
        return fan;
      },
      resolveSession: async ({ sessionHash }) =>
        stored.get(sessionHash) ?? null,
    },
  });
}

function serviceStub(overrides = {}) {
  return {
    create: vi.fn(async (input) => ({
      inviteCode: "BwcHBwcHBwcHBwcHBwcHBw",
      invitePath: "/rooms/join/BwcHBwcHBwcHBwcHBwcHBw",
      owner: input.host.fanId,
      room: { id: "room-1" },
    })),
    get: vi.fn(),
    join: vi.fn(),
    list: vi.fn(async () => []),
    lockCalls: vi.fn(async (input) => ({ roomId: input.roomId })),
    preview: vi.fn(),
    react: vi.fn(async (input) => ({
      reaction: { id: "reaction-1" },
      room: { id: input.roomId },
    })),
    setCalls: vi.fn(async (input) => ({ roomId: input.roomId })),
    subscribe: vi.fn(async () => () => undefined),
    ...overrides,
  } satisfies DurableRoomRouteDependencies["service"];
}

describe("durable Call Three Room routes", () => {
  it("accepts the complete durable team-code contract for a roster team", async () => {
    const sessions = fanSessions();
    const host = await sessions.createGuest();
    const service = serviceStub();
    const app = Fastify();
    registerDurableRoomRoutes(app, { service, sessions });

    const response = await app.inject({
      headers: {
        cookie: `matchsense_session=${host.sessionToken}`,
        "x-matchsense-csrf": host.csrfToken,
      },
      method: "POST",
      payload: {
        fixtureId: "live-fixture-1",
        host: { nickname: "Abhinav", teamCode: "ALP-PARTICIPANT123" },
        name: "Roster-safe Room",
      },
      url: "/api/v1/rooms",
    });

    expect(response.statusCode).toBe(201);
    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({
        host: expect.objectContaining({ teamCode: "ALP-PARTICIPANT123" }),
      }),
    );
    await app.close();
  });

  it("owns Room creation and Call Three mutations through the fan session plus CSRF", async () => {
    const sessions = fanSessions();
    const host = await sessions.createGuest();
    const service = serviceStub();
    const app = Fastify();
    registerDurableRoomRoutes(app, { service, sessions });

    const spoofed = await app.inject({
      headers: { "x-matchsense-fan-id": "fan-attacker" },
      method: "POST",
      payload: {
        fixtureId: "live-fixture-1",
        host: { nickname: "Attacker", teamCode: "ARG" },
        name: "Spoofed Room",
      },
      url: "/api/v1/rooms",
    });
    expect(spoofed.statusCode).toBe(401);
    expect(service.create).not.toHaveBeenCalled();

    const cookie = `matchsense_session=${host.sessionToken}`;
    const missingCsrf = await app.inject({
      headers: { cookie },
      method: "PUT",
      payload: { calls: [] },
      url: "/api/v1/rooms/room-1/calls",
    });
    expect(missingCsrf.statusCode).toBe(403);

    const created = await app.inject({
      headers: {
        cookie,
        "x-matchsense-csrf": host.csrfToken,
        "x-matchsense-fan-id": "fan-attacker",
      },
      method: "POST",
      payload: {
        fixtureId: "live-fixture-1",
        host: { nickname: "Abhinav", teamCode: "ARG" },
        name: "Final night",
      },
      url: "/api/v1/rooms",
    });
    expect(created.statusCode).toBe(201);
    expect(service.create).toHaveBeenCalledWith({
      fixtureId: "live-fixture-1",
      host: { fanId: host.fan.id, nickname: "Abhinav", teamCode: "ARG" },
      name: "Final night",
    });

    const calls = [
      { answer: "HOME", confidence: 3, target: "result" },
      { answer: "YES", confidence: 2, target: "goals" },
      { answer: "NO", confidence: 1, target: "cards" },
    ];
    const saved = await app.inject({
      headers: { cookie, "x-matchsense-csrf": host.csrfToken },
      method: "PUT",
      payload: { calls },
      url: "/api/v1/rooms/room-1/calls",
    });
    expect(saved.statusCode).toBe(200);
    expect(service.setCalls).toHaveBeenCalledWith({
      calls,
      fanId: host.fan.id,
      roomId: "room-1",
    });

    const locked = await app.inject({
      headers: { cookie, "x-matchsense-csrf": host.csrfToken },
      method: "POST",
      payload: {},
      url: "/api/v1/rooms/room-1/calls/lock",
    });
    expect(locked.statusCode).toBe(200);
    expect(service.lockCalls).toHaveBeenCalledWith({
      fanId: host.fan.id,
      roomId: "room-1",
    });
    await app.close();
  });

  it("rejects invalid Call Three shapes before the service receives them", async () => {
    const sessions = fanSessions();
    const host = await sessions.createGuest();
    const service = serviceStub();
    const app = Fastify();
    registerDurableRoomRoutes(app, { service, sessions });

    const response = await app.inject({
      headers: {
        cookie: `matchsense_session=${host.sessionToken}`,
        "x-matchsense-csrf": host.csrfToken,
      },
      method: "PUT",
      payload: {
        calls: [
          { answer: "YES", confidence: 3, target: "goals" },
          { answer: "NO", confidence: 3, target: "cards" },
        ],
      },
      url: "/api/v1/rooms/room-1/calls",
    });

    expect(response.statusCode).toBe(400);
    expect(service.setCalls).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not expose the retired Experience, pick allocation, or manual-start controls", async () => {
    const sessions = fanSessions();
    const host = await sessions.createGuest();
    const prepareExperienceRoom = vi.fn();
    const service = serviceStub();
    const app = Fastify();
    registerDurableRoomRoutes(app, {
      prepareExperienceRoom,
      service,
      sessions,
    });

    const headers = {
      cookie: `matchsense_session=${host.sessionToken}`,
      "x-matchsense-csrf": host.csrfToken,
    };
    for (const url of [
      "/api/v1/experience/rooms",
      "/api/v1/rooms/room-1/picks/open",
      "/api/v1/rooms/room-1/demo/start",
    ]) {
      const response = await app.inject({
        headers,
        method: "POST",
        payload: {},
        url,
      });
      expect(response.statusCode).toBe(404);
    }
    expect(prepareExperienceRoom).not.toHaveBeenCalled();
    await app.close();
  });

  it("exposes the isolated Experience Room lifecycle through fan sessions and CSRF", async () => {
    const sessions = fanSessions();
    const host = await sessions.createGuest();
    const experience = {
      create: vi.fn(async (input) => ({
        inviteCode: "BwcHBwcHBwcHBwcHBwcHBw",
        invitePath: "/experience/rooms/join/BwcHBwcHBwcHBwcHBwcHBw",
        owner: input.host.fanId,
        room: { id: "experience-room" },
      })),
      get: vi.fn(async () => ({ id: "experience-room" })),
      join: vi.fn(async (input) => ({ viewerParticipantId: input.fanId })),
      list: vi.fn(async () => []),
      lockCalls: vi.fn(async () => ({ id: "experience-room" })),
      preview: vi.fn(async () => ({ roomId: "experience-room" })),
      react: vi.fn(async () => ({ reaction: { id: "reaction" } })),
      setCalls: vi.fn(async () => ({ id: "experience-room" })),
      start: vi.fn(async () => ({ id: "experience-room", status: "LIVE" })),
      subscribe: vi.fn(async () => () => undefined),
    };
    const app = Fastify();
    registerDurableRoomRoutes(app, {
      experience: experience as never,
      service: serviceStub(),
      sessions,
    });
    const headers = {
      cookie: `matchsense_session=${host.sessionToken}`,
      "x-matchsense-csrf": host.csrfToken,
    };

    const created = await app.inject({
      headers,
      method: "POST",
      payload: {
        awayTeam: "FRA",
        homeTeam: "ARG",
        host: { nickname: "Abhinav", teamCode: "ARG" },
        name: "Experience finals",
      },
      url: "/api/v1/experience/rooms",
    });
    expect(created.statusCode).toBe(201);
    expect(experience.create).toHaveBeenCalledWith({
      awayTeam: "FRA",
      homeTeam: "ARG",
      host: { fanId: host.fan.id, nickname: "Abhinav", teamCode: "ARG" },
      name: "Experience finals",
    });

    const started = await app.inject({
      headers,
      method: "POST",
      payload: {},
      url: "/api/v1/experience/rooms/experience-room/start",
    });
    expect(started.statusCode).toBe(200);
    expect(experience.start).toHaveBeenCalledWith({
      fanId: host.fan.id,
      roomId: "experience-room",
    });
    await app.close();
  });

  it("rejects an Experience Room SSE nonmember before committing stream headers", async () => {
    const sessions = fanSessions();
    const fan = await sessions.createGuest();
    const experience = {
      ...serviceStub(),
      start: vi.fn(),
      subscribe: vi.fn(async () => {
        throw new RoomServiceError(
          "ROOM_SESSION_REQUIRED",
          403,
          "This fan is not a Room member",
        );
      }),
    };
    const app = Fastify();
    registerDurableRoomRoutes(app, {
      experience: experience as never,
      service: serviceStub(),
      sessions,
    });

    const response = await app.inject({
      headers: { cookie: `matchsense_session=${fan.sessionToken}` },
      url: "/api/v1/experience/rooms/experience-room/stream",
    });
    expect(response.statusCode).toBe(403);
    expect(response.headers["content-type"]).toContain("application/json");
    await app.close();
  });

  it("returns a safe conflict when a fixture is not eligible for Call Three", async () => {
    const sessions = fanSessions();
    const host = await sessions.createGuest();
    const service = serviceStub({
      create: vi.fn(async () => {
        throw new RoomsDomainError(
          "ROOM_NOT_ELIGIBLE",
          "Call Three requires a scheduled live fixture",
        );
      }),
    });
    const app = Fastify();
    registerDurableRoomRoutes(app, { service, sessions });

    const response = await app.inject({
      headers: {
        cookie: `matchsense_session=${host.sessionToken}`,
        "x-matchsense-csrf": host.csrfToken,
      },
      method: "POST",
      payload: {
        fixtureId: "recorded-fixture",
        host: { nickname: "Abhinav" },
        name: "No replay calls",
      },
      url: "/api/v1/rooms",
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: "ROOM_NOT_ELIGIBLE" },
    });
    await app.close();
  });
});
