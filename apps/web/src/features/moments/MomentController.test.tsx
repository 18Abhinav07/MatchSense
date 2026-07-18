import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { MomentResolution, ProductCatalog } from "../../live-api.js";
import type { LiveMoment, LiveSnapshot } from "../../product-state.js";

import { MomentController } from "./MomentController.js";

const catalog: ProductCatalog = {
  teams: [
    {
      code: "ARG",
      name: "Argentina",
      primary: "#74acdf",
      secondary: "#ffffff",
    },
    { code: "FRA", name: "France", primary: "#173a70", secondary: "#ffffff" },
  ],
};

const snapshot: LiveSnapshot = {
  awayTeam: "FRA",
  fixtureId: "fx-arg-fra",
  freshness: "live",
  homeTeam: "ARG",
  lifecycle: "LIVE",
  minute: "24'",
  provenance: "live_txline",
  revision: 4,
  score: { away: 0, home: 1 },
  sourceLabel: "TXLINE MATCH DATA",
};

const goal: LiveMoment = {
  celebratesGoal: true,
  eventTeam: "ARG",
  id: "goal-family",
  identity: "goal-family:3",
  kind: "goal",
  minute: "23'",
  revision: 3,
  score: { away: 0, home: 1 },
  status: "under_review",
};

function render(resolution: MomentResolution) {
  return renderToStaticMarkup(
    createElement(MomentController, {
      catalog,
      onClose: () => undefined,
      resolution,
    }),
  );
}

describe("revision-safe Moment controller", () => {
  it("paints the current score before holding a VAR review", () => {
    const markup = render({
      latest: goal,
      requested: goal,
      snapshot,
      superseded: false,
    });

    expect(markup).toContain("UNDER REVIEW");
    expect(markup).toContain('data-tone="var"');
    expect(markup.indexOf("ARG 1—0 FRA")).toBeLessThan(
      markup.indexOf("UNDER REVIEW"),
    );
    expect(markup).toContain("Celebration held");
  });

  it("replaces a stale goal deep link with the current overturned revision", () => {
    const overturned: LiveMoment = {
      ...goal,
      identity: "goal-family:4",
      kind: "var.overturned",
      revision: 4,
      score: { away: 0, home: 0 },
      status: "overturned",
    };
    const markup = render({
      latest: overturned,
      requested: goal,
      snapshot: { ...snapshot, score: { away: 0, home: 0 } },
      superseded: true,
    });

    expect(markup).toContain("No goal — overturned.");
    expect(markup).toContain("Requested revision superseded");
    expect(markup).toContain("Current revision 4");
    expect(markup).not.toContain("GOAL CONFIRMED");
  });

  it("shows a VAR-stands confirmation and applies factual card tones", () => {
    const stands = render({
      latest: {
        ...goal,
        identity: "goal-family:4",
        kind: "var.stands",
        revision: 4,
        status: "confirmed",
      },
      requested: goal,
      snapshot,
      superseded: true,
    });
    const yellow = render({
      latest: {
        ...goal,
        celebratesGoal: false,
        id: "yellow-1",
        identity: "yellow-1:1",
        kind: "card.yellow",
        revision: 1,
        status: "confirmed",
      },
      requested: null,
      snapshot,
      superseded: false,
    });
    const red = render({
      latest: {
        ...goal,
        celebratesGoal: false,
        id: "red-1",
        identity: "red-1:1",
        kind: "card.red",
        revision: 1,
        status: "confirmed",
      },
      requested: null,
      snapshot,
      superseded: false,
    });

    expect(stands).toContain("The goal stands.");
    expect(yellow).toContain('data-tone="yellow"');
    expect(yellow).toContain("Yellow card");
    expect(red).toContain('data-tone="red"');
    expect(red).toContain("Red card");
  });
});
