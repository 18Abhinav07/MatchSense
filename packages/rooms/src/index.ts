export const CALL_CATEGORIES = ["goals", "cards", "corners"] as const;
export const REACTION_KINDS = ["ROAR", "COLD", "CALLED_IT"] as const;
export const POINTS_PER_CONFIDENCE = 100;

export type CallCategory = (typeof CALL_CATEGORIES)[number];
export type CallAnswer = "YES" | "NO";
export type Confidence = 1 | 2 | 3;
export type MemberRole = "PLAYER" | "SPECTATOR";
export type RoomStatus = "PRE_KICKOFF" | "LIVE" | "FINAL";
export type ReactionKind = (typeof REACTION_KINDS)[number];
export type ReactionStatus = "HELD" | "VISIBLE" | "OVERTURNED";
export type MomentVarState = "CLEAR" | "HOLD" | "CONFIRMED" | "OVERTURNED";

export type RoomsErrorCode =
  | "INVALID_ROOM"
  | "INVALID_PARTICIPANT"
  | "INVALID_NICKNAME"
  | "PARTICIPANT_EXISTS"
  | "NICKNAME_TAKEN"
  | "MEMBER_NOT_FOUND"
  | "NOT_PLAYER"
  | "INVALID_CALLS"
  | "CALLS_REQUIRED"
  | "CALLS_LOCKED"
  | "KICKOFF_LOCKED"
  | "BEFORE_KICKOFF"
  | "INVALID_REVISION"
  | "REVISION_CONFLICT"
  | "INVALID_FINAL_EVENT"
  | "ROOM_FINAL"
  | "INVALID_REACTION_POLICY"
  | "INVALID_REACTION"
  | "MOMENT_NOT_FOUND"
  | "MOMENT_NOT_CONFIRMED"
  | "ROOM_NOT_ELIGIBLE"
  | "MOMENT_RESOLUTION_CONFLICT";

export class RoomsDomainError extends Error {
  readonly code: RoomsErrorCode;

  constructor(code: RoomsErrorCode, message: string) {
    super(message);
    this.name = "RoomsDomainError";
    this.code = code;
  }
}

export interface ParticipantIdentity {
  readonly id: string;
  readonly nickname: string;
}

export interface RoomMember {
  readonly id: string;
  readonly nickname: string;
  readonly nicknameKey: string;
  readonly role: MemberRole;
  readonly joinedAt: number;
}

export interface CallInput {
  readonly category: CallCategory;
  readonly answer: CallAnswer;
  readonly confidence: Confidence;
}

export interface RoomCall extends CallInput {}

export interface CallSlate {
  readonly participantId: string;
  readonly calls: Readonly<Record<CallCategory, RoomCall>>;
  readonly changedAt: number;
  readonly lockedAt: number | null;
}

export interface ReliableStatRevision {
  readonly state: "RELIABLE";
  readonly revision: number;
  readonly answer: CallAnswer;
  readonly reason: null;
  readonly observedAt: number;
}

export interface VoidStatRevision {
  readonly state: "VOID";
  readonly revision: number;
  readonly answer: null;
  readonly reason: string;
  readonly observedAt: number;
}

export type StatRevision = ReliableStatRevision | VoidStatRevision;

export interface ReactionPolicy {
  readonly limit: number;
  readonly windowMs: number;
}

export interface MomentRevision {
  readonly momentId: string;
  readonly revision: number;
  readonly varState: MomentVarState;
}

export interface RoomReaction {
  readonly id: string;
  readonly participantId: string;
  readonly momentId: string;
  readonly revision: number;
  readonly kind: ReactionKind;
  readonly status: ReactionStatus;
  readonly reactedAt: number;
}

export interface RoomState {
  readonly id: string;
  readonly matchId: string;
  readonly kickoffAt: number;
  readonly createdAt: number;
  readonly status: RoomStatus;
  readonly finalisedAt: number | null;
  readonly members: readonly RoomMember[];
  readonly callSlates: Readonly<Record<string, CallSlate>>;
  readonly stats: Readonly<Record<CallCategory, StatRevision | null>>;
  readonly moments: Readonly<Record<string, MomentRevision>>;
  readonly reactions: readonly RoomReaction[];
  readonly reactionPolicy: ReactionPolicy;
}

export interface LeaderboardEntry {
  readonly rank: number;
  readonly participantId: string;
  readonly nickname: string;
  readonly score: number;
  readonly lockedAt: number;
  readonly provisional: boolean;
}

export type ReactionRejectionReason =
  "DUPLICATE" | "RATE_LIMITED" | "MOMENT_OVERTURNED";

export interface ReactionResult {
  readonly room: RoomState;
  readonly accepted: boolean;
  readonly reason: ReactionRejectionReason | null;
  readonly reaction: RoomReaction | null;
}

const DEFAULT_REACTION_POLICY: ReactionPolicy = {
  limit: 3,
  windowMs: 10_000,
};
const callCategorySet = new Set<string>(CALL_CATEGORIES);
const reactionKindSet = new Set<string>(REACTION_KINDS);

function fail(code: RoomsErrorCode, message: string): never {
  throw new RoomsDomainError(code, message);
}

function cleanRequiredText(
  value: string,
  code: RoomsErrorCode,
  field: string,
): string {
  const cleaned = value.trim();
  if (cleaned.length === 0) {
    fail(code, `${field} must not be empty`);
  }
  return cleaned;
}

function assertTimestamp(value: number, field: string): void {
  if (!Number.isFinite(value)) {
    fail("INVALID_ROOM", `${field} must be a finite timestamp`);
  }
}

function assertRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    fail("INVALID_REVISION", "revision must be a positive safe integer");
  }
}

function nicknameKey(nickname: string): string {
  return nickname.normalize("NFKC").toLowerCase();
}

function makeMember(
  identity: ParticipantIdentity,
  role: MemberRole,
  joinedAt: number,
): RoomMember {
  const id = cleanRequiredText(
    identity.id,
    "INVALID_PARTICIPANT",
    "participant id",
  );
  const nickname = cleanRequiredText(
    identity.nickname,
    "INVALID_NICKNAME",
    "nickname",
  );
  assertTimestamp(joinedAt, "joinedAt");
  return {
    id,
    nickname,
    nicknameKey: nicknameKey(nickname),
    role,
    joinedAt,
  };
}

