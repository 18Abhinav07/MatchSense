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
          timeline: [
            {
              celebratesGoal: true,
              eventTeam: "ARG",
              id: "winner",
              identity: "winner:1",
              kind: "goal",
              minute: "70'",
              revision: 1,
              score: { away: 1, home: 2 },
              status: "confirmed",
            },
          ],
          revisionHistory: [],
          transcripts: [
            {
              momentIdentity: "winner:1",
              text: "Argentina are pressing the advantage.",
            },
          ],
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

  it("never shows the previous Moment transcript for a new canonical identity", () => {
    const base = {
      catalog: { teams: [] },
      catchupCount: 0,
      favoriteTeam: "ARG",
      fixture: {
        awayTeam: "FRA",
        fixtureId: "experience:run_one",
        homeTeam: "ARG",
        minute: "24'",
        phase: "first_half",
        provenance: "simulated_txline_shaped",
        score: { away: 0, home: 1 },
      },
      moment: null,
      onBack: vi.fn(),
      onCloseMoment: vi.fn(),
      onRestart: vi.fn(),
      revisionHistory: [],
      run: {
        completedAt: null,
        fixtureId: "experience:run_one",
        id: "run_one",
        kickoffAt: "2026-07-19T12:00:00.000Z",
        nextBeatIndex: 5,
        status: "live" as const,
        templateVersion: 3,
      },
      streamPaused: false,
      timeline: [
        {
          celebratesGoal: false,
          detail: "The referee reaches for the book.",
          eventTeam: "ARG",
          id: "yellow",
          identity: "yellow:1",
          kind: "card.yellow",
          minute: "24'",
          revision: 1,
          score: { away: 0, home: 1 },
          status: "confirmed",
        },
      ],
    };
    const stale = renderToStaticMarkup(
      createElement(
        ListeningProvider,
        null,
        createElement(ExperienceMatch, {
          ...base,
          transcripts: [
            {
              momentIdentity: "goal:1",
              text: "Argentina's goal stands.",
            },
          ],
        }),
      ),
    );
    const ready = renderToStaticMarkup(
      createElement(
        ListeningProvider,
        null,
        createElement(ExperienceMatch, {
          ...base,
          transcripts: [
            {
              momentIdentity: "goal:1",
              text: "Argentina's goal stands.",
            },
            {
              momentIdentity: "yellow:1",
              text: "Yellow card for Argentina in the twenty-fourth minute.",
            },
          ],
        }),
      ),
    );

    expect(stale).not.toContain("Argentina&#x27;s goal stands.");
    expect(stale).toContain("The referee reaches for the book.");
    expect(ready).toContain(
      "Yellow card for Argentina in the twenty-fourth minute.",
    );
  });
});
