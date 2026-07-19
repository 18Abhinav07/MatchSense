import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ExperienceMoment } from "./ExperienceMoment.js";

describe("Experience Moment truth", () => {
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