function findMember(room: RoomState, participantId: string): RoomMember {
  const member = room.members.find(({ id }) => id === participantId);
  if (member === undefined) {
    fail("MEMBER_NOT_FOUND", `participant is not in room: ${participantId}`);
  }
  return member;
}

function assertRoomOpen(room: RoomState): void {
  if (room.status === "FINAL") {
    fail("ROOM_FINAL", "room is final and cannot be changed");
  }
}

function liveAt(room: RoomState, at: number): RoomState {
  return room.status === "PRE_KICKOFF" && at >= room.kickoffAt
    ? { ...room, status: "LIVE" }
    : room;
}

function assertBeforeKickoff(room: RoomState, at: number): void {
  assertTimestamp(at, "change timestamp");
  if (room.status !== "PRE_KICKOFF" || at >= room.kickoffAt) {
    fail("KICKOFF_LOCKED", "calls are hard-locked at kickoff");
  }
}

function isCallAnswer(value: string): value is CallAnswer {
  return value === "YES" || value === "NO";
}

function validateCalls(
  calls: readonly CallInput[],
): Readonly<Record<CallCategory, RoomCall>> {
  if (calls.length !== CALL_CATEGORIES.length) {
    fail("INVALID_CALLS", "a call slate must contain exactly three calls");
  }

  const byCategory = new Map<CallCategory, RoomCall>();
  const confidences = new Set<number>();
  for (const call of calls) {
    if (
      !callCategorySet.has(call.category) ||
      !isCallAnswer(call.answer) ||
      ![1, 2, 3].includes(call.confidence)
    ) {
      fail("INVALID_CALLS", "call category, answer, or confidence is invalid");
    }
    if (byCategory.has(call.category)) {
      fail("INVALID_CALLS", `duplicate call category: ${call.category}`);
    }
    if (confidences.has(call.confidence)) {
      fail("INVALID_CALLS", "confidence values 1, 2, and 3 must be used once");
    }
    byCategory.set(call.category, { ...call });
    confidences.add(call.confidence);
  }

  if (
    byCategory.size !== CALL_CATEGORIES.length ||
    confidences.size !== CALL_CATEGORIES.length
  ) {
    fail("INVALID_CALLS", "all categories and confidence values are required");
  }

  const goals = byCategory.get("goals");
  const cards = byCategory.get("cards");
  const corners = byCategory.get("corners");
  if (goals === undefined || cards === undefined || corners === undefined) {
    fail("INVALID_CALLS", "goals, cards, and corners calls are required");
  }
  return { goals, cards, corners };
}

function validateReactionPolicy(policy: ReactionPolicy): ReactionPolicy {
  if (
    !Number.isSafeInteger(policy.limit) ||
    policy.limit < 1 ||
    !Number.isSafeInteger(policy.windowMs) ||
    policy.windowMs < 1
  ) {
    fail(
      "INVALID_REACTION_POLICY",
      "reaction limit and window must be positive safe integers",
    );
  }
  return { limit: policy.limit, windowMs: policy.windowMs };
}

function momentKey(momentId: string, revision: number): string {
  return JSON.stringify([momentId, revision]);
}

function reactionId(
  participantId: string,
  momentId: string,
  revision: number,
): string {
  return JSON.stringify([participantId, momentId, revision]);
}

export function createRoom(input: {
  readonly id: string;
  readonly matchId: string;
  readonly kickoffAt: number;
  readonly createdAt: number;
  readonly host: ParticipantIdentity;
  readonly reactionPolicy?: ReactionPolicy;
}): RoomState {
  const id = cleanRequiredText(input.id, "INVALID_ROOM", "room id");
  const matchId = cleanRequiredText(input.matchId, "INVALID_ROOM", "match id");
  assertTimestamp(input.createdAt, "createdAt");
  assertTimestamp(input.kickoffAt, "kickoffAt");
  if (input.createdAt >= input.kickoffAt) {
    fail("INVALID_ROOM", "a room must be created before kickoff");
  }
  const host = makeMember(input.host, "PLAYER", input.createdAt);
  return {
    id,
    matchId,
    kickoffAt: input.kickoffAt,
    createdAt: input.createdAt,
    status: "PRE_KICKOFF",
    finalisedAt: null,
    members: [host],
    callSlates: {},
    stats: { goals: null, cards: null, corners: null },
    moments: {},
    reactions: [],
    reactionPolicy: validateReactionPolicy(
      input.reactionPolicy ?? DEFAULT_REACTION_POLICY,
    ),
  };
}

export function joinRoom(
  room: RoomState,
  input: {
    readonly participant: ParticipantIdentity;
    readonly joinedAt: number;
  },
): RoomState {
  assertRoomOpen(room);
  const role: MemberRole =
    input.joinedAt >= room.kickoffAt ? "SPECTATOR" : "PLAYER";
  const member = makeMember(input.participant, role, input.joinedAt);
  if (room.members.some(({ id }) => id === member.id)) {
    fail("PARTICIPANT_EXISTS", `participant already exists: ${member.id}`);
  }
  if (
    room.members.some(
      ({ nicknameKey: existingKey }) => existingKey === member.nicknameKey,
    )
  ) {
    fail("NICKNAME_TAKEN", `nickname is already in use: ${member.nickname}`);
  }
  const currentRoom = liveAt(room, input.joinedAt);
  return { ...currentRoom, members: [...currentRoom.members, member] };
}

export function setCalls(
  room: RoomState,
  input: {
    readonly participantId: string;
    readonly calls: readonly CallInput[];
    readonly changedAt: number;
  },
): RoomState {
  assertRoomOpen(room);
  assertBeforeKickoff(room, input.changedAt);
  const member = findMember(room, input.participantId);
  if (member.role !== "PLAYER") {
    fail("NOT_PLAYER", "spectators cannot make calls");
  }
  const existing = room.callSlates[member.id];
  if (existing?.lockedAt !== null && existing?.lockedAt !== undefined) {
    fail("CALLS_LOCKED", "this call slate was locked early");
  }
  const slate: CallSlate = {
    participantId: member.id,
    calls: validateCalls(input.calls),
    changedAt: input.changedAt,
    lockedAt: null,
  };
  return {
    ...room,
    callSlates: { ...room.callSlates, [member.id]: slate },
  };
}

