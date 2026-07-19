import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ExperienceMemory } from "./ExperienceMemory.js";

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
  });
});
