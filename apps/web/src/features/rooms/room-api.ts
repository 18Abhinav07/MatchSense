import type {
  CallAnswer,
  CallStat,
  CallThreeEntry,
  CallThreeTarget,
  ReactionType,
  RoomApi,
  RoomFixture,
  RoomInvitePreview,
  RoomLeaderboardRow,
  RoomMember,
  RoomMoment,
  RoomReplayStage,
  RoomReactionReceipt,
  RoomTeam,
  RoomView,
} from "./types.js";

type JsonRecord = Record<string, unknown>;

export interface RoomEventSource {
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  removeEventListener?(
    type: string,
    listener: (event: MessageEvent) => void,
  ): void;
  close(): void;
}

export interface CreateRoomApiOptions {
  readonly eventSourceFactory?: (url: string) => RoomEventSource;
  readonly fanId: string;
  readonly favoriteTeam: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly origin: string;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

const TEAM_DETAILS: Readonly<Record<string, Omit<RoomTeam, "code">>> = {
  ARG: {
    foreground: "#0b2035",
    name: "Argentina",
    primary: "#75aadb",
    secondary: "#f3efe4",
  },
  BRA: {
    foreground: "#071f12",
    name: "Brazil",
    primary: "#eacb46",
    secondary: "#177c46",
  },
  ESP: {
    foreground: "#fff7df",
    name: "Spain",
    primary: "#b51f32",
    secondary: "#f4c84a",
  },
  FRA: {
    foreground: "#f4f6fb",
    name: "France",
    primary: "#173a70",
    secondary: "#d34d58",
  },
  JPN: {
    foreground: "#172033",
    name: "Japan",
    primary: "#f4f1e8",
    secondary: "#bc3347",
  },
};

const CALL_TARGETS: readonly CallThreeTarget[] = [
  {
    question: "3+ total goals?",
    reliability: "unknown",
    sourceLabel: "MatchSense game rule",
    stat: "goals",
    threshold: 3,
    version: 1,
  },
  {
    question: "5+ total cards?",
    reliability: "unknown",
    sourceLabel: "MatchSense game rule",
    stat: "cards",
    threshold: 5,
    version: 1,
  },
  {
    question: "10+ total corners?",
    reliability: "unknown",
    sourceLabel: "MatchSense game rule",
    stat: "corners",
    threshold: 10,
    version: 1,
  },
];

const SAFE_ERRORS: Readonly<Record<string, string>> = {
  CALLS_LOCKED: "Call Three is already locked for this match.",
  CALLS_REQUIRED: "Complete all three calls before locking them.",
  DEMO_CONTROL_DISABLED: "Match replay is unavailable for this live fixture.",
  DEMO_NOT_STARTED: "The match replay has not started yet.",
  INVITE_NOT_FOUND: "This room invite is no longer available.",
  KICKOFF_LOCKED: "Kickoff has passed, so calls are now locked.",
  MEMBER_NOT_FOUND: "This fan is no longer in the room.",
  NICKNAME_TAKEN: "That nickname is already in use.",
  NOT_PLAYER: "Spectators cannot submit calls after kickoff.",
  REACTION_DUPLICATE: "You already sent that reaction.",
  REACTION_MOMENT_OVERTURNED: "That Moment was overturned.",
  REACTION_RATE_LIMITED: "Reactions are cooling down. Try again shortly.",
  REACTION_RECIPIENT_INVALID: "That friend can no longer receive reactions.",
  ROOM_CREATION_CLOSED: "Kickoff has passed, so this room cannot be created.",
  ROOM_FINAL: "This room is already final.",
  ROOM_NOT_FOUND: "This room is no longer available.",
  ROOM_SESSION_REQUIRED: "Your room session expired. Rejoin from the invite.",
};

class SafeRoomApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeRoomApiError";
  }
}

function invalidRoomData(): never {
  throw new SafeRoomApiError("Room data was invalid. Try again.");
}

function record(value: unknown): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidRoomData();
  }
  return value as JsonRecord;
}

function safeString(value: unknown, maxLength = 240): string {
  if (typeof value !== "string") invalidRoomData();
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maxLength ||
    /[\u0000-\u001F\u007F]/u.test(normalized)
  ) {
    invalidRoomData();
  }
  return normalized;
}