export function lockCalls(
  room: RoomState,
  input: { readonly participantId: string; readonly lockedAt: number },
): RoomState {
  assertRoomOpen(room);
  assertBeforeKickoff(room, input.lockedAt);
  const member = findMember(room, input.participantId);
  if (member.role !== "PLAYER") {
    fail("NOT_PLAYER", "spectators cannot lock calls");
  }
  const slate = room.callSlates[member.id];
  if (slate === undefined) {
    fail("CALLS_REQUIRED", "a complete call slate is required before lock");
  }
  if (slate.lockedAt !== null) {
    return room;
  }
  return {
    ...room,
    callSlates: {
      ...room.callSlates,
      [member.id]: { ...slate, lockedAt: input.lockedAt },
    },
  };
}

function updateStat(
  room: RoomState,
  category: CallCategory,
  next: StatRevision,
): RoomState {
  assertRoomOpen(room);
  assertRevision(next.revision);
  if (next.observedAt < room.kickoffAt) {
    fail("BEFORE_KICKOFF", "stats cannot be observed before kickoff");
  }
  const existing = room.stats[category];
  if (existing !== null && next.revision < existing.revision) {
    return room;
  }
  if (existing !== null && next.revision === existing.revision) {
    const samePayload =
      next.state === existing.state &&
      next.answer === existing.answer &&
      next.reason === existing.reason;
    if (samePayload) {
      return room;
    }
    fail(
      "REVISION_CONFLICT",
      `stat revision ${next.revision} has conflicting contents`,
    );
  }
  const currentRoom = liveAt(room, next.observedAt);
  return {
    ...currentRoom,
    stats: { ...currentRoom.stats, [category]: next },
  };
}

export function applyStatRevision(
  room: RoomState,
  input: {
    readonly category: CallCategory;
    readonly revision: number;
    readonly answer: CallAnswer;
    readonly observedAt: number;
  },
): RoomState {
  if (!callCategorySet.has(input.category) || !isCallAnswer(input.answer)) {
    fail("REVISION_CONFLICT", "stat category or answer is invalid");
  }
  assertTimestamp(input.observedAt, "observedAt");
  return updateStat(room, input.category, {
    state: "RELIABLE",
    revision: input.revision,
    answer: input.answer,
    reason: null,
    observedAt: input.observedAt,
  });
}

export function voidStat(
  room: RoomState,
  input: {
    readonly category: CallCategory;
    readonly revision: number;
    readonly reason: string;
    readonly observedAt: number;
  },
): RoomState {
  if (!callCategorySet.has(input.category)) {
    fail("REVISION_CONFLICT", "stat category is invalid");
  }
  const reason = cleanRequiredText(
    input.reason,
    "REVISION_CONFLICT",
    "void reason",
  );
  assertTimestamp(input.observedAt, "observedAt");
  return updateStat(room, input.category, {
    state: "VOID",
    revision: input.revision,
    answer: null,
    reason,
    observedAt: input.observedAt,
  });
}

