import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  createExperienceMemoryReplayState,
  experienceMemoryArtifactPath,
  experienceMemoryIntroPath,
  experienceMemoryReplayIsActive,
  experienceMemoryReplayReducer,
  ExperienceMemory,
  isExperienceReplayMoment,
} from "./ExperienceMemory.js";

describe("Experience Match Memory audio replay", () => {
  it("includes the confirmed penalty so the replay contains all three goals", () => {
    expect(
      isExperienceReplayMoment({
        celebratesGoal: false,
        eventTeam: "FRA",
        id: "penalty",
        identity: "penalty:1",
        kind: "penalty.scored",
        minute: "41'",
        revision: 1,
        score: { away: 1, home: 1 },
        status: "confirmed",
      }),
    ).toBe(true);
  });

  it("advances cards only after the current commentary artifact ends", () => {
    const ready = createExperienceMemoryReplayState(2);
    const introLoading = experienceMemoryReplayReducer(ready, {
      type: "start",
    });
    const introPlaying = experienceMemoryReplayReducer(introLoading, {
      type: "audio_started",
    });
    const loading = experienceMemoryReplayReducer(introPlaying, {
      type: "audio_ended",
    });
    const playing = experienceMemoryReplayReducer(loading, {
      type: "audio_started",
    });
    const paused = experienceMemoryReplayReducer(playing, { type: "pause" });
    const resumed = experienceMemoryReplayReducer(paused, { type: "resume" });

    expect(introLoading).toEqual({
      index: null,
      phase: "loading",
      segment: "intro",
      total: 2,
    });
    expect(introPlaying).toMatchObject({
      index: null,
      phase: "playing",
      segment: "intro",
    });
    expect(loading).toMatchObject({
      index: 0,
      phase: "loading",
      segment: "moment",
    });
    expect(playing).toMatchObject({ index: 0, phase: "playing" });
    expect(paused).toMatchObject({ index: 0, phase: "paused" });
    expect(
      experienceMemoryReplayReducer(paused, { type: "audio_unavailable" }),
    ).toMatchObject({ index: 0, phase: "unavailable" });
    expect(resumed).toMatchObject({ index: 0, phase: "playing" });
    expect(
      experienceMemoryReplayReducer(resumed, { type: "audio_ended" }),
    ).toMatchObject({ index: 1, phase: "loading", segment: "moment" });
  });

  it("holds an unavailable artifact until the fan retries or explicitly skips it", () => {
    const ready = createExperienceMemoryReplayState(2);
    const intro = experienceMemoryReplayReducer(ready, { type: "start" });
    const first = experienceMemoryReplayReducer(intro, { type: "skip" });
    const unavailable = experienceMemoryReplayReducer(first, {
      type: "audio_unavailable",
    });

    expect(unavailable).toMatchObject({
      index: 0,
      phase: "unavailable",
      segment: "moment",
      total: 2,
    });
    expect(
      experienceMemoryReplayReducer(unavailable, { type: "retry" }),
    ).toMatchObject({ index: 0, phase: "loading", segment: "moment" });
    expect(
      experienceMemoryReplayReducer(unavailable, { type: "skip" }),
    ).toMatchObject({ index: 1, phase: "loading", segment: "moment" });
  });

  it("holds the introduction card when intro audio errors", () => {
    const loading = experienceMemoryReplayReducer(
      createExperienceMemoryReplayState(3),
      { type: "start" },
    );
    const unavailable = experienceMemoryReplayReducer(loading, {
      type: "audio_unavailable",
    });

    expect(unavailable).toEqual({
      index: null,
      phase: "unavailable",
      segment: "intro",
      total: 3,
    });
    expect(
      experienceMemoryReplayReducer(unavailable, { type: "retry" }),
    ).toMatchObject({ index: null, phase: "loading", segment: "intro" });
  });

  it("finishes only after the final artifact ends and can replay from the start", () => {
    const last = {
      index: 1,
      phase: "playing" as const,
      segment: "moment" as const,
      total: 2,
    };
    const complete = experienceMemoryReplayReducer(last, {
      type: "audio_ended",
    });

    expect(complete).toEqual({
      index: null,
      phase: "complete",
      segment: null,
      total: 2,
    });
    expect(experienceMemoryReplayReducer(complete, { type: "start" })).toEqual({
      index: null,
      phase: "loading",
      segment: "intro",
      total: 2,
    });
    expect(experienceMemoryReplayReducer(complete, { type: "close" })).toEqual({
      index: null,
      phase: "idle",
      segment: null,
      total: 2,
    });
  });

  it("does not allow replay to restart while narration is active", () => {
    expect(
      experienceMemoryReplayIsActive({
        index: 0,
        phase: "playing",
        segment: "moment",
        total: 2,
      }),
    ).toBe(true);
    expect(
      experienceMemoryReplayIsActive(createExperienceMemoryReplayState(2)),
    ).toBe(false);
  });

  it("uses the Experience server artifacts for the intro and each canonical revision", () => {
    expect(experienceMemoryIntroPath("experience:run one")).toBe(
      "/api/v1/experience/runs/run%20one/memory/intro.mp3",
    );
    expect(
      experienceMemoryArtifactPath("experience:run one", "goal:one:3"),
    ).toBe("/api/v1/experience/runs/run%20one/moments/goal%3Aone%3A3/audio");
  });
});

describe("Experience Match Memory", () => {
  it("keeps the final facts, revisions, transcript and restart path together", () => {
    const markup = renderToStaticMarkup(
      createElement(ExperienceMemory, {
        catalog: {
          teams: [
            {
              code: "ARG",
              name: "Argentina",
              primary: "#72b9e8",
              secondary: "#fff",
            },
            {
              code: "FRA",
              name: "France",
              primary: "#173f8a",
              secondary: "#fff",
            },
          ],
        },
        fixture: {
          awayTeam: "FRA",
          fixtureId: "experience:run_one",
          homeTeam: "ARG",
          minute: "FT",
          score: { away: 1, home: 2 },
        },
        onClose: vi.fn(),
        onRestart: vi.fn(),
        timeline: [
          {
            celebratesGoal: false,
            eventTeam: "FRA",
            id: "equalizer",
            identity: "equalizer:2",
            kind: "var.overturned",
            minute: "88'",
            revision: 2,
            score: { away: 1, home: 2 },
            status: "overturned",
          },
        ],
        transcripts: [
          {
            momentIdentity: "equalizer:2",
            text: "No goal. The decision is overturned.",
          },
        ],
      }),
    );

    expect(markup).toContain("EXPERIENCE MEMORY");
    expect(markup).toContain("ARG 2");
    expect(markup).toContain("overturned · revision 2");
    expect(markup).toContain("No goal. The decision is overturned.");
    expect(markup).toContain("Start a new Experience");
    expect(markup).toContain("Here is your MatchSense match summary.");
    expect(markup).not.toContain("speechSynthesis");
  });
});