function safeIdentifier(value: unknown, maxLength = 160): string {
  const identifier = safeString(value, maxLength);
  if (!/^[A-Za-z0-9_:.@-]+$/u.test(identifier)) invalidRoomData();
  return identifier;
}

function safeInteger(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    invalidRoomData();
  }
  return value as number;
}

function isoTimestamp(value: unknown): string {
  const timestamp =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Date.parse(value)
        : Number.NaN;
  if (!Number.isFinite(timestamp)) invalidRoomData();
  return new Date(timestamp).toISOString();
}

function teamCode(value: unknown, nullable = false): string | null {
  if (value === null && nullable) return null;
  const code = safeString(value, 5).toUpperCase();
  if (!/^[A-Z0-9]{2,5}$/u.test(code)) invalidRoomData();
  return code;
}

function team(value: unknown): RoomTeam {
  const codeValue = typeof value === "string" ? value : record(value).code;
  const code = teamCode(codeValue);
  if (code === null) invalidRoomData();
  const details = TEAM_DETAILS[code] ?? {
    foreground: "#f5f2e9",
    name: code,
    primary: "#343b3a",
    secondary: "#9da5a2",
  };
  return { code, ...details };
}

function fixture(value: unknown): RoomFixture {
  const raw = record(value);
  const kickoffAt = isoTimestamp(raw.kickoffAt);
  const provenance = raw.provenance;
  if (
    provenance !== "synthetic_txline_shaped" &&
    provenance !== "live_txline"
  ) {
    invalidRoomData();
  }
  return {
    awayTeam: team(raw.awayTeam),
    homeTeam: team(raw.homeTeam),
    id: safeIdentifier(raw.fixtureId, 80),
    isReplay: provenance === "synthetic_txline_shaped",
    kickoffAt,
  };
}

function normalizeOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Room API origin is invalid");
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    throw new Error("Room API origin is invalid");
  }
  return parsed.origin;
}

function status(value: unknown): "PRE_KICKOFF" | "LIVE" | "FINAL" {
  if (value !== "PRE_KICKOFF" && value !== "LIVE" && value !== "FINAL") {
    invalidRoomData();
  }
  return value;
}

function optionalTimestamp(value: unknown): string | null {
  return value === null || value === undefined ? null : isoTimestamp(value);
}

function members(value: unknown): RoomMember[] {
  if (!Array.isArray(value) || value.length === 0) invalidRoomData();
  return value.map((entry) => {
    const raw = record(entry);
    const role = raw.role;
    if (role !== "PLAYER" && role !== "SPECTATOR") invalidRoomData();
    const isHost = raw.isHost === true;
    const lockedAt = optionalTimestamp(raw.lockedAt);
    return {
      callsLocked: lockedAt !== null,
      id: safeIdentifier(raw.id, 120),
      muted: false,
      nickname: safeString(raw.nickname, 30),
      role: isHost ? "host" : role === "SPECTATOR" ? "spectator" : "member",
      teamCode: teamCode(raw.teamCode, true),
    };
  });
}

function answer(value: unknown): CallAnswer {
  if (value === "YES") return "yes";
  if (value === "NO") return "no";
  invalidRoomData();
}

function confidence(value: unknown): 1 | 2 | 3 {
  if (value !== 1 && value !== 2 && value !== 3) invalidRoomData();
  return value;
}

function viewerEntry(
  value: unknown,
  roomStatus: "PRE_KICKOFF" | "LIVE" | "FINAL",
  viewerPoints: number,
): CallThreeEntry | null {
  if (value === null || value === undefined) return null;
  const raw = record(value);
  const calls = record(raw.calls);
  const picks = (["goals", "cards", "corners"] as const).map((stat) => {
    const call = record(calls[stat]);
    return {
      answer: answer(call.answer),
      confidence: confidence(call.confidence),
      stat,
    };
  });
  const lockedAt = optionalTimestamp(raw.lockedAt);
  return {
    picks,
    points: viewerPoints,
    status:
      roomStatus === "FINAL"
        ? "final"
        : roomStatus === "LIVE"
          ? "provisional"
          : lockedAt
            ? "locked"
            : "open",
    submittedAt: isoTimestamp(raw.changedAt ?? raw.lockedAt),
  };
}

function statRecord(stats: JsonRecord, stat: CallStat): JsonRecord | null {
  const value = stats[stat];
  return value === null || value === undefined ? null : record(value);
}

