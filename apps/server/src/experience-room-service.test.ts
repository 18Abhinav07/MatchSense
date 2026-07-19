import type {
  RoomAggregateRecord,
  RoomAggregateRepository,
} from "@matchsense/db";
import type { CanonicalMoment, FixtureSnapshot } from "@matchsense/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  createExperienceRoomService,
  experienceRoomFanIdsForRun,
  type ExperienceRoomAggregate,
} from "./experience-room-service.js";

function inMemoryRepository(): RoomAggregateRepository<ExperienceRoomAggregate> & {
  records: Map<string, RoomAggregateRecord<ExperienceRoomAggregate>>;
} {
  const records = new Map<
    string,
    RoomAggregateRecord<ExperienceRoomAggregate>
  >();
  const memberships = new Map<string, Set<string>>();
  const copy = <T>(value: T): T => structuredClone(value);
  const compareAndSwap: RoomAggregateRepository<ExperienceRoomAggregate>["compareAndSwap"] =
    async (input) => {
      const current = records.get(input.roomId);
      if (!current || current.version !== input.expectedVersion) return null;
      const next = {
        ...current,
        aggregate: copy(input.aggregate),
        finalizedAt: input.finalizedAt,
        status: input.status,
        updatedAt: new Date().toISOString(),
        version: current.version + 1,
      };
      records.set(next.id, next);
      return copy(next);
    };
  return {
    records,
    compareAndSwap,
    create: async (input) => {
      const createdAt = new Date().toISOString();
      const record: RoomAggregateRecord<ExperienceRoomAggregate> = {
        aggregate: copy(input.aggregate),
        createdAt,
        finalizedAt: null,
        fixtureId: input.fixtureId,
        id: input.id,
        inviteExpiresAt: input.inviteExpiresAt,
        inviteHash: input.inviteHash,
        mode: input.mode,
        ownerFanId: input.host.fanId,
        status: input.status,
        updatedAt: createdAt,
        version: 0,
      };
      records.set(record.id, record);
      memberships.set(record.id, new Set([input.host.fanId]));
      return copy(record);
    },
    get: async (roomId) => copy(records.get(roomId) ?? null),
    join: async (input) => {
      memberships.get(input.roomId)?.add(input.fanId);
    },
    joinAndCompareAndSwap: async (input) => {
      const updated = await compareAndSwap(input);
      if (!updated) return null;
      memberships.get(input.roomId)?.add(input.member.fanId);
      return updated;
    },
    listByFixture: async (input) =>
      copy(
        [...records.values()].filter(
          (record) =>
            record.mode === input.mode && record.fixtureId === input.fixtureId,
        ),
      ),
    listByMode: async (mode) =>
      copy([...records.values()].filter((record) => record.mode === mode)),
    listForFan: async (fanId) =>
      copy(
        [...records.values()].filter((record) =>
          memberships.get(record.id)?.has(fanId),
        ),
      ),
    previewByInviteHash: async (inviteHash) =>
      copy(
        [...records.values()].find(
          (record) => record.inviteHash === inviteHash,
        ) ?? null,
      ),
  };
}

function fixture(
  input: {
    lastEvent?: CanonicalMoment | null;
    phase?: FixtureSnapshot["phase"];
    revision?: number;
    score?: { away: number; home: number };
    updatedAt?: string;
  } = {},
): FixtureSnapshot {
  return {
    awayTeam: "FRA",
    fixtureId: "experience:run-room",
    homeTeam: "ARG",
    kickoffAt: "2026-07-19T12:05:00.000Z",
    lastEvent: input.lastEvent ?? null,
    minute: input.phase === "full_time" ? "FT" : "0'",
    phase: input.phase ?? "scheduled",
    provenance: "synthetic_txline_shaped",
    revision: input.revision ?? 0,
    score: input.score ?? { away: 0, home: 0 },
    scores: {
      extraTime: { away: 0, home: 0 },
      regulation: input.score ?? { away: 0, home: 0 },
      shootout: { away: 0, home: 0 },
    },
    sourceLabel: "SIMULATION · TXLINE-SHAPED DATA",
    updatedAt: input.updatedAt ?? "2026-07-19T12:00:00.000Z",
  };
}

