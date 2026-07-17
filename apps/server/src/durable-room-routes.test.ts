import Fastify from "fastify";
import type { FanRecord, FanSessionRecord } from "@matchsense/db";
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
  const service = createFanSessionService({
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
  return service;
}

describe("durable Room routes", () => {
  it("ignores spoofed fan headers and owns every mutation through session plus CSRF", async () => {
    const sessions = fanSessions();
    const host = await sessions.createGuest();
    const create = vi.fn(async (input) => ({
      inviteCode: "BwcHBwcHBwcHBwcHBwcHBw",
      invitePath: "/rooms/join/BwcHBwcHBwcHBwcHBwcHBw",
      owner: input.host.fanId,
      room: { id: "room-1" },
    }));
    const react = vi.fn(async (input) => ({
      reaction: { id: "reaction-1" },
      room: { id: input.roomId },
    }));
    const service = {
      create,
      get: vi.fn(),
      join: vi.fn(),
      list: vi.fn(async () => []),
      openPicks: vi.fn(),
      preview: vi.fn(),
      react,
      saveSensePicks: vi.fn(),
      startExperience: vi.fn(),
      subscribe: vi.fn(async () => () => undefined),
    } satisfies DurableRoomRouteDependencies["service"];
    const app = Fastify();
    registerDurableRoomRoutes(app, { service, sessions });

    const spoofed = await app.inject({
      headers: { "x-matchsense-fan-id": "fan-attacker" },
      method: "POST",
      payload: {
        fixtureId: "experience:run-1",
        host: { nickname: "Attacker", teamCode: "ARG" },
        name: "Spoofed room",
      },
      url: "/api/v1/rooms",
    });
    expect(spoofed.statusCode).toBe(401);
    expect(create).not.toHaveBeenCalled();

    const cookie = `matchsense_session=${host.sessionToken}`;
    const missingCsrf = await app.inject({
      headers: { cookie },
      method: "POST",
      payload: {
        fixtureId: "experience:run-1",
        host: { nickname: "Abhinav", teamCode: "ARG" },
        name: "Final night",
      },
      url: "/api/v1/rooms",
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
        fixtureId: "experience:run-1",
        host: { nickname: "Abhinav", teamCode: "ARG" },
        name: "Final night",
      },
      url: "/api/v1/rooms",
    });
    expect(created.statusCode).toBe(201);
    expect(create).toHaveBeenCalledWith({
      fixtureId: "experience:run-1",
      host: { fanId: host.fan.id, nickname: "Abhinav", teamCode: "ARG" },
      name: "Final night",
    });

    const listed = await app.inject({
      headers: { cookie },
      method: "GET",
      url: "/api/v1/rooms",
    });
    expect(listed.statusCode).toBe(200);
    expect(service.list).toHaveBeenCalledWith(host.fan.id);

    const reaction = await app.inject({
      headers: {
        cookie,
        "x-matchsense-csrf": host.csrfToken,
        "x-matchsense-fan-id": "fan-attacker",
      },
      method: "POST",
      payload: {
        kind: "ROAR",
        momentId: "goal-1",
        recipientParticipantId: "fan-friend",
        revision: 1,
      },
      url: "/api/v1/rooms/room-1/reactions",
    });
    expect(reaction.statusCode).toBe(201);
    expect(react).toHaveBeenCalledWith({
      fanId: host.fan.id,
      kind: "ROAR",
      momentId: "goal-1",
      recipientParticipantId: "fan-friend",
      revision: 1,
      roomId: "room-1",
    });
    await app.close();
  });
});