function statTotal(stats: JsonRecord, stat: CallStat): number | null {
  const raw = statRecord(stats, stat);
  if (!raw) return null;
  const value = raw.total ?? raw.value;
  return Number.isFinite(value) && (value as number) >= 0
    ? (value as number)
    : null;
}

function targetReliability(
  stats: JsonRecord,
  stat: CallStat,
): CallThreeTarget["reliability"] {
  const raw = statRecord(stats, stat);
  if (!raw) return "unknown";
  if (raw.state === "VOID") return "unreliable";
  if (raw.state === "RELIABLE") return "reliable";
  return "unknown";
}

function score(value: unknown): { away: number; home: number } {
  const raw = record(value);
  return {
    away: safeInteger(raw.away),
    home: safeInteger(raw.home),
  };
}

function currentMoment(
  value: unknown,
  rawFixture: JsonRecord,
): RoomMoment | null {
  if (value === null || value === undefined) return null;
  try {
    const raw = record(value);
    const varState = raw.varState ?? raw.state;
    const state =
      varState === "HOLD" || varState === "review"
        ? "review"
        : varState === "OVERTURNED" || varState === "overturned"
          ? "overturned"
          : varState === "CLEAR" ||
              varState === "CONFIRMED" ||
              varState === "confirmed"
            ? "confirmed"
            : invalidRoomData();
    return {
      label:
        typeof raw.label === "string"
          ? safeString(raw.label, 100)
          : "Match Moment",
      minute:
        typeof raw.minute === "string"
          ? safeString(raw.minute, 20)
          : typeof rawFixture.minute === "string"
            ? safeString(rawFixture.minute, 20)
            : "LIVE",
      momentId: safeIdentifier(raw.momentId, 160),
      revision: safeInteger(raw.revision, 1),
      score: score(raw.score ?? rawFixture.score),
      state,
    };
  } catch (error) {
    if (error instanceof SafeRoomApiError) return null;
    throw error;
  }
}

function leaderboard(
  value: unknown,
  roomStatus: "PRE_KICKOFF" | "LIVE" | "FINAL",
): RoomLeaderboardRow[] {
  if (!Array.isArray(value)) invalidRoomData();
  const rows: RoomLeaderboardRow[] = [];
  for (const entry of value) {
    try {
      const raw = record(entry);
      const points = safeInteger(raw.score ?? raw.points);
      const provisional =
        typeof raw.provisional === "boolean"
          ? raw.provisional
          : roomStatus !== "FINAL";
      rows.push({
        correctCalls:
          raw.correctCalls === undefined ? 0 : safeInteger(raw.correctCalls),
        final: !provisional || roomStatus === "FINAL",
        memberId: safeIdentifier(raw.participantId ?? raw.memberId, 120),
        nickname: safeString(raw.nickname, 30),
        points,
        rank: safeInteger(raw.rank, 1),
        submittedAt: isoTimestamp(raw.submittedAt ?? raw.lockedAt),
      });
    } catch (error) {
      if (!(error instanceof SafeRoomApiError)) throw error;
    }
  }
  return rows;
}

function reactionType(value: unknown): ReactionType {
  if (value === "ROAR" || value === "roar") return "roar";
  if (value === "COLD" || value === "cold") return "cold";
  if (value === "CALLED_IT" || value === "called_it") return "called_it";
  invalidRoomData();
}

