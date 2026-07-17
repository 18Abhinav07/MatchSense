import { describe, expect, it } from "vitest";

import type {
  ExperienceRunRecord,
  FanFollowRecord,
  FixtureEventRecord,
  FixtureProjectionRecord,
  FixtureRecord,
  MemoryRecord,
} from "@matchsense/db";

import {
  createMatchMemoryService,
  type MatchMemoryPayload,
} from "./memory-service.js";

const finalProjection: FixtureProjectionRecord = {
  fixtureId: "fixture-live",
  mode: "live",
  payload: {
    decidedBy: "regulation",
    phase: "full_time",
    revision: 7,
    score: { away: 1, home: 2 },
    scores: {
      extraTime: { away: 0, home: 0 },
      regulation: { away: 1, home: 2 },
      shootout: { away: 0, home: 0 },
    },
    stats: {
      away: { corners: 3, redCards: 1, yellowCards: 2 },
      home: { corners: 7, redCards: 0, yellowCards: 1 },
    },
  },
  revision: 7,
  sourceSequence: "7",
  updatedAt: "2026-07-17T15:00:00.000Z",
};

const liveFixture: FixtureRecord = {
  awayTeamId: "FRA",
  createdAt: "2026-07-17T10:00:00.000Z",
  homeTeamId: "ARG",
  id: "fixture-live",
  metadata: { competition: "World Cup" },
  mode: "live",
  provenance: "live_txline",
  scheduledAt: "2026-07-17T12:00:00.000Z",
  status: "final",
  updatedAt: "2026-07-17T15:00:00.000Z",
};

function fixtureEvent(input: {
  identity: string;
  kind: string;
  minute: string;
  revision: number;
  sequence: number;
  status?: string;
  team?: string | null;
}): FixtureEventRecord {
  return {
    createdAt: `2026-07-17T12:${String(input.sequence).padStart(2, "0")}:00.000Z`,
    eventId: `event-${input.sequence}`,
    eventType: "moment.created",
    fixtureId: "fixture-live",
    mode: "live",
    payload: {
      moment: {
        eventTeam: input.team ?? null,
        familyId: input.identity.split(":").slice(0, -1).join(":"),
        id: input.identity.split(":").slice(0, -1).join(":"),
        identity: input.identity,
        kind: input.kind,
        minute: input.minute,
        player: null,
        revision: input.revision,
        score: { away: input.kind === "phase.full_time" ? 1 : 0, home: 2 },
        status: input.status ?? "confirmed",
      },
    },
    sequence: input.sequence,
  };
}

function memoryRepository() {
  const values = new Map<string, MemoryRecord<MatchMemoryPayload>[]>();
  const key = (fanId: string, mode: string, fixtureId: string) =>
    `${fanId}:${mode}:${fixtureId}`;
  return {
    append: async (input: {
      fanId: string;
      fixtureId: string;
      mode: "demo" | "live";
      payload: MatchMemoryPayload;
      revision: number;
    }) => {
      const record: MemoryRecord<MatchMemoryPayload> = {
        ...input,
        createdAt: input.payload.finalizedAt,
      };
      const recordKey = key(input.fanId, input.mode, input.fixtureId);
      const current = values.get(recordKey) ?? [];
      if (current.some((item) => item.revision === input.revision)) return null;
      values.set(recordKey, [...current, record]);
      return record;
    },
    latestForFanFixture: async (input: {
      fanId: string;
      fixtureId: string;
      mode: "demo" | "live";
    }) =>
      (values.get(key(input.fanId, input.mode, input.fixtureId)) ?? [])
        .toSorted((left, right) => right.revision - left.revision)
        .at(0) ?? null,
    listLatestForFan: async (fanId: string) =>
      [...values.values()]
        .flat()
        .filter((record) => record.fanId === fanId)
        .toSorted((left, right) =>
          right.createdAt.localeCompare(left.createdAt),
        ),
  };
}

function experienceRun(fixtureId = "experience:run-1"): ExperienceRunRecord {
  return {
    completedAt: "2026-07-17T16:05:00.000Z",
    createdAt: "2026-07-17T16:00:00.000Z",
    fixtureId,
    fixtureMode: "demo",
    id: "run-1",
    journey: "experience_match",
    kickoffAt: "2026-07-17T16:00:00.000Z",
    nextBeatIndex: 11,
    ownerFanId: "fan-1",
    status: "final",
    templateId: "five-minute-match",
    templateVersion: 1,
    updatedAt: "2026-07-17T16:05:00.000Z",
    version: 11,
  };
}