function moment(input: {
  id: string;
  kind: CanonicalMoment["kind"];
  revision: number;
  status: CanonicalMoment["status"];
  score: { away: number; home: number };
}): CanonicalMoment {
  return {
    celebratesGoal: input.kind === "goal" && input.status === "confirmed",
    eventTeam: "ARG",
    familyId: input.id,
    fixtureId: "experience:run-room",
    id: input.id,
    identity: `${input.id}:${input.revision}`,
    kind: input.kind,
    minute: input.kind === "phase.full_time" ? "FT" : "78'",
    occurredAt: "2026-07-19T12:03:45.000Z",
    player: null,
    provenance: "synthetic_txline_shaped",
    revision: input.revision,
    score: input.score,
    sourceEnvelopeId: `source:${input.revision}`,
    sourceEventId: `event:${input.revision}`,
    status: input.status,
  };
}

const hostCalls = [
  {
    answer: "HOME" as const,
    confidence: 3 as const,
    target: "result" as const,
  },
  { answer: "YES" as const, confidence: 2 as const, target: "goals" as const },
  { answer: "YES" as const, confidence: 1 as const, target: "cards" as const },
];

const awayCalls = [
  {
    answer: "AWAY" as const,
    confidence: 3 as const,
    target: "result" as const,
  },
  { answer: "NO" as const, confidence: 2 as const, target: "goals" as const },
  { answer: "NO" as const, confidence: 1 as const, target: "cards" as const },
];

