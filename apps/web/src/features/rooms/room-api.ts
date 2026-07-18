import type {
  CallThreeRoomApi,
  CallThreeRoomView,
  CallThreeSlate,
  CallThreeTargetResolution,
  CreateCallThreeRoomApiOptions,
  RoomEventSource,
  RoomFixture,
  RoomInvitePreview,
  RoomMember,
  RoomMoment,
  RoomReaction,
  RoomStatus,
} from "./types.js";
import type {
  CallThreeSubmission,
  CallThreeTarget,
  ResultAnswer,
  ThresholdAnswer,
} from "./model.js";

type JsonRecord = Record<string, unknown>;

const SAFE_ERRORS: Readonly<Record<string, string>> = {
  CALLS_LOCKED: "Calls are locked for this match.",
  CALLS_REQUIRED: "Save all three calls before locking.",
  INVALID_CALLS:
    "Choose all three calls and assign confidence 3, 2, and 1 once each.",
  INVITE_NOT_FOUND: "This Room invite is no longer available.",
  KICKOFF_LOCKED: "Kickoff has passed, so Calls are locked.",
  MEMBER_NOT_FOUND: "That fan is no longer in this Room.",
  MOMENT_NOT_CONFIRMED: "Wait for a confirmed Match Moment before reacting.",
  MOMENT_NOT_FOUND: "That Match Moment is no longer available.",
  REACTION_DUPLICATE: "You already sent a reaction for this Moment.",
  REACTION_MOMENT_OVERTURNED: "That Moment was overturned.",
  REACTION_RATE_LIMITED:
    "Reactions are taking a short breather. Try again shortly.",
  ROOM_FINAL: "This Room has already reached its verified final.",
  ROOM_FULL: "This Room already has its full group of fans.",
  ROOM_NOT_ELIGIBLE:
    "Call Three is available only before kickoff for scheduled live matches.",
  ROOM_NOT_FOUND: "This Room is no longer available.",
  ROOM_SESSION_REQUIRED: "Join this Room before opening its match desk.",
};

export class CallThreeRoomApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CallThreeRoomApiError";
  }
}

function invalidData(): never {
  throw new CallThreeRoomApiError(
    "Room data was invalid. Refresh and try again.",
  );
}

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalidData();
  return value as JsonRecord;
}

function text(value: unknown, max = 240): string {
  if (typeof value !== "string") invalidData();
  const clean = value.trim();
  if (!clean || clean.length > max || /[\u0000-\u001F\u007F]/u.test(clean)) {
    invalidData();
  }
  return clean;
}

function identifier(value: unknown, max = 160): string {
  const clean = text(value, max);
  if (!/^[A-Za-z0-9_:.@-]+$/u.test(clean)) invalidData();
  return clean;
}

function optionalTeamCode(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const code = text(value, 12).toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/u.test(code)) invalidData();
  return code;
}

function integer(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) invalidData();
  return Number(value);
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    invalidData();
  }
  return new Date(Date.parse(value)).toISOString();
}

function status(value: unknown): RoomStatus {
  if (value === "PRE_KICKOFF" || value === "LIVE" || value === "FINAL") {
    return value;
  }
  invalidData();
}

function fixture(value: unknown): RoomFixture {
  const raw = record(value);
  if (raw.provenance !== "live_txline") invalidData();
  const score = record(raw.score);
  return {
    awayTeam: optionalTeamCode(raw.awayTeam) ?? invalidData(),
    fixtureId: identifier(raw.fixtureId, 120),
    homeTeam: optionalTeamCode(raw.homeTeam) ?? invalidData(),
    kickoffAt: timestamp(raw.kickoffAt),
    minute: text(raw.minute, 30),
    phase: text(raw.phase, 40),
    provenance: "live_txline",
    revision: integer(raw.revision),
    score: { away: integer(score.away), home: integer(score.home) },
    sourceLabel: text(raw.sourceLabel, 120),
    updatedAt: timestamp(raw.updatedAt),
  };
}

function members(value: unknown): readonly RoomMember[] {
  if (!Array.isArray(value) || value.length === 0) invalidData();
  return value.map((entry) => {
    const raw = record(entry);
    if (raw.role !== "PLAYER" && raw.role !== "SPECTATOR") invalidData();
    return {
      hasCalls: raw.hasCalls === true,
      id: identifier(raw.id, 120),
      isHost: raw.isHost === true,
      joinedAt: integer(raw.joinedAt),
      lockedAt: raw.lockedAt === null ? null : integer(raw.lockedAt),
      nickname: text(raw.nickname, 30),
      role: raw.role,
      teamCode: optionalTeamCode(raw.teamCode),
    };
  });
}

