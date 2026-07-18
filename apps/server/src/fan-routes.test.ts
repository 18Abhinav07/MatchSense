import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type {
  FanRecord,
  FanRepository,
  FixtureReadRepository,
  FixtureReadSnapshot,
} from "@matchsense/db";

import { isInvalidRawFollowPath, registerFanRoutes } from "./fan-routes.js";
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

function fixtureSnapshot(
  overrides: Partial<FixtureReadSnapshot> = {},
): FixtureReadSnapshot {
  return {
    archiveManifestId: null,
    bucket: "upcoming",
    fixtureId: "fixture-live",
    lifecycle: "scheduled",
    metadata: {},
    mode: "live",
    projection: null,
    provenance: "live_txline",
    replayReady: false,
    scheduledAt: "2026-07-19T12:00:00.000Z",
    teams: { away: "FRA", home: "ARG" },
    ...overrides,
  };
}

function harness({
  snapshot = fixtureSnapshot(),
}: {
  snapshot?: FixtureReadSnapshot | null;
} = {}) {
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
  const fixtureReads = {
    getFixture: vi.fn(async () => snapshot),
  } satisfies Pick<FixtureReadRepository, "getFixture">;
  const tokens = [Buffer.alloc(32, 1), Buffer.alloc(32, 2)];
  const sessions = createFanSessionService({
    id: () => "fan-1",
    now: () => new Date("2026-07-17T12:00:00.000Z"),
    randomBytes: () => tokens.shift()!,
    repository,
  });
  return { fixtureReads, repository, sessions };
}

function cookies(value: string | string[] | undefined) {
  return (Array.isArray(value) ? value : value ? [value] : [])
    .map((entry) => entry.split(";", 1)[0])
    .join("; ");
}

