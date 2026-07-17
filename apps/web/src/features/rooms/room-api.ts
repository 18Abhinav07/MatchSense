import type {
  ReactionType,
  RoomApi,
  RoomFixture,
  RoomInvitePreview,
  RoomMember,
  RoomMoment,
  RoomReactionReceipt,
  RoomReplayStage,
  RoomTeam,
  RoomView,
  SenseLeaderboardRow,
  SenseMarket,
  SenseMarketId,
  SensePick,
  SenseRoomPhase,
  SenseSelection,
  SenseSlate,
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
  ENG: {
    foreground: "#111827",
    name: "England",
    primary: "#f5f5f0",
    secondary: "#d71920",
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

const MARKET_IDS = new Set<SenseMarketId>([
  "winner",
  "goals_2_5",
  "cards_4_5",
  "corners_9_5",
  "btts",
]);
const SELECTIONS = new Set<SenseSelection>([
  "HOME",
  "DRAW",
  "AWAY",
  "OVER",
  "UNDER",
  "YES",
  "NO",
]);
const SAFE_ERRORS: Readonly<Record<string, string>> = {
  INVITE_NOT_FOUND: "This room invite is no longer available.",
  INVALID_CALLS: "Allocate all 100 Sense across all five markets.",
  KICKOFF_LOCKED: "Kickoff has passed, so picks are locked.",
  MEMBER_NOT_FOUND: "This fan is no longer in the room.",
  NICKNAME_TAKEN: "That nickname is already in use.",
  NOT_PLAYER: "Spectators cannot submit picks after kickoff.",
  PICKS_NOT_OPEN: "The host has not opened picks yet.",
  PICKS_OPEN: "Your 100-Sense picks are already locked.",
  REACTION_DUPLICATE: "You already sent that reaction.",
  REACTION_MOMENT_OVERTURNED: "That Moment was overturned.",
  REACTION_RATE_LIMITED: "Reactions are cooling down. Try again shortly.",
  ROOM_CREATION_CLOSED: "Kickoff has passed, so this room cannot be created.",
  ROOM_FULL: "This room already has 20 fans.",
  ROOM_NOT_FOUND: "This room is no longer available.",
};

class SafeRoomApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeRoomApiError";
  }
}

function invalidData(): never {
  throw new SafeRoomApiError("Room data was invalid. Try again.");
}

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalidData();
  return value as JsonRecord;
}

function text(value: unknown, max = 240): string {
  if (typeof value !== "string") invalidData();
  const clean = value.trim();
  if (!clean || clean.length > max || /[\u0000-\u001F\u007F]/u.test(clean))
    invalidData();
  return clean;
}

function id(value: unknown, max = 160): string {
  const clean = text(value, max);
  if (!/^[A-Za-z0-9_:.@-]+$/u.test(clean)) invalidData();
  return clean;
}

function integer(value: unknown, min = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < min) invalidData();
  return Number(value);
}

function number(value: unknown, min = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min)
    invalidData();
  return value;
}

function timestamp(value: unknown): string {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Date.parse(value)
        : Number.NaN;
  if (!Number.isFinite(parsed)) invalidData();
  return new Date(parsed).toISOString();
}

function teamCode(value: unknown): string {
  const code = text(value, 12).toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/u.test(code)) invalidData();
  return code;
}

function team(value: unknown): RoomTeam {
  const rawCode = typeof value === "string" ? value : record(value).code;
  const code = teamCode(rawCode);
  return {
    code,
    ...(TEAM_DETAILS[code] ?? {
      foreground: "#f5f2e9",
      name: code,
      primary: "#343b3a",
      secondary: "#9da5a2",
    }),
  };
}

function fixture(value: unknown): RoomFixture {
  const raw = record(value);
  const provenance = raw.provenance;
  if (provenance !== "synthetic_txline_shaped" && provenance !== "live_txline")
    invalidData();
  return {
    awayTeam: team(raw.awayTeam),
    homeTeam: team(raw.homeTeam),
    id: id(raw.fixtureId, 80),
    isReplay: provenance === "synthetic_txline_shaped",
    kickoffAt: timestamp(raw.kickoffAt),
  };
}

function marketId(value: unknown): SenseMarketId {
  const candidate = text(value, 24) as SenseMarketId;
  if (!MARKET_IDS.has(candidate)) invalidData();
  return candidate;
}

function selection(value: unknown): SenseSelection {
  const candidate = text(value, 8) as SenseSelection;
  if (!SELECTIONS.has(candidate)) invalidData();
  return candidate;
}

