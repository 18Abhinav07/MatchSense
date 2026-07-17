import assert from "node:assert/strict";
import { test } from "vitest";

import {
  RoomsDomainError,
  addReaction,
  applyStatRevision,
  createRoom,
  finaliseRoom,
  getLeaderboard,
  joinRoom,
  lockCalls,
  registerMoment,
  resolveMoment,
  scoreSenseSlates,
  setCalls,
  validateSensePicks,
  voidStat,
} from "../src/index.ts";

const completeCalls = (
  goals: "YES" | "NO" = "YES",
  cards: "YES" | "NO" = "NO",
  corners: "YES" | "NO" = "YES",
) => [
  { category: "goals" as const, answer: goals, confidence: 3 as const },
  { category: "cards" as const, answer: cards, confidence: 2 as const },
  { category: "corners" as const, answer: corners, confidence: 1 as const },
];

function hasCode(code: string) {
  return (error: unknown) =>
    error instanceof RoomsDomainError && error.code === code;
}

test("creates a room, preserves nicknames, and makes kickoff joiners spectators", () => {
  let room = createRoom({
    id: "room-1",
    matchId: "match-1",
    kickoffAt: 1_000,
    createdAt: 100,
    host: { id: "alice", nickname: " Alice " },
  });

  assert.deepEqual(room.members[0], {
    id: "alice",
    nickname: "Alice",
    nicknameKey: "alice",
    role: "PLAYER",
    joinedAt: 100,
  });

  room = joinRoom(room, {
    participant: { id: "bob", nickname: "Bob" },
    joinedAt: 200,
  });
  room = joinRoom(room, {
    participant: { id: "viewer", nickname: "Viewer" },
    joinedAt: 1_000,
  });

  assert.equal(room.members.find(({ id }) => id === "bob")?.role, "PLAYER");
  assert.equal(
    room.members.find(({ id }) => id === "viewer")?.role,
    "SPECTATOR",
  );
  assert.equal(room.status, "LIVE");

  assert.throws(
    () =>
      joinRoom(room, {
        participant: { id: "alice-2", nickname: "  ALICE" },
        joinedAt: 1_001,
      }),
    hasCode("NICKNAME_TAKEN"),
  );
});

test("allows complete call edits before lock and hard-locks calls at kickoff", () => {
  let room = createRoom({
    id: "room-1",
    matchId: "match-1",
    kickoffAt: 1_000,
    createdAt: 100,
    host: { id: "alice", nickname: "Alice" },
  });

  room = setCalls(room, {
    participantId: "alice",
    calls: completeCalls(),
    changedAt: 200,
  });
  room = setCalls(room, {
    participantId: "alice",
    calls: completeCalls("NO", "YES", "NO"),
    changedAt: 300,
  });

  assert.equal(room.callSlates.alice?.calls.goals.answer, "NO");
  assert.throws(
    () =>
      setCalls(room, {
        participantId: "alice",
        calls: [
          { category: "goals", answer: "YES", confidence: 3 },
          { category: "cards", answer: "NO", confidence: 3 },
          { category: "corners", answer: "YES", confidence: 1 },
        ],
        changedAt: 400,
      }),
    hasCode("INVALID_CALLS"),
  );

  room = lockCalls(room, { participantId: "alice", lockedAt: 500 });
  assert.equal(room.callSlates.alice?.lockedAt, 500);
  assert.throws(
    () =>
      setCalls(room, {
        participantId: "alice",
        calls: completeCalls(),
        changedAt: 600,
      }),
    hasCode("CALLS_LOCKED"),
  );

  const unlockedRoom = createRoom({
    id: "room-2",
    matchId: "match-1",
    kickoffAt: 1_000,
    createdAt: 100,
    host: { id: "bob", nickname: "Bob" },
  });
  assert.throws(
    () =>
      setCalls(unlockedRoom, {
        participantId: "bob",
        calls: completeCalls(),
        changedAt: 1_000,
      }),
    hasCode("KICKOFF_LOCKED"),
  );

  const liveRoom = joinRoom(unlockedRoom, {
    participant: { id: "viewer", nickname: "Viewer" },
    joinedAt: 1_000,
  });
  assert.throws(
    () =>
      setCalls(liveRoom, {
        participantId: "bob",
        calls: completeCalls(),
        changedAt: 999,
      }),
    hasCode("KICKOFF_LOCKED"),
  );
});