async function fanMutationHeaders(app: ReturnType<typeof Fastify>) {
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/session/guest",
  });
  const setCookie = created.headers["set-cookie"] as string[];
  return {
    cookie: cookies(setCookie),
    "x-matchsense-csrf": setCookie
      .find((entry) => entry.startsWith("matchsense_csrf="))!
      .split(";", 1)[0]!
      .split("=")[1]!,
  };
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

  it("deletes an authenticated profile without a request body and clears its cookies", async () => {
    const deps = harness();
    const app = Fastify();
    registerFanRoutes(app, deps);
    const headers = await fanMutationHeaders(app);

    const removed = await app.inject({
      headers,
      method: "DELETE",
      url: "/api/v1/profile",
    });

    expect(removed.statusCode).toBe(204);
    expect(deps.repository.deleteFan).toHaveBeenCalledWith("fan-1");
    expect(removed.headers["set-cookie"]).toEqual(
      expect.arrayContaining([
        "matchsense_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
        "matchsense_csrf=; Path=/; Max-Age=0; SameSite=Strict",
      ]),
    );
    await app.close();
  });

  it("follows a public live TxLINE upcoming fixture", async () => {
    const deps = harness();
    const app = Fastify();
    registerFanRoutes(app, deps);
    const headers = await fanMutationHeaders(app);

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
      url: "/api/v1/follows/live/fixture-live",
    });
    expect(followed.statusCode).toBe(204);
    expect(deps.fixtureReads.getFixture).toHaveBeenCalledWith({
      fixtureId: "fixture-live",
      mode: "live",
    });
    expect(deps.repository.upsertFollow).toHaveBeenCalledWith({
      eventPreferences: {
        fullTime: true,
        goals: true,
        redCards: false,
      },
      fanId: "fan-1",
      fixtureId: "fixture-live",
      mode: "live",
    });

    await app.close();
  });

  it("follows a public live TxLINE live fixture with dotted and colon ID characters", async () => {
    const fixtureId = "fixture.live:1";
    const deps = harness({
      snapshot: fixtureSnapshot({
        bucket: "live",
        fixtureId,
        lifecycle: "live",
      }),
    });
    const app = Fastify();
    registerFanRoutes(app, deps);
    const headers = await fanMutationHeaders(app);

    const followed = await app.inject({
      headers,
      method: "PUT",
      payload: { eventPreferences: {} },
      url: `/api/v1/follows/live/${encodeURIComponent(fixtureId)}`,
    });

    expect(followed.statusCode).toBe(204);
    expect(deps.fixtureReads.getFixture).toHaveBeenCalledWith({
      fixtureId,
      mode: "live",
    });
    expect(deps.repository.upsertFollow).toHaveBeenCalledWith({
      eventPreferences: { fullTime: true, goals: true, redCards: true },
      fanId: "fan-1",
      fixtureId,
      mode: "live",
    });
    await app.close();
  });

  it.each(["demo", "recorded"] as const)(
    "rejects %s mode for follow creation and removal",
    async (mode) => {
      const deps = harness();
      const app = Fastify();
      registerFanRoutes(app, deps);
      const headers = await fanMutationHeaders(app);

      const followed = await app.inject({
        headers,
        method: "PUT",
        payload: { eventPreferences: {} },
        url: `/api/v1/follows/${mode}/fixture-live`,
      });
      const removed = await app.inject({
        headers,
        method: "DELETE",
        url: `/api/v1/follows/${mode}/fixture-live`,
      });

      expect(followed.statusCode).toBe(400);
      expect(followed.json()).toEqual({ error: "follow_invalid" });
      expect(removed.statusCode).toBe(400);
      expect(removed.json()).toEqual({ error: "follow_invalid" });
      expect(deps.fixtureReads.getFixture).not.toHaveBeenCalled();
      expect(deps.repository.upsertFollow).not.toHaveBeenCalled();
      expect(deps.repository.removeFollow).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it("rejects malformed follow fixture identities", async () => {
    const deps = harness();
    const app = Fastify();
    registerFanRoutes(app, deps);
    const headers = await fanMutationHeaders(app);

    const followed = await app.inject({
      headers,
      method: "PUT",
      payload: { eventPreferences: {} },
      url: "/api/v1/follows/live/fixture!invalid",
    });
    const removed = await app.inject({
      headers,
      method: "DELETE",
      url: "/api/v1/follows/live/fixture!invalid",
    });

    expect(followed.statusCode).toBe(400);
    expect(followed.json()).toEqual({ error: "follow_invalid" });
    expect(removed.statusCode).toBe(400);
    expect(removed.json()).toEqual({ error: "follow_invalid" });
    expect(deps.fixtureReads.getFixture).not.toHaveBeenCalled();
    expect(deps.repository.upsertFollow).not.toHaveBeenCalled();
    expect(deps.repository.removeFollow).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ["decoded percent", "fixture%25invalid"],
    ["encoded slash", "fixture%2Finvalid"],
  ])("rejects %s fixture identities", async (_kind, encodedFixtureId) => {
    const deps = harness();
    const app = Fastify();
    registerFanRoutes(app, deps);
    const headers = await fanMutationHeaders(app);

    const followed = await app.inject({
      headers,
      method: "PUT",
      payload: { eventPreferences: {} },
      url: `/api/v1/follows/live/${encodedFixtureId}`,
    });

    expect(followed.statusCode).toBe(400);
    expect(followed.json()).toEqual({ error: "follow_invalid" });
    expect(deps.fixtureReads.getFixture).not.toHaveBeenCalled();
    expect(deps.repository.upsertFollow).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ["raw dot", "/api/v1/follows/live/."],
    ["raw parent", "/api/v1/follows/live/.."],
    ["encoded dot", "/api/v1/follows/live/%2E"],
    ["encoded parent", "/api/v1/follows/live/%2E%2E"],
    ["mixed parent", "/api/v1/follows/live/.%2E"],
    ["encoded dot mode", "/api/v1/follows/%2E/fixture-live"],
    ["encoded slash", "/api/v1/follows/live/fixture%2Finvalid"],
    ["malformed escape", "/api/v1/follows/live/%ZZ"],
  ] as const)("identifies %s raw follow target as invalid", (_kind, rawUrl) => {
    expect(isInvalidRawFollowPath(rawUrl)).toBe(true);
  });

  it.each([
    ["valid dotted ID", "/api/v1/follows/live/fixture.live%3A1"],
    ["missing fixture segment", "/api/v1/follows/live"],
    ["additional path segment", "/api/v1/follows/live/fixture/extra"],
    ["unrelated path", "/api/v1/profile/%2E%2E"],
  ] as const)(
    "does not flag %s as an invalid raw follow target",
    (_kind, rawUrl) => {
      expect(isInvalidRawFollowPath(rawUrl)).toBe(false);
    },
  );

  it.each([
    ["unknown", null],
    [
      "final",
      fixtureSnapshot({
        bucket: "final",
        fixtureId: "fixture-live",
        lifecycle: "final",
      }),
    ],
    [
      "recorded",
      fixtureSnapshot({
        archiveManifestId: "archive-1",
        bucket: "final",
        fixtureId: "fixture-live",
        lifecycle: "final",
        mode: "recorded",
        provenance: "recorded_txline_authorised",
        replayReady: true,
      }),
    ],
  ] as const)(
    "does not follow a %s or non-followable fixture",
    async (_kind, snapshot) => {
      const deps = harness({ snapshot });
      const app = Fastify();
      registerFanRoutes(app, deps);
      const headers = await fanMutationHeaders(app);

      const followed = await app.inject({
        headers,
        method: "PUT",
        payload: { eventPreferences: {} },
        url: "/api/v1/follows/live/fixture-live",
      });

      expect(followed.statusCode).toBe(404);
      expect(followed.json()).toEqual({ error: "follow_fixture_not_found" });
      expect(deps.fixtureReads.getFixture).toHaveBeenCalledWith({
        fixtureId: "fixture-live",
        mode: "live",
      });
      expect(deps.repository.upsertFollow).not.toHaveBeenCalled();
      await app.close();
    },
  );

  it("does not follow a live upcoming fixture with recorded provenance", async () => {
    const deps = harness({
      snapshot: fixtureSnapshot({
        mode: "live",
        provenance: "recorded_txline_authorised",
      }),
    });
    const app = Fastify();
    registerFanRoutes(app, deps);
    const headers = await fanMutationHeaders(app);

    const followed = await app.inject({
      headers,
      method: "PUT",
      payload: { eventPreferences: {} },
      url: "/api/v1/follows/live/fixture-live",
    });

    expect(followed.statusCode).toBe(404);
    expect(followed.json()).toEqual({ error: "follow_fixture_not_found" });
    expect(deps.repository.upsertFollow).not.toHaveBeenCalled();
    await app.close();
  });

  it("does not follow an otherwise eligible snapshot with recorded mode", async () => {
    const deps = harness({
      snapshot: fixtureSnapshot({ mode: "recorded" }),
    });
    const app = Fastify();
    registerFanRoutes(app, deps);
    const headers = await fanMutationHeaders(app);

    const followed = await app.inject({
      headers,
      method: "PUT",
      payload: { eventPreferences: {} },
      url: "/api/v1/follows/live/fixture-live",
    });

    expect(followed.statusCode).toBe(404);
    expect(followed.json()).toEqual({ error: "follow_fixture_not_found" });
    expect(deps.repository.upsertFollow).not.toHaveBeenCalled();
    await app.close();
  });

  it("removes a live follow even after its fixture has disappeared", async () => {
    const deps = harness({ snapshot: null });
    const app = Fastify();
    registerFanRoutes(app, deps);
    const headers = await fanMutationHeaders(app);

    const removed = await app.inject({
      headers,
      method: "DELETE",
      url: "/api/v1/follows/live/fixture-live",
    });
    expect(removed.statusCode).toBe(204);
    expect(deps.fixtureReads.getFixture).not.toHaveBeenCalled();
    expect(deps.repository.removeFollow).toHaveBeenCalledWith({
      fanId: "fan-1",
      fixtureId: "fixture-live",
      mode: "live",
    });
    await app.close();
  });
});
