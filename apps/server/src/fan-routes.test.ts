import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { FanRecord, FanRepository } from "@matchsense/db";

import { registerFanRoutes } from "./fan-routes.js";
import { createFanSessionService } from "./fan-session.js";

function fan(overrides: Partial<FanRecord> = {}): FanRecord {
  return {
    avatarVariant: null,
    createdAt: "2026-07-17T12:00:00.000Z",
    deletedAt: null,
    favoriteTeam: null,
    handle: null,
    handleNormalized: null,
    id: "fan-1",
    preferences: {},
    profile: {},
    updatedAt: "2026-07-17T12:00:00.000Z",
    ...overrides,
  };
}

function harness() {
  let current = fan();
  let storedSession: {
    csrfHash: string;
    expiresAt: string;
    sessionHash: string;
  } | null = null;
  const repository = {
    createGuest: vi.fn(async (input) => {
      storedSession = input;
      return current;
    }),
    deleteFan: vi.fn(async () => true),
    getProfile: vi.fn(async () => current),
    isHandleAvailable: vi.fn(async () => true),
    listFollows: vi.fn(async () => []),
    listFollowers: vi.fn(async () => []),
    removeFollow: vi.fn(async () => true),
    resolveSession: vi.fn(async ({ sessionHash }) => {
      const session = storedSession;
      if (!session || session.sessionHash !== sessionHash) return null;
      return {
        csrfHash: session.csrfHash,
        expiresAt: session.expiresAt,
        fan: current,
        lastSeenAt: "2026-07-17T12:00:00.000Z",
        revokedAt: null,
        sessionHash,
      };
    }),
    touchSession: vi.fn(async () => true),
    updateProfile: vi.fn(async (input) => {
      current = fan({
        avatarVariant: input.avatarVariant,
        favoriteTeam: input.favoriteTeam,
        handle: input.handle,
        handleNormalized: input.handle.toLowerCase(),
        preferences: input.preferences,
        profile: input.profile,
      });
      return current;
    }),
    upsertFollow: vi.fn(async () => undefined),
  } satisfies FanRepository;
  const tokens = [Buffer.alloc(32, 1), Buffer.alloc(32, 2)];
  const sessions = createFanSessionService({
    id: () => "fan-1",
    now: () => new Date("2026-07-17T12:00:00.000Z"),
    randomBytes: () => tokens.shift()!,
    repository,
  });
  return { repository, sessions };
}

function cookies(value: string | string[] | undefined) {
  return (Array.isArray(value) ? value : value ? [value] : [])
    .map((entry) => entry.split(";", 1)[0])
    .join("; ");
}

describe("fan identity and profile routes", () => {
  it("issues an HttpOnly guest session, a readable CSRF cookie, and bootstrap", async () => {
    const deps = harness();
    const app = Fastify();
    registerFanRoutes(app, deps);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/session/guest",
    });

    expect(created.statusCode).toBe(201);
    const setCookie = created.headers["set-cookie"];
    expect(setCookie).toEqual(
      expect.arrayContaining([
        expect.stringContaining("matchsense_session="),
        expect.stringContaining("matchsense_csrf="),
      ]),
    );
    expect((setCookie as string[])[0]).toContain("HttpOnly");

    const bootstrap = await app.inject({
      headers: { cookie: cookies(setCookie) },
      method: "GET",
      url: "/api/v1/bootstrap",
    });
    expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json()).toMatchObject({
      fan: { id: "fan-1" },
      follows: [],
      memories: [],
      rooms: [],
    });
    await app.close();
  });

  it("requires CSRF for profile mutation and persists a unique handle/team avatar", async () => {
    const deps = harness();
    const app = Fastify();
    registerFanRoutes(app, deps);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/session/guest",
    });
    const setCookie = created.headers["set-cookie"] as string[];
    const cookie = cookies(setCookie);
    const csrf = setCookie
      .find((entry) => entry.startsWith("matchsense_csrf="))!
      .split(";", 1)[0]!
      .split("=")[1]!;

    const denied = await app.inject({
      headers: { cookie },
      method: "PATCH",
      payload: {
        avatarVariant: "argentina-sun",
        favoriteTeam: "ARG",
        handle: "Abhinav",
      },
      url: "/api/v1/profile",
    });
    expect(denied.statusCode).toBe(403);

    const updated = await app.inject({
      headers: { cookie, "x-matchsense-csrf": csrf },
      method: "PATCH",
      payload: {
        avatarVariant: "argentina-sun",
        favoriteTeam: "ARG",
        handle: "Abhinav",
        preferences: { commentary: true },
        profile: { displayName: "Abhinav" },
      },
      url: "/api/v1/profile",
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      avatarVariant: "argentina-sun",
      favoriteTeam: "ARG",
      handle: "Abhinav",
    });
    expect(deps.repository.updateProfile).toHaveBeenCalledOnce();
    await app.close();
  });

  it("persists fixture following independently from notification permission", async () => {
    const deps = harness();
    const app = Fastify();
    registerFanRoutes(app, deps);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/session/guest",
    });
    const setCookie = created.headers["set-cookie"] as string[];
    const cookie = cookies(setCookie);
    const csrf = setCookie
      .find((entry) => entry.startsWith("matchsense_csrf="))!
      .split(";", 1)[0]!
      .split("=")[1]!;
    const headers = { cookie, "x-matchsense-csrf": csrf };

    const followed = await app.inject({
      headers,
      method: "PUT",
      payload: {
        eventPreferences: {
          fullTime: true,
          goals: true,
          redCards: false,
        },
      },
      url: "/api/v1/follows/demo/experience%3Arun-1",
    });
    expect(followed.statusCode).toBe(204);
    expect(deps.repository.upsertFollow).toHaveBeenCalledWith({
      eventPreferences: {
        fullTime: true,
        goals: true,
        redCards: false,
      },
      fanId: "fan-1",
      fixtureId: "experience:run-1",
      mode: "demo",
    });

    const removed = await app.inject({
      headers,
      method: "DELETE",
      url: "/api/v1/follows/demo/experience%3Arun-1",
    });
    expect(removed.statusCode).toBe(204);
    expect(deps.repository.removeFollow).toHaveBeenCalledWith({
      fanId: "fan-1",
      fixtureId: "experience:run-1",
      mode: "demo",
    });
    await app.close();
  });
});