test("scores provisionally, voids unreliable stats, and applies corrections once", () => {
  let room = createRoom({
    id: "room-1",
    matchId: "match-1",
    kickoffAt: 1_000,
    createdAt: 100,
    host: { id: "alice", nickname: "Alice" },
  });
  room = joinRoom(room, {
    participant: { id: "bob", nickname: "Bob" },
    joinedAt: 110,
  });
  room = setCalls(room, {
    participantId: "alice",
    calls: completeCalls(),
    changedAt: 200,
  });
  room = setCalls(room, {
    participantId: "bob",
    calls: [
      { category: "goals", answer: "YES", confidence: 1 },
      { category: "cards", answer: "NO", confidence: 2 },
      { category: "corners", answer: "YES", confidence: 3 },
    ],
    changedAt: 210,
  });
  room = lockCalls(room, { participantId: "alice", lockedAt: 400 });
  room = lockCalls(room, { participantId: "bob", lockedAt: 500 });

  room = applyStatRevision(room, {
    category: "goals",
    revision: 1,
    answer: "YES",
    observedAt: 1_100,
  });
  const duplicate = applyStatRevision(room, {
    category: "goals",
    revision: 1,
    answer: "YES",
    observedAt: 1_100,
  });
  assert.strictEqual(duplicate, room);

  room = applyStatRevision(room, {
    category: "cards",
    revision: 1,
    answer: "NO",
    observedAt: 1_110,
  });
  room = voidStat(room, {
    category: "corners",
    revision: 1,
    reason: "source marked this stat unreliable",
    observedAt: 1_120,
  });

  assert.deepEqual(
    getLeaderboard(room).map(({ participantId, score, provisional }) => ({
      participantId,
      score,
      provisional,
    })),
    [
      { participantId: "alice", score: 500, provisional: true },
      { participantId: "bob", score: 300, provisional: true },
    ],
  );

  room = applyStatRevision(room, {
    category: "goals",
    revision: 2,
    answer: "NO",
    observedAt: 1_200,
  });
  assert.deepEqual(
    getLeaderboard(room).map(({ participantId, score }) => ({
      participantId,
      score,
    })),
    [
      { participantId: "alice", score: 200 },
      { participantId: "bob", score: 200 },
    ],
  );

  const repeatedCorrection = applyStatRevision(room, {
    category: "goals",
    revision: 2,
    answer: "NO",
    observedAt: 1_200,
  });
  const staleRevision = applyStatRevision(room, {
    category: "goals",
    revision: 1,
    answer: "YES",
    observedAt: 1_250,
  });
  assert.strictEqual(repeatedCorrection, room);
  assert.strictEqual(staleRevision, room);
});

test("uses earliest lock and participant id as deterministic score tiebreaks", () => {
  let room = createRoom({
    id: "room-1",
    matchId: "match-1",
    kickoffAt: 1_000,
    createdAt: 100,
    host: { id: "z-player", nickname: "Zed" },
  });
  room = joinRoom(room, {
    participant: { id: "a-player", nickname: "Ada" },
    joinedAt: 110,
  });
  for (const participantId of ["z-player", "a-player"]) {
    room = setCalls(room, {
      participantId,
      calls: completeCalls(),
      changedAt: 200,
    });
  }
  room = lockCalls(room, { participantId: "z-player", lockedAt: 300 });
  room = lockCalls(room, { participantId: "a-player", lockedAt: 400 });
  room = applyStatRevision(room, {
    category: "goals",
    revision: 1,
    answer: "YES",
    observedAt: 1_100,
  });

  assert.deepEqual(
    getLeaderboard(room).map(({ participantId, rank }) => ({
      participantId,
      rank,
    })),
    [
      { participantId: "z-player", rank: 1 },
      { participantId: "a-player", rank: 2 },
    ],
  );
});

