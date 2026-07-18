import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FixtureCard } from "./FixtureCard.js";

describe("FixtureCard", () => {
  it("does not fabricate a score for a live fixture before a score projection exists", () => {
    const markup = renderToStaticMarkup(
      createElement(FixtureCard, {
        catalog: {
          teams: [
            {
              code: "ARG",
              name: "Argentina",
              primary: "#74acdf",
              secondary: "#ffffff",
            },
            {
              code: "FRA",
              name: "France",
              primary: "#173a70",
              secondary: "#ffffff",
            },
          ],
        },
        fixture: {
          awayTeam: "FRA",
          fixtureId: "arg-fra",
          freshness: "live",
          homeTeam: "ARG",
          lifecycle: "LIVE",
          minute: "—",
          score: null,
        },
        onOpen: () => undefined,
        tone: "live",
      }),
    );

    expect(markup).toContain("SCORE PENDING");
    expect(markup).not.toContain("0—0");
  });
});
