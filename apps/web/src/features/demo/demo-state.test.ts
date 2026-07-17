import { describe, expect, it } from "vitest";

import {
  createDemoViewState,
  demoEventPresentation,
  demoViewReducer,
  parseDemoBeatEvent,
} from "./demo-state.js";

function beat(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    atSeconds: 76,
    cursor: 6,
    description: "VAR is checking the Argentina goal.",
    id: "arg-fra-demo:var:1:start",
    matchMinute: "23'",
    progress: {
      current: 6,
      durationSeconds: 300,
      elapsedSeconds: 76,
      percent: 25.3,
      total: 16,
    },
    score: { away: 0, home: 1 },
    sessionId: "demo-1",
    simulation: true,
    sourceLabel: "SIMULATION · ARGENTINA VS FRANCE · 5 MIN",
    team: "ARG",
    type: "var_started",
    ...overrides,
  });
}

describe("demo beat contract", () => {
  it("parses the server demo.beat payload without weakening simulation truth", () => {
    expect(parseDemoBeatEvent(beat())).toMatchObject({
      cursor: 6,
      matchMinute: "23'",
      score: { away: 0, home: 1 },
      simulation: true,
      type: "var_started",
    });
  });

  it("rejects non-simulation, unknown, and malformed frames", () => {
    expect(parseDemoBeatEvent(beat({ simulation: false }))).toBeNull();
    expect(parseDemoBeatEvent(beat({ type: "made_up" }))).toBeNull();
    expect(parseDemoBeatEvent("not-json")).toBeNull();
  });
});

describe("demo experience reducer", () => {
  it("moves score, minute, progress, phase, and timeline from each beat", () => {
    const event = parseDemoBeatEvent(beat());
    expect(event).not.toBeNull();
    const state = demoViewReducer(createDemoViewState(), {
      event: event!,
      type: "beat",
    });
    expect(state).toMatchObject({
      cursor: 6,
      minute: "23'",
      phase: "VAR review",
      progress: { percent: 25.3 },
      score: { away: 0, home: 1 },
      status: "running",
    });
    expect(state.timeline).toHaveLength(1);
    expect(state.currentEvent?.id).toBe("arg-fra-demo:var:1:start");
  });

  it("ignores a duplicate or older cursor and completes at full time", () => {
    const first = parseDemoBeatEvent(beat())!;
    const afterFirst = demoViewReducer(createDemoViewState(), {
      event: first,
      type: "beat",
    });
    expect(demoViewReducer(afterFirst, { event: first, type: "beat" })).toBe(
      afterFirst,
    );

    const fullTime = parseDemoBeatEvent(
      beat({
        atSeconds: 300,
        cursor: 16,
        description: "Full time. Argentina win 2–1.",
        id: "arg-fra-demo:full-time",
        matchMinute: "FT",
        progress: {
          current: 16,
          durationSeconds: 300,
          elapsedSeconds: 300,
          percent: 100,
          total: 16,
        },
        score: { away: 1, home: 2 },
        type: "full_time",
      }),
    )!;
    expect(
      demoViewReducer(afterFirst, { event: fullTime, type: "beat" }),
    ).toMatchObject({ phase: "Full time", status: "complete" });
  });

  it("presents the honest match states in fan language", () => {
    expect(demoEventPresentation("var_started").title).toBe("Under review");
    expect(demoEventPresentation("var_resolved").title).toBe("Goal stands");
    expect(demoEventPresentation("goal_overturned").title).toBe("No goal");
    expect(demoEventPresentation("reconnect_catchup").title).toBe(
      "Caught you up",
    );
    expect(demoEventPresentation("red_card").tone).toBe("danger");
    expect(demoEventPresentation("yellow_card").tone).toBe("warning");
  });
});
