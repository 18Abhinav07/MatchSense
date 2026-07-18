import Fastify from "fastify";
import type { FanRecord, FanSessionRecord } from "@matchsense/db";
import { RoomsDomainError } from "@matchsense/rooms";
import { describe, expect, it, vi } from "vitest";

import { createFanSessionService } from "./fan-session.js";
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
