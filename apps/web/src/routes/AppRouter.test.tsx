import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { FanProfile } from "../fan-profile.js";
import type { ProductCatalog } from "../live-api.js";
import type { LiveSnapshot } from "../product-state.js";

import { AppRouter, type AppRouterProps } from "./AppRouter.js";

const catalog: ProductCatalog = {
  teams: [
    {
      code: "ARG",
      name: "Argentina",
      primary: "#78bde9",
      secondary: "#ffffff",
    },
    {
      code: "FRA",
      name: "France",
      primary: "#174c9a",
      secondary: "#ffffff",
    },
  ],
};

const profile: FanProfile = {
  avatarVariant: "arg-pulse",
  createdAt: "2026-07-18T00:00:00.000Z",
  deletedAt: null,
  favoriteTeam: "ARG",
  handle: "matchfan",
  handleNormalized: "matchfan",
  id: "fan-42",
  preferences: {},
  profile: {},
  updatedAt: "2026-07-18T00:00:00.000Z",
};

const fixture: LiveSnapshot = {
  awayTeam: "FRA",
  fixtureId: "arg-fra",
  freshness: "live",
  homeTeam: "ARG",
  lifecycle: "LIVE",
  minute: "23'",
  provenance: "live_txline",
  score: { away: 0, home: 1 },
};

function render(props: Partial<AppRouterProps>) {
  return renderToStaticMarkup(
    createElement(AppRouter as FunctionComponent<AppRouterProps>, {
      initialCatalog: catalog,
      initialFixtures: [fixture],
      initialProfile: profile,
      ...props,
    }),
  );
}

describe("truthful application router", () => {
  it("renders Today from supplied server-qualified fixtures", () => {
    const markup = render({ initialPath: "/" });

    expect(markup).toContain("Live now");
    expect(markup).toContain("Argentina");
    expect(markup).not.toContain("DEMO MODE");
  });

  it("renders the exact Match Hub route without inventing its score", () => {
    const markup = render({ initialPath: "/matches/arg-fra" });

    expect(markup).toContain("Argentina");
    expect(markup).toContain("France");
    expect(markup).toContain("LIVE");
    expect(markup).toContain("Stream unavailable");
  });

  it("does not expose a public demo route", () => {
    const markup = render({ initialPath: "/demo" });

    expect(markup).toContain("YOUR MATCH DAY");
    expect(markup).not.toContain("JUDGED DEMO");
    expect(markup).not.toContain("Open Demo Mode");
  });
});
