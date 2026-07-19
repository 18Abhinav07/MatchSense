import { describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { createProductRuntime } from "./product-runtime.js";

describe("production live listening registration", () => {
  it("dispatches a real fixture session through the authenticated live runtime", async () => {
    const liveSession = {
      awayTeam: "ARG",
      createdAt: "2026-07-19T19:00:00.000Z",
      fixtureId: "18257739",
      homeTeam: "ESP",
      id: "live-session-1",
      perspectiveTeam: "ESP",
      sourceLabel: "TXLINE · LIVE" as const,
      state: "listening" as const,
    };
    const liveListening = {
      attach: vi.fn(() => true),
      createSession: vi.fn(async () => liveSession),
      pollOnce: vi.fn(async () => undefined),
      removeSession: vi.fn((id: string, fanId: string) =>
        id === liveSession.id && fanId === "fan-1" ? true : false,
      ),
      session: vi.fn((id: string, fanId: string) =>
        id === liveSession.id && fanId === "fan-1" ? liveSession : null,
      ),
      stop: vi.fn(),
    };
    const fan = {
      avatarVariant: "esp",
      createdAt: "2026-07-19T18:00:00.000Z",
      deletedAt: null,
      favoriteTeam: "ESP",
      handle: "fan_one",
      handleNormalized: "fan_one",
      id: "fan-1",
      preferences: {},
      profile: {},
      updatedAt: "2026-07-19T18:00:00.000Z",
    };
    const sessions = {
      createGuest: vi.fn(),
      hash: vi.fn(),
      resolve: vi.fn(async (token: string) =>
        token === "fan-token"
          ? {
              csrfHash: "hash",
              expiresAt: "2099-01-01T00:00:00.000Z",
              fan,
              lastSeenAt: "2026-07-19T18:00:00.000Z",
              revokedAt: null,
              sessionHash: "session-hash",
            }
          : null,
      ),
      verifyCsrf: vi.fn((_session: unknown, token: string) => token === "csrf"),
    };
    const runtime = createProductRuntime({
      cueBytes: Buffer.from("cue"),
      silenceBytes: Buffer.from("silence"),
      writeIntervalMs: 60_000,
    });
    const app = buildApp({
      demo: false,
      experience: { close: vi.fn() } as never,
      experienceRuntime: runtime,
      fan: {
        fixtureReads: {},
        repository: { listFollows: vi.fn(async () => []) },
        sessions,
      } as never,
      liveListening,
      readinessProbe: {
        check: async () => ({ databaseReachable: true, migrationsCurrent: true }),
      },
      webDistPath: "/tmp/matchsense-missing-web-dist",
    });
    const mutationHeaders = {
      cookie: "matchsense_session=fan-token",
      "x-matchsense-csrf": "csrf",
    };

    const created = await app.inject({
      headers: mutationHeaders,
      method: "POST",
      payload: { perspectiveTeam: "ESP" },
      url: "/api/v1/fixtures/18257739/listening-sessions",
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      fixtureId: "18257739",
      id: "live-session-1",
      perspectiveTeam: "ESP",
    });
    expect(liveListening.createSession).toHaveBeenCalledWith({
      fanId: "fan-1",
      fixtureId: "18257739",
      perspectiveTeam: "ESP",
    });

    const read = await app.inject({
      headers: { cookie: mutationHeaders.cookie },
      url: "/api/v1/listening-sessions/live-session-1",
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({ id: "live-session-1" });

    const removed = await app.inject({
      headers: mutationHeaders,
      method: "DELETE",
      url: "/api/v1/listening-sessions/live-session-1",
    });
    expect(removed.statusCode).toBe(204);
    expect(liveListening.removeSession).toHaveBeenCalledWith(
      "live-session-1",
      "fan-1",
    );
    await app.close();
    expect(liveListening.stop).toHaveBeenCalledOnce();
  });
});
