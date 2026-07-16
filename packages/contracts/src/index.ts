export const TEAM_CODES = ["ARG", "BRA", "ESP", "FRA", "JPN"] as const;
export const SIMULATION_SOURCE_LABEL =
  "SIMULATION · TXLINE-SHAPED DATA" as const;
export const TXLINE_DEVNET_SOURCE_LABEL = "TXLINE · DEVNET SOURCE" as const;

export type TeamCode = (typeof TEAM_CODES)[number];
export type DataProvenance = "synthetic_txline_shaped" | "live_txline";

export interface TeamSummary {
  code: TeamCode;
  name: string;
  colors: { primary: string; secondary: string };
}

export interface Score {
  home: number;
  away: number;
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

export type SourceFact = ScoreSnapshotFact;

export interface CanonicalMoment {
  eventTeam: TeamCode;
  id: string;
  identity: string;
  fixtureId: string;
  kind: "goal";
  minute: string;
  revision: number;
  score: Score;
  sourceEnvelopeId: string;
  status: "confirmed";
  provenance: DataProvenance;
}

export interface FixtureSnapshot {
  fixtureId: string;
  homeTeam: TeamCode;
  awayTeam: TeamCode;
  kickoffAt: string;
  minute: string;
  phase: "scheduled" | "first_half";
  score: Score;
  provenance: DataProvenance;
  sourceLabel:
    typeof SIMULATION_SOURCE_LABEL | typeof TXLINE_DEVNET_SOURCE_LABEL;
  lastEvent: CanonicalMoment | null;
  revision: number;
  updatedAt: string;
}

export interface FixtureProjection extends FixtureSnapshot {
  appliedSourceEnvelopeIds: readonly string[];
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