function phase(value: unknown): SenseRoomPhase {
  if (
    value === "DRAFT" ||
    value === "OPEN" ||
    value === "LOCKED" ||
    value === "LIVE" ||
    value === "FINAL"
  )
    return value;
  invalidData();
}

function markets(value: unknown): SenseMarket[] {
  if (!Array.isArray(value) || value.length !== 5) invalidData();
  return value.map((entry) => {
    const raw = record(entry);
    if (
      !Array.isArray(raw.selections) ||
      raw.sourceLabel !== "MatchSense pricing"
    )
      invalidData();
    return {
      id: marketId(raw.id),
      label: text(raw.label, 80),
      selections: raw.selections.map((option) => {
        const rawOption = record(option);
        return {
          id: selection(rawOption.id),
          label: text(rawOption.label, 30),
          price: number(rawOption.price, 1),
        };
      }),
      sourceLabel: "MatchSense pricing",
    };
  });
}

function slate(value: unknown): SenseSlate | null {
  if (value === null || value === undefined) return null;
  const raw = record(value);
  const rawPicks = record(raw.picks);
  const picks = [...MARKET_IDS].map((key) => {
    const pick = record(rawPicks[key]);
    return {
      allocation: integer(pick.allocation, 5),
      marketId: marketId(pick.marketId),
      selection: selection(pick.selection),
    };
  });
  return {
    lockedAt: timestamp(raw.lockedAt),
    participantId: id(raw.participantId, 120),
    picks,
  };
}

function members(value: unknown): RoomMember[] {
  if (!Array.isArray(value) || value.length === 0) invalidData();
  return value.map((entry) => {
    const raw = record(entry);
    const role =
      raw.isHost === true
        ? "host"
        : raw.role === "SPECTATOR"
          ? "spectator"
          : "member";
    return {
      hasPicks: raw.hasPicks === true,
      id: id(raw.id, 120),
      nickname: text(raw.nickname, 30),
      role,
      teamCode:
        raw.teamCode === null || raw.teamCode === undefined
          ? null
          : teamCode(raw.teamCode),
    };
  });
}

function leaderboard(value: unknown): SenseLeaderboardRow[] {
  if (!Array.isArray(value)) invalidData();
  return value.map((entry) => {
    const raw = record(entry);
    return {
      correctCount: integer(raw.correctCount),
      memberId: id(raw.participantId, 120),
      nickname: text(raw.nickname, 30),
      rank: integer(raw.rank, 1),
      returnedSense: number(raw.returnedSense),
    };
  });
}

function moment(value: unknown, rawFixture: JsonRecord): RoomMoment | null {
  if (value === null || value === undefined) return null;
  const raw = record(value);
  const rawState = raw.varState ?? raw.state;
  const state =
    rawState === "HOLD"
      ? "review"
      : rawState === "OVERTURNED"
        ? "overturned"
        : "confirmed";
  const rawScore = record(raw.score ?? rawFixture.score);
  return {
    label:
      typeof raw.label === "string" ? text(raw.label, 100) : "Match Moment",
    minute: typeof raw.minute === "string" ? text(raw.minute, 20) : "LIVE",
    momentId: id(raw.momentId, 160),
    revision: integer(raw.revision, 1),
    score: { away: integer(rawScore.away), home: integer(rawScore.home) },
    state,
  };
}

function reactionType(value: unknown): ReactionType {
  if (value === "ROAR") return "roar";
  if (value === "COLD") return "cold";
  if (value === "CALLED_IT") return "called_it";
  invalidData();
}

function reactions(
  value: unknown,
  roomMembers: readonly RoomMember[],
): RoomReactionReceipt[] {
  if (!Array.isArray(value)) invalidData();
  return value.map((entry) => {
    const raw = record(entry);
    const senderId = id(raw.senderParticipantId, 120);
    const recipientId = id(raw.recipientParticipantId, 120);
    const sender = roomMembers.find((member) => member.id === senderId);
    const recipient = roomMembers.find((member) => member.id === recipientId);
    if (!sender || !recipient) invalidData();
    return {
      createdAt: timestamp(raw.reactedAt),
      id: text(raw.id),
      momentId: id(raw.momentId, 160),
      momentRevision: integer(raw.revision, 1),
      recipient: { id: recipient.id, nickname: recipient.nickname },
      sender: { id: sender.id, nickname: sender.nickname },
      state:
        raw.status === "HELD"
          ? "held"
          : raw.status === "OVERTURNED"
            ? "overturned"
            : "delivered",
      type: reactionType(raw.kind),
    };
  });
}