test("finalises only on game_finalised and freezes the final leaderboard", () => {
  let room = createRoom({
    id: "room-1",
    matchId: "match-1",
    kickoffAt: 1_000,
    createdAt: 100,
    host: { id: "alice", nickname: "Alice" },
  });
  room = setCalls(room, {
    participantId: "alice",
    calls: completeCalls(),
    changedAt: 200,
  });
  room = applyStatRevision(room, {
    category: "goals",
    revision: 1,
    answer: "YES",
    observedAt: 1_100,
  });

  assert.throws(
    () =>
      finaliseRoom(room, {
        event: "clock_stopped" as "game_finalised",
        finalisedAt: 2_000,
      }),
    hasCode("INVALID_FINAL_EVENT"),
  );

  room = finaliseRoom(room, {
    event: "game_finalised",
    finalisedAt: 2_000,
  });
  assert.equal(room.status, "FINAL");
  assert.equal(getLeaderboard(room)[0]?.provisional, false);
  assert.throws(
    () =>
      applyStatRevision(room, {
        category: "goals",
        revision: 2,
        answer: "NO",
        observedAt: 2_100,
      }),
    hasCode("ROOM_FINAL"),
  );
});

test("deduplicates and rate-limits revision-scoped reactions across VAR states", () => {
  let room = createRoom({
    id: "room-1",
    matchId: "match-1",
    kickoffAt: 1_000,
    createdAt: 100,
    host: { id: "alice", nickname: "Alice" },
    reactionPolicy: { limit: 2, windowMs: 1_000 },
  });
  room = joinRoom(room, {
    participant: { id: "bob", nickname: "Bob" },
    joinedAt: 200,
  });
  room = registerMoment(room, {
    momentId: "moment-1",
    revision: 1,
    varState: "HOLD",
  });

  const held = addReaction(room, {
    participantId: "alice",
    momentId: "moment-1",
    revision: 1,
    kind: "ROAR",
    reactedAt: 1_100,
  });
  assert.equal(held.accepted, true);
  assert.equal(held.reaction?.status, "HELD");
  room = held.room;

  const duplicate = addReaction(room, {
    participantId: "alice",
    momentId: "moment-1",
    revision: 1,
    kind: "ROAR",
    reactedAt: 1_101,
  });
  assert.deepEqual(
    { accepted: duplicate.accepted, reason: duplicate.reason },
    { accepted: false, reason: "DUPLICATE" },
  );
  assert.strictEqual(duplicate.room, room);

  const bobReaction = addReaction(room, {
    participantId: "bob",
    momentId: "moment-1",
    revision: 1,
    kind: "CALLED_IT",
    reactedAt: 1_102,
  });
  room = resolveMoment(bobReaction.room, {
    momentId: "moment-1",
    revision: 1,
    resolution: "OVERTURNED",
  });
  assert.deepEqual(
    room.reactions.map(({ status }) => status),
    ["OVERTURNED", "OVERTURNED"],
  );

  room = registerMoment(room, {
    momentId: "moment-1",
    revision: 2,
    varState: "CLEAR",
  });
  const correctedRevision = addReaction(room, {
    participantId: "alice",
    momentId: "moment-1",
    revision: 2,
    kind: "COLD",
    reactedAt: 1_200,
  });
  assert.equal(correctedRevision.accepted, true);
  assert.equal(correctedRevision.reaction?.status, "VISIBLE");
  room = registerMoment(correctedRevision.room, {
    momentId: "moment-2",
    revision: 1,
    varState: "CLEAR",
  });

  const limited = addReaction(room, {
    participantId: "alice",
    momentId: "moment-2",
    revision: 1,
    kind: "ROAR",
    reactedAt: 1_300,
  });
  assert.deepEqual(
    { accepted: limited.accepted, reason: limited.reason },
    { accepted: false, reason: "RATE_LIMITED" },
  );

  const afterWindow = addReaction(room, {
    participantId: "alice",
    momentId: "moment-2",
    revision: 1,
    kind: "ROAR",
    reactedAt: 2_101,
  });
  assert.equal(afterWindow.accepted, true);
});