function compareParticipantIds(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

export function getLeaderboard(room: RoomState): readonly LeaderboardEntry[] {
  const rows: Omit<LeaderboardEntry, "rank">[] = [];
  for (const member of room.members) {
    if (member.role !== "PLAYER") {
      continue;
    }
    const slate = room.callSlates[member.id];
    if (slate === undefined) {
      continue;
    }
    let score = 0;
    for (const category of CALL_CATEGORIES) {
      const stat = room.stats[category];
      const call = slate.calls[category];
      if (stat?.state === "RELIABLE" && stat.answer === call.answer) {
        score += call.confidence * POINTS_PER_CONFIDENCE;
      }
    }
    rows.push({
      participantId: member.id,
      nickname: member.nickname,
      score,
      lockedAt: slate.lockedAt ?? room.kickoffAt,
      provisional: room.status !== "FINAL",
    });
  }

  rows.sort(
    (left, right) =>
      right.score - left.score ||
      left.lockedAt - right.lockedAt ||
      compareParticipantIds(left.participantId, right.participantId),
  );
  return rows.map((row, index) => ({ ...row, rank: index + 1 }));
}

export function finaliseRoom(
  room: RoomState,
  input: {
    readonly event: "game_finalised";
    readonly finalisedAt: number;
  },
): RoomState {
  if (input.event !== "game_finalised") {
    fail("INVALID_FINAL_EVENT", "room scores finalise only on game_finalised");
  }
  if (room.status === "FINAL") {
    return room;
  }
  assertTimestamp(input.finalisedAt, "finalisedAt");
  if (input.finalisedAt < room.kickoffAt) {
    fail("BEFORE_KICKOFF", "a room cannot finalise before kickoff");
  }
  return { ...room, status: "FINAL", finalisedAt: input.finalisedAt };
}

export function registerMoment(
  room: RoomState,
  input: {
    readonly momentId: string;
    readonly revision: number;
    readonly varState: "CLEAR" | "HOLD";
  },
): RoomState {
  assertRoomOpen(room);
  const momentId = cleanRequiredText(
    input.momentId,
    "MOMENT_NOT_FOUND",
    "moment id",
  );
  assertRevision(input.revision);
  if (input.varState !== "CLEAR" && input.varState !== "HOLD") {
    fail("REVISION_CONFLICT", "initial VAR state must be CLEAR or HOLD");
  }
  const key = momentKey(momentId, input.revision);
  const existing = room.moments[key];
  if (existing !== undefined) {
    if (existing.varState === input.varState) {
      return room;
    }
    fail(
      "REVISION_CONFLICT",
      `moment revision ${input.revision} is already registered`,
    );
  }
  const moment: MomentRevision = {
    momentId,
    revision: input.revision,
    varState: input.varState,
  };
  return { ...room, moments: { ...room.moments, [key]: moment } };
}

export function addReaction(
  room: RoomState,
  input: {
    readonly participantId: string;
    readonly momentId: string;
    readonly revision: number;
    readonly kind: ReactionKind;
    readonly reactedAt: number;
  },
): ReactionResult {
  assertRoomOpen(room);
  const member = findMember(room, input.participantId);
  const momentId = cleanRequiredText(
    input.momentId,
    "MOMENT_NOT_FOUND",
    "moment id",
  );
  assertRevision(input.revision);
  assertTimestamp(input.reactedAt, "reactedAt");
  if (input.reactedAt < room.kickoffAt) {
    fail("BEFORE_KICKOFF", "reactions cannot be added before kickoff");
  }
  if (!reactionKindSet.has(input.kind)) {
    fail("INVALID_REACTION", `unsupported reaction: ${input.kind}`);
  }
  const moment = room.moments[momentKey(momentId, input.revision)];
  if (moment === undefined) {
    fail(
      "MOMENT_NOT_FOUND",
      `moment revision not registered: ${momentId}:${input.revision}`,
    );
  }

  const id = reactionId(member.id, momentId, input.revision);
  const existing = room.reactions.find((reaction) => reaction.id === id);
  if (existing !== undefined) {
    return {
      room,
      accepted: false,
      reason: "DUPLICATE",
      reaction: existing,
    };
  }
  if (moment.varState === "OVERTURNED") {
    return {
      room,
      accepted: false,
      reason: "MOMENT_OVERTURNED",
      reaction: null,
    };
  }

  const windowStart = input.reactedAt - room.reactionPolicy.windowMs;
  const recentCount = room.reactions.filter(
    (reaction) =>
      reaction.participantId === member.id &&
      reaction.reactedAt > windowStart &&
      reaction.reactedAt <= input.reactedAt,
  ).length;
  if (recentCount >= room.reactionPolicy.limit) {
    return {
      room,
      accepted: false,
      reason: "RATE_LIMITED",
      reaction: null,
    };
  }

  const reaction: RoomReaction = {
    id,
    participantId: member.id,
    momentId,
    revision: input.revision,
    kind: input.kind,
    status: moment.varState === "HOLD" ? "HELD" : "VISIBLE",
    reactedAt: input.reactedAt,
  };
  const currentRoom = liveAt(room, input.reactedAt);
  const nextRoom = {
    ...currentRoom,
    reactions: [...currentRoom.reactions, reaction],
  };
  return { room: nextRoom, accepted: true, reason: null, reaction };
}

export function resolveMoment(
  room: RoomState,
  input: {
    readonly momentId: string;
    readonly revision: number;
    readonly resolution: "CONFIRMED" | "OVERTURNED";
  },
): RoomState {
  assertRoomOpen(room);
  const momentId = cleanRequiredText(
    input.momentId,
    "MOMENT_NOT_FOUND",
    "moment id",
  );
  assertRevision(input.revision);
  if (input.resolution !== "CONFIRMED" && input.resolution !== "OVERTURNED") {
    fail("MOMENT_RESOLUTION_CONFLICT", "invalid VAR resolution");
  }
  const key = momentKey(momentId, input.revision);
  const moment = room.moments[key];
  if (moment === undefined) {
    fail(
      "MOMENT_NOT_FOUND",
      `moment revision not registered: ${momentId}:${input.revision}`,
    );
  }
  if (moment.varState === input.resolution) {
    return room;
  }
  if (moment.varState === "CONFIRMED" || moment.varState === "OVERTURNED") {
    fail(
      "MOMENT_RESOLUTION_CONFLICT",
      "a resolved moment revision cannot change resolution",
    );
  }

  const reactionStatus: ReactionStatus =
    input.resolution === "CONFIRMED" ? "VISIBLE" : "OVERTURNED";
  return {
    ...room,
    moments: {
      ...room.moments,
      [key]: { ...moment, varState: input.resolution },
    },
    reactions: room.reactions.map((reaction) =>
      reaction.momentId === momentId && reaction.revision === input.revision
        ? { ...reaction, status: reactionStatus }
        : reaction,
    ),
  };
}

/**
 * The durable product room protocol. It is deliberately separate from the
 * legacy demo/100-Sense exports below so a deployed durable Room cannot inherit
 * their allocation, price, or synthetic-fixture semantics while those old
 * surfaces are retired separately.
 */
export const CALL_THREE_TARGETS = ["result", "goals", "cards"] as const;

export type CallThreeTarget = (typeof CALL_THREE_TARGETS)[number];
export type RegulationResult = "HOME" | "DRAW" | "AWAY";
export type ThresholdAnswer = "YES" | "NO";
export type CallThreeAnswer = RegulationResult | ThresholdAnswer;

export type CallThreeInput =
  | {
      readonly target: "result";
      readonly answer: RegulationResult;
      readonly confidence: Confidence;
    }
  | {
      readonly target: "goals" | "cards";
      readonly answer: ThresholdAnswer;
      readonly confidence: Confidence;
    };

export type CallThreeCall = CallThreeInput;

export interface CallThreeSlate {
  readonly participantId: string;
  readonly calls: Readonly<{
    result: Extract<CallThreeCall, { target: "result" }>;
    goals: Extract<CallThreeCall, { target: "goals" }>;
    cards: Extract<CallThreeCall, { target: "cards" }>;
  }>;
  readonly changedAt: number;
  readonly lockedAt: number | null;
}

export interface CallThreeResolvedTarget {
  readonly state: "RESOLVED";
  readonly answer: CallThreeAnswer;
  readonly reason: null;
  readonly observedAt: number;
  readonly version: number;
}

export interface CallThreeVoidTarget {
  readonly state: "VOID";
  readonly answer: null;
  readonly reason: string;
  readonly observedAt: number;
  readonly version: number;
}

export type CallThreeTargetResolution =
  CallThreeResolvedTarget | CallThreeVoidTarget;

export interface CallThreeFinalFacts {
  readonly finalisedAt: number;
  readonly regulationResult: RegulationResult | null;
  readonly totalCards: number | null;
  readonly totalGoals: number | null;
  /** Only the confirmed canonical game_finalised fact may set this true. */
  readonly verified: boolean;
  readonly version: number;
}

export interface CallThreeFixture {
  readonly fixtureId: string;
  readonly kickoffAt: number;
  readonly provenance:
    "live_txline" | "recorded_txline_authorised" | "synthetic_txline_shaped";
}

export interface CallThreeRoomState {
  readonly id: string;
  readonly matchId: string;
  readonly kickoffAt: number;
  readonly createdAt: number;
  readonly status: RoomStatus;
  readonly finalisedAt: number | null;
  readonly finalisedVersion: number | null;
  readonly members: readonly RoomMember[];
  readonly callSlates: Readonly<Record<string, CallThreeSlate>>;
  readonly targets: Readonly<
    Record<CallThreeTarget, CallThreeTargetResolution | null>
  >;
  readonly moments: Readonly<Record<string, MomentRevision>>;
  readonly reactions: readonly RoomReaction[];
  readonly reactionPolicy: ReactionPolicy;
}

export interface CallThreeLeaderboardEntry {
  readonly correctCalls: number;
  readonly lockedAt: number;
  readonly nickname: string;
  readonly participantId: string;
  readonly provisional: boolean;
  readonly rank: number;
  /** Non-transferable MatchSense Points awarded by this Room. */
  readonly score: number;
  readonly voidCalls: number;
}

export interface CallThreeReactionResult {
  readonly room: CallThreeRoomState;
  readonly accepted: boolean;
  readonly reason: ReactionRejectionReason | null;
  readonly reaction: RoomReaction | null;
}

const callThreeTargetSet = new Set<string>(CALL_THREE_TARGETS);

function assertCallThreeRoomOpen(room: CallThreeRoomState) {
  if (room.status === "FINAL") {
    fail("ROOM_FINAL", "room is final and cannot be changed");
  }
}

function assertCallThreeBeforeKickoff(room: CallThreeRoomState, at: number) {
  assertTimestamp(at, "change timestamp");
  if (room.status !== "PRE_KICKOFF" || at >= room.kickoffAt) {
    fail("KICKOFF_LOCKED", "calls are hard-locked at kickoff");
  }
}

function isRegulationResult(value: string): value is RegulationResult {
  return value === "HOME" || value === "DRAW" || value === "AWAY";
}

function isThresholdAnswer(value: string): value is ThresholdAnswer {
  return value === "YES" || value === "NO";
}

function validateCallThreeCalls(
  calls: readonly CallThreeInput[],
): CallThreeSlate["calls"] {
  if (calls.length !== CALL_THREE_TARGETS.length) {
    fail("INVALID_CALLS", "Call Three requires exactly three calls");
  }
  const byTarget = new Map<CallThreeTarget, CallThreeCall>();
  const confidences = new Set<number>();
  for (const call of calls) {
    if (
      !callThreeTargetSet.has(call.target) ||
      ![1, 2, 3].includes(call.confidence) ||
      (call.target === "result" && !isRegulationResult(call.answer)) ||
      (call.target !== "result" && !isThresholdAnswer(call.answer))
    ) {
      fail(
        "INVALID_CALLS",
        "Call Three target, answer, or confidence is invalid",
      );
    }
    if (byTarget.has(call.target)) {
      fail("INVALID_CALLS", `duplicate Call Three target: ${call.target}`);
    }
    if (confidences.has(call.confidence)) {
      fail("INVALID_CALLS", "confidence values 1, 2, and 3 must be used once");
    }
    byTarget.set(call.target, { ...call });
    confidences.add(call.confidence);
  }
  const result = byTarget.get("result");
  const goals = byTarget.get("goals");
  const cards = byTarget.get("cards");
  if (!result || !goals || !cards || confidences.size !== 3) {
    fail(
      "INVALID_CALLS",
      "result, goals, cards, and confidence 3/2/1 are required",
    );
  }
  return {
    result: result as Extract<CallThreeCall, { target: "result" }>,
    goals: goals as Extract<CallThreeCall, { target: "goals" }>,
    cards: cards as Extract<CallThreeCall, { target: "cards" }>,
  };
}

function hardLockCallThreeAtKickoff(
  room: CallThreeRoomState,
): CallThreeRoomState {
  if (room.status === "FINAL") return room;
  const callSlates = Object.fromEntries(
    Object.entries(room.callSlates).map(([participantId, slate]) => [
      participantId,
      slate.lockedAt === null ? { ...slate, lockedAt: room.kickoffAt } : slate,
    ]),
  ) as Record<string, CallThreeSlate>;
  return {
    ...room,
    callSlates,
    status: "LIVE",
  };
}

/**
 * Advances a real-fixture Call Three Room from its scheduled state without
 * trusting a caller-supplied lifecycle label. The authoritative fixture
 * projection supplies `observedAt`; once it reaches official kickoff every
 * existing slate is frozen at that same kickoff timestamp.
 */
export function startCallThreeRoom(
  room: CallThreeRoomState,
  input: { readonly observedAt: number },
): CallThreeRoomState {
  assertCallThreeRoomOpen(room);
  assertTimestamp(input.observedAt, "observedAt");
  return input.observedAt >= room.kickoffAt
    ? hardLockCallThreeAtKickoff(room)
    : room;
}

function voidCallThreeTarget(
  reason: string,
  facts: CallThreeFinalFacts,
): CallThreeVoidTarget {
  return {
    answer: null,
    observedAt: facts.finalisedAt,
    reason,
    state: "VOID",
    version: facts.version,
  };
}

function resolvedCallThreeTarget(
  answer: CallThreeAnswer,
  facts: CallThreeFinalFacts,
): CallThreeResolvedTarget {
  return {
    answer,
    observedAt: facts.finalisedAt,
    reason: null,
    state: "RESOLVED",
    version: facts.version,
  };
}

function assertedFinalTotal(value: number | null, label: string) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    fail("INVALID_FINAL_EVENT", `${label} must be a non-negative safe integer`);
  }
  return value;
}