describe("durable per-fan Match Memory", () => {
  it("materializes a completed followed live fixture from canonical events", async () => {
    const memories = memoryRepository();
    const follows: FanFollowRecord[] = [
      {
        createdAt: "2026-07-17T11:00:00.000Z",
        eventPreferences: { goals: true },
        fanId: "fan-1",
        fixtureId: liveFixture.id,
        mode: "live",
      },
    ];
    const events = [
      fixtureEvent({
        identity: "fixture-live:event:goal:2",
        kind: "goal",
        minute: "23'",
        revision: 2,
        sequence: 1,
        team: "ARG",
      }),
      fixtureEvent({
        identity: "fixture-live:event:red:5",
        kind: "card.red",
        minute: "71'",
        revision: 5,
        sequence: 2,
        team: "FRA",
      }),
      fixtureEvent({
        identity: "fixture-live:event:final:7",
        kind: "phase.full_time",
        minute: "FT",
        revision: 7,
        sequence: 3,
      }),
    ];
    const service = createMatchMemoryService({
      experiences: { listForOwner: async () => [] },
      fans: { listFollows: async () => follows },
      fixtureTruth: {
        eventsAfter: async () => events,
        get: async () => liveFixture,
        getLatestProjection: async () => finalProjection,
      },
      memories,
    });

    const result = await service.listForFan("fan-1");

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      fanId: "fan-1",
      fixtureId: "fixture-live",
      mode: "live",
      payload: {
        awayTeam: "FRA",
        homeTeam: "ARG",
        score: { away: 1, home: 2 },
        replay: {
          available: true,
          kind: "canonical_timeline",
          restartable: false,
        },
      },
      revision: 7,
    });
    expect(result[0]?.payload.keyMoments.map(({ kind }) => kind)).toEqual([
      "goal",
      "card.red",
      "phase.full_time",
    ]);
  });

  it("materializes the owner's completed Experience with restart metadata", async () => {
    const memories = memoryRepository();
    const run = experienceRun();
    const fixture: FixtureRecord = {
      ...liveFixture,
      id: run.fixtureId,
      mode: "demo",
      provenance: "synthetic_txline_shaped",
      status: "final",
    };
    const projection: FixtureProjectionRecord = {
      ...finalProjection,
      fixtureId: run.fixtureId,
      mode: "demo",
    };
    const events = [
      {
        ...fixtureEvent({
          identity: `${run.fixtureId}:event:final:7`,
          kind: "phase.full_time",
          minute: "FT",
          revision: 7,
          sequence: 1,
        }),
        fixtureId: run.fixtureId,
        mode: "demo" as const,
      },
    ];
    const service = createMatchMemoryService({
      experiences: { listForOwner: async () => [run] },
      fans: { listFollows: async () => [] },
      fixtureTruth: {
        eventsAfter: async () => events,
        get: async () => fixture,
        getLatestProjection: async () => projection,
      },
      memories,
    });

    const memory = await service.getForFan({
      fanId: "fan-1",
      fixtureId: run.fixtureId,
      mode: "demo",
    });

    expect(memory?.payload.replay).toMatchObject({
      available: true,
      kind: "experience",
      restartable: true,
      runId: "run-1",
      templateId: "five-minute-match",
      templateVersion: 1,
    });
  });

  it("does not expose unfinished or unrelated fixtures", async () => {
    const memories = memoryRepository();
    const unfinished = {
      ...finalProjection,
      payload: { phase: "second_half" },
    };
    const service = createMatchMemoryService({
      experiences: { listForOwner: async () => [] },
      fans: {
        listFollows: async () => [
          {
            createdAt: "2026-07-17T11:00:00.000Z",
            eventPreferences: {},
            fanId: "fan-1",
            fixtureId: liveFixture.id,
            mode: "live",
          },
        ],
      },
      fixtureTruth: {
        eventsAfter: async () => [],
        get: async () => liveFixture,
        getLatestProjection: async () => unfinished,
      },
      memories,
    });

    await expect(service.listForFan("fan-1")).resolves.toEqual([]);
    await expect(
      service.getForFan({
        fanId: "fan-2",
        fixtureId: liveFixture.id,
        mode: "live",
      }),
    ).resolves.toBeNull();
  });
});
