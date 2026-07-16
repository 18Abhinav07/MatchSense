import type {
  FixtureSnapshot,
  FixtureStreamEvent,
} from "@matchsense/contracts";
import type { TxlineCanonicalEvent } from "@matchsense/txline-adapter";
import { describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { createProductRuntime } from "./product-runtime.js";
import { createRoomService } from "./room-service.js";

const fixture: FixtureSnapshot = {
  awayTeam: "ESP",
  fixtureId: "18237038",
  homeTeam: "FRA",
  kickoffAt: "2026-07-16T18:00:00.000Z",
  lastEvent: null,
  minute: "—",
  phase: "scheduled",
  provenance: "live_txline",
  revision: 0,
  score: { away: 0, home: 0 },
  sourceLabel: "TXLINE · DEVNET SOURCE",
  updatedAt: "2026-07-16T17:00:00.000Z",
};

function canonical(
  overrides: Partial<TxlineCanonicalEvent>,
): TxlineCanonicalEvent {
  return {
    action: "goal",
    actionId: "goal-1",
    clockSeconds: 1_320,
    confirmed: false,
    delivery: "live",
    fixtureId: fixture.fixtureId,
    participant: 1,
    participantScore: { participant1: 3, participant2: 0 },
    participantStats: {
      participant1: {
        corners: 6,
        goals: 3,
        redCards: 0,
        yellowCards: 3,
      },
      participant2: {
        corners: 5,
        goals: 0,
        redCards: 0,
        yellowCards: 2,
      },
    },
    playerId: "907005",
    provenance: "live_txline",
    receivedAt: "2026-07-16T18:22:00.000Z",
    revision: 7,
    score: { away: 0, home: 3 },
    source: {
      actionId: "goal-1",
      observedSeq: "700",
      payloadHash: "goal-hash",
      sourceTimestampMs: 1_784_227_320_000,
      sseEventId: "700",
    },
    statusId: 2,
    supersedesRevision: null,
    varOutcome: null,
    varReviewType: null,
    ...overrides,
  };
}

const calls = [
  { answer: "YES", category: "goals", confidence: 1 },
  { answer: "YES", category: "cards", confidence: 2 },
  { answer: "YES", category: "corners", confidence: 3 },
] as const;

describe("canonical match events drive Rooms", () => {
  it("scores Call Three, preserves exact Moment IDs, and finalises", () => {
    let now = Date.parse("2026-07-16T17:30:00.000Z");
    const service = createRoomService({
      fixture: (fixtureId) =>
        fixtureId === fixture.fixtureId ? fixture : null,
      now: () => now,
    });
    const created = service.create({
      fixtureId: fixture.fixtureId,
      host: { nickname: "Abhinav", participantId: "fan-abhinav" },
      name: "Finals Night",
    });
    service.join({
      inviteCode: created.inviteCode,
      nickname: "Pratik",
      participantId: "fan-pratik",
    });
    service.saveCalls({
      calls,
      lock: true,
      participantId: "fan-abhinav",
      roomId: created.room.id,
    });

    now = Date.parse("2026-07-16T18:22:00.000Z");
    expect(service.applyCanonicalEvent(canonical({ confirmed: true }))).toBe(1);
    expect(service.get(created.room.id, "fan-abhinav")).toMatchObject({
      currentMoment: null,
      leaderboard: [{ correctCalls: 3, provisional: true, score: 600 }],
      stats: {
        cards: { answer: "YES", revision: 7, state: "RELIABLE" },
        corners: { answer: "YES", revision: 7, state: "RELIABLE" },
        goals: { answer: "YES", revision: 7, state: "RELIABLE" },
      },
      status: "LIVE",
    });
    const moment = {
      eventTeam: "FRA",
      fixtureId: fixture.fixtureId,
      id: "txline:18237038:goal:551",
      identity: "txline:18237038:goal:551:7",
      kind: "goal",
      minute: "68'",
      provenance: "live_txline",
      revision: 7,
      score: { away: 0, home: 3 },
      sourceEnvelopeId: "txline:18237038:700:goal-hash",
      status: "confirmed",
    } as const;
    expect(
      service.applyFixtureEvent({
        event: "moment.created",
        id: moment.identity,
        moment,
        snapshot: {
          ...fixture,
          lastEvent: moment,
          minute: "68'",
          phase: "first_half",
          revision: 7,
          score: moment.score,
        },
      }),
    ).toBe(1);
    const visible = service.react({
      kind: "CALLED_IT",
      momentId: moment.id,
      participantId: "fan-abhinav",
      recipientParticipantId: "fan-pratik",
      revision: 7,
      roomId: created.room.id,
    });
    expect(visible.reaction.status).toBe("VISIBLE");

    // TxLINE's raw VAR action has no verified target Moment identifier. The
    // bridge must not guess which Moment to revise.
    service.applyCanonicalEvent(
      canonical({
        action: "var_end",
        actionId: "var-1",
        confirmed: true,
        revision: 8,
        source: {
          actionId: "var-1",
          observedSeq: "701",
          payloadHash: "var-hash",
          sourceTimestampMs: 1_784_227_380_000,
          sseEventId: "701",
        },
        varOutcome: "stands",
        varReviewType: "goal",
      }),
    );
    expect(
      service.get(created.room.id, "fan-abhinav").reactions[0]?.status,
    ).toBe("VISIBLE");
    expect(
      service.get(created.room.id, "fan-abhinav").currentMoment?.varState,
    ).toBe("CLEAR");

    service.applyCanonicalEvent(
      canonical({
        action: "game_finalised",
        actionId: "final-1",
        confirmed: true,
        receivedAt: "2026-07-16T20:00:00.000Z",
        revision: 9,
        source: {
          actionId: "final-1",
          observedSeq: "900",
          payloadHash: "final-hash",
          sourceTimestampMs: 1_784_233_200_000,
          sseEventId: "900",
        },
      }),
    );
    expect(service.get(created.room.id, "fan-abhinav")).toMatchObject({
      leaderboard: [{ correctCalls: 3, provisional: false, score: 600 }],
      status: "FINAL",
    });
  });

  it("lets the canonical replay Moment drive synthetic rooms without demo APIs", () => {
    let now = Date.parse("2026-07-16T17:30:00.000Z");
    const replayFixture: FixtureSnapshot = {
      ...fixture,
      fixtureId: "arg-fra-demo",
      provenance: "synthetic_txline_shaped",
      sourceLabel: "SIMULATION · TXLINE-SHAPED DATA",
    };
    const service = createRoomService({
      fixture: () => replayFixture,
      now: () => now,
    });
    const created = service.create({
      fixtureId: replayFixture.fixtureId,
      host: { nickname: "Abhinav", participantId: "fan-abhinav" },
      name: "Replay Room",
    });
    now = Date.parse("2026-07-16T18:22:00.000Z");
    const moment = {
      eventTeam: "FRA",
      fixtureId: replayFixture.fixtureId,
      id: "arg-fra-demo:score:1-0",
      identity: "arg-fra-demo:score:1-0:1",
      kind: "goal",
      minute: "22'",
      provenance: "synthetic_txline_shaped",
      revision: 1,
      score: { away: 0, home: 1 },
      sourceEnvelopeId: "replay-goal-1",
      status: "confirmed",
    } as const;
    const event: FixtureStreamEvent = {
      event: "moment.created",
      id: moment.identity,
      moment,
      snapshot: {
        ...replayFixture,
        lastEvent: moment,
        minute: "22'",
        phase: "first_half",
        revision: 1,
        score: moment.score,
      },
    };

    expect(service.applyFixtureEvent(event)).toBe(1);
    expect(service.get(created.room.id, "fan-abhinav")).toMatchObject({
      currentMoment: {
        momentId: moment.id,
        revision: 1,
        varState: "CLEAR",
      },
      stats: { goals: { answer: "NO", revision: 1 } },
      status: "LIVE",
    });
  });

  it("composes the runtime bridge in the production app", async () => {
    let currentTime = "2026-07-16T17:30:00.000Z";
    const runtime = createProductRuntime({
      cueBytes: Buffer.from("cue"),
      now: () => currentTime,
      silenceBytes: Buffer.from("silence"),
      writeIntervalMs: 60_000,
    });
    const service = createRoomService({
      fixture: (fixtureId) => runtime.fixture(fixtureId),
      now: () => Date.parse(currentTime),
    });
    const app = buildApp({
      readinessProbe: {
        check: async () => ({
          databaseReachable: true,
          migrationsCurrent: true,
        }),
      },
      rooms: service,
      runtime,
      webDistPath: new URL("../../web/public", import.meta.url).pathname,
    });
    try {
      const created = service.create({
        fixtureId: "arg-fra-demo",
        host: { nickname: "Abhinav", participantId: "fan-abhinav" },
        name: "Replay Room",
      });
      const replay = runtime.createReplaySession("arg-fra-demo");
      currentTime = "2026-07-16T18:22:00.000Z";
      runtime.commandReplay(replay.id, {
        marker: "goal",
        type: "advance_to_marker",
      });

      expect(service.get(created.room.id, "fan-abhinav")).toMatchObject({
        currentMoment: { revision: 1, varState: "CLEAR" },
        stats: { goals: { answer: "NO", total: 1 } },
        status: "LIVE",
      });
    } finally {
      await app.close();
    }
  });
});
