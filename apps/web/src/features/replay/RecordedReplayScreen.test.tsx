import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ProductCatalog } from "../../live-api.js";
import type { RecordedReplayTimeline } from "../../replay-api.js";

import { RecordedReplayScreen } from "./RecordedReplayScreen.js";

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

const replay: RecordedReplayTimeline = {
  archiveManifestId: "archive-ready",
  events: [
    {
      eventId: "goal-1:2",
      eventType: "moment.created",
      moment: {
        celebratesGoal: true,
        eventTeam: "ARG",
        id: "goal-1",
        identity: "goal-1:2",
        kind: "goal",
        minute: "81'",
        revision: 2,
        score: { away: 1, home: 2 },
        status: "confirmed",
      },
      replaySeq: 14,
    },
  ],
  fixtureId: "arg-fra",
  fixtureMode: "recorded",
  highWaterSequence: 14,
  id: "recorded_YXJnLWZyYQ.YXJjaGl2ZS1yZWFkeQ",
  mode: "recorded",
  replaySeq: 0,
  snapshot: {
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
  },
};

describe("recorded replay screen", () => {
  it("renders archive-qualified facts and ordered source events without live-product controls", () => {
    const markup = renderToStaticMarkup(
      createElement(RecordedReplayScreen, {
        catalog,
        onBack: () => undefined,
        replay,
      }),
    );

    expect(markup).toContain("RECORDED · TXLINE DATA");
    expect(markup).toContain("Argentina 2—1 France");
    expect(markup).toContain("Replay sequence 14");
    expect(markup).toContain('data-replay-sequence="14"');
    expect(markup).not.toContain("Create Room");
    expect(markup).not.toContain("Enable alerts");
    expect(markup).not.toContain("Start listening");
  });
});