/**
 * Converts the verified final facts into the three exact Call Three outcomes.
 * A missing canonical fact deliberately voids only its target; it never invents
 * an outcome from a partial snapshot.
 */
export function resolveCallThree(
  facts: CallThreeFinalFacts,
): Readonly<Record<CallThreeTarget, CallThreeTargetResolution>> {
  assertTimestamp(facts.finalisedAt, "finalisedAt");
  assertRevision(facts.version);
  const goals = assertedFinalTotal(facts.totalGoals, "final goals total");
  const cards = assertedFinalTotal(facts.totalCards, "final cards total");
  if (!facts.verified) {
    const unavailable = voidCallThreeTarget(
      "verified final fact is unavailable",
      facts,
    );
    return { cards: unavailable, goals: unavailable, result: unavailable };
  }
  return {
    result: facts.regulationResult
      ? resolvedCallThreeTarget(facts.regulationResult, facts)
      : voidCallThreeTarget("verified regulation result is unavailable", facts),
    goals:
      goals === null
        ? voidCallThreeTarget(
            "verified final goals total is unavailable",
            facts,
          )
        : resolvedCallThreeTarget(goals >= 3 ? "YES" : "NO", facts),
    cards:
      cards === null
        ? voidCallThreeTarget(
            "verified final cards total is unavailable",
            facts,
          )
        : resolvedCallThreeTarget(cards >= 5 ? "YES" : "NO", facts),
  };
}

