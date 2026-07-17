import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  createMemoryReplayState,
  MEMORY_REPLAY_DELAYS_MS,
  memoryReplayPath,
  memoryReplayReducer,
  MemoryReplayPlayer,
  memoryReplaySpeechText,
} from "./MemoryReplayPlayer.js";

const argentina = {
  code: "ARG",
  foreground: "#0b2035",
  name: "Argentina",
  primary: "#75aadb",
  secondary: "#f3efe4",
};

const france = {
  code: "FRA",
  name: "France",
  primary: "#173a70",
  secondary: "#d34d58",
};

const moments = [
  {
    identity: "fixture:goal:1",
    kind: "goal",
    minute: "23′",
    score: { away: 0, home: 1 },
    team: argentina,
    title: "Messi gives Argentina the lead",
  },
  {
    identity: "fixture:red:2",
    kind: "red_card",
    minute: "71′",
    score: { away: 0, home: 1 },
    team: france,
    title: "France are reduced to ten",
  },
];

describe("canonical Match Memory replay", () => {
  it("starts score-first, advances in order, pauses, and restarts", () => {
    const ready = createMemoryReplayState(2);
    expect(ready).toEqual({ index: -1, phase: "ready", total: 2 });

    const playing = memoryReplayReducer(ready, { type: "play" });
    const first = memoryReplayReducer(playing, { type: "advance" });
    const paused = memoryReplayReducer(first, { type: "pause" });
    const resumed = memoryReplayReducer(paused, { type: "play" });
    const second = memoryReplayReducer(resumed, { type: "advance" });
    const complete = memoryReplayReducer(second, { type: "advance" });

    expect(first).toMatchObject({ index: 0, phase: "playing" });
    expect(paused).toMatchObject({ index: 0, phase: "paused" });
    expect(complete).toMatchObject({ index: 1, phase: "complete" });
    expect(memoryReplayReducer(complete, { type: "restart" })).toEqual({
      index: -1,
      phase: "playing",
      total: 2,
    });
    expect(MEMORY_REPLAY_DELAYS_MS.intro).toBeGreaterThan(0);
    expect(MEMORY_REPLAY_DELAYS_MS.moment).toBeGreaterThan(
      MEMORY_REPLAY_DELAYS_MS.intro,
    );
  });

  it("renders final truth before motion with explicit foreground-only speech", () => {
    const markup = renderToStaticMarkup(
      createElement(MemoryReplayPlayer, {
        finalScore: {
          away: 1,
          awayTeam: france,
          home: 2,
          homeTeam: argentina,
        },
        moments,
        onBack: () => undefined,
        onOpenMemory: () => undefined,
        sourceLabel: "TXLINE · DEVNET SOURCE",
        summary: "Two goals and one nervy finish.",
        supportedTeam: argentina,
      }),
    );

    expect(markup).toContain('data-state="memory-replay"');
    expect(markup).toContain('data-replay-phase="ready"');
    expect(markup).toContain("Final truth");
    expect(markup).toContain("ARG");
    expect(markup).toContain("2—1");
    expect(markup).toContain("Play canonical replay");
    expect(markup).toContain("Foreground voice recap");
    expect(markup).toContain("only while this replay screen is open");
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain("ms-team-flag");
    expect(markup).not.toContain("background radio");
  });

  it("derives speech and routes from the persisted canonical Moment", () => {
    expect(memoryReplaySpeechText(moments[0]!, argentina, france)).toBe(
      "23′. Messi gives Argentina the lead. Argentina 1, France 0.",
    );
    expect(memoryReplayPath("experience:run 1")).toBe(
      "/matches/experience%3Arun%201/memory/replay",
    );
  });
});
