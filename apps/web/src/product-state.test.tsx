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

  it("keeps canonical moments in chronological stream order", () => {
    const first = liveViewReducer(createInitialLiveState(), {
      sequence: 0,
      snapshot,
      type: "snapshot",
    });
    const afterGoal = liveViewReducer(first, {
      payload: {
        deliveryIntent: "reconcile",
        event: "moment.created",
        id: goal.identity,
        moment: goal,
        sequence: 1,
        snapshot,
      },
      type: "canonical_event",
    });
    const card = {
      ...goal,
      celebratesGoal: false,
      id: "card-1",
      identity: "card-1:1",
      kind: "red_card",
      minute: "61′",
      title: "France are down to ten",
    };
    const afterCard = liveViewReducer(afterGoal, {
      payload: {
        deliveryIntent: "realtime",
        event: "moment.created",
        id: card.identity,
        moment: card,
        sequence: 2,
        snapshot: { ...snapshot, lastEvent: card, minute: "61′" },
      },
      type: "canonical_event",
    });

    expect(afterCard.timeline.map((moment) => moment.identity)).toEqual([
      goal.identity,
      card.identity,
    ]);
  });

  it("advances the durable cursor across interleaved commentary", () => {
    const painted = liveViewReducer(createInitialLiveState(), {
      sequence: 1,
      snapshot,
      type: "snapshot",
    });
    const commented = liveViewReducer(painted, {
      payload: {
        commentary: {
          generatedAt: "2026-07-19T00:00:00.000Z",
          language: "en",
          momentIdentity: goal.identity,
          provider: "deterministic",
          text: "Argentina have the breakthrough.",
          usedFallback: false,
        },
        event: "commentary.ready",
        id: "commentary-2",
        sequence: 2,
        snapshot,
      },
      type: "commentary_ready",
    });
    const next = liveViewReducer(commented, {
      payload: {
        deliveryIntent: "realtime",
        event: "moment.created",
        id: goal.identity,
        moment: goal,
        sequence: 3,
        snapshot,
      },
      type: "canonical_event",
    });

    expect(commented.lastAppliedSequence).toBe(2);
    expect(next.resetRequired).toBe(false);
    expect(next.timeline).toEqual([goal]);
  });

  it("reconciles older history without regressing the latest painted truth", () => {
    const latest = {
      ...snapshot,
      minute: "61′",
      revision: 4,
      score: { away: 0, home: 2 },
    };
    const painted = liveViewReducer(createInitialLiveState(), {
      sequence: 0,
      snapshot: latest,
      type: "snapshot",
    });
    const afterHistoricalSnapshot = liveViewReducer(painted, {
      sequence: 1,
      snapshot: { ...snapshot, minute: "4′", revision: 1, score: null },
      type: "snapshot",
    });
    const afterHistoricalMoment = liveViewReducer(afterHistoricalSnapshot, {
      payload: {
        deliveryIntent: "reconcile",
        event: "moment.created",
        id: goal.identity,
        moment: { ...goal, revision: 2 },
        sequence: 2,
        snapshot: { ...snapshot, revision: 2 },
      },
      type: "canonical_event",
    });

    expect(afterHistoricalSnapshot.lastAppliedSequence).toBe(1);
    expect(afterHistoricalMoment.lastAppliedSequence).toBe(2);
    expect(afterHistoricalMoment.currentRevision).toBe(4);
    expect(afterHistoricalMoment.snapshot).toEqual(latest);
    expect(afterHistoricalMoment.timeline).toHaveLength(1);
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

  it("replaces prior match state when the route changes to another fixture", () => {
    const first = liveViewReducer(createInitialLiveState(), {
      sequence: 8,
      snapshot: { ...snapshot, revision: 8 },
      type: "snapshot",
    });
    const nextFixture = {
      ...snapshot,
      awayTeam: "ENG",
      fixtureId: "fixture-99",
      homeTeam: "FRA",
      revision: 0,
      score: null,
    } satisfies LiveSnapshot;
    const switched = liveViewReducer(first, {
      sequence: 0,
      snapshot: nextFixture,
      type: "snapshot",
    });

    expect(switched.snapshot?.fixtureId).toBe("fixture-99");
    expect(switched.currentRevision).toBe(0);
    expect(switched.timeline).toEqual([]);
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
