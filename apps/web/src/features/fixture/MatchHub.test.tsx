import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MatchHub } from "./MatchHub.js";

const catalog = {
  teams: [
    {
      code: "ARG",
      name: "Argentina",
      primary: "#75aadb",
      secondary: "#f4f1e8",
    },
    {
      code: "FRA",
      name: "France",
      primary: "#203c7c",
      secondary: "#f4f1e8",
    },
  ],
};

describe("MatchHub", () => {
  it("labels cached data honestly instead of claiming a live match", () => {
    const markup = renderToStaticMarkup(
      createElement(MatchHub, {
        catalog,
        favoriteTeam: "ARG",
        fixture: {
          awayTeam: "FRA",
          fixtureId: "fx-1",
          freshness: "cached",
          homeTeam: "ARG",
          lifecycle: "LIVE",
          minute: "63′",
          score: { away: 0, home: 1 },
          updatedAt: "2026-07-18T06:00:00.000Z",
        },
        state: "ready",
      }),
    );

    expect(markup).toContain("CACHED DATA");
    expect(markup).toContain("Argentina");
    expect(markup).toContain("France");
    expect(markup).not.toContain(">LIVE<");
    expect(markup).not.toContain("Start listening");
  });

  it("does not fabricate a score while an exact fixture is loading", () => {
    const markup = renderToStaticMarkup(
      createElement(MatchHub, {
        catalog,
        favoriteTeam: "ARG",
        fixture: null,
        state: "loading",
      }),
    );

    expect(markup).toContain("Loading match truth");
    expect(markup).not.toContain("0—0");
  });

  it("keeps an unprojected fixture scoreless instead of rendering 0—0", () => {
    const markup = renderToStaticMarkup(
      createElement(MatchHub, {
        catalog,
        favoriteTeam: null,
        fixture: {
          awayTeam: "FRA",
          fixtureId: "scheduled-1",
          homeTeam: "ARG",
          lifecycle: "SCHEDULED",
          minute: "—",
          score: null,
        },
        state: "ready",
      }),
    );

    expect(markup).toContain("SCORE NOT PUBLISHED");
    expect(markup).not.toContain("0—0");
  });

  it("offers an exact deep link to the latest canonical Moment only when connected", () => {
    const markup = renderToStaticMarkup(
      createElement(MatchHub, {
        catalog,
        favoriteTeam: "ARG",
        fixture: {
          awayTeam: "FRA",
          fixtureId: "fx-1",
          freshness: "live",
          homeTeam: "ARG",
          lastEvent: {
            celebratesGoal: true,
            eventTeam: "ARG",
            id: "goal-1",
            identity: "goal-1:2",
            kind: "goal",
            minute: "63′",
            revision: 2,
            score: { away: 0, home: 1 },
            status: "confirmed",
          },
          lifecycle: "LIVE",
          minute: "63′",
          score: { away: 0, home: 1 },
        },
        onOpenMoment: () => undefined,
        state: "ready",
      }),
    );

    expect(markup).toContain("Open current Moment");
    expect(markup).not.toContain("Replay a demo");
  });
});
