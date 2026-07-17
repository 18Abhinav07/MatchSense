import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchMatchMemories, fetchMatchMemory } from "./memory-api.js";

const memory = {
  createdAt: "2026-07-17T15:00:00.000Z",
  fanId: "fan-1",
  fixtureId: "experience:run-1",
  mode: "demo",
  payload: {
    awayTeam: "FRA",
    decidedBy: "regulation",
    finalizedAt: "2026-07-17T15:00:00.000Z",
    fixtureId: "experience:run-1",
    homeTeam: "ARG",
    keyMoments: [
      {
        eventTeam: "ARG",
        familyId: "experience:run-1:event:goal",
        identity: "experience:run-1:event:goal:2",
        kind: "goal",
        minute: "23'",
        player: { displayName: "Lionel Messi", id: "messi" },
        revision: 2,
        score: { away: 0, home: 1 },
        status: "confirmed",
      },
    ],
    kickoffAt: "2026-07-17T12:00:00.000Z",
    mode: "demo",
    provenance: "synthetic_txline_shaped",
    replay: {
      available: true,
      fixtureRoute: "/matches/experience%3Arun-1/memory",
      kind: "experience",
      momentRouteTemplate: "/matches/experience%3Arun-1/moments/{identity}",
      restartable: true,
      runId: "run-1",
      templateId: "five-minute-match",
      templateVersion: 1,
    },
    revision: 7,
    schemaVersion: 1,
    score: { away: 1, home: 2 },
    sourceLabel: "SIMULATION · TXLINE-SHAPED DATA",
    stats: {
      away: { corners: 3, redCards: 1, yellowCards: 2 },
      home: { corners: 7, redCards: 0, yellowCards: 1 },
    },
    summary: "ARG 2–1 FRA",
  },
  revision: 7,
};

afterEach(() => vi.unstubAllGlobals());

describe("authenticated Match Memory client", () => {
  it("loads and validates the server-owned history list", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ memories: [memory] }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetch);

    const memories = await fetchMatchMemories();

    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/memories",
      expect.objectContaining({
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      }),
    );
    expect(memories).toMatchObject([
      {
        fixtureId: "experience:run-1",
        mode: "demo",
        payload: {
          keyMoments: [
            {
              identity: "experience:run-1:event:goal:2",
              player: { displayName: "Lionel Messi" },
            },
          ],
          replay: { restartable: true, runId: "run-1" },
          score: { away: 1, home: 2 },
        },
      },
    ]);
  });

  it("loads one fixture memory through the id route", async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ memory }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(fetchMatchMemory("experience:run-1")).resolves.toMatchObject({
      fixtureId: "experience:run-1",
      revision: 7,
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/memories/experience%3Arun-1",
      expect.any(Object),
    );
  });

  it("rejects malformed history instead of turning it into false final truth", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              memories: [{ ...memory, payload: { score: {} } }],
            }),
            { status: 200 },
          ),
      ),
    );

    await expect(fetchMatchMemories()).rejects.toThrow(
      "Match Memory data was invalid",
    );
  });
});
