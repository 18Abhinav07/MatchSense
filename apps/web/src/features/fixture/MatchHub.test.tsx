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
});
