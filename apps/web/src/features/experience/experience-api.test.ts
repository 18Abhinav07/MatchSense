import { describe, expect, it, vi } from "vitest";

import { createExperienceApi } from "./experience-api.js";

const run = {
  completedAt: null,
  fixtureId: "experience:run_one",
  id: "run_one",
  kickoffAt: "2026-07-19T12:00:00.000Z",
  nextBeatIndex: 0,
  status: "countdown" as const,
  templateVersion: 2,
};

describe("Experience API", () => {
  it("starts a private server-owned run with an idempotency key", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ run }), {
        headers: { "content-type": "application/json" },
        status: 201,
      }),
    );

    const result = await createExperienceApi(fetcher).start({
      awayTeam: "FRA",
      homeTeam: "ARG",
    });

    expect(result.id).toBe("run_one");
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/experience/runs",
      expect.objectContaining({ method: "POST" }),
    );
    const request = fetcher.mock.calls[0]?.[1];
    expect(new Headers(request?.headers).get("idempotency-key")).toMatch(
      /^experience-/u,
    );
  });

  it("reads run-scoped truth and exact Moment revisions", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ run }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ fixtureId: run.fixtureId }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ superseded: false }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ cursor: null, events: [], fixture: {} }),
          { status: 200 },
        ),
      );
    const api = createExperienceApi(fetcher);

    await api.fetchRun("run_one");
    await api.fetchFixture("run_one");
    await api.fetchMoment("run_one", "goal:1");
    await api.fetchTimeline("run_one");

    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/experience/runs/run_one",
      "/api/v1/experience/runs/run_one/fixture",
      "/api/v1/experience/runs/run_one/moments/goal%3A1",
      "/api/v1/experience/runs/run_one/timeline",
    ]);
  });
});
