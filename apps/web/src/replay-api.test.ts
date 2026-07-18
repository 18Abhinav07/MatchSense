import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchRecordedReplayTimeline,
  normalizeRecordedReplayTimeline,
  startRecordedReplay,
} from "./replay-api.js";

const fixture = {
  archiveManifestId: "archive-ready",
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

const session = {
  archiveManifestId: "archive-ready",
  fixtureId: "fx-final",
  fixtureMode: "recorded",
  id: "recorded_ZngtZmluYWw.YXJjaGl2ZS1yZWFkeQ",
  mode: "recorded",
  replaySeq: 0,
};

const timeline = {
  ...session,
  events: [
    {
      event: {
        event: "moment.created",
        id: "goal-1:2",
        moment: {
          celebratesGoal: true,
          eventTeam: "ARG",
          id: "goal-1",
          identity: "goal-1:2",
          kind: "goal",
          minute: "81'",
          revision: 2,
          score: { away: 1, home: 2 },
          status: "confirmed",
        },
      },
      replaySeq: 14,
    },
  ],
  highWaterSequence: 14,
  snapshot: fixture,
};

afterEach(() => vi.unstubAllGlobals());

describe("recorded replay client", () => {
  it("accepts only a server-authorized recorded replay timeline", () => {
    expect(normalizeRecordedReplayTimeline(timeline)).toMatchObject({
      archiveManifestId: "archive-ready",
      events: [{ moment: { identity: "goal-1:2" }, replaySeq: 14 }],
      fixtureId: "fx-final",
      mode: "recorded",
      snapshot: { provenance: "recorded_txline_authorised" },
    });
  });

  it("rejects a timeline whose snapshot is not replay-ready recorded data", () => {
    expect(
      normalizeRecordedReplayTimeline({
        ...timeline,
        snapshot: { ...fixture, mode: "live", provenance: "live_txline" },
      }),
    ).toBeNull();
  });

  it("opens a stateless recorded session and fetches its timeline", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(session), { status: 201 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(timeline), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetch);

    await expect(startRecordedReplay("fx-final")).resolves.toMatchObject({
      id: session.id,
      mode: "recorded",
    });
    await expect(
      fetchRecordedReplayTimeline(session.id),
    ).resolves.toMatchObject({
      highWaterSequence: 14,
      id: session.id,
    });
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "/api/v1/replay/sessions",
      expect.objectContaining({
        body: JSON.stringify({ fixtureId: "fx-final", mode: "recorded" }),
        method: "POST",
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      `/api/v1/replay/sessions/${encodeURIComponent(session.id)}/timeline`,
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });
});
