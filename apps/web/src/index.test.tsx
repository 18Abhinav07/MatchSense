import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import * as shell from "./index";
import type { AppProps } from "./App.js";

describe("MatchSense web product", () => {
  it("opens an ordinary first launch with the skippable MatchSense intro", () => {
    expect("App" in shell).toBe(true);

    const App = (
      "App" in shell ? shell.App : () => null
    ) as FunctionComponent<AppProps>;
    const markup = renderToStaticMarkup(
      createElement(App, { initialFavoriteTeam: null, initialPath: "/" }),
    );

    expect(markup).toContain("<main");
    expect(markup).toContain("MatchSense");
    expect(markup).toContain("EVERY MATCH HAS A PULSE.");
    expect(markup).toContain("Skip intro");
    expect(markup).not.toContain("Who do you support?");
    expect(markup).not.toContain("SIMULATION · TXLINE-SHAPED DATA");
    expect(markup).not.toContain("DEMO MODE");
  });

  it("renders a deep-linked match before asking an incomplete fan to finish their card", () => {
    const App = shell.App as FunctionComponent<AppProps>;
    const markup = renderToStaticMarkup(
      createElement(App, {
        initialFavoriteTeam: null,
        initialPath: "/matches/experience-match/live",
      }),
    );

    expect(markup).toContain("CONNECTING TO MATCH");
    expect(markup).toContain("Finish your fan card");
    expect(markup).not.toContain("EVERY MATCH HAS A PULSE.");
  });

  it("serves a first-class You profile with team identity and preferences", () => {
    const App = shell.App as FunctionComponent<AppProps>;
    const markup = renderToStaticMarkup(
      createElement(App, { initialFavoriteTeam: "ARG", initialPath: "/you" }),
    );

    expect(markup).toContain("This is your MatchSense.");
    expect(markup).toContain("Save profile");
    expect(markup).toContain("ms-team-flag");
    expect(markup).toContain("Delete profile");
  });

  it("renders the judged demo as a favorite-team launcher for the production Experience flow", () => {
    const App = shell.App as FunctionComponent<AppProps>;
    const markup = renderToStaticMarkup(
      createElement(App, { initialFavoriteTeam: "BRA", initialPath: "/demo" }),
    );

    expect(markup).toContain("JUDGED DEMO · REAL PRODUCT FLOW");
    expect(markup).toContain("BRA");
    expect(markup).toContain("Enable &amp; test real alerts");
    expect(markup).toContain("Start the five-minute Experience Match");
    expect(markup).toContain("Start listening");
    expect(markup).not.toContain("Scripted Argentina–France match");
    expect(markup).not.toContain("not OS push notifications");
  });
});
