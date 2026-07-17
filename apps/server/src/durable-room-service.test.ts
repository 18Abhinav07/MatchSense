import type {
  RoomAggregateRecord,
  RoomAggregateRepository,
  RoomStatus,
} from "@matchsense/db";
import type { FixtureSnapshot } from "@matchsense/contracts";
import { registerMoment, RoomsDomainError } from "@matchsense/rooms";
import { describe, expect, it } from "vitest";

import {
  createDurableRoomService,
  type DurableRoomAggregate,
} from "./durable-room-service.js";

const fixture: FixtureSnapshot = {
  awayTeam: "FRA",
  fixtureId: "experience:run-7",
  homeTeam: "ARG",
  kickoffAt: "2026-07-17T12:00:00.000Z",
  lastEvent: null,
  minute: "0'",
  phase: "scheduled",
  provenance: "synthetic_txline_shaped",
  revision: 0,
  score: { away: 0, home: 0 },
  sourceLabel: "SIMULATION · TXLINE-SHAPED DATA",
  updatedAt: "2026-07-17T11:00:00.000Z",
};

const picks = [
  { allocation: 20, marketId: "winner", selection: "HOME" },
  { allocation: 20, marketId: "goals_2_5", selection: "OVER" },
  { allocation: 20, marketId: "cards_4_5", selection: "UNDER" },
  { allocation: 20, marketId: "corners_9_5", selection: "OVER" },
  { allocation: 20, marketId: "btts", selection: "YES" },
] as const;

