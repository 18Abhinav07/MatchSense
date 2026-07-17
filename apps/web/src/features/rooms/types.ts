export type RoomMemberRole = "host" | "member" | "spectator";
export type ReactionType = "roar" | "cold" | "called_it";
export type SenseRoomPhase = "DRAFT" | "OPEN" | "LOCKED" | "LIVE" | "FINAL";
export type SenseMarketId =
  "winner" | "goals_2_5" | "cards_4_5" | "corners_9_5" | "btts";
export type SenseSelection =
  "HOME" | "DRAW" | "AWAY" | "OVER" | "UNDER" | "YES" | "NO";

export interface RoomTeam {
  readonly code: string;
  readonly flagUrl?: string;
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
  readonly hasPicks: boolean;
  readonly id: string;
  readonly nickname: string;
  readonly role: RoomMemberRole;
  readonly teamCode: string | null;
}

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

export interface SensePick {
  readonly allocation: number;
  readonly marketId: SenseMarketId;
  readonly selection: SenseSelection;
}

export interface SenseSlate {
  readonly lockedAt: string;
  readonly participantId: string;
  readonly picks: readonly SensePick[];
}

export interface SenseLeaderboardRow {
  readonly correctCount: number;
  readonly memberId: string;
  readonly nickname: string;
  readonly rank: number;
  readonly returnedSense: number;
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
  readonly currentMoment: RoomMoment | null;
  readonly fixture: RoomFixture;
  readonly id: string;
  readonly inviteUrl: string | null;
  readonly isHost: boolean;
  readonly members: readonly RoomMember[];
  readonly name: string;
  readonly reactions: readonly RoomReactionReceipt[];
  readonly sense: {
    readonly currencyLabel: "FRIEND SENSE · NO MONEY · NO PRIZES";
    readonly leaderboard: readonly SenseLeaderboardRow[];
    readonly markets: readonly SenseMarket[];
    readonly mySlate: SenseSlate | null;
    readonly phase: SenseRoomPhase;
    readonly revealedSlates: readonly SenseSlate[];
    readonly total: 100;
  };
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

export interface SendReactionInput {
  readonly momentId: string;
  readonly momentRevision: number;
  readonly recipientMemberId: string;
  readonly type: ReactionType;
}

export interface RoomApi {
  createRoom(
    input: CreateRoomInput,
  ): Promise<{ readonly inviteUrl: string; readonly room: RoomView }>;
  getRoom(roomId: string): Promise<RoomView>;
  joinRoom(
    input: JoinRoomInput,
  ): Promise<{ readonly lateJoin: boolean; readonly room: RoomView }>;
  openPicks(roomId: string): Promise<RoomView>;
  previewInvite(inviteCode: string): Promise<RoomInvitePreview>;
  savePicks(roomId: string, picks: readonly SensePick[]): Promise<RoomView>;
  sendReaction(
    roomId: string,
    input: SendReactionInput,
  ): Promise<{ readonly receiptId: string; readonly room: RoomView }>;
  startExperience(roomId: string): Promise<RoomView>;
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
