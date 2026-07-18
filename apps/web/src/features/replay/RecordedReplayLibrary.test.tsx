import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ProductCatalog } from "../../live-api.js";
import type { LiveSnapshot } from "../../product-state.js";

import { RecordedReplayLibrary } from "./RecordedReplayLibrary.js";

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

const ready: LiveSnapshot = {
  archiveManifestId: "archive-ready",
  archiveStatus: "REPLAY_READY",
  awayTeam: "FRA",
  fixtureId: "arg-fra",
  homeTeam: "ARG",
  lifecycle: "FINAL",
  minute: "FT",
  mode: "recorded",
  provenance: "recorded_txline_authorised",
  score: { away: 1, home: 2 },
};

describe("recorded replay library", () => {
  it("shows only archive-qualified recorded finals", () => {
    const markup = renderToStaticMarkup(
      createElement(RecordedReplayLibrary, {
        catalog,
        fixtures: [
          ready,
          { ...ready, archiveStatus: "PENDING", fixtureId: "not-ready" },
        ],
        onBack: () => undefined,
        onOpenMemory: () => undefined,
        onOpenReplay: () => undefined,
        state: "ready",
      }),
    );

    expect(markup).toContain("RECORDED REPLAYS");
    expect(markup).toContain("Argentina");
    expect(markup).toContain("Open recorded replay");
    expect(markup).toContain("View verified Memory");
    expect(markup).not.toContain("not-ready");
    expect(markup).not.toContain("Create Room");
  });

  it("makes no claim when no verified recording is available", () => {
    const markup = renderToStaticMarkup(
      createElement(RecordedReplayLibrary, {
        catalog,
        fixtures: [],
        state: "ready",
      }),
    );

    expect(markup).toContain("No recorded replays are available yet");
    expect(markup).not.toContain("Replay a demo");
  });
});
