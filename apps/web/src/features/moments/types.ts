export interface MomentTeam {
  code: string;
  flagUrl?: string;
  name: string;
  primary: string;
  secondary: string;
  foreground?: string;
}

export interface MomentScore {
  home: number;
  away: number;
  homeTeam: MomentTeam;
  awayTeam: MomentTeam;
}

export interface MomentTruth {
  eventId: string;
  minute: string;
  revision: number;
  sourceLabel?: string;
}

export interface ConfirmedGoalMomentProps {
  scoringTeam: MomentTeam;
  score: MomentScore;
  truth: MomentTruth;
  relation?: "for" | "against" | "neutral";
  playerName?: string;
  assistName?: string;
  headline?: string;
  consequence?: string;
  commentary?: string;
  sponsor?: string;
  onClose(): void;
  closeLabel?: string;
}

export interface VarReviewMomentProps {
  attackingTeam: MomentTeam;
  score: MomentScore;
  truth: MomentTruth;
  subject?: string;
  detail?: string;
  onReturn?: () => void;
}

export interface VarDecisionMomentProps {
  team: MomentTeam;
  score: MomentScore;
  truth: MomentTruth;
  subject?: string;
  headline?: string;
  detail?: string;
  onContinue(): void;
}

export interface VarOverturnedMomentProps extends VarDecisionMomentProps {
  supersededScore?: Pick<MomentScore, "home" | "away">;
  reason?: string;
}

export type CatchUpEventKind =
  | "goal"
  | "yellow_card"
  | "red_card"
  | "var"
  | "half_time"
  | "full_time"
  | "other";

export interface CatchUpEvent {
  id: string;
  sequence: number;
  minute: string;
  kind: CatchUpEventKind;
  title: string;
  detail?: string;
  team?: MomentTeam;
  revision: number;
  overturned?: boolean;
}

export interface ReconnectCatchUpProps {
  events: readonly CatchUpEvent[];
  sourceLabel: string;
  caughtUpAt: string;
  onContinue(): void;
}

export interface FreshnessBannerProps {
  status: "stale" | "offline";
  asOf: string;
  age: string;
  message?: string;
  onRetry?: () => void;
}

export interface MatchMemoryMoment {
  id: string;
  minute: string;
  title: string;
  detail?: string;
  team?: MomentTeam;
  kind: CatchUpEventKind;
}

export interface MatchMemoryRoomResult {
  roomName: string;
  position: number;
  points: number;
  players: number;
}

export interface MatchMemoryStat {
  label: string;
  home: string | number;
  away: string | number;
}

export interface MatchMemoryProps {
  supportedTeam: MomentTeam;
  score: MomentScore;
  truth: MomentTruth;
  summary: string;
  moments: readonly MatchMemoryMoment[];
  roomResult?: MatchMemoryRoomResult;
  stats?: readonly MatchMemoryStat[];
  onShare(): void;
  onReplay(): void;
}
