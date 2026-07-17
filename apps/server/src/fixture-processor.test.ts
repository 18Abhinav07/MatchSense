import {
  createInMemoryFixtureTruthRepository,
  type FixtureProjectionRecord,
  type PersistenceMode,
} from "@matchsense/db";
import type { CanonicalEventFact } from "@matchsense/contracts";
import { describe, expect, it } from "vitest";

import { createFixtureProcessor } from "./fixture-processor.js";

const fixture = {
  awayTeam: "FRA",
  fixtureId: "experience:run-1",
  homeTeam: "ARG",
  kickoffAt: "2026-07-17T12:00:00.000Z",
};

const goalFact = {
  familyId: "run-1:goal-one",
  fixtureId: fixture.fixtureId,
  kind: "goal",
  minute: "23'",
  occurredAt: "2026-07-17T12:23:00.000Z",
  player: null,
  provenance: "synthetic_txline_shaped",
  receivedAt: "2026-07-17T12:23:00.000Z",
  sourceEnvelopeId: "run-1:beat-2",
  sourceEventId: "beat-2",
  status: "confirmed",
  team: "ARG",
  type: "canonical_event",
} as const;

const raw = {
  dedupeKey: "run-1:beat-2",
  id: "raw-run-1-beat-2",
  payload: { privateProviderShape: "must not escape live ingestion" },
  payloadHash: "a".repeat(64),
  receivedAt: goalFact.receivedAt,
  source: "experience",
  sourceRecordId: goalFact.sourceEventId,
  sourceSequence: "2",
};

function repositoryHarness(
  mode: PersistenceMode,
  projection?: FixtureProjectionRecord | null,
) {
  const repository = createInMemoryFixtureTruthRepository();
  repository.seedFixture({
    fixtureId: fixture.fixtureId,
    mode,
    ...(projection !== undefined ? { projection } : {}),
  });
  return repository;
}

