import { describe, expect, it, vi } from "vitest";

import { createFanProfileApi, needsProfileCompletion } from "./fan-profile.js";

const fan = {
  avatarVariant: null,
  createdAt: "2026-07-17T08:00:00.000Z",
  deletedAt: null,
  favoriteTeam: null,
  handle: null,
  handleNormalized: null,
  id: "fan-1",
  preferences: {},
  profile: {},
  updatedAt: "2026-07-17T08:00:00.000Z",
};

describe("fan profile client", () => {
  it("requests only minimal completion when an incomplete fan deep-links", () => {
    expect(needsProfileCompletion(null, "/matches/final/moments/goal:1")).toBe(
      true,
    );
    expect(needsProfileCompletion(fan, "/rooms/join/finals-night")).toBe(true);
    expect(needsProfileCompletion(fan, "/demo")).toBe(false);
    expect(
      needsProfileCompletion(
        {
          ...fan,
          avatarVariant: "arg-pulse",
          favoriteTeam: "ARG",
          handle: "Abhinav_07",
        },
        "/matches/final/live",
      ),
    ).toBe(false);
    expect(needsProfileCompletion(null, "/")).toBe(false);
  });

  it("does not expose the retired synthetic Experience launcher from the profile client", () => {
    const api = createFanProfileApi({
      fetcher: vi.fn<typeof fetch>(),
    });

    expect("startExperience" in api).toBe(false);
  });

  it("creates one guest session when bootstrap reports no session", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "fan_session_required" }), {
          headers: { "content-type": "application/json" },
          status: 401,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ csrfToken: "fixture-csrf-new", fan }), {
          headers: { "content-type": "application/json" },
          status: 201,
        }),
      );
    const api = createFanProfileApi({ fetcher });

    const bootstrap = await api.ensureBootstrap();

    expect(bootstrap.fan.id).toBe("fan-1");
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/bootstrap",
      "/api/v1/session/guest",
    ]);
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      credentials: "same-origin",
      method: "POST",
    });
  });

  it("repairs an incomplete standalone session that has no readable CSRF cookie", async () => {
    const repaired = { ...fan, id: "fan-repaired" };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ fan, follows: [], memories: [], rooms: [] }),
          { headers: { "content-type": "application/json" }, status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ csrfToken: "fresh-csrf", fan: repaired }),
          { headers: { "content-type": "application/json" }, status: 201 },
        ),
      );
    const api = createFanProfileApi({ cookieSource: () => "", fetcher });

    await expect(api.ensureBootstrap()).resolves.toMatchObject({
      fan: { id: "fan-repaired" },
    });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/bootstrap",
      "/api/v1/session/guest",
    ]);
  });

  it("checks a safely encoded public handle", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ available: true, handle: "Abhinav_07" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    const api = createFanProfileApi({ fetcher });

    await expect(api.checkHandle("Abhinav_07")).resolves.toEqual({
      available: true,
      handle: "Abhinav_07",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/profile/handles/Abhinav_07/availability",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("sends the readable CSRF cookie when saving a profile", async () => {
    const updated = {
      ...fan,
      avatarVariant: "arg-pulse",
      favoriteTeam: "ARG",
      handle: "Abhinav_07",
      handleNormalized: "abhinav_07",
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(updated), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    const api = createFanProfileApi({
      cookieSource: () => "other=1; matchsense_csrf=csrf%20token",
      fetcher,
    });

    await api.updateProfile({
      avatarVariant: "arg-pulse",
      favoriteTeam: "ARG",
      handle: "Abhinav_07",
      preferences: { commentaryLanguage: "en" },
      profile: { displayName: "Abhinav" },
    });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/profile",
      expect.objectContaining({
        credentials: "same-origin",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "x-matchsense-csrf": "csrf token",
        }),
        method: "PATCH",
      }),
    );
  });

  it("sends an authenticated bodyless request when deleting a profile", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const api = createFanProfileApi({
      cookieSource: () => "matchsense_csrf=csrf%20token",
      fetcher,
    });

    await api.deleteProfile();

    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/profile",
      expect.objectContaining({
        credentials: "same-origin",
        headers: expect.objectContaining({
          Accept: "application/json",
          "x-matchsense-csrf": "csrf token",
        }),
        method: "DELETE",
      }),
    );
    expect(fetcher.mock.calls[0]?.[1]?.headers).not.toHaveProperty(
      "Content-Type",
    );
  });

  it("surfaces handle conflicts as a stable client error", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: "handle_unavailable" }), {
        headers: { "content-type": "application/json" },
        status: 409,
      }),
    );
    const api = createFanProfileApi({
      cookieSource: () => "matchsense_csrf=csrf",
      fetcher,
    });

    await expect(
      api.updateProfile({
        avatarVariant: "arg-pulse",
        favoriteTeam: "ARG",
        handle: "Taken",
        preferences: {},
        profile: {},
      }),
    ).rejects.toMatchObject({ code: "handle_unavailable", status: 409 });
  });

  it("hardcodes live follows and does not expose recorded as a follow mode", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const api = createFanProfileApi({
      cookieSource: () => "matchsense_csrf=csrf",
      fetcher,
    });

    const followLiveOnly: (
      fixtureId: string,
      eventPreferences?: Record<string, boolean>,
    ) => Promise<void> = api.followFixture;
    if (false) {
      // @ts-expect-error Recorded fixtures are not publicly followable.
      void api.followFixture("fixture-live", "recorded");
    }

    await followLiveOnly("fixture-live", {
      fullTime: false,
      goals: true,
      redCards: true,
    });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/follows/live/fixture-live",
      expect.objectContaining({
        body: JSON.stringify({
          eventPreferences: { fullTime: false, goals: true, redCards: true },
        }),
        method: "PUT",
      }),
    );
  });

  it.each([".", ".."])(
    "does not dispatch a normalized navigation fixture ID %s",
    async (fixtureId) => {
      const fetcher = vi.fn<typeof fetch>();
      const api = createFanProfileApi({
        cookieSource: () => "matchsense_csrf=csrf",
        fetcher,
      });

      await expect(api.followFixture(fixtureId)).rejects.toMatchObject({
        code: "follow_invalid",
        status: 400,
      });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
});