export function createCallThreeRoom(input: {
  readonly id: string;
  readonly createdAt: number;
  readonly fixture: CallThreeFixture;
  readonly host: ParticipantIdentity;
  readonly reactionPolicy?: ReactionPolicy;
}): CallThreeRoomState {
  if (input.fixture.provenance !== "live_txline") {
    fail(
      "ROOM_NOT_ELIGIBLE",
      "Call Three is available only for live TxLINE fixtures",
    );
  }
  const id = cleanRequiredText(input.id, "INVALID_ROOM", "room id");
  const matchId = cleanRequiredText(
    input.fixture.fixtureId,
    "INVALID_ROOM",
    "fixture id",
  );
  assertTimestamp(input.createdAt, "createdAt");
  assertTimestamp(input.fixture.kickoffAt, "kickoffAt");
  if (input.createdAt >= input.fixture.kickoffAt) {
    fail(
      "ROOM_NOT_ELIGIBLE",
      "Call Three rooms must be created before kickoff",
    );
  }
  return {
    callSlates: {},
    createdAt: input.createdAt,
    finalisedAt: null,
    finalisedVersion: null,
    id,
    kickoffAt: input.fixture.kickoffAt,
    matchId,
    members: [makeMember(input.host, "PLAYER", input.createdAt)],
    moments: {},
    reactionPolicy: validateReactionPolicy(
      input.reactionPolicy ?? DEFAULT_REACTION_POLICY,
    ),
    reactions: [],
    status: "PRE_KICKOFF",
    targets: { cards: null, goals: null, result: null },
  };
}

export function joinCallThreeRoom(
  room: CallThreeRoomState,
  input: {
    readonly participant: ParticipantIdentity;
    readonly joinedAt: number;
  },
): CallThreeRoomState {
  assertCallThreeRoomOpen(room);
  const member = makeMember(
    input.participant,
    input.joinedAt >= room.kickoffAt ? "SPECTATOR" : "PLAYER",
    input.joinedAt,
  );
  if (room.members.some(({ id }) => id === member.id)) {
    fail("PARTICIPANT_EXISTS", `participant already exists: ${member.id}`);
  }
  if (room.members.some(({ nicknameKey: key }) => key === member.nicknameKey)) {
    fail("NICKNAME_TAKEN", `nickname is already in use: ${member.nickname}`);
  }
  const live =
    input.joinedAt >= room.kickoffAt ? hardLockCallThreeAtKickoff(room) : room;
  return { ...live, members: [...live.members, member] };
}

export function setCallThreeCalls(
  room: CallThreeRoomState,
  input: {
    readonly calls: readonly CallThreeInput[];
    readonly changedAt: number;
    readonly participantId: string;
  },
): CallThreeRoomState {
  assertCallThreeRoomOpen(room);
  assertCallThreeBeforeKickoff(room, input.changedAt);
  const member = room.members.find(({ id }) => id === input.participantId);
  if (!member) fail("MEMBER_NOT_FOUND", "participant is not in this Room");
  if (member.role !== "PLAYER")
    fail("NOT_PLAYER", "spectators cannot make calls");
  const existing = room.callSlates[member.id];
  if (existing?.lockedAt !== null && existing?.lockedAt !== undefined) {
    fail("CALLS_LOCKED", "this Call Three slate is already locked");
  }
  return {
    ...room,
    callSlates: {
      ...room.callSlates,
      [member.id]: {
        calls: validateCallThreeCalls(input.calls),
        changedAt: input.changedAt,
        lockedAt: null,
        participantId: member.id,
      },
    },
  };
}

export function lockCallThreeCalls(
  room: CallThreeRoomState,
  input: { readonly lockedAt: number; readonly participantId: string },
): CallThreeRoomState {
  assertCallThreeRoomOpen(room);
  assertCallThreeBeforeKickoff(room, input.lockedAt);
  const member = room.members.find(({ id }) => id === input.participantId);
  if (!member) fail("MEMBER_NOT_FOUND", "participant is not in this Room");
  if (member.role !== "PLAYER")
    fail("NOT_PLAYER", "spectators cannot lock calls");
  const slate = room.callSlates[member.id];
  if (!slate) fail("CALLS_REQUIRED", "a complete Call Three slate is required");
  if (slate.lockedAt !== null) return room;
  return {
    ...room,
    callSlates: {
      ...room.callSlates,
      [member.id]: { ...slate, lockedAt: input.lockedAt },
    },
  };
}

function sameCallThreeTargets(
  left: CallThreeRoomState["targets"],
  right: CallThreeRoomState["targets"],
) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function finaliseCallThreeRoom(
  room: CallThreeRoomState,
  input: { readonly facts: CallThreeFinalFacts },
): CallThreeRoomState {
  if (input.facts.finalisedAt < room.kickoffAt) {
    fail("BEFORE_KICKOFF", "a Room cannot finalise before kickoff");
  }
  const targets = resolveCallThree(input.facts);
  if (
    room.finalisedVersion !== null &&
    input.facts.version < room.finalisedVersion
  ) {
    return room;
  }
  if (room.finalisedVersion === input.facts.version) {
    if (sameCallThreeTargets(room.targets, targets)) return room;
    fail(
      "REVISION_CONFLICT",
      "final facts conflict with the existing revision",
    );
  }
  const locked = hardLockCallThreeAtKickoff(room);
  return {
    ...locked,
    finalisedAt: input.facts.finalisedAt,
    finalisedVersion: input.facts.version,
    status: "FINAL",
    targets,
  };
}

export function getCallThreeLeaderboard(
  room: CallThreeRoomState,
): readonly CallThreeLeaderboardEntry[] {
  const rows: Omit<CallThreeLeaderboardEntry, "rank">[] = [];
  for (const member of room.members) {
    if (member.role !== "PLAYER") continue;
    const slate = room.callSlates[member.id];
    if (!slate) continue;
    let correctCalls = 0;
    let score = 0;
    let voidCalls = 0;
    for (const target of CALL_THREE_TARGETS) {
      const outcome = room.targets[target];
      const call = slate.calls[target];
      if (outcome?.state === "VOID") {
        voidCalls += 1;
      } else if (
        outcome?.state === "RESOLVED" &&
        outcome.answer === call.answer
      ) {
        correctCalls += 1;
        score += call.confidence * POINTS_PER_CONFIDENCE;
      }
    }
    rows.push({
      correctCalls,
      lockedAt: slate.lockedAt ?? room.kickoffAt,
      nickname: member.nickname,
      participantId: member.id,
      provisional: room.status !== "FINAL",
      score,
      voidCalls,
    });
  }
  rows.sort(
    (left, right) =>
      right.score - left.score ||
      left.lockedAt - right.lockedAt ||
      compareParticipantIds(left.participantId, right.participantId),
  );
  return rows.map((row, index) => ({ ...row, rank: index + 1 }));
}