test("releases held reactions when VAR confirms the same moment revision", () => {
  let room = createRoom({
    id: "room-1",
    matchId: "match-1",
    kickoffAt: 1_000,
    createdAt: 100,
    host: { id: "alice", nickname: "Alice" },
  });
  room = registerMoment(room, {
    momentId: "moment-1",
    revision: 4,
    varState: "HOLD",
  });
  room = addReaction(room, {
    participantId: "alice",
    momentId: "moment-1",
    revision: 4,
    kind: "COLD",
    reactedAt: 1_100,
  }).room;

  room = resolveMoment(room, {
    momentId: "moment-1",
    revision: 4,
    resolution: "CONFIRMED",
  });
  assert.equal(room.reactions[0]?.status, "VISIBLE");
});

test("100-Sense requires all five markets and exactly 100 in five-Sense steps", () => {
  const slate = validateSensePicks(
    "fan-1",
    [
      { allocation: 30, marketId: "winner", selection: "HOME" },
      { allocation: 20, marketId: "goals_2_5", selection: "OVER" },
      { allocation: 15, marketId: "cards_4_5", selection: "UNDER" },
      { allocation: 25, marketId: "corners_9_5", selection: "OVER" },
      { allocation: 10, marketId: "btts", selection: "YES" },
    ],
    100,
  );
  assert.equal(
    Object.values(slate.picks).reduce(
      (total, pick) => total + pick.allocation,
      0,
    ),
    100,
  );
  assert.throws(
    () =>
      validateSensePicks(
        "fan-1",
        [
          { allocation: 25, marketId: "winner", selection: "HOME" },
          { allocation: 20, marketId: "goals_2_5", selection: "OVER" },
          { allocation: 20, marketId: "cards_4_5", selection: "UNDER" },
          { allocation: 20, marketId: "corners_9_5", selection: "OVER" },
          { allocation: 10, marketId: "btts", selection: "YES" },
        ],
        100,
      ),
    hasCode("INVALID_CALLS"),
  );
});

test("100-Sense leaderboard uses returned Sense then earliest lock", () => {
  const picks = [
    { allocation: 20, marketId: "winner", selection: "HOME" },
    { allocation: 20, marketId: "goals_2_5", selection: "OVER" },
    { allocation: 20, marketId: "cards_4_5", selection: "UNDER" },
    { allocation: 20, marketId: "corners_9_5", selection: "OVER" },
    { allocation: 20, marketId: "btts", selection: "YES" },
  ] as const;
  const leaderboard = scoreSenseSlates({
    members: [
      { id: "fan-1", nickname: "A" },
      { id: "fan-2", nickname: "B" },
    ],
    outcomes: {
      btts: "YES",
      cards_4_5: "UNDER",
      corners_9_5: "OVER",
      goals_2_5: "OVER",
      winner: "HOME",
    },
    slates: {
      "fan-1": validateSensePicks("fan-1", picks, 10),
      "fan-2": validateSensePicks("fan-2", picks, 20),
    },
  });
  assert.equal(leaderboard[0]?.participantId, "fan-1");
  assert.equal(leaderboard[0]?.correctCount, 5);
  assert.equal(leaderboard[0]?.returnedSense, 206);
});
