export const TEAM_CODES = ["ARG", "BRA", "FRA", "JPN"] as const;
export const SIMULATION_SOURCE_LABEL =
  "SIMULATION · TXLINE-SHAPED DATA" as const;

export type TeamCode = (typeof TEAM_CODES)[number];

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
  provenance: "synthetic_txline_shaped";
  score: Score;
  minute: string;
}

export type SourceFact = ScoreSnapshotFact;

export interface CanonicalMoment {
  id: string;
  identity: string;
  fixtureId: string;
  kind: "goal";
  minute: string;
  revision: number;
  score: Score;
  sourceEnvelopeId: string;
  status: "confirmed";
  provenance: "synthetic_txline_shaped";
}

export interface FixtureSnapshot {
  fixtureId: string;
  homeTeam: TeamCode;
  awayTeam: TeamCode;
  kickoffAt: string;
  minute: string;
  phase: "scheduled" | "first_half";
  score: Score;
  provenance: "synthetic_txline_shaped";
  sourceLabel: typeof SIMULATION_SOURCE_LABEL;
  lastEvent: CanonicalMoment | null;
  revision: number;
  updatedAt: string;
}

export interface FixtureProjection extends FixtureSnapshot {
  appliedSourceEnvelopeIds: readonly string[];
}

export interface FixtureStreamEvent {
  event: "snapshot" | "moment.created" | "moment.revised" | "heartbeat";
  id: string;
  moment?: CanonicalMoment;
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
