import type {
  CallThreeSubmission,
  CallThreeTarget,
  ResultAnswer,
  ThresholdAnswer,
} from "./model.js";

export type RoomStatus = "PRE_KICKOFF" | "LIVE" | "FINAL";
export type RoomMemberRole = "PLAYER" | "SPECTATOR";
export type ReactionKind = "ROAR" | "COLD" | "CALLED_IT";

export interface RoomFixture {
  readonly awayTeam: string;
  readonly fixtureId: string;
  readonly homeTeam: string;
  readonly kickoffAt: string;
  readonly minute: string;
  readonly phase: string;
  readonly provenance: "live_txline";
  readonly revision: number;
  readonly score: { readonly away: number; readonly home: number };
  readonly sourceLabel: string;
  readonly updatedAt: string;
}

export interface RoomMember {
  readonly hasCalls: boolean;
  readonly id: string;
  readonly isHost: boolean;
  readonly joinedAt: number;
  readonly lockedAt: number | null;
  readonly nickname: string;
  readonly role: RoomMemberRole;
  readonly teamCode: string | null;
}

export interface CallThreeSlate {
  readonly changedAt: number;
  readonly lockedAt: number | null;
  readonly participantId: string;
  readonly calls: Readonly<{
    readonly result: Extract<
      CallThreeSubmission,
      { readonly target: "result" }
    >;
    readonly goals: Extract<CallThreeSubmission, { readonly target: "goals" }>;
    readonly cards: Extract<CallThreeSubmission, { readonly target: "cards" }>;
  }>;
}

export type CallThreeTargetResolution =
  | {
      readonly answer: ResultAnswer | ThresholdAnswer;
      readonly observedAt: number;
      readonly reason: null;
      readonly state: "RESOLVED";
      readonly version: number;
    }
  | {
      readonly answer: null;
      readonly observedAt: number;
      readonly reason: string;
      readonly state: "VOID";
      readonly version: number;
    };

export interface CallThreeLeaderboardEntry {
  readonly correctCalls: number;
  readonly lockedAt: number;
  readonly nickname: string;
  readonly participantId: string;
  readonly provisional: boolean;
  readonly rank: number;
  readonly score: number;
  readonly voidCalls: number;
}

export interface RoomMoment {
  readonly momentId: string;
  readonly revision: number;
  readonly varState: "CLEAR" | "HOLD" | "CONFIRMED" | "OVERTURNED";
}

export interface RoomReaction {
  readonly id: string;
  readonly kind: ReactionKind;
  readonly momentId: string;
  readonly reactedAt: number;
  readonly recipientNickname: string;
  readonly recipientParticipantId: string;
  readonly recipientTeamCode: string | null;
  readonly revision: number;
  readonly senderNickname: string;
  readonly senderParticipantId: string;
  readonly senderTeamCode: string | null;
  readonly status: "VISIBLE" | "OVERTURNED";
}

export interface CallThreeRoomView {
  readonly createdAt: number;
  readonly currentMoment: RoomMoment | null;
  readonly finalisedAt: number | null;
  readonly fixture: RoomFixture;
  readonly hostParticipantId: string;
  readonly id: string;
  readonly kickoffAt: number;
  readonly leaderboard: readonly CallThreeLeaderboardEntry[];
  readonly members: readonly RoomMember[];
  readonly moments: readonly RoomMoment[];
  readonly myCalls: CallThreeSlate | null;
  readonly name: string;
  readonly points: {
    readonly label: "MATCHSENSE POINTS · NON-TRANSFERABLE";
    readonly lifetimeTotal: number;
    readonly roomPoints: number;
  };
  readonly reactions: readonly RoomReaction[];
  readonly revision: number;
  readonly status: RoomStatus;
  readonly targets: Readonly<
    Record<CallThreeTarget, CallThreeTargetResolution | null>
  >;
  readonly viewerParticipantId: string;
}

export interface RoomInvitePreview {
  readonly callsLocked: boolean;
  readonly expiresAt: number;
  readonly fixture: RoomFixture;
  readonly hostNickname: string;
  readonly kickoffAt: number;
  readonly memberCount: number;
  readonly memberNicknames: readonly string[];
  readonly name: string;
  readonly roomId: string;
  readonly status: RoomStatus;
}

export interface CreateCallThreeRoomInput {
  readonly fixtureId: string;
  readonly name: string;
  readonly nickname: string;
  readonly teamCode?: string | null;
}

export interface JoinCallThreeRoomInput {
  readonly inviteCode: string;
  readonly nickname: string;
  readonly teamCode?: string | null;
}

export interface SendRoomReactionInput {
  readonly kind: ReactionKind;
  readonly momentId: string;
  readonly recipientParticipantId: string;
  readonly revision: number;
}

export interface RoomEventSource {
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  removeEventListener?(
    type: string,
    listener: (event: MessageEvent) => void,
  ): void;
  close(): void;
}

export interface CallThreeRoomApi {
  create(input: CreateCallThreeRoomInput): Promise<{
    readonly inviteCode: string;
    readonly invitePath: string;
    readonly room: CallThreeRoomView;
  }>;
  get(roomId: string): Promise<CallThreeRoomView>;
  join(input: JoinCallThreeRoomInput): Promise<CallThreeRoomView>;
  list(): Promise<readonly CallThreeRoomView[]>;
  lockCalls(roomId: string): Promise<CallThreeRoomView>;
  preview(inviteCode: string): Promise<RoomInvitePreview>;
  react(
    roomId: string,
    input: SendRoomReactionInput,
  ): Promise<{
    readonly reaction: RoomReaction;
    readonly room: CallThreeRoomView;
  }>;
  setCalls(
    roomId: string,
    calls: readonly CallThreeSubmission[],
  ): Promise<CallThreeRoomView>;
  subscribe(
    roomId: string,
    onRoom: (room: CallThreeRoomView) => void,
    onError: (error: Error) => void,
  ): () => void;
}

export interface CreateCallThreeRoomApiOptions {
  readonly cookieSource?: (() => string) | undefined;
  readonly eventSourceFactory?: (url: string) => RoomEventSource;
  readonly fetchImpl?: typeof fetch;
  readonly origin?: string;
}

export interface RoomCreationFixture {
  readonly awayTeam: string;
  readonly fixtureId: string;
  readonly homeTeam: string;
  readonly kickoffAt?: string | undefined;
  readonly lifecycle?: string | undefined;
  readonly mode?: string | undefined;
  readonly phase?: string | undefined;
  readonly provenance?: string | undefined;
}

export type RoomExperienceRoute =
  | {
      readonly initialRooms?: readonly CallThreeRoomView[];
      readonly mode: "list";
    }
  | { readonly fixture: RoomCreationFixture; readonly mode: "create" }
  | { readonly inviteCode: string; readonly mode: "invite" }
  | {
      readonly initialRoom?: CallThreeRoomView;
      readonly mode: "room";
      readonly roomId: string;
    };