export function registerConfirmedCallThreeMoment(
  room: CallThreeRoomState,
  input: { readonly momentId: string; readonly revision: number },
): CallThreeRoomState {
  assertCallThreeRoomOpen(room);
  const momentId = cleanRequiredText(
    input.momentId,
    "MOMENT_NOT_FOUND",
    "moment id",
  );
  assertRevision(input.revision);
  const key = momentKey(momentId, input.revision);
  const existing = room.moments[key];
  if (existing) {
    if (existing.varState === "CLEAR") return room;
    fail(
      "MOMENT_RESOLUTION_CONFLICT",
      "canonical Moment revision is not confirmed",
    );
  }
  return {
    ...room,
    moments: {
      ...room.moments,
      [key]: { momentId, revision: input.revision, varState: "CLEAR" },
    },
  };
}

/**
 * A canonical correction replaces the meaning of an older revision in the
 * same Moment family. Keep the old revision visible, but make any response to
 * it visibly overturned before the replacement is registered as confirmed.
 */
export function supersedeCallThreeMoment(
  room: CallThreeRoomState,
  input: { readonly momentId: string; readonly revision: number },
): CallThreeRoomState {
  assertCallThreeRoomOpen(room);
  const momentId = cleanRequiredText(
    input.momentId,
    "MOMENT_NOT_FOUND",
    "moment id",
  );
  assertRevision(input.revision);
  let changed = false;
  const moments = Object.fromEntries(
    Object.entries(room.moments).map(([key, moment]) => {
      if (moment.momentId !== momentId || moment.revision >= input.revision) {
        return [key, moment];
      }
      changed ||= moment.varState !== "OVERTURNED";
      return [key, { ...moment, varState: "OVERTURNED" as const }];
    }),
  ) as Record<string, MomentRevision>;
  if (!changed) return room;
  return {
    ...room,
    moments,
    reactions: room.reactions.map((reaction) =>
      reaction.momentId === momentId && reaction.revision < input.revision
        ? { ...reaction, status: "OVERTURNED" }
        : reaction,
    ),
  };
}

export function overturnCallThreeMoment(
  room: CallThreeRoomState,
  input: { readonly momentId: string; readonly revision: number },
): CallThreeRoomState {
  const momentId = cleanRequiredText(
    input.momentId,
    "MOMENT_NOT_FOUND",
    "moment id",
  );
  assertRevision(input.revision);
  const moments: Record<string, MomentRevision> = { ...room.moments };
  let matched = false;
  for (const [key, moment] of Object.entries(moments)) {
    if (moment.momentId === momentId && moment.revision <= input.revision) {
      moments[key] = { ...moment, varState: "OVERTURNED" };
      matched = true;
    }
  }
  const currentKey = momentKey(momentId, input.revision);
  if (!moments[currentKey]) {
    moments[currentKey] = {
      momentId,
      revision: input.revision,
      varState: "OVERTURNED",
    };
  }
  if (!matched && room.moments[currentKey]?.varState === "OVERTURNED") {
    return room;
  }
  return {
    ...room,
    moments,
    reactions: room.reactions.map((reaction) =>
      reaction.momentId === momentId && reaction.revision <= input.revision
        ? { ...reaction, status: "OVERTURNED" }
        : reaction,
    ),
  };
}

export function addCallThreeReaction(
  room: CallThreeRoomState,
  input: {
    readonly kind: ReactionKind;
    readonly momentId: string;
    readonly participantId: string;
    readonly reactedAt: number;
    readonly revision: number;
  },
): CallThreeReactionResult {
  assertCallThreeRoomOpen(room);
  const member = room.members.find(({ id }) => id === input.participantId);
  if (!member) fail("MEMBER_NOT_FOUND", "participant is not in this Room");
  const momentId = cleanRequiredText(
    input.momentId,
    "MOMENT_NOT_FOUND",
    "moment id",
  );
  assertRevision(input.revision);
  assertTimestamp(input.reactedAt, "reactedAt");
  if (input.reactedAt < room.kickoffAt) {
    fail("BEFORE_KICKOFF", "reactions cannot be added before kickoff");
  }
  if (!reactionKindSet.has(input.kind)) {
    fail("INVALID_REACTION", `unsupported reaction: ${input.kind}`);
  }
  const moment = room.moments[momentKey(momentId, input.revision)];
  if (!moment || moment.varState !== "CLEAR") {
    fail(
      "MOMENT_NOT_CONFIRMED",
      "reactions require a confirmed canonical Moment",
    );
  }
  const id = reactionId(member.id, momentId, input.revision);
  const existing = room.reactions.find((reaction) => reaction.id === id);
  if (existing)
    return { accepted: false, reaction: existing, reason: "DUPLICATE", room };
  const windowStart = input.reactedAt - room.reactionPolicy.windowMs;
  const recentCount = room.reactions.filter(
    (reaction) =>
      reaction.participantId === member.id &&
      reaction.reactedAt > windowStart &&
      reaction.reactedAt <= input.reactedAt,
  ).length;
  if (recentCount >= room.reactionPolicy.limit) {
    return { accepted: false, reaction: null, reason: "RATE_LIMITED", room };
  }
  const live =
    input.reactedAt >= room.kickoffAt ? hardLockCallThreeAtKickoff(room) : room;
  const reaction: RoomReaction = {
    id,
    kind: input.kind,
    momentId,
    participantId: member.id,
    reactedAt: input.reactedAt,
    revision: input.revision,
    status: "VISIBLE",
  };
  const nextRoom = { ...live, reactions: [...live.reactions, reaction] };
  return { accepted: true, reaction, reason: null, room: nextRoom };
}

// Legacy compatibility only. The durable Call Three service never imports this
// allocation-based surface; it remains here temporarily for the isolated
// legacy in-memory Room service until that service is retired separately.
export const SENSE_TOTAL = 100;
export const SENSE_INCREMENT = 5;
export const SENSE_MINIMUM_PER_MARKET = 5;
export const SENSE_MARKET_IDS = [
  "winner",
  "goals_2_5",
  "cards_4_5",
  "corners_9_5",
  "btts",
] as const;

export type SenseMarketId = (typeof SENSE_MARKET_IDS)[number];
export type SenseSelection =
  "HOME" | "DRAW" | "AWAY" | "OVER" | "UNDER" | "YES" | "NO";
