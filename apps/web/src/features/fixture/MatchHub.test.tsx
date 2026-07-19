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
        transportHealth: "reconciled",
      }),
    );

    expect(markup).toContain("CACHED DATA");
    expect(markup).toContain("Argentina");
    expect(markup).toContain("France");
    expect(markup).not.toContain(">LIVE<");
    expect(markup).toContain("Start listening");
  });

  it("shows a source-projected live match when the SSE is reconciled", () => {
    const markup = renderToStaticMarkup(
      createElement(MatchHub, {
        catalog,
        favoriteTeam: "FRA",
        fixture: {
          awayTeam: "ENG",
          fixtureId: "france-england",
          homeTeam: "FRA",
          lifecycle: "LIVE",
          minute: "18′",
          phase: "first_half",
          score: { away: 0, home: 0 },
        },
        state: "ready",
        transportHealth: "reconciled",
      }),
    );

    expect(markup).toContain(">LIVE<");
    expect(markup).not.toContain("MATCH STATUS PENDING");
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

    expect(markup).toContain("Kickoff time pending");
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

    expect(markup).toContain("Open Moment");
    expect(markup).not.toContain("Replay a demo");
  });

  it("renders an upcoming fixture as a scheduled match rather than a missing score", () => {
    const markup = renderToStaticMarkup(
      createElement(MatchHub, {
        catalog,
        favoriteTeam: "ARG",
        fixture: {
          awayTeam: "FRA",
          fixtureId: "scheduled-1",
          homeTeam: "ARG",
          kickoffAt: "2026-07-19T19:00:00.000Z",
          lifecycle: "SCHEDULED",
          minute: "—",
          score: null,
          sourceLabel: "TXLINE MATCH DATA",
        },
        state: "ready",
      }),
    );

    expect(markup).toContain("UPCOMING");
    expect(markup).toContain("Jul");
    expect(markup).toContain("Match events begin when TxLINE publishes them");
    expect(markup).not.toContain("SCORE NOT PUBLISHED");
    expect(markup).not.toContain("Connection required");
    expect(markup).not.toContain("Stream unavailable");
  });

  it("prioritises verified-final truth over cached transport freshness", () => {
    const markup = renderToStaticMarkup(
      createElement(MatchHub, {
        catalog,
        favoriteTeam: "ARG",
        fixture: {
          archiveStatus: "REPLAY_READY",
          awayTeam: "FRA",
          fixtureId: "final-1",
          freshness: "cached",
          homeTeam: "ARG",
          lifecycle: "FINAL",
          minute: "FT",
          score: { away: 1, home: 2 },
        },
        state: "ready",
      }),
    );

    expect(markup).toContain("VERIFIED FINAL");
    expect(markup).not.toContain("CACHED DATA");
  });

  it("labels terminal truth as finalising rather than pending", () => {
    const markup = renderToStaticMarkup(
      createElement(MatchHub, {
        catalog,
        favoriteTeam: "ARG",
        fixture: {
          awayTeam: "FRA",
          fixtureId: "terminal-1",
          freshness: "cached",
          homeTeam: "ARG",
          lifecycle: "TERMINAL_FACT_COMMITTED",
          minute: "FT",
          score: { away: 1, home: 2 },
        },
        state: "ready",
      }),
    );

    expect(markup).toContain("FINALISING RESULT");
    expect(markup).not.toContain("MATCH STATUS PENDING");
  });

  it("renders the ordered canonical event rail and honest reconnect state", () => {
    const moments = [
      {
        celebratesGoal: true,
        eventTeam: "ARG",
        id: "goal-1",
        identity: "goal-1:1",
        kind: "goal",
        minute: "23′",
        revision: 1,
        score: { away: 0, home: 1 },
        status: "confirmed",
        title: "Argentina take the lead",
      },
      {
        celebratesGoal: false,
        eventTeam: "FRA",
        id: "card-1",
        identity: "card-1:1",
        kind: "red_card",
        minute: "61′",
        revision: 1,
        score: { away: 0, home: 1 },
        status: "confirmed",
        title: "France are down to ten",
      },
    ] as const;
    const markup = renderToStaticMarkup(
      createElement(MatchHub, {
        catalog,
        favoriteTeam: "ARG",
        fixture: {
          awayTeam: "FRA",
          fixtureId: "fx-1",
          freshness: "live",
          homeTeam: "ARG",
          lifecycle: "LIVE",
          minute: "61′",
          score: { away: 0, home: 1 },
        },
        state: "ready",
        timeline: moments,
        transportHealth: "stale",
      }),
    );

    expect(markup).toContain("RECONNECTING");
    expect(markup).not.toContain(">LIVE<");
    expect(markup.indexOf("Argentina take the lead")).toBeLessThan(
      markup.indexOf("France are down to ten"),
    );
  });
});
