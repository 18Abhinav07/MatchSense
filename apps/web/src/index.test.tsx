import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import * as shell from "./index";
import type { AppProps } from "./App.js";

describe("MatchSense web product", () => {
  it("renders the team-first product entry point", () => {
    expect("App" in shell).toBe(true);

    const App = (
      "App" in shell ? shell.App : () => null
    ) as FunctionComponent<AppProps>;
    const markup = renderToStaticMarkup(
      createElement(App, { initialFavoriteTeam: null, initialPath: "/" }),
    );

    expect(markup).toContain("<main");
    expect(markup).toContain("MatchSense");
    expect(markup).toContain("Who do you support?");
    expect(markup).toContain("Search teams");
    expect(markup).toContain("TXLINE TOURNAMENT CATALOG");
    expect(markup).not.toContain("SIMULATION · TXLINE-SHAPED DATA");
    expect(markup).not.toContain("DEMO MODE");
  });
});
