import type { FixtureSnapshot } from "@matchsense/contracts";
import type { TxlineCanonicalEvent } from "@matchsense/txline-adapter";
import { describe, expect, it } from "vitest";

import { productFactsFromTxlineEvent } from "./txline-product-facts.js";

const fixture = {
  awayTeam: "ESP",
  fixtureId: "fixture-live",
  homeTeam: "FRA",
  participant1IsHome: true,
} as const;

const current: FixtureSnapshot = {
  awayTeam: "ESP",
  fixtureId: fixture.fixtureId,
  homeTeam: "FRA",
  kickoffAt: "2026-07-17T18:00:00.000Z",
  lastEvent: null,
  minute: "20'",
  phase: "first_half",
  provenance: "live_txline",
  revision: 4,
  score: { away: 0, home: 0 },
  sourceLabel: "TXLINE · DEVNET SOURCE",
  stats: {
    away: {
      corners: 1,
      penaltiesAwarded: 0,
      penaltiesMissed: 0,
      penaltiesScored: 0,
      redCards: 0,
      yellowCards: 0,
    },
    home: {
      corners: 2,
      penaltiesAwarded: 0,
      penaltiesMissed: 0,
      penaltiesScored: 0,
      redCards: 0,
      yellowCards: 1,
    },
  },
  updatedAt: "2026-07-17T18:20:00.000Z",
};

function update(
  overrides: Partial<TxlineCanonicalEvent> = {},
): TxlineCanonicalEvent {
  return {
    action: "shot",
    actionId: "action-21",
    clockSeconds: 1_260,
    confirmed: true,
    delivery: "live",
    fixtureId: fixture.fixtureId,
    participant: 2,
    participantScore: { participant1: 0, participant2: 0 },
    participantStats: {
      participant1: {
        corners: 3,
        goals: 0,
        redCards: 0,
        yellowCards: 2,
      },
      participant2: {
        corners: 2,
        goals: 0,
        redCards: 1,
        yellowCards: 0,
      },
    },
    playerId: "player-9",
    provenance: "live_txline",
    receivedAt: "2026-07-17T18:21:00.000Z",
    revision: 5,
    score: { away: 0, home: 0 },
    source: {
      actionId: "action-21",
      observedSeq: "21",
      payloadHash: "a".repeat(64),
      sourceTimestampMs: 1_784_313_660_000,
      sseEventId: "21",
    },
    statusId: 4,
    supersedesRevision: null,
    varOutcome: null,
    varReviewType: null,
    ...overrides,
  };
}

describe("TxLINE product fact mapping", () => {
  it("turns aggregate counter deltas into canonical card and corner Moments", () => {
    const facts = productFactsFromTxlineEvent(update(), fixture, current);

    expect(facts.map(({ kind, team }) => ({ kind, team }))).toEqual([
      { kind: "corner", team: "FRA" },
      { kind: "card.yellow", team: "FRA" },
      { kind: "corner", team: "ESP" },
      { kind: "card.red", team: "ESP" },
    ]);
    expect(facts.every(({ minute }) => minute === "21'")).toBe(true);
    expect(
      new Set(facts.map(({ sourceEnvelopeId }) => sourceEnvelopeId)).size,
    ).toBe(4);
  });

  it("maps a confirmed penalty action to a team-owned penalty Moment", () => {
    const facts = productFactsFromTxlineEvent(
      update({
        action: "penalty",
        actionId: "penalty-1",
        participantStats: null,
      }),
      fixture,
      current,
    );

    expect(facts).toEqual([
      expect.objectContaining({
        kind: "penalty.awarded",
        minute: "21'",
        team: "ESP",
      }),
    ]);
  });
});
