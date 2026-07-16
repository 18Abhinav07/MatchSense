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
