export const TEAM_CODES = ["ARG", "BRA", "ENG", "ESP", "FRA", "JPN"] as const;
export const SIMULATION_SOURCE_LABEL =
  "SIMULATION · TXLINE-SHAPED DATA" as const;
export const TXLINE_DEVNET_SOURCE_LABEL = "TXLINE · DEVNET SOURCE" as const;
export const TEAM_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,19}$/;

export type KnownTeamCode = (typeof TEAM_CODES)[number];
export type TeamCode = string;
export type DataProvenance = "synthetic_txline_shaped" | "live_txline";

export interface TeamSummary {
  code: TeamCode;
  name: string;
  colors: { primary: string; secondary: string };
  participantId?: string | undefined;
}

export interface Score {
  home: number;
  away: number;
}

export type CanonicalEventKind =
  | "phase.kickoff"
  | "goal"
  | "card.yellow"
  | "card.red"
  | "corner"
  | "penalty.awarded"
  | "penalty.scored"
  | "penalty.missed"
  | "var.started"
  | "var.stands"
  | "var.overturned"
  | "phase.half_time"
  | "phase.second_half_start"
  | "phase.regulation_end"
  | "phase.extra_time_start"
  | "phase.extra_time_half"
  | "phase.extra_time_second_half_start"
  | "phase.shootout_start"
  | "shootout.kick_scored"
  | "shootout.kick_missed"
  | "phase.full_time"
  | "correction";

export type MatchPhase =
  | "scheduled"
  | "first_half"
  | "half_time"
  | "second_half"
  | "regulation_end"
  | "extra_time_first_half"
  | "extra_time_half"
  | "extra_time_second_half"
  | "shootout"
  | "full_time";

export type MatchDecision = "regulation" | "extra_time" | "shootout";

export interface MatchScores {
  regulation: Score;
  extraTime: Score;
  shootout: Score;
}

export interface TeamMatchStats {
  yellowCards: number;
  redCards: number;
  corners: number;
  penaltiesAwarded: number;
  penaltiesScored: number;
  penaltiesMissed: number;
}

export interface FixtureStats {
  home: TeamMatchStats;
  away: TeamMatchStats;
}

export interface CanonicalPlayerIdentity {
  id: string;
  displayName: string | null;
}

export type CanonicalEventStatus =
  "provisional" | "confirmed" | "under_review" | "overturned" | "corrected";

export type CanonicalFactStatus = "provisional" | "under_review" | "confirmed";

export interface CanonicalEventReplacement {
  kind:
    | "goal"
    | "card.yellow"
    | "card.red"
    | "corner"
    | "penalty.awarded"
    | "penalty.scored"
    | "penalty.missed";
  team: TeamCode;
  player?: CanonicalPlayerIdentity | null | undefined;
}

export interface SyntheticScoreSnapshot {
  type: "score_snapshot";
  homeGoals: number;
  awayGoals: number;
  minute: string;
}

export interface SyntheticSourceEnvelope {
  id: string;
  source: "replay";
  provenance: "synthetic_txline_shaped";
  fixtureId: string;
  receivedAt: string;
  supportedFact: SyntheticScoreSnapshot;
}

export interface ScoreSnapshotFact {
  type: "score_snapshot";
  sourceEnvelopeId: string;
  fixtureId: string;
  receivedAt: string;
  provenance: DataProvenance;
  score: Score;
  minute: string;
}

export interface CanonicalEventFact {
  type: "canonical_event";
  familyId: string;
  sourceEnvelopeId: string;
  sourceEventId: string;
  fixtureId: string;
  receivedAt: string;
  occurredAt: string | null;
  provenance: DataProvenance;
  kind: CanonicalEventKind;
  minute: string;
  team: TeamCode | null;
  player: CanonicalPlayerIdentity | null;
  status: CanonicalFactStatus;
  targetFamilyId?: string | null | undefined;
  replacement?: CanonicalEventReplacement | null | undefined;
  scores?: MatchScores | undefined;
  stats?: FixtureStats | undefined;
}

export type SourceFact = ScoreSnapshotFact | CanonicalEventFact;

export interface CanonicalEventEffect {
  active: boolean;
  pending: boolean;
  kind: CanonicalEventKind;
  occurredPhase: MatchPhase;
  scoreSegment: keyof MatchScores | null;
  team: TeamCode | null;
  player: CanonicalPlayerIdentity | null;
  scores: MatchScores;
  stats: FixtureStats;
}

export interface CanonicalMoment {
  /** True only when this exact canonical revision may open the goal celebration. */
  celebratesGoal: boolean;
  eventTeam: TeamCode | null;
  familyId: string;
  id: string;
  identity: string;
  fixtureId: string;
  kind: CanonicalEventKind;
  minute: string;
  revision: number;
  score: Score;
  scores?: MatchScores | undefined;
  stats?: FixtureStats | undefined;
  team?: TeamCode | null | undefined;
  player?: CanonicalPlayerIdentity | null | undefined;
  occurredAt: string | null;
  receivedAt?: string | undefined;
  sourceEventId?: string | undefined;
  targetFamilyId?: string | null | undefined;
  sourceEnvelopeId: string;
  status: CanonicalEventStatus;
  provenance: DataProvenance;
}

export interface FixtureSnapshot {
  fixtureId: string;
  homeTeam: TeamCode;
  awayTeam: TeamCode;
  kickoffAt: string;
  minute: string;
  phase: MatchPhase;
  score: Score;
  /** Canonical split truth. Optional only while legacy fixtures migrate. */
  scores?: MatchScores | undefined;
  stats?: FixtureStats | undefined;
  decidedBy?: MatchDecision | null | undefined;
  provenance: DataProvenance;
  sourceLabel:
    typeof SIMULATION_SOURCE_LABEL | typeof TXLINE_DEVNET_SOURCE_LABEL;
  lastEvent: CanonicalMoment | null;
  revision: number;
  updatedAt: string;
}

export interface FixtureProjection extends FixtureSnapshot {
  appliedSourceEnvelopeIds: readonly string[];
  eventEffects: Readonly<Record<string, CanonicalEventEffect>>;
}

export interface CommentaryReady {
  generatedAt: string;
  language: "en";
  momentIdentity: string;
  provider: "gemini" | "deterministic";
  text: string;
  usedFallback: boolean;
}

export interface FixtureCatchup {
  fromEventId: string;
  moments: CanonicalMoment[];
}

export interface FixtureStreamEvent {
  event:
    | "snapshot"
    | "moment.created"
    | "moment.revised"
    | "commentary.ready"
    | "catchup.ready"
    | "heartbeat";
  id: string;
  moment?: CanonicalMoment;
  commentary?: CommentaryReady;
  catchup?: FixtureCatchup;
  snapshot: FixtureSnapshot;
}

export interface ReplayCommand {
  type: "advance_to_marker";
  marker: "goal";
  listeningSessionId?: string | null | undefined;
}

export type ListeningControllerState =
  | "prepared"
  | "connecting"
  | "listening"
  | "speaking"
  | "buffering"
  | "reconnecting"
  | "paused"
  | "blocked"
  | "stopped"
  | "ended";
