import { describe, expect, it } from "vitest";

import {
  DEMO_DURATION_SECONDS,
  DEMO_TIMELINE,
  createDemoPlayback,
  nextDemoBeat,
} from "./demo-timeline.js";

describe("five-minute MatchSense demo timeline", () => {
  it("covers the complete fan journey in deterministic chronological order", () => {
    expect(DEMO_DURATION_SECONDS).toBe(300);
    expect(DEMO_TIMELINE.map(({ type }) => type)).toEqual([
      "kickoff",
      "shot",
      "corner",
      "yellow_card",
      "goal",
      "var_started",
      "var_resolved",
      "red_card",
      "penalty_scored",
      "goal",
      "var_started",
      "goal_overturned",
      "reconnect_catchup",
      "corner",
      "winning_goal",
      "full_time",
    ]);
    expect(
      DEMO_TIMELINE.every((beat, index) => {
        const previous = DEMO_TIMELINE[index - 1];
        return previous === undefined || previous.atSeconds < beat.atSeconds;
      }),
    ).toBe(true);
    expect(DEMO_TIMELINE.at(-1)).toMatchObject({
      atSeconds: 300,
      score: { away: 1, home: 2 },
      type: "full_time",
    });
  });

  it("advances once per beat and can resume from a stable cursor", () => {
    const playback = createDemoPlayback("demo-session");
    const first = nextDemoBeat(playback);
    const second = nextDemoBeat(first.playback);

    expect(first.beat?.id).toBe("arg-fra-demo:kickoff");
    expect(second.beat?.id).toBe("arg-fra-demo:shot:1");
    expect(second.playback.cursor).toBe(2);

    let state = second.playback;
    while (!state.complete) state = nextDemoBeat(state).playback;
    expect(state.cursor).toBe(DEMO_TIMELINE.length);
    expect(nextDemoBeat(state)).toEqual({ beat: null, playback: state });
  });
});
