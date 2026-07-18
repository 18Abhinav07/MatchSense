import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import * as shell from "./index";
import type { AppProps } from "./App.js";

const catalog = {
  teams: [
    {
      code: "ARG",
      name: "Argentina",
      primary: "#78bde9",
      secondary: "#ffffff",
    },
  ],
};

const profile = {
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

describe("MatchSense web product", () => {
  it("opens a white-on-green MatchSense intro before asking for permission", () => {
    expect("App" in shell).toBe(true);
    const App = shell.App as FunctionComponent<AppProps>;
    const markup = renderToStaticMarkup(
      createElement(App, {
        initialCatalog: catalog,
        initialPath: "/",
        initialProfile: null,
      }),
    );

    expect(markup).toContain("Every match has a pulse.");
    expect(markup).toContain("Skip intro");
    expect(markup).not.toContain("SIMULATION");
    expect(markup).not.toContain("DEMO MODE");
  });

  it("renders a profile surface from the saved supporter identity", () => {
    const App = shell.App as FunctionComponent<AppProps>;
    const markup = renderToStaticMarkup(
      createElement(App, {
        initialCatalog: catalog,
        initialFixtures: [],
        initialPath: "/you",
        initialProfile: profile,
      }),
    );

    expect(markup).toContain("SUPPORTER PROFILE");
    expect(markup).toContain("fan-42");
    expect(markup).toContain("Argentina flag");
  });

  it("does not expose the retired demo route", () => {
    const App = shell.App as FunctionComponent<AppProps>;
    const markup = renderToStaticMarkup(
      createElement(App, {
        initialCatalog: catalog,
        initialFixtures: [],
        initialPath: "/demo",
        initialProfile: profile,
      }),
    );

    expect(markup).toContain("YOUR MATCH DAY");
    expect(markup).not.toContain("JUDGED DEMO");
    expect(markup).not.toContain("Open Demo Mode");
  });
});