describe("durable Experience Call Three Rooms", () => {
  it("runs the two-device lobby, early start, revisions, reactions, and final scoring without entering live mode", async () => {
    const repository = inMemoryRepository();
    let now = Date.parse("2026-07-19T12:00:00.000Z");
    const startFixture = vi.fn(async () => ({
      ...fixture(),
      kickoffAt: new Date(now + 10_000).toISOString(),
    }));
    const service = createExperienceRoomService({
      inviteBytes: () => Buffer.alloc(16, 7),
      lobbyMs: 5 * 60_000,
      now: () => now,
      prepareFixture: async () => ({ fixture: fixture(), runId: "run-room" }),
      repository,
      roomId: () => "experience-room",
      startFixture,
    });

    const created = await service.create({
      awayTeam: "FRA",
      homeTeam: "ARG",
      host: { fanId: "fan-host", nickname: "Alice", teamCode: "ARG" },
      name: "Final night",
    });
    expect(created.room).toMatchObject({
      experience: {
        label: "EXPERIENCE · SIMULATED TXLINE-SHAPED DATA",
        lobbyDeadlineAt: now + 5 * 60_000,
        runId: "run-room",
      },
      status: "PRE_KICKOFF",
    });
    expect(repository.records.get("experience-room")?.mode).toBe("demo");

    const joined = await service.join({
      fanId: "fan-away",
      inviteCode: created.inviteCode,
      nickname: "Bob",
      teamCode: "FRA",
    });
    expect(joined.members).toHaveLength(2);
    await expect(service.isRunMember("run-room", "fan-host")).resolves.toBe(
      true,
    );
    await expect(service.isRunMember("run-room", "fan-away")).resolves.toBe(
      true,
    );
    await expect(service.isRunMember("run-room", "fan-other")).resolves.toBe(
      false,
    );

    await service.setCalls({
      calls: hostCalls,
      fanId: "fan-host",
      roomId: "experience-room",
    });
    await service.lockCalls({ fanId: "fan-host", roomId: "experience-room" });
    await service.setCalls({
      calls: awayCalls,
      fanId: "fan-away",
      roomId: "experience-room",
    });
    await service.lockCalls({ fanId: "fan-away", roomId: "experience-room" });

    await expect(
      service.start({ fanId: "fan-away", roomId: "experience-room" }),
    ).rejects.toMatchObject({ code: "DEMO_HOST_REQUIRED" });
    const started = await service.start({
      fanId: "fan-host",
      roomId: "experience-room",
    });
    expect(startFixture).toHaveBeenCalledOnce();
    expect(started.status).toBe("LIVE");

    const late = await service.join({
      fanId: "fan-late",
      inviteCode: created.inviteCode,
      nickname: "Late",
    });
    expect(late.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "fan-late", role: "SPECTATOR" }),
      ]),
    );

    now += 60_000;
    await service.projectFixture(
      fixture({
        lastEvent: moment({
          id: "goal-winning",
          kind: "goal",
          revision: 14,
          score: { away: 1, home: 2 },
          status: "confirmed",
        }),
        phase: "second_half",
        revision: 14,
        score: { away: 1, home: 2 },
      }),
    );
    expect(
      (await service.get("experience-room", "fan-host")).leaderboard[0],
    ).toMatchObject({
      participantId: "fan-host",
      provisional: true,
      score: 500,
    });
    const reacted = await service.react({
      fanId: "fan-host",
      kind: "ROAR",
      momentId: "goal-winning",
      recipientParticipantId: "fan-away",
      revision: 14,
      roomId: "experience-room",
    });
    expect(reacted.reaction.status).toBe("VISIBLE");

    await service.projectFixture(
      fixture({
        lastEvent: moment({
          id: "goal-winning",
          kind: "var.started",
          revision: 15,
          score: { away: 1, home: 2 },
          status: "under_review",
        }),
        phase: "second_half",
        revision: 15,
        score: { away: 1, home: 2 },
      }),
    );
    expect(
      (await service.get("experience-room", "fan-host")).reactions[0]?.status,
    ).toBe("HELD");

    await service.projectFixture(
      fixture({
        lastEvent: moment({
          id: "goal-winning",
          kind: "var.overturned",
          revision: 17,
          score: { away: 1, home: 2 },
          status: "overturned",
        }),
        phase: "second_half",
        revision: 17,
        score: { away: 1, home: 2 },
      }),
    );
    expect(
      (await service.get("experience-room", "fan-host")).reactions[0]?.status,
    ).toBe("OVERTURNED");

    const finalMoment = moment({
      id: "full-time",
      kind: "phase.full_time",
      revision: 20,
      score: { away: 1, home: 2 },
      status: "confirmed",
    });
    const final = await service.projectFixture({
      ...fixture({
        lastEvent: finalMoment,
        phase: "full_time",
        revision: 20,
        score: { away: 1, home: 2 },
      }),
      stats: {
        away: {
          corners: 1,
          penaltiesAwarded: 1,
          penaltiesMissed: 0,
          penaltiesScored: 1,
          redCards: 1,
          yellowCards: 2,
        },
        home: {
          corners: 1,
          penaltiesAwarded: 0,
          penaltiesMissed: 0,
          penaltiesScored: 0,
          redCards: 0,
          yellowCards: 2,
        },
      },
    });
    expect(final).toBe(1);
    const finalRoom = await service.get("experience-room", "fan-host");
    expect(finalRoom).toMatchObject({
      status: "FINAL",
      leaderboard: [
        expect.objectContaining({ participantId: "fan-host", score: 600 }),
        expect.objectContaining({ participantId: "fan-away", score: 0 }),
      ],
    });
  });

  it("starts automatically at the five-minute deadline even when calls are incomplete", async () => {
    const repository = inMemoryRepository();
    let now = 1_000;
    const startFixture = vi.fn(async () => ({
      ...fixture(),
      kickoffAt: new Date(now).toISOString(),
    }));
    const service = createExperienceRoomService({
      now: () => now,
      prepareFixture: async () => ({ fixture: fixture(), runId: "run-room" }),
      repository,
      startFixture,
    });
    const created = await service.create({
      awayTeam: "FRA",
      homeTeam: "ARG",
      host: { fanId: "fan-host", nickname: "Host" },
      name: "Deadline",
    });

    now += 5 * 60_000;
    const recovered = createExperienceRoomService({
      now: () => now,
      prepareFixture: async () => ({ fixture: fixture(), runId: "run-room" }),
      repository,
      startFixture,
    });
    await recovered.recover();
    await recovered.tick();

    expect(startFixture).toHaveBeenCalledOnce();
    expect((await recovered.get(created.room.id, "fan-host")).status).toBe(
      "LIVE",
    );
  });

  it("can add clearly labelled local demo supporters without creating fan identities", async () => {
    const repository = inMemoryRepository();
    const service = createExperienceRoomService({
      now: () => 1_000,
      prepareFixture: async () => ({ fixture: fixture(), runId: "run-room" }),
      repository,
      startFixture: async () => fixture(),
    });

    const created = await service.create({
      addDemoSupporters: true,
      awayTeam: "FRA",
      homeTeam: "ARG",
      host: { fanId: "fan-host", nickname: "Host" },
      name: "Solo judge",
    });

    expect(created.room.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          isDemoSupporter: true,
          nickname: "Maya",
          role: "PLAYER",
        }),
        expect.objectContaining({
          isDemoSupporter: true,
          nickname: "Leo",
          role: "PLAYER",
        }),
      ]),
    );
    await expect(
      experienceRoomFanIdsForRun(repository, "run-room"),
    ).resolves.toEqual(["fan-host"]);
  });
});