export type SenseRoomPhase = "DRAFT" | "OPEN" | "LOCKED" | "LIVE" | "FINAL";

export interface SenseMarket {
  readonly id: SenseMarketId;
  readonly label: string;
  readonly selections: readonly {
    readonly id: SenseSelection;
    readonly label: string;
    readonly price: number;
  }[];
  readonly sourceLabel: "MatchSense pricing";
}

export interface SensePickInput {
  readonly marketId: SenseMarketId;
  readonly selection: SenseSelection;
  readonly allocation: number;
}

export interface SenseSlate {
  readonly participantId: string;
  readonly picks: Readonly<Record<SenseMarketId, SensePickInput>>;
  readonly lockedAt: number;
}

export interface SenseOutcomes {
  readonly winner: "HOME" | "DRAW" | "AWAY" | "VOID";
  readonly goals_2_5: "OVER" | "UNDER" | "VOID";
  readonly cards_4_5: "OVER" | "UNDER" | "VOID";
  readonly corners_9_5: "OVER" | "UNDER" | "VOID";
  readonly btts: "YES" | "NO" | "VOID";
}

export interface SenseLeaderboardEntry {
  readonly correctCount: number;
  readonly participantId: string;
  readonly nickname: string;
  readonly rank: number;
  readonly returnedSense: number;
  readonly lockedAt: number;
}

export const SENSE_MARKETS: readonly SenseMarket[] = [
  {
    id: "winner",
    label: "Who wins?",
    selections: [
      { id: "HOME", label: "Home", price: 2.7 },
      { id: "DRAW", label: "Draw", price: 2.7 },
      { id: "AWAY", label: "Away", price: 2.7 },
    ],
    sourceLabel: "MatchSense pricing",
  },
  {
    id: "goals_2_5",
    label: "Total goals · 2.5",
    selections: [
      { id: "OVER", label: "Over", price: 1.9 },
      { id: "UNDER", label: "Under", price: 1.9 },
    ],
    sourceLabel: "MatchSense pricing",
  },
  {
    id: "cards_4_5",
    label: "Total cards · 4.5",
    selections: [
      { id: "OVER", label: "Over", price: 1.9 },
      { id: "UNDER", label: "Under", price: 1.9 },
    ],
    sourceLabel: "MatchSense pricing",
  },
  {
    id: "corners_9_5",
    label: "Total corners · 9.5",
    selections: [
      { id: "OVER", label: "Over", price: 1.9 },
      { id: "UNDER", label: "Under", price: 1.9 },
    ],
    sourceLabel: "MatchSense pricing",
  },
  {
    id: "btts",
    label: "Both teams to score?",
    selections: [
      { id: "YES", label: "Yes", price: 1.9 },
      { id: "NO", label: "No", price: 1.9 },
    ],
    sourceLabel: "MatchSense pricing",
  },
] as const;

const senseMarketById = new Map(
  SENSE_MARKETS.map((market) => [market.id, market] as const),
);

export function validateSensePicks(
  participantId: string,
  picks: readonly SensePickInput[],
  lockedAt: number,
): SenseSlate {
  const id = cleanRequiredText(
    participantId,
    "INVALID_PARTICIPANT",
    "participant id",
  );
  assertTimestamp(lockedAt, "lockedAt");
  if (picks.length !== SENSE_MARKET_IDS.length) {
    fail("INVALID_CALLS", "exactly five 100-Sense picks are required");
  }
  const mapped = new Map<SenseMarketId, SensePickInput>();
  let total = 0;
  for (const pick of picks) {
    const market = senseMarketById.get(pick.marketId);
    if (
      !market ||
      mapped.has(pick.marketId) ||
      !market.selections.some(
        ({ id: selection }) => selection === pick.selection,
      ) ||
      !Number.isSafeInteger(pick.allocation) ||
      pick.allocation < SENSE_MINIMUM_PER_MARKET ||
      pick.allocation % SENSE_INCREMENT !== 0
    ) {
      fail(
        "INVALID_CALLS",
        "each market needs one valid pick and at least 5 Sense in 5-Sense steps",
      );
    }
    mapped.set(pick.marketId, { ...pick });
    total += pick.allocation;
  }
  if (total !== SENSE_TOTAL) {
    fail("INVALID_CALLS", "all 100 Sense must be allocated exactly");
  }
  const winner = mapped.get("winner");
  const goals = mapped.get("goals_2_5");
  const cards = mapped.get("cards_4_5");
  const corners = mapped.get("corners_9_5");
  const btts = mapped.get("btts");
  if (!winner || !goals || !cards || !corners || !btts) {
    fail("INVALID_CALLS", "all five 100-Sense markets are required");
  }
  return {
    lockedAt,
    participantId: id,
    picks: {
      btts,
      cards_4_5: cards,
      corners_9_5: corners,
      goals_2_5: goals,
      winner,
    },
  };
}

export function scoreSenseSlates(input: {
  readonly members: readonly Pick<RoomMember, "id" | "nickname">[];
  readonly outcomes: SenseOutcomes;
  readonly slates: Readonly<Record<string, SenseSlate>>;
}): readonly SenseLeaderboardEntry[] {
  const rows = Object.values(input.slates).map((slate) => {
    let correctCount = 0;
    let returnedSense = 0;
    for (const marketId of SENSE_MARKET_IDS) {
      const pick = slate.picks[marketId];
      const outcome = input.outcomes[marketId];
      if (outcome === "VOID") {
        returnedSense += pick.allocation;
        continue;
      }
      if (pick.selection !== outcome) continue;
      correctCount += 1;
      const market = senseMarketById.get(marketId)!;
      const selection = market.selections.find(
        ({ id }) => id === pick.selection,
      )!;
      returnedSense += pick.allocation * selection.price;
    }
    return {
      correctCount,
      lockedAt: slate.lockedAt,
      nickname:
        input.members.find(({ id }) => id === slate.participantId)?.nickname ??
        "Fan",
      participantId: slate.participantId,
      returnedSense: Math.round(returnedSense * 10) / 10,
    };
  });
  rows.sort(
    (left, right) =>
      right.returnedSense - left.returnedSense ||
      right.correctCount - left.correctCount ||
      left.lockedAt - right.lockedAt ||
      compareParticipantIds(left.participantId, right.participantId),
  );
  return rows.map((row, index) => ({ ...row, rank: index + 1 }));
}
