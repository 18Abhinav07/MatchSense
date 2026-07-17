import { describe, expect, it } from "vitest";

import type { MatchMemoryRecord } from "./memory-api.js";
import { matchMemoryView } from "./memory-view.js";

const memory: MatchMemoryRecord = {
  createdAt: "2026-07-17T15:00:00.000Z",
  fanId: "fan-1",
  fixtureId: "fixture-live",
  mode: "live",
  payload: {
    awayTeam: "FRA",
    decidedBy: "regulation",
    finalizedAt: "2026-07-17T15:00:00.000Z",
    fixtureId: "fixture-live",
    homeTeam: "ARG",
    keyMoments: [
      {
        eventTeam: "FRA",
        familyId: "red-1",
        identity: "red-1:5",
        kind: "card.red",
        minute: "71'",
        player: { displayName: "Theo Hernández", id: "theo" },
        revision: 5,
        score: { away: 1, home: 2 },
        status: "confirmed",
      },
      {
        eventTeam: null,
        familyId: "final-1",
        identity: "final-1:7",
        kind: "phase.full_time",
        minute: "FT",
        player: null,
        revision: 7,
        score: { away: 1, home: 2 },
        status: "confirmed",
      },
    ],
    kickoffAt: "2026-07-17T12:00:00.000Z",
    mode: "live",
    provenance: "live_txline",
    replay: {
      available: true,
      fixtureRoute: "/matches/fixture-live/memory",
      kind: "canonical_timeline",
      momentRouteTemplate: "/matches/fixture-live/moments/{identity}",
      restartable: false,
      runId: null,
      templateId: null,
      templateVersion: null,
    },
    revision: 7,
    schemaVersion: 1,
    score: { away: 1, home: 2 },
    sourceLabel: "TXLINE · DEVNET SOURCE",
    stats: {
      away: { corners: 3, redCards: 1, yellowCards: 2 },
      home: { corners: 7, redCards: 0, yellowCards: 1 },
    },
    summary: "Argentina won a tense final.",
  },
  revision: 7,
};

describe("Match Memory UI view model", () => {
  it("maps durable final truth and canonical event kinds into the Memory UI", () => {
    const view = matchMemoryView(memory);

    expect(view.snapshot).toMatchObject({
      fixtureId: "fixture-live",
      minute: "FT",
      phase: "full_time",
      revision: 7,
      score: { away: 1, home: 2 },
    });
    expect(view.moments).toMatchObject([
      { kind: "red_card", playerName: "Theo Hernández" },
      { eventTeam: "ARG", kind: "full_time" },
    ]);
    expect(view.stats).toEqual([
      { away: 1, home: 2, label: "Goals" },
      { away: 3, home: 1, label: "Cards" },
      { away: 3, home: 7, label: "Corners" },
    ]);
    expect(view.summary).toBe("Argentina won a tense final.");
  });
});
