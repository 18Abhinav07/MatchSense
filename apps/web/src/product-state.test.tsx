import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  App,
  type AppProps,
  MomentOverlay,
  resolveRoomCreationFixture,
  roomCreationPath,
  SampleMoment,
} from "./App.js";
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
} from "./product-state.js";

describe("fan journey state", () => {
  it("renders the reduced-motion-safe first-launch promise before permissions", () => {
    const markup = renderToStaticMarkup(
      createElement(App as FunctionComponent<AppProps>, {
        initialFavoriteTeam: null,
        initialPath: "/",
      }),
    );

    expect(markup).toContain("EVERY MATCH HAS A PULSE.");
    expect(markup).toContain("Skip intro");
    expect(markup).toContain('aria-live="polite"');
  });

  it("makes canonical truth render before the cinematic moment opens", () => {
    const cold = createInitialLiveState();
    const event = {
      event: "moment.created" as const,
      id: "arg-fra-demo:score:1-0:1",
      moment: {
        celebratesGoal: true,
        eventTeam: "ARG" as const,
        id: "arg-fra-demo:score:1-0",
        identity: "arg-fra-demo:score:1-0:1",
        kind: "goal" as const,
        minute: "23'",
        revision: 1,
        score: { away: 0, home: 1 },
        status: "confirmed" as const,
      },
      snapshot: {
        awayTeam: "FRA" as const,
        fixtureId: "arg-fra-demo",
        homeTeam: "ARG" as const,
        minute: "23'",
        score: { away: 0, home: 1 },
      },
    };

    const painted = liveViewReducer(cold, {
      payload: event,
      type: "canonical_event",
    });
    const cinematic = liveViewReducer(painted, {
      identity: event.id,
      type: "open_moment",
    });

    expect(painted.snapshot.score.home).toBe(1);
    expect(painted.currentRevision).toBe(1);
    expect(painted.openMoment).toBeNull();
    expect(painted.pendingMoment?.identity).toBe(event.id);
    expect(cinematic.openMoment?.identity).toBe(event.id);
  });

  it("normalizes canonical match routes without adding a router dependency", () => {
    expect(normalizePath("/matches/arg-fra-demo/live?from=push")).toBe(
      "/matches/arg-fra-demo/live",
    );
  });

  it("keeps simulation data mode separate from reconciled transport health", () => {
    const initial = createInitialLiveState();
    const reconciled = liveViewReducer(initial, {
      snapshot: {
        ...initial.snapshot,
        updatedAt: "2026-07-16T12:00:00.000Z",
      },
      type: "snapshot",
    });

    expect(initial.dataMode).toBe("simulation");
    expect(initial.transportHealth).toBe("connecting");
    expect(reconciled.dataMode).toBe("simulation");
    expect(reconciled.transportHealth).toBe("reconciled");
    expect(JSON.stringify(reconciled)).not.toContain('"live"');
  });

  it("formats source freshness deterministically without claiming live data", () => {
    expect(
      formatFreshness("2026-07-16T12:00:00.000Z", "2026-07-16T12:00:00.000Z"),
    ).toBe("UPDATED JUST NOW");
    expect(
      formatFreshness("2026-07-16T11:59:53.000Z", "2026-07-16T12:00:00.000Z"),
    ).toBe("UPDATED 7s AGO");
    expect(
      formatFreshness("2026-07-16T11:57:59.000Z", "2026-07-16T12:00:00.000Z"),
    ).toBe("UPDATED 2m AGO");
  });

  it("starts a prepared audio stream inside the gesture before deferred network cleanup", async () => {
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
    expect(fetchMock).not.toHaveBeenCalled();

    releasePlayback();
    await started;
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockRestore();
  });

  it("cancels a superseded preparation without terminating active route-persistent audio", () => {
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

  it("reloads the unchanged listening source once before synchronous resume playback", async () => {
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

    const resumed = resumePreparedPlayback(audio);

    expect(calls).toEqual(["load", "play"]);
    expect(audio.setAttribute).not.toHaveBeenCalled();
    await resumed;
    expect(audio.getAttribute("src")).toBe(source);
  });

  it("ignores a delayed lower-revision snapshot after a canonical Moment", () => {
    const initial = createInitialLiveState();
    const current = liveViewReducer(initial, {
      payload: {
        event: "moment.created",
        id: "arg-fra-demo:score:1-0:1",
        moment: {
          celebratesGoal: true,
          eventTeam: "ARG",
          id: "arg-fra-demo:score:1-0",
          identity: "arg-fra-demo:score:1-0:1",
          kind: "goal",
          minute: "23'",
          revision: 1,
          score: { away: 0, home: 1 },
          status: "confirmed",
        },
        snapshot: {
          ...initial.snapshot,
          minute: "23'",
          revision: 1,
          score: { away: 0, home: 1 },
        },
      },
      type: "canonical_event",
    });

    const delayed = liveViewReducer(current, {
      snapshot: {
        ...initial.snapshot,
        minute: "—",
        revision: 0,
        score: { away: 0, home: 0 },
      },
      type: "snapshot",
    });

    expect(delayed).toBe(current);
    expect(delayed.snapshot.score).toEqual({ away: 0, home: 1 });
    expect(delayed.currentRevision).toBe(1);
  });

  it("attaches one shared commentary transcript to its canonical Moment", () => {
    const initial = createInitialLiveState();
    const withGoal = liveViewReducer(initial, {
      payload: {
        event: "moment.created",
        id: "arg-fra-demo:score:1-0:1",
        moment: {
          celebratesGoal: true,
          eventTeam: "ARG",
          id: "arg-fra-demo:score:1-0",
          identity: "arg-fra-demo:score:1-0:1",
          kind: "goal",
          minute: "23'",
          revision: 1,
          score: { away: 0, home: 1 },
          status: "confirmed",
        },
        snapshot: {
          ...initial.snapshot,
          minute: "23'",
          revision: 1,
          score: { away: 0, home: 1 },
        },
      },
      type: "canonical_event",
    });

    const spoken = liveViewReducer(withGoal, {
      payload: {
        commentary: {
          generatedAt: "2026-07-16T12:00:03.000Z",
          language: "en",
          momentIdentity: "arg-fra-demo:score:1-0:1",
          provider: "gemini",
          text: "Goal! Argentina score. Argentina lead France one nil.",
          usedFallback: false,
        },
        event: "commentary.ready",
        id: "commentary:arg-fra-demo:score:1-0:1:en",
        snapshot: withGoal.snapshot,
      },
      type: "commentary_ready",
    });

    expect(spoken.commentaryByMoment["arg-fra-demo:score:1-0:1"]?.text).toBe(
      "Goal! Argentina score. Argentina lead France one nil.",
    );
    expect(spoken.timeline).toHaveLength(1);
    expect(spoken.currentRevision).toBe(1);
  });

  it("opens the goal celebration for a VAR-stands goal but not a non-goal VAR decision", () => {
    const props = {
      catalog: { teams: [] },
      commentary: "The check is complete.",
      favoriteTeam: "ARG",
      onClose: () => undefined,
      snapshot: {
        awayTeam: "FRA",
        fixtureId: "fixture-1",
        homeTeam: "ARG",
        minute: "24'",
        score: { away: 0, home: 1 },
        sourceLabel: "TXLINE · DEVNET SOURCE",
      },
    };
    const goalStands = renderToStaticMarkup(
      createElement(MomentOverlay, {
        ...props,
        moment: {
          celebratesGoal: true,
          eventTeam: "ARG",
          id: "goal-family",
          identity: "goal-family:3",
          kind: "var.stands",
          minute: "24'",
          revision: 3,
          score: { away: 0, home: 1 },
          status: "confirmed",
        },
      }),
    );
    const cardStands = renderToStaticMarkup(
      createElement(MomentOverlay, {
        ...props,
        moment: {
          celebratesGoal: false,
          eventTeam: "ARG",
          id: "card-family",
          identity: "card-family:3",
          kind: "var.stands",
          minute: "24'",
          revision: 3,
          score: { away: 0, home: 1 },
          status: "confirmed",
        },
      }),
    );

    expect(goalStands).toContain('data-state="confirmed-goal"');
    expect(goalStands).toContain("Goal · confirmed");
    expect(cardStands).not.toContain('data-state="confirmed-goal"');
    expect(cardStands).toContain("VAR stands.");
  });

  it("renders a France replay sample against a different mapped opponent", () => {
    const markup = renderToStaticMarkup(
      createElement(SampleMoment, { onContinue: () => undefined, team: "FRA" }),
    );

    expect(markup).toContain("FRA 1—0 ARG");
    expect(markup).toContain("France take the lead against Argentina.");
    expect(markup).not.toContain("FRA 1—0 FRA");
  });

  it("offers the friends ritual from Today without turning it into wagering", () => {
    const markup = renderToStaticMarkup(
      createElement(App as FunctionComponent<AppProps>, {
        initialFavoriteTeam: "ARG",
        initialPath: "/",
      }),
    );

    expect(markup).toContain(
      "Make five calls, then let the match settle the chat.",
    );
    expect(markup).toContain("Create a room");
    expect(markup).toContain("free Sense");
    expect(markup).toContain("ms-team-flag");
    expect(markup).not.toContain("Place a bet");
  });

  it("serves the room creation flow as a first-class PWA route", () => {
    const markup = renderToStaticMarkup(
      createElement(App as FunctionComponent<AppProps>, {
        initialFavoriteTeam: "ARG",
        initialPath: "/rooms/new",
      }),
    );

    expect(markup).toContain("OPENING ROOMS");
    expect(markup).toContain("Finding the next match for your room");
  });

  it("serves a dedicated pre-match friends Experience route", () => {
    const markup = renderToStaticMarkup(
      createElement(App as FunctionComponent<AppProps>, {
        initialFavoriteTeam: "ARG",
        initialPath: "/experience/with-friends",
      }),
    );

    expect(markup).toContain("Start a five-minute match night");
    expect(markup).toContain("Create &amp; invite friends");
    expect(markup).toContain("Argentina");
    expect(markup).toContain("France");
  });

  it("carries the exact Experience fixture into room creation", async () => {
    const exactFixture = { fixtureId: "experience:run-7" };
    const fetchExact = vi.fn().mockResolvedValue(exactFixture);
    const fetchSchedule = vi
      .fn()
      .mockResolvedValue([{ fixtureId: "schedule-default" }]);

    expect(roomCreationPath("experience:run-7")).toBe(
      "/rooms/new/experience%3Arun-7",
    );
    await expect(
      resolveRoomCreationFixture("experience:run-7", {
        fetchExact,
        fetchSchedule,
      }),
    ).resolves.toBe(exactFixture);
    expect(fetchExact).toHaveBeenCalledWith("experience:run-7");
    expect(fetchSchedule).not.toHaveBeenCalled();

    const markup = renderToStaticMarkup(
      createElement(App as FunctionComponent<AppProps>, {
        initialFavoriteTeam: "ARG",
        initialPath: roomCreationPath("experience:run-7"),
      }),
    );
    expect(markup).toContain("Opening this match for your room");
  });

  it("serves Match Memory replay as a dedicated route, not a final live screen", () => {
    const markup = renderToStaticMarkup(
      createElement(App as FunctionComponent<AppProps>, {
        initialFavoriteTeam: "ARG",
        initialPath: "/matches/experience%3Arun-1/memory/replay",
      }),
    );

    expect(markup).toContain("MATCH REPLAY");
    expect(markup).toContain("Loading the canonical Moment timeline");
    expect(markup).not.toContain("CONNECTING TO MATCH");
  });
});
