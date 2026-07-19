import type {
  RoomAggregateRecord,
  RoomAggregateRepository,
} from "@matchsense/db";
import type { CanonicalMoment, FixtureSnapshot } from "@matchsense/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  createDurableRoomService,
  type DurableRoomAggregate,
  type DurableRoomStreamEvent,
} from "./durable-room-service.js";

const kickoffAt = Date.parse("2026-07-18T18:00:00.000Z");

const scheduledLiveFixture: FixtureSnapshot = {
  awayTeam: "ESP",
  fixtureId: "live-fixture-call-three",
  homeTeam: "FRA",
  kickoffAt: new Date(kickoffAt).toISOString(),
  lastEvent: null,
  minute: "—",
  phase: "scheduled",
  provenance: "live_txline",
  revision: 0,
  score: { away: 0, home: 0 },
  scores: {
    extraTime: { away: 0, home: 0 },
    regulation: { away: 0, home: 0 },
    shootout: { away: 0, home: 0 },
  },
  sourceLabel: "TXLINE · DEVNET SOURCE",
  updatedAt: "2026-07-18T17:00:00.000Z",
};

function canonicalMoment(input: {
  kind: CanonicalMoment["kind"];
  revision: number;
  status: CanonicalMoment["status"];
  score?: { away: number; home: number };
}): CanonicalMoment {
  return {
    celebratesGoal: input.kind === "goal" && input.status === "confirmed",
    eventTeam: input.kind === "goal" ? "FRA" : null,
    familyId: `family:${input.kind}`,
    fixtureId: scheduledLiveFixture.fixtureId,
    id: `family:${input.kind}`,
    identity: `family:${input.kind}:${input.revision}`,
    kind: input.kind,
    minute: input.kind === "phase.full_time" ? "FT" : "23'",
    occurredAt: "2026-07-18T18:23:00.000Z",
    player: null,
    provenance: "live_txline",
    revision: input.revision,
    score: input.score ?? { away: 0, home: 1 },
    sourceEnvelopeId: `source:${input.revision}`,
    sourceEventId: `event:${input.revision}`,
    status: input.status,
  };
}

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

const calls = [
  {
    answer: "HOME" as const,
    confidence: 3 as const,
    target: "result" as const,
  },
  { answer: "YES" as const, confidence: 2 as const, target: "goals" as const },
  { answer: "NO" as const, confidence: 1 as const, target: "cards" as const },
];

