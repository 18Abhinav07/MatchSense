import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchVerifiedFixtureMemory,
  fetchVerifiedHistory,
  normalizeVerifiedFixtureMemory,
} from "./memory-api.js";

const fixture = {
  archiveManifestId: "archive-final",
  fixtureId: "fx-final",
  lifecycle: "final",
  mode: "recorded",
  projection: {
    payload: {
      minute: "FT",
      phase: "full_time",
      score: { away: 1, home: 2 },
    },
    revision: 9,
    sourceSequence: "1026",
    updatedAt: "2026-07-18T15:00:00.000Z",
  },
  provenance: "recorded_txline_authorised",
  replayReady: true,
  scheduledAt: "2026-07-18T12:00:00.000Z",
  teams: { away: "FRA", home: "ARG" },
};

const memory = {
  fixture,
  timeline: [
    {
      createdAt: "2026-07-18T14:18:00.000Z",
      eventId: "fx-final:revision:4",
      eventType: "moment.created",
      payload: {
        event: "moment.created",
        id: "fx-final:revision:4",
        moment: {
          eventTeam: "ARG",
          id: "goal-1",
          identity: "goal-1:4",
          kind: "goal",
          minute: "81'",
          revision: 4,
          score: { away: 1, home: 2 },
          status: "confirmed",
        },
      },
      sequence: 4,
    },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe("verified archive Memory client", () => {
  it("accepts Memory only from a replay-ready final archive", () => {
    const parsed = normalizeVerifiedFixtureMemory({ memory });

    expect(parsed).toMatchObject({
      archiveManifestId: "archive-final",
      fixture: {
        archiveStatus: "REPLAY_READY",
        fixtureId: "fx-final",
        lifecycle: "FINAL",
      },
      timeline: [
        {
          moment: { identity: "goal-1:4" },
          sequence: 4,
        },
      ],
    });
  });

  it("rejects a final response whose archive is not verified", () => {
    expect(
      normalizeVerifiedFixtureMemory({
        memory: { ...memory, fixture: { ...fixture, replayReady: false } },
      }),
    ).toBeNull();
  });

  it("loads fixture Memory from the durable read endpoint", async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ memory }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(fetchVerifiedFixtureMemory("fx-final")).resolves.toMatchObject(
      { fixture: { fixtureId: "fx-final" } },
    );
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/fixtures/fx-final/memory",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });

  it("keeps unverified finals out of the recorded history library", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              fixtures: [
                fixture,
                { ...fixture, fixtureId: "fx-unverified", replayReady: false },
              ],
            }),
            { status: 200 },
          ),
      ),
    );

    await expect(fetchVerifiedHistory()).resolves.toMatchObject([
      { fixtureId: "fx-final", archiveStatus: "REPLAY_READY" },
    ]);
  });
});
