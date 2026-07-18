import { describe, expect, it, vi } from "vitest";

import {
  beginPreparedPlayback,
  decidePreparationRelease,
  resumePreparedPlayback,
} from "./ListeningProvider.js";
import {
  createInitialLiveState,
  formatFreshness,
  liveViewReducer,
  normalizePath,
  type LiveSnapshot,
} from "./product-state.js";

const snapshot: LiveSnapshot = {
  awayTeam: "FRA",
  fixtureId: "fixture-42",
  freshness: "live",
  homeTeam: "ARG",
  lifecycle: "LIVE",
  minute: "23'",
  provenance: "live_txline",
  revision: 1,
  score: { away: 0, home: 1 },
};

const goal = {
  celebratesGoal: true,
  eventTeam: "ARG",
  id: "fixture-42:goal:1",
  identity: "fixture-42:goal:1:1",
  kind: "goal",
  minute: "23'",
  revision: 1,
  score: { away: 0, home: 1 },
  status: "confirmed",
};

describe("truthful match state", () => {
  it("starts with no invented fixture, score, or data mode", () => {
    expect(createInitialLiveState()).toMatchObject({
      dataMode: "unavailable",
      pendingMoment: null,
      snapshot: null,
      timeline: [],
    });
  });

  it("opens a Moment only after a contiguous fresh realtime canonical event", () => {
    const painted = liveViewReducer(createInitialLiveState(), {
      sequence: 8,
      snapshot,
      type: "snapshot",
    });
    const next = liveViewReducer(painted, {
      payload: {
        deliveryIntent: "realtime",
        event: "moment.created",
        id: "stream:9",
        moment: goal,
        sequence: 9,
        snapshot,
      },
      type: "canonical_event",
    });
    const cinematic = liveViewReducer(next, {
      identity: goal.identity,
      type: "open_moment",
    });

    expect(next.snapshot?.score).toEqual({ away: 0, home: 1 });
    expect(next.pendingMoment?.identity).toBe(goal.identity);
    expect(cinematic.openMoment?.identity).toBe(goal.identity);
  });

  it("renders reconciled history without replaying it as a fresh celebration", () => {
    const next = liveViewReducer(createInitialLiveState(), {
      payload: {
        deliveryIntent: "reconcile",
        event: "moment.created",
        id: "stream:9",
        moment: goal,
        sequence: 9,
        snapshot,
      },
      type: "canonical_event",
    });

    expect(next.pendingMoment).toBeNull();
    expect(next.timeline).toEqual([goal]);
  });

  it("requires a resync rather than applying a sequence gap", () => {
    const painted = liveViewReducer(createInitialLiveState(), {
      sequence: 8,
      snapshot,
      type: "snapshot",
    });
    const gapped = liveViewReducer(painted, {
      payload: {
        deliveryIntent: "realtime",
        event: "moment.created",
        id: "stream:10",
        moment: goal,
        sequence: 10,
        snapshot,
      },
      type: "canonical_event",
    });

    expect(gapped.resetRequired).toBe(true);
    expect(gapped.timeline).toEqual([]);
    expect(gapped.pendingMoment).toBeNull();
  });

  it("formats freshness and paths deterministically", () => {
    expect(
      formatFreshness("2026-07-16T11:59:53.000Z", "2026-07-16T12:00:00.000Z"),
    ).toBe("UPDATED 7s AGO");
    expect(normalizePath("/matches/fixture-42?from=push")).toBe(
      "/matches/fixture-42",
    );
  });
});

describe("listening transport gesture contracts", () => {
  it("starts a prepared audio stream in the user gesture", async () => {
    let gestureIsActive = true;
    let releasePlayback!: () => void;
    const playback = new Promise<void>((resolve) => {
      releasePlayback = resolve;
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    const calls: string[] = [];
    const audio = {
      getAttribute: () => null,
      play: () => {
        expect(gestureIsActive).toBe(true);
        calls.push("play");
        return playback;
      },
      setAttribute: (name: string, value: string) => {
        calls.push(`${name}:${value}`);
      },
    };

    const started = beginPreparedPlayback({
      afterPlaybackStarts: async () => {
        await fetch("/api/v1/listening-sessions/previous-session", {
          method: "DELETE",
        });
      },
      audio,
      streamUrl: "/api/v1/listening-sessions/session-1/stream.mp3",
    });
    gestureIsActive = false;

    expect(calls).toEqual([
      "src:/api/v1/listening-sessions/session-1/stream.mp3",
      "play",
    ]);
    releasePlayback();
    await started;
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockRestore();
  });

  it("keeps an active prepared session when a new preparation supersedes it", () => {
    expect(
      decidePreparationRelease({
        activeSessionId: "active-session",
        preparedKey: "fixture-old:ARG",
        preparedSessionId: "active-session",
        releasedKey: "fixture-new:BRA",
      }),
    ).toEqual({
      deleteSessionId: null,
      nextPreparationKey: "fixture-old:ARG",
      preservePrepared: true,
    });
  });

  it("reloads the unchanged listening source before resuming it", async () => {
    const source = "/api/v1/listening-sessions/session-1/stream.mp3";
    const calls: string[] = [];
    const audio = {
      getAttribute: (name: string) => {
        expect(name).toBe("src");
        return source;
      },
      load: () => calls.push("load"),
      play: () => {
        calls.push("play");
        return Promise.resolve();
      },
      setAttribute: vi.fn(),
    };

    await resumePreparedPlayback(audio);
    expect(calls).toEqual(["load", "play"]);
  });
});
