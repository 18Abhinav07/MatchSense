import { describe, expect, it, vi } from "vitest";

import type { FanRepository } from "@matchsense/db";

import { createFanSessionService } from "./fan-session.js";

function repositoryHarness() {
  const createGuest = vi.fn(
    async (input: Parameters<FanRepository["createGuest"]>[0]) => ({
      avatarVariant: null,
      createdAt: "2026-07-17T12:00:00.000Z",
      deletedAt: null,
      favoriteTeam: null,
      handle: null,
      handleNormalized: null,
      id: input.fanId,
      preferences: {},
      profile: {},
      updatedAt: "2026-07-17T12:00:00.000Z",
    }),
  );
  const resolveSession = vi.fn<FanRepository["resolveSession"]>(
    async () => null,
  );
  return {
    createGuest,
    repository: { createGuest, resolveSession } as Pick<
      FanRepository,
      "createGuest" | "resolveSession"
    >,
    resolveSession,
  };
}

describe("fan session service", () => {
  it("creates opaque session and CSRF tokens while persisting only hashes", async () => {
    const harness = repositoryHarness();
    const tokens = [Buffer.alloc(32, 1), Buffer.alloc(32, 2)];
    const service = createFanSessionService({
      id: () => "fan-1",
      now: () => new Date("2026-07-17T12:00:00.000Z"),
      randomBytes: () => tokens.shift()!,
      repository: harness.repository,
    });

    const session = await service.createGuest();

    expect(session.fan.id).toBe("fan-1");
    expect(session.sessionToken).not.toMatch(/^[a-f0-9]{64}$/u);
    expect(session.csrfToken).not.toMatch(/^[a-f0-9]{64}$/u);
    expect(harness.createGuest).toHaveBeenCalledWith({
      csrfHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      expiresAt: "2026-08-16T12:00:00.000Z",
      fanId: "fan-1",
      sessionHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(harness.createGuest.mock.calls[0]?.[0].sessionHash).not.toBe(
      session.sessionToken,
    );
  });

  it("resolves a raw cookie through its hash and validates CSRF in constant-shape form", async () => {
    const harness = repositoryHarness();
    const service = createFanSessionService({ repository: harness.repository });
    const rawSession = "opaque-session";
    const rawCsrf = "opaque-csrf";
    harness.resolveSession.mockResolvedValueOnce({
      csrfHash: service.hash(rawCsrf),
      expiresAt: "2026-08-16T12:00:00.000Z",
      fan: {
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
      },
      lastSeenAt: "2026-07-17T12:00:00.000Z",
      revokedAt: null,
      sessionHash: service.hash(rawSession),
    });

    const resolved = await service.resolve(rawSession);

    expect(harness.resolveSession).toHaveBeenCalledWith({
      sessionHash: service.hash(rawSession),
    });
    expect(service.verifyCsrf(resolved!, rawCsrf)).toBe(true);
    expect(service.verifyCsrf(resolved!, "wrong")).toBe(false);
  });
});
