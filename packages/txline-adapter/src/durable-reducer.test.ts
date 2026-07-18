import type { FixtureSnapshot } from "@matchsense/contracts";
import { describe, expect, it } from "vitest";

import {
  reduceDurableTxlineDelivery,
  type DurableTxlineFixture,
} from "./durable-reducer.js";

const fixture: DurableTxlineFixture = {
  awayTeam: "ESP",
  fixtureId: "fx-1",
  homeTeam: "FRA",
  kickoffAt: "2026-07-18T18:00:00.000Z",
  participant1IsHome: true,
};

const current: FixtureSnapshot = {
  awayTeam: fixture.awayTeam,
  fixtureId: fixture.fixtureId,
  homeTeam: fixture.homeTeam,
  kickoffAt: fixture.kickoffAt,
  lastEvent: null,
  minute: "20'",
  phase: "first_half",
  provenance: "live_txline",
  revision: 0,
  score: { away: 0, home: 0 },
  sourceLabel: "TXLINE · DEVNET SOURCE",
  updatedAt: "2026-07-18T18:20:00.000Z",
};

function scorePayload(action: string, overrides: Record<string, unknown> = {}) {
  return {
    Action: action,
    Confirmed: true,
    FixtureId: fixture.fixtureId,
    Id: "action-1",
    Participant: 1,
    Score: {
      Participant1: {
        Total: { Corners: 0, Goals: 1, RedCards: 0, YellowCards: 0 },
      },
      Participant2: {
        Total: { Corners: 0, Goals: 0, RedCards: 0, YellowCards: 0 },
      },
    },
    Seq: "12",
    Ts: 1_784_403_000_000,
    ...overrides,
  };
}

describe("durable TxLINE reduction", () => {
  it("turns an authorised realtime goal delivery into deterministic canonical facts", () => {
    const result = reduceDurableTxlineDelivery({
      current,
      fixture,
      metadata: {
        delivery: "live",
        provenance: "live_txline",
        receivedAt: "2026-07-18T18:21:00.000Z",
        sseEventId: "stream:12",
      },
      payload: scorePayload("goal"),
    });

    expect(result).toMatchObject({
      facts: [
        expect.objectContaining({
          fixtureId: "fx-1",
          kind: "goal",
          status: "confirmed",
          team: "FRA",
        }),
      ],
      invalidatesArchive: false,
      kind: "canonical",
    });
    if (result.kind !== "canonical") throw new Error("expected canonical");
    expect(result.facts[0]?.sourceEnvelopeId).toContain("txline:fx-1:12");
  });

  it("preserves authorised recorded TxLINE provenance for replay reduction", () => {
    const result = reduceDurableTxlineDelivery({
      current: { ...current, provenance: "recorded_txline_authorised" },
      fixture,
      metadata: {
        delivery: "replay",
        provenance: "recorded_txline_authorised",
        receivedAt: "2026-07-18T18:21:00.000Z",
        sseEventId: null,
      },
      payload: scorePayload("goal"),
    });

    expect(result).toMatchObject({
      facts: [
        expect.objectContaining({
          kind: "goal",
          provenance: "recorded_txline_authorised",
        }),
      ],
      kind: "canonical",
    });
  });

  it("keeps observed lifecycle telemetry as source-only with no canonical facts", () => {
    const result = reduceDurableTxlineDelivery({
      current,
      fixture,
      metadata: {
        delivery: "reconciliation",
        provenance: "live_txline",
        receivedAt: "2026-07-18T18:21:00.000Z",
        sseEventId: null,
      },
      payload: scorePayload("coverage_update"),
    });

    expect(result).toMatchObject({
      kind: "source_only",
      source: { action: "coverage_update", fixtureId: "fx-1" },
    });
  });

  it("marks an amendment as an archive-invalidating canonical correction", () => {
    const result = reduceDurableTxlineDelivery({
      current,
      fixture,
      metadata: {
        delivery: "reconciliation",
        provenance: "live_txline",
        receivedAt: "2026-07-18T18:21:00.000Z",
        sseEventId: null,
      },
      payload: scorePayload("action_amend", { Id: "amend-1" }),
    });

    expect(result).toMatchObject({
      invalidatesArchive: true,
      kind: "canonical",
    });
    if (result.kind !== "canonical") throw new Error("expected canonical");
    expect(result.facts).toContainEqual(
      expect.objectContaining({ kind: "correction" }),
    );
  });
});
