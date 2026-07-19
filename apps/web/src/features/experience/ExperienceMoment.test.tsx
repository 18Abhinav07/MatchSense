import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ExperienceMoment } from "./ExperienceMoment.js";

describe("Experience Moment truth", () => {
  it("turns technical event kinds into fan-facing action names", () => {
    const markup = renderToStaticMarkup(
      createElement(ExperienceMoment, {
        catalog: { teams: [] },
        moment: {
          celebratesGoal: false,
          eventTeam: "FRA",
          id: "penalty",
          identity: "penalty:1",
          kind: "phase.penalty",
          minute: "40'",
          revision: 1,
          score: { away: 0, home: 1 },
          status: "confirmed",
          title: "phase.penalty",
        },
        onClose: vi.fn(),
        snapshot: {
          awayTeam: "FRA",
          fixtureId: "experience:run_one",
          homeTeam: "ARG",
          minute: "40'",
          score: { away: 0, home: 1 },
        },
      }),
    );

    expect(markup).toContain("Penalty awarded");
    expect(markup).not.toContain("phase.penalty");
  });

  it("renders the authored caption without adding its own audio player", () => {
    const markup = renderToStaticMarkup(
      createElement(ExperienceMoment, {
        authoredCaption: "Argentina lead France two goals to one.",
        catalog: { teams: [] },
        moment: {
          celebratesGoal: true,
          eventTeam: "ARG",
          id: "winner",
          identity: "winner:1",
          kind: "goal",
          minute: "78'",
          revision: 1,
          score: { away: 1, home: 2 },
          status: "confirmed",
        },
        onClose: vi.fn(),
        snapshot: {
          awayTeam: "FRA",
          fixtureId: "experience:run_one",
          homeTeam: "ARG",
          minute: "78'",
          score: { away: 1, home: 2 },
        },
      }),
    );

    expect(markup).toContain("Argentina lead France two goals to one.");
    expect(markup).not.toContain("<audio");
  });

  it("renders neutral full-time cinema when the canonical event has no team", () => {
    const markup = renderToStaticMarkup(
      createElement(ExperienceMoment, {
        catalog: { teams: [] },
        moment: {
          celebratesGoal: false,
          eventTeam: null as unknown as string,
          id: "full-time",
          identity: "full-time:1",
          kind: "phase.full_time",
          minute: "FT",
          revision: 1,
          score: { away: 1, home: 2 },
          status: "confirmed",
        },
        onClose: vi.fn(),
        snapshot: {
          awayTeam: "FRA",
          fixtureId: "experience:run_one",
          homeTeam: "ARG",
          minute: "FT",
          score: { away: 1, home: 2 },
        },
      }),
    );

    expect(markup).toContain("Full time");
    expect(markup).toContain("ARG");
    expect(markup).toContain("FRA");
    expect(markup).not.toContain("undefined flag");
  });
});
