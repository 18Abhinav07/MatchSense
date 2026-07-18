import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ProductCatalog } from "../../live-api.js";
import type { VerifiedFixtureMemory } from "../../memory-api.js";

import { MemorySurface } from "./MemorySurface.js";

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

const memory: VerifiedFixtureMemory = {
  archiveManifestId: "archive-arg-fra",
  fixture: {
    archiveManifestId: "archive-arg-fra",
    archiveStatus: "REPLAY_READY",
    awayTeam: "FRA",
    fixtureId: "arg-fra",
    homeTeam: "ARG",
    lifecycle: "FINAL",
    minute: "FT",
    mode: "recorded",
    provenance: "recorded_txline_authorised",
    score: { away: 1, home: 2 },
    sourceLabel: "TXLINE MATCH DATA",
  },
  timeline: [
    {
      createdAt: "2026-07-18T16:12:00.000Z",
      eventId: "goal-1",
      eventType: "moment.created",
      moment: {
        celebratesGoal: true,
        eventTeam: "ARG",
        id: "goal-1",
        identity: "goal-1:1",
        kind: "goal",
        minute: "81'",
        revision: 1,
        score: { away: 1, home: 2 },
        status: "confirmed",
      },
      sequence: 14,
    },
  ],
};

describe("verified Match Memory surface", () => {
  it("renders only archive-qualified final truth and a recorded replay entry", () => {
    const markup = renderToStaticMarkup(
      createElement(MemorySurface, {
        catalog,
        memory,
        onBack: () => undefined,
        onOpenReplay: () => undefined,
      }),
    );

    expect(markup).toContain("ARCHIVE VERIFIED");
    expect(markup).toContain("Argentina 2—1 France");
    expect(markup).toContain("Full time");
    expect(markup).toContain("81&#x27;");
    expect(markup).toContain("Open recorded replay");
    expect(markup).not.toContain("Create Room");
    expect(markup).not.toContain("Enable alerts");
  });

  it("does not offer a replay action unless a server-backed session opener exists", () => {
    const markup = renderToStaticMarkup(
      createElement(MemorySurface, { catalog, memory }),
    );

    expect(markup).not.toContain("Open recorded replay");
  });
});