describe("fixture processor", () => {
  it("reduces one realtime fact into broadcast, push, commentary, Room, and Memory work", async () => {
    const repository = repositoryHarness("demo");
    const processor = createFixtureProcessor({
      repository,
    });

    const input = {
      deliveryIntent: "realtime" as const,
      fact: goalFact,
      fixture,
      mode: "demo" as const,
      raw,
    };
    await expect(processor.process(input)).resolves.toMatchObject({
      kind: "committed",
      revision: 1,
    });
    await expect(processor.process(input)).resolves.toEqual({
      kind: "duplicate",
    });

    const state = repository.inspect({
      fixtureId: fixture.fixtureId,
      mode: "demo",
    });
    expect(state.moments[0]).toMatchObject({
      id: "run-1:goal-one",
      kind: "goal",
      revisions: [1],
    });
    expect(state.outbox.map(({ topic }) => topic)).toEqual([
      "fixture.broadcast",
      "push.candidate",
      "commentary.prepare",
      "room.project",
      "memory.project",
    ]);
    expect(
      state.outbox.every(
        ({ payload }) =>
          JSON.stringify(payload).includes("privateProviderShape") === false,
      ),
    ).toBe(true);
  });

  it("keeps reconcile truth off every live delivery topic", async () => {
    const repository = repositoryHarness("demo");
    const processor = createFixtureProcessor({
      repository,
    });

    await processor.process({
      deliveryIntent: "reconcile",
      fact: goalFact,
      fixture,
      mode: "demo",
      raw,
    });

    const topics = repository
      .inspect({ fixtureId: fixture.fixtureId, mode: "demo" })
      .outbox.map(({ topic }) => topic);
    expect(topics).toEqual([
      "fixture.reconcile",
      "room.reconcile",
      "memory.reconcile",
    ]);
  });

  it("sanitizes live raw payload before crossing the repository boundary", async () => {
    const repository = repositoryHarness("live");
    const processor = createFixtureProcessor({
      repository,
    });

    await processor.process({
      deliveryIntent: "realtime",
      fact: { ...goalFact, provenance: "live_txline" },
      fixture,
      mode: "live",
      raw: { ...raw, source: "txline" },
      sourceFence: {
        fencingToken: 1,
        holderId: "worker-1",
        source: "txline",
        streamKey: "scores:mainnet",
      },
    });

    const stored = repository.inspect({
      fixtureId: fixture.fixtureId,
      mode: "live",
    }).sourceRecords[0];
    expect(stored?.payload).toBeNull();
    expect(stored?.deliveryIntent).toBe("realtime");
    expect(stored?.occurredAt).toBe(goalFact.occurredAt);
  });

  it("normalizes a legacy v2 projection before reducing the next event", async () => {
    const repository = repositoryHarness("demo", {
      fixtureId: fixture.fixtureId,
      mode: "demo",
      payload: {
        appliedSourceEnvelopeIds: [],
        awayTeam: fixture.awayTeam,
        fixtureId: fixture.fixtureId,
        homeTeam: fixture.homeTeam,
        kickoffAt: fixture.kickoffAt,
        lastEvent: null,
        minute: "22'",
        provenance: "synthetic_txline_shaped",
        revision: 0,
        score: { away: 0, home: 0 },
        sourceLabel: "SIMULATION · TXLINE-SHAPED DATA",
        updatedAt: "2026-07-17T12:22:00.000Z",
      },
      revision: 0,
      sourceSequence: null,
      updatedAt: "2026-07-17T12:22:00.000Z",
    });
    const processor = createFixtureProcessor({ repository });

    await processor.process({
      deliveryIntent: "realtime",
      fact: goalFact,
      fixture,
      mode: "demo",
      raw,
    });

    const projection = repository.inspect({
      fixtureId: fixture.fixtureId,
      mode: "demo",
    }).projection?.payload;
    expect(projection).toMatchObject({
      eventEffects: {
        "run-1:goal-one": { active: true, kind: "goal", team: "ARG" },
      },
      phase: "scheduled",
      scores: {
        extraTime: { away: 0, home: 0 },
        regulation: { away: 0, home: 1 },
        shootout: { away: 0, home: 0 },
      },
      stats: {
        away: { redCards: 0, yellowCards: 0 },
        home: { redCards: 0, yellowCards: 0 },
      },
    });
  });

  it.each([
    [
      "confirmed card",
      { kind: "card.yellow", status: "confirmed", team: "ARG" },
    ],
    ["VAR review", { kind: "var.started", status: "under_review", team: null }],
    ["phase", { kind: "phase.kickoff", status: "confirmed", team: null }],
    ["provisional goal", { kind: "goal", status: "provisional", team: "ARG" }],
    ["correction", { kind: "correction", status: "confirmed", team: null }],
  ] as const)(
    "keeps %s off push and commentary topics",
    async (_label, event) => {
      const repository = repositoryHarness("demo");
      const processor = createFixtureProcessor({ repository });
      const fact: CanonicalEventFact = {
        ...goalFact,
        familyId: `family:${event.kind}`,
        kind: event.kind,
        sourceEnvelopeId: `envelope:${event.kind}:${event.status}`,
        sourceEventId: `event:${event.kind}:${event.status}`,
        status: event.status,
        team: event.team,
      };

      await processor.process({
        deliveryIntent: "realtime",
        fact,
        fixture,
        mode: "demo",
        raw: {
          ...raw,
          dedupeKey: fact.sourceEnvelopeId,
          id: `raw:${fact.sourceEnvelopeId}`,
          sourceRecordId: fact.sourceEventId,
        },
      });

      expect(
        repository
          .inspect({ fixtureId: fixture.fixtureId, mode: "demo" })
          .outbox.map(({ topic }) => topic),
      ).toEqual(["fixture.broadcast", "room.project", "memory.project"]);
    },
  );
});