function confidence(value: unknown): 1 | 2 | 3 {
  if (value === 1 || value === 2 || value === 3) return value;
  invalidData();
}

function resultAnswer(value: unknown): ResultAnswer {
  if (value === "HOME" || value === "DRAW" || value === "AWAY") return value;
  invalidData();
}

function thresholdAnswer(value: unknown): ThresholdAnswer {
  if (value === "YES" || value === "NO") return value;
  invalidData();
}

function target(value: unknown): CallThreeTarget {
  if (value === "result" || value === "goals" || value === "cards")
    return value;
  invalidData();
}

function call(value: unknown): CallThreeSubmission {
  const raw = record(value);
  const kind = target(raw.target);
  const level = confidence(raw.confidence);
  if (kind === "result") {
    return {
      answer: resultAnswer(raw.answer),
      confidence: level,
      target: kind,
    };
  }
  return {
    answer: thresholdAnswer(raw.answer),
    confidence: level,
    target: kind,
  };
}

function slate(value: unknown): CallThreeSlate | null {
  if (value === null || value === undefined) return null;
  const raw = record(value);
  const rawCalls = record(raw.calls);
  const result = call(rawCalls.result);
  const goals = call(rawCalls.goals);
  const cards = call(rawCalls.cards);
  if (
    result.target !== "result" ||
    goals.target !== "goals" ||
    cards.target !== "cards"
  ) {
    invalidData();
  }
  return {
    calls: { cards, goals, result },
    changedAt: integer(raw.changedAt),
    lockedAt: raw.lockedAt === null ? null : integer(raw.lockedAt),
    participantId: identifier(raw.participantId, 120),
  };
}

function resolution(value: unknown): CallThreeTargetResolution | null {
  if (value === null || value === undefined) return null;
  const raw = record(value);
  if (raw.state === "VOID") {
    return {
      answer: null,
      observedAt: integer(raw.observedAt),
      reason: text(raw.reason, 240),
      state: "VOID",
      version: integer(raw.version, 1),
    };
  }
  if (raw.state === "RESOLVED") {
    const answer = raw.answer;
    if (
      answer !== "HOME" &&
      answer !== "DRAW" &&
      answer !== "AWAY" &&
      answer !== "YES" &&
      answer !== "NO"
    ) {
      invalidData();
    }
    return {
      answer,
      observedAt: integer(raw.observedAt),
      reason: null,
      state: "RESOLVED",
      version: integer(raw.version, 1),
    };
  }
  invalidData();
}

function leaderboard(value: unknown) {
  if (!Array.isArray(value)) invalidData();
  return value.map((entry) => {
    const raw = record(entry);
    return {
      correctCalls: integer(raw.correctCalls),
      lockedAt: integer(raw.lockedAt),
      nickname: text(raw.nickname, 30),
      participantId: identifier(raw.participantId, 120),
      provisional: raw.provisional === true,
      rank: integer(raw.rank, 1),
      score: integer(raw.score),
      voidCalls: integer(raw.voidCalls),
    };
  });
}

function moment(value: unknown): RoomMoment | null {
  if (value === null || value === undefined) return null;
  const raw = record(value);
  if (
    raw.varState !== "CLEAR" &&
    raw.varState !== "HOLD" &&
    raw.varState !== "CONFIRMED" &&
    raw.varState !== "OVERTURNED"
  ) {
    invalidData();
  }
  return {
    momentId: identifier(raw.momentId, 160),
    revision: integer(raw.revision, 1),
    varState: raw.varState,
  };
}

function moments(value: unknown): readonly RoomMoment[] {
  if (!Array.isArray(value)) invalidData();
  return value.map((entry) => moment(entry) ?? invalidData());
}

function reactionKind(value: unknown): RoomReaction["kind"] {
  if (value === "ROAR" || value === "COLD" || value === "CALLED_IT")
    return value;
  invalidData();
}

function reactions(value: unknown): readonly RoomReaction[] {
  if (!Array.isArray(value)) invalidData();
  return value.map((entry) => {
    const raw = record(entry);
    if (raw.status !== "VISIBLE" && raw.status !== "OVERTURNED") invalidData();
    return {
      id: identifier(raw.id, 180),
      kind: reactionKind(raw.kind),
      momentId: identifier(raw.momentId, 160),
      reactedAt: integer(raw.reactedAt),
      recipientNickname: text(raw.recipientNickname, 30),
      recipientParticipantId: identifier(raw.recipientParticipantId, 120),
      recipientTeamCode: optionalTeamCode(raw.recipientTeamCode),
      revision: integer(raw.revision, 1),
      senderNickname: text(raw.senderNickname, 30),
      senderParticipantId: identifier(raw.senderParticipantId, 120),
      senderTeamCode: optionalTeamCode(raw.senderTeamCode),
      status: raw.status,
    };
  });
}

