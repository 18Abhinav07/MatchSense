import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TodayHub } from "./TodayHub.js";

const teams = {
  ARG: {
    code: "ARG",
    name: "Argentina",
    primary: "#75aadb",
    secondary: "#f4f1e8",
  },
  FRA: {
    code: "FRA",
    name: "France",
    primary: "#203c7c",
    secondary: "#f4f1e8",
  },
};

describe("TodayHub", () => {
  it("renders only server-qualified live, upcoming, and verified-final buckets", () => {
    const markup = renderToStaticMarkup(
      createElement(TodayHub, {
        catalog: { teams: Object.values(teams) },
        favoriteTeam: "ARG",
        fixtures: [
          {
            awayTeam: "FRA",
            fixtureId: "live-1",
            freshness: "live",
            homeTeam: "ARG",
            lifecycle: "LIVE",
            minute: "63′",
            score: { away: 0, home: 1 },
          },
          {
            awayTeam: "FRA",
            fixtureId: "upcoming-1",
            homeTeam: "ARG",
            kickoffAt: "2026-07-19T19:00:00.000Z",
            lifecycle: "SCHEDULED",
            minute: "—",
            score: { away: 0, home: 0 },
          },
          {
            archiveStatus: "REPLAY_READY",
            awayTeam: "FRA",
            fixtureId: "final-1",
            freshness: "cached",
            homeTeam: "ARG",
            lifecycle: "FINAL",
            minute: "FT",
            score: { away: 1, home: 2 },
          },
          {
            awayTeam: "FRA",
            fixtureId: "unavailable-result",
            homeTeam: "ARG",
            lifecycle: "RESULT_UNAVAILABLE",
            minute: "—",
            score: { away: 0, home: 0 },
          },
        ],
        onOpenFixture: () => undefined,
        onOpenProfile: () => undefined,
        state: "ready",
      }),
    );

    expect(markup).toContain("Live now");
    expect(markup).toContain("Upcoming");
    expect(markup).toContain("Verified finals");
    expect(markup).toContain("live-1");
    expect(markup).toContain("final-1");
    expect(markup).not.toContain("unavailable-result");
    expect(markup).not.toContain("Demo");
  });

  it("does not invent a schedule when the server has no eligible rows", () => {
    const markup = renderToStaticMarkup(
      createElement(TodayHub, {
        catalog: { teams: [] },
        favoriteTeam: null,
        fixtures: [],
        onOpenFixture: () => undefined,
        onOpenProfile: () => undefined,
        state: "unavailable",
      }),
    );

    expect(markup).toContain("Match schedule unavailable");
    expect(markup).not.toContain("Argentina");
  });

  it("offers the separate archive-backed replay library when navigation is connected", () => {
    const markup = renderToStaticMarkup(
      createElement(TodayHub, {
        catalog: { teams: [] },
        favoriteTeam: null,
        fixtures: [],
        onOpenFixture: () => undefined,
        onOpenProfile: () => undefined,
        onOpenReplays: () => undefined,
        state: "ready",
      }),
    );

    expect(markup).toContain("Recorded replays");
  });

  it("offers an accessible route to the fan's editable profile", () => {
    const markup = renderToStaticMarkup(
      createElement(TodayHub, {
        catalog: { teams: [] },
        favoriteTeam: null,
        fixtures: [],
        onOpenFixture: () => undefined,
        onOpenProfile: () => undefined,
        state: "ready",
      }),
    );

    expect(markup).toContain("Your profile");
    expect(markup).toContain('aria-label="Your profile"');
  });
});