function reactions(
  value: unknown,
  roomMembers: readonly RoomMember[],
): RoomReactionReceipt[] {
  if (!Array.isArray(value)) invalidRoomData();
  const receipts: RoomReactionReceipt[] = [];
  for (const entry of value) {
    try {
      const raw = record(entry);
      const senderId = safeIdentifier(
        raw.senderParticipantId ?? raw.participantId,
        120,
      );
      const recipientId = safeIdentifier(raw.recipientParticipantId, 120);
      const sender = roomMembers.find(({ id }) => id === senderId);
      const recipient = roomMembers.find(({ id }) => id === recipientId);
      const senderNickname =
        typeof raw.senderNickname === "string"
          ? safeString(raw.senderNickname, 30)
          : sender?.nickname;
      const recipientNickname =
        typeof raw.recipientNickname === "string"
          ? safeString(raw.recipientNickname, 30)
          : recipient?.nickname;
      if (!senderNickname || !recipientNickname) invalidRoomData();
      const rawState = raw.status ?? raw.state;
      const state =
        rawState === "HELD" || rawState === "held"
          ? "held"
          : rawState === "VISIBLE" || rawState === "delivered"
            ? "delivered"
            : rawState === "OVERTURNED" || rawState === "overturned"
              ? "overturned"
              : invalidRoomData();
      receipts.push({
        createdAt: isoTimestamp(raw.createdAt ?? raw.reactedAt),
        id: safeString(raw.id, 240),
        momentId: safeIdentifier(raw.momentId, 160),
        momentRevision: safeInteger(raw.revision ?? raw.momentRevision, 1),
        recipient: { id: recipientId, nickname: recipientNickname },
        sender: { id: senderId, nickname: senderNickname },
        state,
        type: reactionType(raw.kind ?? raw.type),
      });
    } catch (error) {
      if (!(error instanceof SafeRoomApiError)) throw error;
    }
  }
  return receipts;
}

function safeErrorCode(value: unknown): string | null {
  try {
    const body = record(value);
    const error = record(body.error);
    return typeof error.code === "string" ? error.code : null;
  } catch {
    return null;
  }
}

function defaultEventSourceFactory(url: string): RoomEventSource {
  const source = new EventSource(url);
  return {
    addEventListener: (type, listener) =>
      source.addEventListener(type, listener as EventListener),
    close: () => source.close(),
    get onerror() {
      return source.onerror as ((event: Event) => void) | null;
    },
    set onerror(listener) {
      source.onerror = listener;
    },
    removeEventListener: (type, listener) =>
      source.removeEventListener(type, listener as EventListener),
  };
}