export function parseCallThreeRoom(value: unknown): CallThreeRoomView {
  const raw = record(value);
  const rawPoints = record(raw.points);
  if (rawPoints.label !== "MATCHSENSE POINTS · NON-TRANSFERABLE") invalidData();
  const rawTargets = record(raw.targets);
  return {
    createdAt: integer(raw.createdAt),
    currentMoment: moment(raw.currentMoment),
    finalisedAt: raw.finalisedAt === null ? null : integer(raw.finalisedAt),
    fixture: fixture(raw.fixture),
    hostParticipantId: identifier(raw.hostParticipantId, 120),
    id: identifier(raw.id, 120),
    kickoffAt: integer(raw.kickoffAt),
    leaderboard: leaderboard(raw.leaderboard),
    members: members(raw.members),
    moments: moments(raw.moments),
    myCalls: slate(raw.myCalls),
    name: text(raw.name, 60),
    points: {
      label: "MATCHSENSE POINTS · NON-TRANSFERABLE",
      lifetimeTotal: integer(rawPoints.lifetimeTotal),
      roomPoints: integer(rawPoints.roomPoints),
    },
    reactions: reactions(raw.reactions),
    revision: integer(raw.revision, 1),
    status: status(raw.status),
    targets: {
      cards: resolution(rawTargets.cards),
      goals: resolution(rawTargets.goals),
      result: resolution(rawTargets.result),
    },
    viewerParticipantId: identifier(raw.viewerParticipantId, 120),
  };
}

function parsePreview(value: unknown): RoomInvitePreview {
  const raw = record(value);
  if (!Array.isArray(raw.memberNicknames)) invalidData();
  return {
    callsLocked: raw.callsLocked === true,
    expiresAt: integer(raw.expiresAt),
    fixture: fixture(raw.fixture),
    hostNickname: text(raw.hostNickname, 30),
    kickoffAt: integer(raw.kickoffAt),
    memberCount: integer(raw.memberCount, 1),
    memberNicknames: raw.memberNicknames.map((value) => text(value, 30)),
    name: text(raw.name, 60),
    roomId: identifier(raw.roomId, 120),
    status: status(raw.status),
  };
}

function csrfFromCookie(cookie: string): string | null {
  const part = cookie
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith("matchsense_csrf="));
  if (!part) return null;
  try {
    return decodeURIComponent(part.slice("matchsense_csrf=".length));
  } catch {
    return null;
  }
}

function defaultOrigin() {
  return typeof window === "undefined"
    ? "https://matchsense.invalid"
    : window.location.origin;
}

function parseFailure(value: unknown, fallback: string): Error {
  const root =
    value && typeof value === "object" ? (value as JsonRecord) : null;
  const nested = root?.error;
  if (typeof nested === "string") {
    if (nested === "fan_session_required") {
      return new CallThreeRoomApiError(
        "Open MatchSense with your supporter profile to use Rooms.",
      );
    }
    if (nested === "csrf_invalid") {
      return new CallThreeRoomApiError(
        "Refresh MatchSense before changing this Room.",
      );
    }
  }
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const code = (nested as JsonRecord).code;
    if (typeof code === "string" && SAFE_ERRORS[code]) {
      return new CallThreeRoomApiError(SAFE_ERRORS[code]);
    }
  }
  return new CallThreeRoomApiError(fallback);
}

function jsonHeaders(csrf: string | null, mutation: boolean) {
  const headers = new Headers({ Accept: "application/json" });
  if (mutation) {
    headers.set("Content-Type", "application/json");
    if (csrf) headers.set("x-matchsense-csrf", csrf);
  }
  return headers;
}

function eventSourceFactory(): ((url: string) => RoomEventSource) | null {
  if (typeof EventSource === "undefined") return null;
  return (url) => new EventSource(url, { withCredentials: true });
}