describe("durable data-qualified Call Three Rooms", () => {
  it("delivers committed updates across service instances and stops polling after unsubscribe", async () => {
    vi.useFakeTimers();
    try {
      const repository = inMemoryRepository();
      const serviceOptions = {
        fixture: async () => scheduledLiveFixture,
        now: () => kickoffAt - 60_000,
        repository,
      };
      const writer = createDurableRoomService({
        ...serviceOptions,
        roomId: () => "room-cross-process-stream",
      });
      const reader = createDurableRoomService(serviceOptions);
      const created = await writer.create({
        fixtureId: scheduledLiveFixture.fixtureId,
        host: { fanId: "fan-host", nickname: "Host" },
        name: "Call Three",
      });
      const events: DurableRoomStreamEvent[] = [];
      const unsubscribe = await reader.subscribe(
        created.room.id,
        "fan-host",
        (event) => events.push(event),
      );

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event: "room.snapshot",
        revision: 1,
      });

      await writer.setCalls({
        calls,
        fanId: "fan-host",
        roomId: created.room.id,
      });
      expect(events).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({
        event: "room.updated",
        revision: 2,
        room: {
          myCalls: {
            calls: {
              cards: { answer: "NO", confidence: 1 },
              goals: { answer: "YES", confidence: 2 },
              result: { answer: "HOME", confidence: 3 },
            },
          },
        },
      });

      unsubscribe();
      expect(vi.getTimerCount()).toBe(0);
      await writer.lockCalls({
        fanId: "fan-host",
        roomId: created.room.id,
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(events).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects synthetic, recorded, and already-live fixtures before persistence", async () => {
    const repository = inMemoryRepository();
    const now = () => kickoffAt - 60_000;
    for (const fixture of [
      {
        ...scheduledLiveFixture,
        provenance: "synthetic_txline_shaped" as const,
      },
      {
        ...scheduledLiveFixture,
        provenance: "recorded_txline_authorised" as const,
      },
      { ...scheduledLiveFixture, phase: "first_half" as const },
    ]) {
      const service = createDurableRoomService({
        fixture: async () => fixture,
        now,
        repository,
      });
      await expect(
        service.create({
          fixtureId: fixture.fixtureId,
          host: { fanId: "fan-host", nickname: "Host" },
          name: "Call Three",
        }),
      ).rejects.toMatchObject({ code: "ROOM_NOT_ELIGIBLE" });
    }
    expect(repository.records).toHaveLength(0);
  });

  it("locks exact calls at official kickoff and keeps late joiners as spectators", async () => {
    const repository = inMemoryRepository();
    let now = kickoffAt - 60_000;
    const service = createDurableRoomService({
      fixture: async () => scheduledLiveFixture,
      now: () => now,
      repository,
      roomId: () => "room-lock",
    });
    const created = await service.create({
      fixtureId: scheduledLiveFixture.fixtureId,
      host: { fanId: "fan-host", nickname: "Host" },
      name: "Call Three",
    });
    await service.setCalls({
      calls,
      fanId: "fan-host",
      roomId: created.room.id,
    });
    now = kickoffAt + 1_000;
    await service.projectFixture({
      ...scheduledLiveFixture,
      lastEvent: canonicalMoment({
        kind: "phase.kickoff",
        revision: 1,
        status: "confirmed",
      }),
      phase: "first_half",
      revision: 1,
      updatedAt: new Date(now).toISOString(),
    });
    const joined = await service.join({
      fanId: "fan-late",
      inviteCode: created.inviteCode,
      nickname: "Late fan",
    });

    expect(joined.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "fan-late", role: "SPECTATOR" }),
      ]),
    );
    await expect(
      service.setCalls({ calls, fanId: "fan-host", roomId: created.room.id }),
    ).rejects.toMatchObject({ code: "KICKOFF_LOCKED" });
    await expect(
      service.get(created.room.id, "fan-host"),
    ).resolves.toMatchObject({
      myCalls: { lockedAt: kickoffAt },
      status: "LIVE",
    });
  });

  it("accepts a teaser only after the referenced canonical Moment is confirmed and overturns it honestly", async () => {
    const repository = inMemoryRepository();
    let now = kickoffAt - 60_000;
    const service = createDurableRoomService({
      fixture: async () => scheduledLiveFixture,
      now: () => now,
      repository,
      roomId: () => "room-reactions",
    });
    const created = await service.create({
      fixtureId: scheduledLiveFixture.fixtureId,
      host: { fanId: "fan-host", nickname: "Host" },
      name: "Call Three",
    });
    await service.join({
      fanId: "fan-friend",
      inviteCode: created.inviteCode,
      nickname: "Friend",
    });
    now = kickoffAt + 60_000;
    const underReview = canonicalMoment({
      kind: "goal",
      revision: 2,
      status: "under_review",
    });
    await service.projectFixture({
      ...scheduledLiveFixture,
      lastEvent: underReview,
      phase: "first_half",
      revision: 2,
      score: underReview.score,
      updatedAt: new Date(now).toISOString(),
    });
    await expect(
      service.react({
        fanId: "fan-host",
        kind: "ROAR",
        momentId: underReview.id,
        recipientParticipantId: "fan-friend",
        revision: underReview.revision,
        roomId: created.room.id,
      }),
    ).rejects.toMatchObject({ code: "MOMENT_NOT_CONFIRMED" });

    const confirmed = {
      ...underReview,
      revision: 3,
      status: "confirmed" as const,
    };
    await service.projectFixture({
      ...scheduledLiveFixture,
      lastEvent: confirmed,
      phase: "first_half",
      revision: 3,
      score: confirmed.score,
      updatedAt: new Date(now + 1_000).toISOString(),
    });
    await expect(
      service.react({
        fanId: "fan-host",
        kind: "ROAR",
        momentId: confirmed.id,
        recipientParticipantId: "fan-friend",
        revision: confirmed.revision,
        roomId: created.room.id,
      }),
    ).resolves.toMatchObject({ reaction: { status: "VISIBLE" } });

    await service.projectFixture({
      ...scheduledLiveFixture,
      lastEvent: { ...confirmed, revision: 4, status: "overturned" as const },
      phase: "first_half",
      revision: 4,
      score: { away: 0, home: 0 },
      updatedAt: new Date(now + 2_000).toISOString(),
    });
    await expect(
      service.get(created.room.id, "fan-host"),
    ).resolves.toMatchObject({
      reactions: [expect.objectContaining({ status: "OVERTURNED" })],
    });
  });

  it("finalizes verified facts into MatchSense Points and voids missing cards for everyone", async () => {
    const repository = inMemoryRepository();
    let now = kickoffAt - 60_000;
    const service = createDurableRoomService({
      fixture: async () => scheduledLiveFixture,
      now: () => now,
      repository,
      roomId: () => "room-final",
    });
    const created = await service.create({
      fixtureId: scheduledLiveFixture.fixtureId,
      host: { fanId: "fan-host", nickname: "Host" },
      name: "Call Three",
    });
    await service.setCalls({
      calls,
      fanId: "fan-host",
      roomId: created.room.id,
    });
    now = kickoffAt + 7_200_000;
    const finalMoment = canonicalMoment({
      kind: "phase.full_time",
      revision: 8,
      status: "confirmed",
      score: { away: 1, home: 2 },
    });
    await service.projectFixture({
      ...scheduledLiveFixture,
      lastEvent: finalMoment,
      minute: "FT",
      phase: "full_time",
      revision: 8,
      score: finalMoment.score,
      scores: {
        extraTime: { away: 0, home: 0 },
        regulation: finalMoment.score,
        shootout: { away: 0, home: 0 },
      },
      updatedAt: new Date(now).toISOString(),
    });

    await expect(
      service.get(created.room.id, "fan-host"),
    ).resolves.toMatchObject({
      points: { lifetimeTotal: 500, roomPoints: 500 },
      status: "FINAL",
      targets: {
        cards: { state: "VOID" },
        goals: { answer: "YES", state: "RESOLVED" },
        result: { answer: "HOME", state: "RESOLVED" },
      },
    });
  });
});