function normalizeOrigin(value: string): string {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password
  )
    throw new Error("Room API origin is invalid");
  return parsed.origin;
}

function defaultEventSourceFactory(url: string): RoomEventSource {
  const source = new EventSource(url);
  return source as unknown as RoomEventSource;
}

export function createRoomApi(options: CreateRoomApiOptions): RoomApi {
  const origin = normalizeOrigin(options.origin);
  const fanId = id(options.fanId, 120);
  const favoriteTeam = options.favoriteTeam
    ? teamCode(options.favoriteTeam)
    : null;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const eventSourceFactory =
    options.eventSourceFactory ?? defaultEventSourceFactory;
  const wait =
    options.wait ??
    ((ms: number) =>
      new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms)));
  const invites = new Map<string, string>();

  const request = async (
    path: string,
    init?: RequestInit,
  ): Promise<unknown> => {
    let response: Response;
    try {
      response = await fetchImpl(new URL(path, origin), {
        ...init,
        credentials: "same-origin",
        headers: { ...init?.headers, "x-matchsense-fan-id": fanId },
      });
    } catch {
      throw new SafeRoomApiError("The room could not connect. Try again.");
    }
    if (!response.ok) {
      let code = "";
      try {
        code = text(record(record(await response.json()).error).code, 80);
      } catch {
        code = "";
      }
      throw new SafeRoomApiError(
        SAFE_ERRORS[code] ?? "The room could not update. Try again.",
      );
    }
    try {
      return await response.json();
    } catch {
      invalidData();
    }
  };
  const json = (method: "POST" | "PUT", body: unknown): RequestInit => ({
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method,
  });

  const mapRoom = (value: unknown, expectedViewer?: string): RoomView => {
    const raw = record(value);
    const viewerMemberId = id(raw.viewerParticipantId, 120);
    if (expectedViewer && viewerMemberId !== expectedViewer) invalidData();
    const rawFixture = record(raw.fixture);
    const roomMembers = members(raw.members);
    const rawSense = record(raw.sense);
    const roomId = id(raw.id, 120);
    return {
      currentMoment: moment(raw.currentMoment, rawFixture),
      fixture: fixture(rawFixture),
      id: roomId,
      inviteUrl: invites.get(roomId) ?? null,
      isHost: id(raw.hostParticipantId, 120) === viewerMemberId,
      members: roomMembers,
      name: text(raw.name, 60),
      reactions: reactions(raw.reactions, roomMembers),
      sense: {
        currencyLabel: "FRIEND SENSE · NO MONEY · NO PRIZES",
        leaderboard: leaderboard(rawSense.leaderboard),
        markets: markets(rawSense.markets),
        mySlate: slate(rawSense.mySlate),
        phase: phase(rawSense.phase),
        revealedSlates: Array.isArray(rawSense.revealedSlates)
          ? rawSense.revealedSlates
              .map((value) => slate(value)!)
              .filter(Boolean)
          : invalidData(),
        total: rawSense.total === 100 ? 100 : invalidData(),
      },
      viewerMemberId,
    };
  };

  const replayStep = async (
    roomId: string,
    action: string,
    body: unknown,
    stage: RoomReplayStage,
    onUpdate?: (update: { room: RoomView; stage: RoomReplayStage }) => void,
  ) => {
    const room = mapRoom(
      await request(
        `/api/v1/rooms/${encodeURIComponent(roomId)}/demo/${action}`,
        json("POST", body),
      ),
    );
    onUpdate?.({ room, stage });
    return room;
  };

  return {
    async createRoom(input) {
      const result = record(
        await request(
          "/api/v1/rooms",
          json("POST", {
            fixtureId: id(input.fixtureId, 80),
            host: {
              nickname: text(input.nickname, 30),
              ...(favoriteTeam ? { teamCode: favoriteTeam } : {}),
            },
            name: text(input.name, 60),
          }),
        ),
      );
      const room = mapRoom(result.room);
      const invitePath =
        typeof result.invitePath === "string"
          ? result.invitePath
          : `/rooms/join/${id(result.inviteCode, 22)}`;
      const inviteUrl = new URL(invitePath, origin).href;
      invites.set(room.id, inviteUrl);
      return { inviteUrl, room: { ...room, inviteUrl } };
    },
    async getRoom(roomId) {
      return mapRoom(
        await request(`/api/v1/rooms/${encodeURIComponent(id(roomId, 120))}`),
      );
    },
    async joinRoom(input) {
      const room = mapRoom(
        await request(
          "/api/v1/rooms/join",
          json("POST", {
            inviteCode: id(input.inviteCode, 22),
            nickname: text(input.nickname, 30),
            ...(input.teamCode ? { teamCode: teamCode(input.teamCode) } : {}),
          }),
        ),
      );
      return {
        lateJoin:
          room.members.find((member) => member.id === room.viewerMemberId)
            ?.role === "spectator",
        room,
      };
    },
    async openPicks(roomId) {
      const safeId = id(roomId, 120);
      return mapRoom(
        await request(
          `/api/v1/rooms/${encodeURIComponent(safeId)}/picks/open`,
          json("POST", {}),
        ),
      );
    },
    async playReplay(roomId, onUpdate) {
      const safeId = id(roomId, 120);
      const started = await replayStep(
        safeId,
        "start",
        {},
        "kickoff",
        onUpdate,
      );
      const momentId = `${started.fixture.id}:replay:goal`;
      await wait(300);
      await replayStep(
        safeId,
        "resolve-stats",
        { cards: "NO", corners: "YES", goals: "YES", revision: 1 },
        "calls_resolved",
        onUpdate,
      );
      await wait(300);
      await replayStep(
        safeId,
        "register-moment",
        { momentId, revision: 7, varState: "HOLD" },
        "under_review",
        onUpdate,
      );
      await wait(500);
      await replayStep(
        safeId,
        "resolve-moment",
        { momentId, resolution: "CONFIRMED", revision: 7 },
        "confirmed",
        onUpdate,
      );
      return replayStep(safeId, "finalise", {}, "final", onUpdate);
    },
    async previewInvite(inviteCode) {
      const raw = record(
        await request(
          `/api/v1/rooms/invites/${encodeURIComponent(id(inviteCode, 22))}/preview`,
        ),
      );
      if (!Array.isArray(raw.memberNicknames)) invalidData();
      return {
        callsLocked: raw.callsLocked === true,
        expiresAt: timestamp(raw.expiresAt),
        fixture: fixture(raw.fixture),
        hostNickname: text(raw.hostNickname, 30),
        memberNicknames: raw.memberNicknames.map((value) => text(value, 30)),
        roomName: text(raw.name ?? raw.roomName, 60),
      } satisfies RoomInvitePreview;
    },
    async savePicks(roomId, picks) {
      const safeId = id(roomId, 120);
      return mapRoom(
        await request(
          `/api/v1/rooms/${encodeURIComponent(safeId)}/picks`,
          json("PUT", { picks }),
        ),
      );
    },
    async sendReaction(roomId, input) {
      const safeId = id(roomId, 120);
      const result = record(
        await request(
          `/api/v1/rooms/${encodeURIComponent(safeId)}/reactions`,
          json("POST", {
            kind: input.type.toUpperCase(),
            momentId: id(input.momentId, 160),
            recipientParticipantId: id(input.recipientMemberId, 120),
            revision: integer(input.momentRevision, 1),
          }),
        ),
      );
      return {
        receiptId: text(record(result.reaction).id),
        room: mapRoom(result.room),
      };
    },
    subscribeRoom(roomId, viewerMemberId, onRoom, onError) {
      const safeId = id(roomId, 120);
      const viewer = id(viewerMemberId, 120);
      const url = new URL(
        `/api/v1/rooms/${encodeURIComponent(safeId)}/stream`,
        origin,
      );
      url.searchParams.set("fanId", fanId);
      const source = eventSourceFactory(url.href);
      let closed = false;
      let latest = -1;
      const receive = (event: MessageEvent) => {
        if (closed) return;
        try {
          const envelope = record(JSON.parse(String(event.data)));
          const revision = integer(envelope.revision);
          if (revision <= latest) return;
          latest = revision;
          onRoom(mapRoom(envelope.room, viewer));
        } catch {
          onError(new Error("A live room update was invalid. Reconnecting…"));
        }
      };
      source.addEventListener("room.snapshot", receive);
      source.addEventListener("room.updated", receive);
      source.onerror = () => {
        if (!closed)
          onError(
            new Error("Live room updates were interrupted. Reconnecting…"),
          );
      };
      return () => {
        closed = true;
        source.removeEventListener?.("room.snapshot", receive);
        source.removeEventListener?.("room.updated", receive);
        source.close();
      };
    },
  };
}