export function createRoomApi(options: CreateRoomApiOptions): RoomApi {
  const origin = normalizeOrigin(options.origin);
  const favoriteTeam =
    options.favoriteTeam === null ? null : teamCode(options.favoriteTeam, true);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const eventSourceFactory =
    options.eventSourceFactory ?? defaultEventSourceFactory;
  const wait =
    options.wait ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, milliseconds);
      }));
  const inviteMemory = new Map<string, string>();

  const validateInviteUrl = (value: string): string | null => {
    try {
      const parsed = new URL(value, origin);
      return parsed.origin === origin &&
        /^\/rooms\/join\/[A-Za-z0-9_-]{22}$/u.test(parsed.pathname)
        ? parsed.href
        : null;
    } catch {
      return null;
    }
  };

  const rememberInvite = (roomId: string, inviteUrl: string) => {
    const validated = validateInviteUrl(inviteUrl);
    if (!validated) invalidRoomData();
    inviteMemory.set(roomId, validated);
  };

  const inviteFor = (roomId: string): string | null => {
    return inviteMemory.get(roomId) ?? null;
  };

  const request = async (
    path: string,
    init: RequestInit | undefined,
    fallbackMessage: string,
  ): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchImpl(new URL(path, origin).href, {
        ...init,
        credentials: init?.credentials ?? "same-origin",
      });
    } catch {
      throw new SafeRoomApiError(fallbackMessage);
    }
    if (!response.ok) {
      let code: string | null = null;
      try {
        code = safeErrorCode(await response.json());
      } catch {
        code = null;
      }
      throw new SafeRoomApiError(
        (code ? SAFE_ERRORS[code] : undefined) ?? fallbackMessage,
      );
    }
    try {
      return await response.json();
    } catch {
      invalidRoomData();
    }
  };

  const jsonInit = (method: "POST" | "PUT", body: unknown): RequestInit => ({
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method,
  });

  const mapRoom = (
    value: unknown,
    expectedViewerMemberId?: string,
  ): RoomView => {
    const raw = record(value);
    const viewerMemberId = safeIdentifier(raw.viewerParticipantId, 120);
    if (
      expectedViewerMemberId !== undefined &&
      viewerMemberId !== expectedViewerMemberId
    ) {
      invalidRoomData();
    }
    const roomId = safeIdentifier(raw.id, 120);
    const roomStatus = status(raw.status);
    const rawFixture = record(raw.fixture);
    const mappedFixture = fixture(rawFixture);
    const mappedMembers = members(raw.members);
    if (!mappedMembers.some(({ id }) => id === viewerMemberId)) {
      invalidRoomData();
    }
    const mappedLeaderboard = leaderboard(raw.leaderboard, roomStatus);
    const viewerPoints =
      mappedLeaderboard.find(({ memberId }) => memberId === viewerMemberId)
        ?.points ?? 0;
    const stats = record(raw.stats);
    const entry = viewerEntry(raw.myCalls, roomStatus, viewerPoints);
    const viewer = mappedMembers.find(({ id }) => id === viewerMemberId)!;
    return {
      calls: {
        lockAt: mappedFixture.kickoffAt,
        locked: roomStatus !== "PRE_KICKOFF" || viewer.role === "spectator",
        pointsOnly: true,
        progress: {
          cards: statTotal(stats, "cards"),
          corners: statTotal(stats, "corners"),
          goals: statTotal(stats, "goals"),
        },
        targets: CALL_TARGETS.map((target) => ({
          ...target,
          reliability: targetReliability(stats, target.stat),
        })),
        viewerEntry: entry,
      },
      currentMoment: currentMoment(raw.currentMoment, rawFixture),
      fixture: mappedFixture,
      id: roomId,
      inviteUrl: inviteFor(roomId),
      leaderboard: mappedLeaderboard,
      members: mappedMembers,
      name: safeString(raw.name, 60),
      phase:
        roomStatus === "FINAL"
          ? "final"
          : roomStatus === "LIVE"
            ? "live"
            : entry?.status === "locked"
              ? "locked"
              : "lobby",
      reactions: reactions(raw.reactions, mappedMembers),
      viewerMemberId,
    };
  };

  const replayStep = async (
    roomId: string,
    path: string,
    body: unknown,
    stage: RoomReplayStage,
    onUpdate?:
      | ((update: { room: RoomView; stage: RoomReplayStage }) => void)
      | undefined,
  ) => {
    const room = mapRoom(
      await request(
        `/api/v1/rooms/${encodeURIComponent(roomId)}/demo/${path}`,
        jsonInit("POST", body),
        "The match replay was interrupted. Try again.",
      ),
    );
    onUpdate?.({ room, stage });
    return room;
  };

  return {
    async createRoom(input) {
      const host = {
        nickname: safeString(input.nickname, 30),
        ...(favoriteTeam ? { teamCode: favoriteTeam } : {}),
      };
      const result = record(
        await request(
          "/api/v1/rooms",
          jsonInit("POST", {
            fixtureId: safeIdentifier(input.fixtureId, 80),
            host,
            name: safeString(input.name, 60),
          }),
          "The room could not be created. Try again.",
        ),
      );
      const rawRoom = record(result.room);
      const roomId = safeIdentifier(rawRoom.id, 120);
      const invitePath =
        typeof result.invitePath === "string"
          ? result.invitePath
          : `/rooms/join/${safeIdentifier(result.inviteCode, 22)}`;
      const inviteUrl = new URL(invitePath, origin).href;
      rememberInvite(roomId, inviteUrl);
      return { inviteUrl, room: mapRoom(rawRoom) };
    },

    async getRoom(roomId) {
      const id = safeIdentifier(roomId, 120);
      return mapRoom(
        await request(
          `/api/v1/rooms/${encodeURIComponent(id)}`,
          undefined,
          "The room could not be opened. Try again.",
        ),
      );
    },

    async joinRoom(input) {
      const result = await request(
        "/api/v1/rooms/join",
        jsonInit("POST", {
          inviteCode: safeIdentifier(input.inviteCode, 22),
          nickname: safeString(input.nickname, 30),
          ...(input.teamCode
            ? { teamCode: teamCode(input.teamCode, true) }
            : {}),
        }),
        "The room could not be joined. Try again.",
      );
      const envelope = record(result);
      const roomValue = "room" in envelope ? envelope.room : result;
      const room = mapRoom(roomValue);
      const viewer = room.members.find(({ id }) => id === room.viewerMemberId);
      return {
        lateJoin:
          typeof envelope.lateJoin === "boolean"
            ? envelope.lateJoin
            : viewer?.role === "spectator",
        room,
      };
    },

    async playReplay(roomId, onUpdate) {
      const id = safeIdentifier(roomId, 120);
      const startedRoom = await replayStep(
        id,
        "start",
        {},
        "kickoff",
        onUpdate,
      );
      const momentId = `${startedRoom.fixture.id}:replay:goal`;
      await wait(700);
      await replayStep(
        id,
        "resolve-stats",
        { cards: "NO", corners: "YES", goals: "YES", revision: 1 },
        "calls_resolved",
        onUpdate,
      );
      await wait(800);
      await replayStep(
        id,
        "register-moment",
        { momentId, revision: 7, varState: "HOLD" },
        "under_review",
        onUpdate,
      );
      await wait(1_400);
      await replayStep(
        id,
        "resolve-moment",
        { momentId, resolution: "CONFIRMED", revision: 7 },
        "confirmed",
        onUpdate,
      );
      await wait(650);
      return replayStep(id, "finalise", {}, "final", onUpdate);
    },

    async previewInvite(inviteCode) {
      const code = safeIdentifier(inviteCode, 22);
      const raw = record(
        await request(
          `/api/v1/rooms/invites/${encodeURIComponent(code)}/preview`,
          undefined,
          "This room invite could not be opened.",
        ),
      );
      if (!Array.isArray(raw.memberNicknames)) invalidRoomData();
      if (typeof raw.callsLocked !== "boolean") invalidRoomData();
      return {
        callsLocked: raw.callsLocked,
        expiresAt: isoTimestamp(raw.expiresAt),
        fixture: fixture(raw.fixture),
        hostNickname: safeString(raw.hostNickname, 30),
        memberNicknames: raw.memberNicknames.map((name) =>
          safeString(name, 30),
        ),
        roomName: safeString(raw.roomName ?? raw.name, 60),
      } satisfies RoomInvitePreview;
    },

    async saveCalls(roomId, input) {
      const id = safeIdentifier(roomId, 120);
      return mapRoom(
        await request(
          `/api/v1/rooms/${encodeURIComponent(id)}/calls`,
          jsonInit("PUT", {
            calls: input.picks.map((pick) => ({
              answer: pick.answer.toUpperCase(),
              category: pick.stat,
              confidence: pick.confidence,
            })),
            lock: input.lock,
          }),
          "Call Three could not be saved. Try again.",
        ),
      );
    },

    async sendReaction(roomId, input) {
      const id = safeIdentifier(roomId, 120);
      const result = record(
        await request(
          `/api/v1/rooms/${encodeURIComponent(id)}/reactions`,
          jsonInit("POST", {
            kind: input.type.toUpperCase(),
            momentId: safeIdentifier(input.momentId, 160),
            recipientParticipantId: safeIdentifier(
              input.recipientMemberId,
              120,
            ),
            revision: safeInteger(input.momentRevision, 1),
          }),
          "The reaction could not be sent. Try again.",
        ),
      );
      return {
        receiptId: safeString(record(result.reaction).id, 240),
        room: mapRoom(result.room),
      };
    },

    subscribeRoom(roomId, viewerMemberId, onRoom, onError) {
      let id: string;
      let viewerId: string;
      try {
        id = safeIdentifier(roomId, 120);
        viewerId = safeIdentifier(viewerMemberId, 120);
      } catch {
        onError(new Error("Live room updates could not start."));
        return () => undefined;
      }
      let source: RoomEventSource;
      try {
        source = eventSourceFactory(
          `${origin}/api/v1/rooms/${encodeURIComponent(id)}/stream`,
        );
      } catch {
        onError(new Error("Live room updates could not start."));
        return () => undefined;
      }
      let closed = false;
      let latestRevision = -1;
      const receive = (event: MessageEvent) => {
        if (closed) return;
        try {
          const envelope = record(JSON.parse(String(event.data)));
          const revisionValue =
            envelope.revision ?? record(envelope.room).revision;
          const revision = safeInteger(revisionValue, 0);
          if (revision <= latestRevision) return;
          latestRevision = revision;
          onRoom(mapRoom(envelope.room, viewerId));
        } catch {
          onError(new Error("A live room update was invalid. Reconnecting…"));
        }
      };
      source.addEventListener("room.snapshot", receive);
      source.addEventListener("room.updated", receive);
      source.onerror = () => {
        if (!closed) {
          onError(
            new Error("Live room updates were interrupted. Reconnecting…"),
          );
        }
      };
      return () => {
        if (closed) return;
        closed = true;
        source.removeEventListener?.("room.snapshot", receive);
        source.removeEventListener?.("room.updated", receive);
        source.onerror = null;
        source.close();
      };
    },
  };
}