function inMemoryRepository(): RoomAggregateRepository<DurableRoomAggregate> & {
  records: Map<string, RoomAggregateRecord<DurableRoomAggregate>>;
} {
  const records = new Map<string, RoomAggregateRecord<DurableRoomAggregate>>();
  const memberships = new Map<string, Set<string>>();
  const copy = <T>(value: T) => structuredClone(value);
  const compareAndSwap: RoomAggregateRepository<DurableRoomAggregate>["compareAndSwap"] =
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
      const record: RoomAggregateRecord<DurableRoomAggregate> = {
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

describe("durable Room happy path", () => {
  it("persists members, 100-Sense predictions, lifecycle, and final ledger", async () => {
    const repository = inMemoryRepository();
    let now = Date.parse("2026-07-17T13:00:00.000Z");
    const service = createDurableRoomService({
      fixture: async (fixtureId) =>
        fixtureId === fixture.fixtureId ? fixture : null,
      inviteBytes: () => Buffer.alloc(16, 7),
      now: () => now,
      repository,
      roomId: () => "room-7",
    });

    const created = await service.create({
      fixtureId: fixture.fixtureId,
      host: { fanId: "fan-host", nickname: "Abhinav", teamCode: "ARG" },
      name: "Final night",
    });
    const streamEvents: string[] = [];
    const unsubscribe = await service.subscribe(
      created.room.id,
      "fan-host",
      (event) => streamEvents.push(event.event),
    );
    expect(created.room).toMatchObject({
      hostParticipantId: "fan-host",
      sense: {
        balance: { available: 100, committed: 0, starting: 100 },
        phase: "DRAFT",
        total: 100,
      },
      status: "PRE_KICKOFF",
    });
    expect(created.room.kickoffAt).toBe(now + 5 * 60_000);

    const joined = await service.join({
      fanId: "fan-friend",
      inviteCode: created.inviteCode,
      nickname: "Pratik",
      teamCode: "FRA",
    });
    expect(joined.members).toHaveLength(2);
    expect(joined.sense.balance).toEqual({
      available: 100,
      committed: 0,
      returned: null,
      starting: 100,
    });

    await service.openPicks("room-7", "fan-host");
    expect(streamEvents).toEqual([
      "room.snapshot",
      "room.updated",
      "room.updated",
    ]);
    const saved = await service.saveSensePicks({
      fanId: "fan-friend",
      picks,
      roomId: "room-7",
    });
    expect(saved.sense.balance).toEqual({
      available: 0,
      committed: 100,
      returned: null,
      starting: 100,
    });
    expect(saved.sense.revealedSlates).toEqual([]);

    now += 60_000;
    const live = await service.startExperience("room-7", "fan-host");
    expect(live.status).toBe("LIVE");
    expect(live.sense.phase).toBe("LIVE");
    expect(live.sense.revealedSlates).toHaveLength(1);

    const final = await service.finalise({
      finalisedAt: now + 4 * 60_000,
      fixture: {
        ...fixture,
        phase: "full_time",
        score: { away: 1, home: 2 },
      },
      outcomes: {
        btts: "YES",
        cards_4_5: "UNDER",
        corners_9_5: "OVER",
        goals_2_5: "OVER",
        winner: "HOME",
      },
      roomId: "room-7",
    });
    expect(final.status).toBe("FINAL");
    const friendFinal = await service.get("room-7", "fan-friend");
    expect(friendFinal.sense.balance.returned).toBeGreaterThan(100);
    expect(friendFinal.sense.ledger["fan-friend"]).toMatchObject({
      committed: 100,
      starting: 100,
    });

    const restarted = createDurableRoomService({
      fixture: async () => fixture,
      now: () => now,
      repository,
    });
    await expect(restarted.get("room-7", "fan-friend")).resolves.toMatchObject({
      id: "room-7",
      status: "FINAL",
      viewerParticipantId: "fan-friend",
    });
    expect(repository.records.get("room-7")).toMatchObject({
      aggregate: {
        lifecycle: [
          { status: "LOBBY" },
          { status: "LOCKED" },
          { status: "LIVE" },
          { status: "FINAL" },
        ],
      },
      status: "final" satisfies RoomStatus,
    });
    unsubscribe();
  });

  it("rejects an invalid or overdrawn prediction slate without changing the ledger", async () => {
    const repository = inMemoryRepository();
    const service = createDurableRoomService({
      fixture: async () => fixture,
      now: () => Date.parse("2026-07-17T11:00:00.000Z"),
      repository,
      roomId: () => "room-8",
    });
    const created = await service.create({
      fixtureId: fixture.fixtureId,
      host: { fanId: "fan-host", nickname: "Abhinav" },
      name: "Predictions",
    });
    await service.openPicks(created.room.id, "fan-host");

    await expect(
      service.saveSensePicks({
        fanId: "fan-host",
        picks: picks.map((pick, index) => ({
          ...pick,
          allocation: index === 0 ? 25 : 20,
        })),
        roomId: created.room.id,
      }),
    ).rejects.toBeInstanceOf(RoomsDomainError);
    await expect(
      service.get(created.room.id, "fan-host"),
    ).resolves.toMatchObject({
      sense: {
        balance: { available: 100, committed: 0, starting: 100 },
      },
    });
  });

  it("projects a real fixture from lobby through live to final automatically", async () => {
    const repository = inMemoryRepository();
    const realFixture: FixtureSnapshot = {
      ...fixture,
      fixtureId: "live-fixture-1",
      kickoffAt: "2026-07-17T12:00:00.000Z",
      provenance: "live_txline",
      sourceLabel: "TXLINE · DEVNET SOURCE",
    };
    const service = createDurableRoomService({
      fixture: async () => realFixture,
      now: () => Date.parse("2026-07-17T11:00:00.000Z"),
      repository,
      roomId: () => "room-live",
    });
    const created = await service.create({
      fixtureId: realFixture.fixtureId,
      host: { fanId: "fan-host", nickname: "Abhinav" },
      name: "Live final",
    });
    await service.join({
      fanId: "fan-friend",
      inviteCode: created.inviteCode,
      nickname: "Pratik",
    });

    const reviewedGoal = {
      celebratesGoal: false,
      eventTeam: "ARG",
      familyId: "txline:live-fixture-1:goal:1",
      fixtureId: realFixture.fixtureId,
      id: "txline:live-fixture-1:goal:1",
      identity: "txline:live-fixture-1:goal:1:7",
      kind: "goal",
      minute: "12'",
      occurredAt: "2026-07-17T12:12:00.000Z",
      provenance: "live_txline",
      revision: 7,
      score: { away: 0, home: 1 },
      sourceEnvelopeId: "txline:live-fixture-1:7:goal-hash",
      status: "under_review",
    } as const;

    const reviewedSnapshot = {
      ...realFixture,
      lastEvent: reviewedGoal,
      minute: "12'",
      phase: "first_half",
      revision: 2,
      score: reviewedGoal.score,
      updatedAt: "2026-07-17T12:12:00.000Z",
    } as const;
    await service.projectFixture(reviewedSnapshot);
    await expect(
      service.get(created.room.id, "fan-host"),
    ).resolves.toMatchObject({
      currentMoment: {
        momentId: reviewedGoal.id,
        revision: reviewedGoal.revision,
        varState: "HOLD",
      },
      fixture: { revision: 2, score: { away: 0, home: 1 } },
      sense: { phase: "LIVE" },
      status: "LIVE",
    });
    const held = await service.react({
      fanId: "fan-host",
      kind: "ROAR",
      momentId: reviewedGoal.id,
      recipientParticipantId: "fan-friend",
      revision: reviewedGoal.revision,
      roomId: created.room.id,
    });
    expect(held.reaction.status).toBe("HELD");

    const confirmedSnapshot = {
      ...reviewedSnapshot,
      lastEvent: {
        ...reviewedGoal,
        celebratesGoal: true,
        identity: "txline:live-fixture-1:goal:1:8",
        revision: 8,
        status: "confirmed" as const,
      },
      revision: 3,
      updatedAt: "2026-07-17T12:12:05.000Z",
    };
    await service.projectFixture(confirmedSnapshot);
    const confirmed = await service.get(created.room.id, "fan-host");
    expect(confirmed.currentMoment).toMatchObject({
      momentId: reviewedGoal.id,
      revision: 8,
      varState: "CLEAR",
    });
    expect(confirmed.moments).toEqual(
      expect.arrayContaining([
        {
          momentId: reviewedGoal.id,
          revision: reviewedGoal.revision,
          varState: "CONFIRMED",
        },
      ]),
    );
    expect(confirmed.reactions).toMatchObject([{ status: "VISIBLE" }]);
    const versionAfterConfirmation = repository.records.get(
      created.room.id,
    )!.version;
    await service.projectFixture(confirmedSnapshot);
    expect(repository.records.get(created.room.id)!.version).toBe(
      versionAfterConfirmation,
    );

    await service.projectFixture({
      ...realFixture,
      minute: "FT",
      phase: "full_time",
      revision: 9,
      score: { away: 1, home: 2 },
      updatedAt: "2026-07-17T14:00:00.000Z",
    });
    await expect(
      service.get(created.room.id, "fan-host"),
    ).resolves.toMatchObject({
      fixture: { revision: 9, score: { away: 1, home: 2 } },
      sense: { phase: "FINAL" },
      status: "FINAL",
    });
  });

  it("voids cards and corners when the final fixture has no reliable stats", async () => {
    const repository = inMemoryRepository();
    const service = createDurableRoomService({
      fixture: async () => fixture,
      now: () => Date.parse("2026-07-17T11:00:00.000Z"),
      repository,
      roomId: () => "room-missing-stats",
    });
    const created = await service.create({
      fixtureId: fixture.fixtureId,
      host: { fanId: "fan-host", nickname: "Abhinav" },
      name: "Truthful stats",
    });
    await service.openPicks(created.room.id, "fan-host");
    await service.saveSensePicks({
      fanId: "fan-host",
      picks,
      roomId: created.room.id,
    });

    await service.projectFixture({
      ...fixture,
      minute: "FT",
      phase: "full_time",
      revision: 1,
      score: { away: 1, home: 2 },
      updatedAt: "2026-07-17T14:00:00.000Z",
    });

    const final = await service.get(created.room.id, "fan-host");
    expect(final.sense.balance.returned).toBe(170);
    expect(final.sense.leaderboard).toMatchObject([
      { correctCount: 3, participantId: "fan-host", returnedSense: 170 },
    ]);
    expect(
      repository.records.get(created.room.id)?.aggregate.senseOutcomes,
    ).toEqual({
      btts: "YES",
      cards_4_5: "VOID",
      corners_9_5: "VOID",
      goals_2_5: "OVER",
      winner: "HOME",
    });
  });

  it("resolves held reactions when a newer revision overturns the same canonical moment", async () => {
    const repository = inMemoryRepository();
    let now = Date.parse("2026-07-17T11:00:00.000Z");
    const realFixture: FixtureSnapshot = {
      ...fixture,
      fixtureId: "live-fixture-overturn",
      kickoffAt: "2026-07-17T12:00:00.000Z",
      provenance: "live_txline",
      sourceLabel: "TXLINE · DEVNET SOURCE",
    };
    const service = createDurableRoomService({
      fixture: async () => realFixture,
      now: () => now,
      repository,
      roomId: () => "room-overturn",
    });
    const created = await service.create({
      fixtureId: realFixture.fixtureId,
      host: { fanId: "fan-host", nickname: "Abhinav" },
      name: "VAR night",
    });
    await service.join({
      fanId: "fan-friend",
      inviteCode: created.inviteCode,
      nickname: "Pratik",
    });
    now = Date.parse("2026-07-17T12:15:00.000Z");
    const familyId = "txline:live-fixture-overturn:goal:1";
    const reviewedGoal = {
      celebratesGoal: false,
      eventTeam: "ARG",
      familyId,
      fixtureId: realFixture.fixtureId,
      id: familyId,
      identity: `${familyId}:7`,
      kind: "goal",
      minute: "12'",
      occurredAt: "2026-07-17T12:12:00.000Z",
      provenance: "live_txline",
      revision: 7,
      score: { away: 0, home: 1 },
      sourceEnvelopeId: "txline:live-fixture-overturn:7:goal-hash",
      status: "under_review",
    } as const;
    await service.projectFixture({
      ...realFixture,
      lastEvent: reviewedGoal,
      minute: "12'",
      phase: "first_half",
      revision: 2,
      score: reviewedGoal.score,
      updatedAt: "2026-07-17T12:12:00.000Z",
    });
    const held = await service.react({
      fanId: "fan-host",
      kind: "ROAR",
      momentId: familyId,
      recipientParticipantId: "fan-friend",
      revision: 7,
      roomId: created.room.id,
    });
    expect(held.reaction.status).toBe("HELD");

    await service.projectFixture({
      ...realFixture,
      lastEvent: {
        ...reviewedGoal,
        identity: `${familyId}:8`,
        revision: 8,
        score: { away: 0, home: 0 },
        status: "overturned",
      },
      minute: "13'",
      phase: "first_half",
      revision: 3,
      score: { away: 0, home: 0 },
      updatedAt: "2026-07-17T12:13:00.000Z",
    });

    const overturned = await service.get(created.room.id, "fan-host");
    expect(overturned.currentMoment).toMatchObject({
      momentId: familyId,
      revision: 8,
      varState: "OVERTURNED",
    });
    expect(overturned.moments).toEqual(
      expect.arrayContaining([
        { momentId: familyId, revision: 7, varState: "OVERTURNED" },
        { momentId: familyId, revision: 8, varState: "OVERTURNED" },
      ]),
    );
    expect(overturned.reactions).toMatchObject([{ status: "OVERTURNED" }]);
  });

  it("persists recipient-scoped reactions and preserves the domain rate limit", async () => {
    const repository = inMemoryRepository();
    const now = Date.parse("2026-07-17T13:00:00.000Z");
    const service = createDurableRoomService({
      fixture: async () => fixture,
      now: () => now,
      repository,
      roomId: () => "room-reactions",
    });
    const created = await service.create({
      fixtureId: fixture.fixtureId,
      host: { fanId: "fan-host", nickname: "Abhinav", teamCode: "ARG" },
      name: "Rival night",
    });
    await service.join({
      fanId: "fan-friend",
      inviteCode: created.inviteCode,
      nickname: "Pratik",
      teamCode: "FRA",
    });
    await service.startExperience(created.room.id, "fan-host");

    const record = repository.records.get(created.room.id)!;
    record.aggregate.room = registerMoment(record.aggregate.room, {
      momentId: "goal-1",
      revision: 1,
      varState: "CLEAR",
    });
    record.aggregate.room = registerMoment(record.aggregate.room, {
      momentId: "goal-2",
      revision: 1,
      varState: "CLEAR",
    });
    record.aggregate.room = {
      ...record.aggregate.room,
      reactionPolicy: { limit: 1, windowMs: 10_000 },
    };

    const result = await service.react({
      fanId: "fan-host",
      kind: "ROAR",
      momentId: "goal-1",
      recipientParticipantId: "fan-friend",
      revision: 1,
      roomId: created.room.id,
    });
    expect(result.reaction).toMatchObject({
      kind: "ROAR",
      recipientParticipantId: "fan-friend",
      senderParticipantId: "fan-host",
      status: "VISIBLE",
    });
    expect(result.room.reactions).toHaveLength(1);

    await expect(
      service.react({
        fanId: "fan-host",
        kind: "COLD",
        momentId: "goal-2",
        recipientParticipantId: "fan-friend",
        revision: 1,
        roomId: created.room.id,
      }),
    ).rejects.toMatchObject({ code: "REACTION_RATE_LIMITED" });
  });

  it("cannot regress a room when an older fixture projection loses a CAS race", async () => {
    const repository = inMemoryRepository();
    const compareAndSwap = repository.compareAndSwap;
    let releaseOlder!: () => void;
    let olderReachedCas!: () => void;
    const olderBlocked = new Promise<void>((resolve) => {
      olderReachedCas = resolve;
    });
    const olderRelease = new Promise<void>((resolve) => {
      releaseOlder = resolve;
    });
    repository.compareAndSwap = async (input) => {
      if (input.aggregate.fixture.revision === 2) {
        olderReachedCas();
        await olderRelease;
      }
      return compareAndSwap(input);
    };
    const realFixture: FixtureSnapshot = {
      ...fixture,
      fixtureId: "live-race",
      provenance: "live_txline",
      sourceLabel: "TXLINE · DEVNET SOURCE",
    };
    const service = createDurableRoomService({
      fixture: async () => realFixture,
      now: () => Date.parse("2026-07-17T11:00:00.000Z"),
      repository,
      roomId: () => "room-race",
    });
    const created = await service.create({
      fixtureId: realFixture.fixtureId,
      host: { fanId: "fan-host", nickname: "Abhinav" },
      name: "Projection race",
    });
    const older = service.projectFixture({
      ...realFixture,
      phase: "first_half",
      revision: 2,
      score: { away: 0, home: 1 },
    });
    await olderBlocked;
    await service.projectFixture({
      ...realFixture,
      phase: "first_half",
      revision: 3,
      score: { away: 0, home: 2 },
    });
    releaseOlder();
    await older;

    await expect(
      service.get(created.room.id, "fan-host"),
    ).resolves.toMatchObject({
      fixture: { revision: 3, score: { away: 0, home: 2 } },
    });
  });
});
