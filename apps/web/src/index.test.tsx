import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import * as shell from "./index";

describe("MatchSense web shell", () => {
  it("renders an accessible product entry point", () => {
    expect("App" in shell).toBe(true);

    const App = ("App" in shell ? shell.App : () => null) as FunctionComponent;
    const markup = renderToStaticMarkup(createElement(App));

    expect(markup).toContain("<main");
    expect(markup).toContain("MatchSense");
    expect(markup).toContain("Follow every moment");
    expect(markup).toContain("Simulation shell");
    expect(markup).not.toContain("Replay ready");
    expect(markup).not.toContain("LIVE");
    expect(markup).not.toContain("Live match truth");
    expect(markup).not.toContain("automatic spoken commentary");
  });
});
