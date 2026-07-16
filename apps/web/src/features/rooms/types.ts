export type RoomPhase = "lobby" | "locked" | "live" | "final";
export type RoomMemberRole = "host" | "member" | "spectator";
export type CallStat = "goals" | "cards" | "corners";
export type CallAnswer = "yes" | "no";
export type CallConfidence = 1 | 2 | 3;
export type ReactionType = "roar" | "cold" | "called_it";

export interface RoomTeam {
  readonly code: string;
  readonly foreground?: string;
  readonly name: string;
  readonly primary: string;
  readonly secondary: string;
}

export interface RoomFixture {
  readonly awayTeam: RoomTeam;
  readonly homeTeam: RoomTeam;
  readonly id: string;
  readonly isReplay: boolean;
  readonly kickoffAt: string;
}

export interface RoomMember {
  readonly callsLocked: boolean;
  readonly id: string;
  readonly muted: boolean;
  readonly nickname: string;
  readonly role: RoomMemberRole;
  readonly teamCode: string | null;
}

export interface CallThreeTarget {
  readonly question: string;
  readonly reliability: "reliable" | "unreliable" | "unknown";
  readonly sourceLabel: "MatchSense game rule";
  readonly stat: CallStat;
  readonly threshold: number;
  readonly version: number;
}

export interface CallThreePick {
  readonly answer: CallAnswer;
  readonly confidence: CallConfidence;
  readonly stat: CallStat;
}

export interface CallThreeEntry {
  readonly picks: readonly CallThreePick[];
  readonly points: number;
  readonly status: "open" | "locked" | "provisional" | "final";
  readonly submittedAt: string;
}

export interface CallThreePublic {
  readonly lockAt: string;
  readonly locked: boolean;
  readonly pointsOnly: true;
  readonly progress: Readonly<Record<CallStat, number | null>>;
  readonly targets: readonly CallThreeTarget[];
  readonly viewerEntry: CallThreeEntry | null;
}

export interface RoomLeaderboardRow {
  readonly correctCalls: number;
  readonly final: boolean;
  readonly memberId: string;
  readonly nickname: string;
  readonly points: number;
  readonly rank: number;
  readonly submittedAt: string;
}

export interface RoomReactionReceipt {
  readonly createdAt: string;
  readonly id: string;
  readonly momentId: string;
  readonly momentRevision: number;
  readonly recipient: Pick<RoomMember, "id" | "nickname">;
  readonly sender: Pick<RoomMember, "id" | "nickname">;
  readonly state: "held" | "delivered" | "overturned";
  readonly type: ReactionType;
}

export interface RoomMoment {
  readonly label: string;
  readonly minute: string;
  readonly momentId: string;
  readonly revision: number;
  readonly score: { readonly away: number; readonly home: number };
  readonly state: "confirmed" | "review" | "overturned";
}

export interface RoomView {
  readonly calls: CallThreePublic;
  readonly currentMoment: RoomMoment | null;
  readonly fixture: RoomFixture;
  readonly id: string;
  readonly inviteUrl: string | null;
  readonly leaderboard: readonly RoomLeaderboardRow[];
  readonly members: readonly RoomMember[];
  readonly name: string;
  readonly phase: RoomPhase;
  readonly reactions: readonly RoomReactionReceipt[];
  readonly viewerMemberId: string;
}

export interface RoomInvitePreview {
  readonly callsLocked: boolean;
  readonly expiresAt: string;
  readonly fixture: RoomFixture;
  readonly hostNickname: string;
  readonly memberNicknames: readonly string[];
  readonly roomName: string;
}

export interface CreateRoomInput {
  readonly fixtureId: string;
  readonly name: string;
  readonly nickname: string;
}

export interface JoinRoomInput {
  readonly inviteCode: string;
  readonly nickname: string;
  readonly teamCode: string | null;
}

export interface SaveCallsInput {
  readonly lock: boolean;
  readonly picks: readonly CallThreePick[];
  readonly targetVersions: Readonly<Record<CallStat, number>>;
}

export interface SendReactionInput {
  readonly momentId: string;
  readonly momentRevision: number;
  readonly recipientMemberId: string;
  readonly type: ReactionType;
}

export type RoomReplayStage =
  "kickoff" | "calls_resolved" | "under_review" | "confirmed" | "final";

export interface RoomReplayUpdate {
  readonly room: RoomView;
  readonly stage: RoomReplayStage;
}

export interface RoomApi {
  createRoom(
    input: CreateRoomInput,
  ): Promise<{ readonly inviteUrl: string; readonly room: RoomView }>;
  getRoom(roomId: string): Promise<RoomView>;
  joinRoom(
    input: JoinRoomInput,
  ): Promise<{ readonly lateJoin: boolean; readonly room: RoomView }>;
  playReplay(
    roomId: string,
    onUpdate?: (update: RoomReplayUpdate) => void,
  ): Promise<RoomView>;
  previewInvite(inviteCode: string): Promise<RoomInvitePreview>;
  saveCalls(roomId: string, input: SaveCallsInput): Promise<RoomView>;
  sendReaction(
    roomId: string,
    input: SendReactionInput,
  ): Promise<{ readonly receiptId: string; readonly room: RoomView }>;
  subscribeRoom(
    roomId: string,
    viewerMemberId: string,
    onRoom: (room: RoomView) => void,
    onError: (error: Error) => void,
  ): () => void;
}

export type RoomExperienceRoute =
  | {
      readonly defaultNickname?: string;
      readonly defaultRoomName?: string;
      readonly fixture: RoomFixture;
      readonly mode: "create";
    }
  | {
      readonly defaultNickname?: string;
      readonly inviteCode: string;
      readonly mode: "invite";
      readonly preview?: RoomInvitePreview;
      readonly teamCode?: string | null;
    }
  | {
      readonly initialRoom?: RoomView;
      readonly mode: "room";
      readonly roomId: string;
    };
