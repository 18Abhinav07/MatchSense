import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ListeningProvider } from "../../ListeningProvider.js";
import { ExperienceMatch } from "./ExperienceMatch.js";

describe("Experience match", () => {
  it("renders server progress, Pocket Listening and honest canonical truth", () => {
    const markup = renderToStaticMarkup(
      createElement(
        ListeningProvider,
        null,
        createElement(ExperienceMatch, {
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
          catchupCount: 2,
          commentary: "Argentina are pressing the advantage.",
          favoriteTeam: "ARG",
          fixture: {
            awayTeam: "FRA",
            fixtureId: "experience:run_one",
            homeTeam: "ARG",
            minute: "70'",
            phase: "second_half",
            provenance: "simulated_txline_shaped",
            score: { away: 1, home: 2 },
          },
          moment: null,
          onBack: vi.fn(),
          onCloseMoment: vi.fn(),
          onRestart: vi.fn(),
          run: {
            completedAt: null,
            fixtureId: "experience:run_one",
            id: "run_one",
            kickoffAt: "2026-07-19T12:00:00.000Z",
            nextBeatIndex: 12,
            status: "live",
            templateVersion: 2,
          },
          streamPaused: false,
          timeline: [],
          revisionHistory: [],
          transcripts: [],
        }),
      ),
    );

    expect(markup).toContain("SIMULATED TXLINE-SHAPED DATA");
    expect(markup).toContain("SERVER RUN · 12/20");
    expect(markup).toContain("LISTENING MODE");
    expect(markup).toContain("Follow the match by sound");
    expect(markup).toContain("Caught you up");
    expect(markup).toContain("Argentina are pressing the advantage.");
  });
});