export function createCallThreeRoomApi(
  options: CreateCallThreeRoomApiOptions = {},
): CallThreeRoomApi {
  const fetchImpl = options.fetchImpl ?? fetch;
  const origin = options.origin ?? defaultOrigin();
  const cookieSource = options.cookieSource ?? (() => document.cookie);
  const sourceFactory = options.eventSourceFactory ?? eventSourceFactory();

  async function request(
    path: string,
    init: { readonly body?: unknown; readonly method?: string } = {},
  ): Promise<unknown> {
    const mutation = init.method !== undefined && init.method !== "GET";
    const requestInit = {
      credentials: "same-origin",
      headers: jsonHeaders(csrfFromCookie(cookieSource()), mutation),
      method: init.method ?? "GET",
    } as const;
    const response = await fetchImpl(
      new URL(path, origin),
      mutation
        ? { ...requestInit, body: JSON.stringify(init.body ?? {}) }
        : requestInit,
    );
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      if (!response.ok) throw parseFailure(null, "The Room could not update.");
    }
    if (!response.ok) throw parseFailure(payload, "The Room could not update.");
    return payload;
  }

  return {
    async create(input) {
      const payload = record(
        await request("/api/v1/rooms", {
          body: {
            fixtureId: input.fixtureId,
            host: {
              nickname: input.nickname,
              ...(input.teamCode ? { teamCode: input.teamCode } : {}),
            },
            name: input.name,
          },
          method: "POST",
        }),
      );
      const inviteCode = text(payload.inviteCode, 22);
      if (!/^[A-Za-z0-9_-]{22}$/u.test(inviteCode)) invalidData();
      const invitePath = text(payload.invitePath, 160);
      if (!/^\/rooms\/join\/[A-Za-z0-9_-]{22}$/u.test(invitePath))
        invalidData();
      return { inviteCode, invitePath, room: parseCallThreeRoom(payload.room) };
    },
    async get(roomId) {
      return parseCallThreeRoom(
        await request(`/api/v1/rooms/${encodeURIComponent(roomId)}`),
      );
    },
    async join(input) {
      return parseCallThreeRoom(
        await request("/api/v1/rooms/join", {
          body: {
            inviteCode: input.inviteCode,
            nickname: input.nickname,
            ...(input.teamCode ? { teamCode: input.teamCode } : {}),
          },
          method: "POST",
        }),
      );
    },
    async list() {
      const payload = record(await request("/api/v1/rooms"));
      if (!Array.isArray(payload.rooms)) invalidData();
      return payload.rooms.map(parseCallThreeRoom);
    },
    async lockCalls(roomId) {
      return parseCallThreeRoom(
        await request(
          `/api/v1/rooms/${encodeURIComponent(roomId)}/calls/lock`,
          {
            body: {},
            method: "POST",
          },
        ),
      );
    },
    async preview(inviteCode) {
      return parsePreview(
        await request(
          `/api/v1/rooms/invites/${encodeURIComponent(inviteCode)}/preview`,
        ),
      );
    },
    async react(roomId, input) {
      const payload = record(
        await request(`/api/v1/rooms/${encodeURIComponent(roomId)}/reactions`, {
          body: input,
          method: "POST",
        }),
      );
      const parsedReactions = reactions([payload.reaction]);
      const reaction = parsedReactions[0];
      if (!reaction) invalidData();
      return { reaction, room: parseCallThreeRoom(payload.room) };
    },
    async setCalls(roomId, calls) {
      return parseCallThreeRoom(
        await request(`/api/v1/rooms/${encodeURIComponent(roomId)}/calls`, {
          body: { calls },
          method: "PUT",
        }),
      );
    },
    subscribe(roomId, onRoom, onError) {
      if (!sourceFactory) {
        onError(
          new CallThreeRoomApiError(
            "Live Room updates are unavailable in this browser.",
          ),
        );
        return () => undefined;
      }
      const source = sourceFactory(
        new URL(
          `/api/v1/rooms/${encodeURIComponent(roomId)}/stream`,
          origin,
        ).toString(),
      );
      const receive = (event: MessageEvent) => {
        try {
          const payload = record(JSON.parse(String(event.data)));
          if (
            payload.event !== "room.snapshot" &&
            payload.event !== "room.updated"
          ) {
            invalidData();
          }
          onRoom(parseCallThreeRoom(payload.room));
        } catch (error) {
          onError(
            error instanceof Error
              ? error
              : new CallThreeRoomApiError("A live Room update was invalid."),
          );
        }
      };
      source.addEventListener("room.snapshot", receive);
      source.addEventListener("room.updated", receive);
      source.onerror = () => {
        onError(
          new CallThreeRoomApiError("Live Room updates are reconnecting."),
        );
      };
      return () => {
        source.removeEventListener?.("room.snapshot", receive);
        source.removeEventListener?.("room.updated", receive);
        source.close();
      };
    },
  };
}
