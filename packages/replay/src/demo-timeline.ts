export const DEMO_DURATION_SECONDS = 300;

export type DemoBeatType =
  | "kickoff"
  | "shot"
  | "corner"
  | "yellow_card"
  | "goal"
  | "var_started"
  | "var_resolved"
  | "red_card"
  | "penalty_scored"
  | "goal_overturned"
  | "reconnect_catchup"
  | "winning_goal"
  | "full_time";

export interface DemoBeat {
  readonly atSeconds: number;
  readonly description: string;
  readonly id: string;
  readonly matchMinute: string;
  readonly score: { readonly away: number; readonly home: number };
  readonly team: "ARG" | "FRA" | null;
  readonly type: DemoBeatType;
}

export const DEMO_TIMELINE: readonly DemoBeat[] = [
  {
    atSeconds: 0,
    description: "The final is under way.",
    id: "arg-fra-demo:kickoff",
    matchMinute: "1'",
    score: { away: 0, home: 0 },
    team: null,
    type: "kickoff",
  },
  {
    atSeconds: 16,
    description: "Argentina drive the first shot on target.",
    id: "arg-fra-demo:shot:1",
    matchMinute: "8'",
    score: { away: 0, home: 0 },
    team: "ARG",
    type: "shot",
  },
  {
    atSeconds: 30,
    description: "France force the first corner.",
    id: "arg-fra-demo:corner:1",
    matchMinute: "13'",
    score: { away: 0, home: 0 },
    team: "FRA",
    type: "corner",
  },
  {
    atSeconds: 48,
    description: "A late France challenge brings the first yellow card.",
    id: "arg-fra-demo:yellow:1",
    matchMinute: "19'",
    score: { away: 0, home: 0 },
    team: "FRA",
    type: "yellow_card",
  },
  {
    atSeconds: 68,
    description: "Argentina score and the Moment is held for review.",
    id: "arg-fra-demo:goal:1",
    matchMinute: "23'",
    score: { away: 0, home: 1 },
    team: "ARG",
    type: "goal",
  },
  {
    atSeconds: 76,
    description: "VAR is checking the Argentina goal.",
    id: "arg-fra-demo:var:1:start",
    matchMinute: "23'",
    score: { away: 0, home: 1 },
    team: "ARG",
    type: "var_started",
  },
  {
    atSeconds: 88,
    description: "The goal stands. Celebration released.",
    id: "arg-fra-demo:var:1:stands",
    matchMinute: "23'",
    score: { away: 0, home: 1 },
    team: "ARG",
    type: "var_resolved",
  },
  {
    atSeconds: 112,
    description: "France are reduced to ten.",
    id: "arg-fra-demo:red:1",
    matchMinute: "36'",
    score: { away: 0, home: 1 },
    team: "FRA",
    type: "red_card",
  },
  {
    atSeconds: 140,
    description: "France score from the penalty spot.",
    id: "arg-fra-demo:penalty:1",
    matchMinute: "51'",
    score: { away: 1, home: 1 },
    team: "FRA",
    type: "penalty_scored",
  },
  {
    atSeconds: 166,
    description: "France appear to complete the comeback.",
    id: "arg-fra-demo:goal:2",
    matchMinute: "63'",
    score: { away: 2, home: 1 },
    team: "FRA",
    type: "goal",
  },
  {
    atSeconds: 174,
    description: "The second France goal is under review.",
    id: "arg-fra-demo:var:2:start",
    matchMinute: "63'",
    score: { away: 2, home: 1 },
    team: "FRA",
    type: "var_started",
  },
  {
    atSeconds: 190,
    description: "No goal. VAR overturns it and restores the draw.",
    id: "arg-fra-demo:goal:2:overturned",
    matchMinute: "64'",
    score: { away: 1, home: 1 },
    team: "FRA",
    type: "goal_overturned",
  },
  {
    atSeconds: 216,
    description: "Caught you up: a substitution and a France attack happened while reconnecting.",
    id: "arg-fra-demo:catchup:1",
    matchMinute: "72'",
    score: { away: 1, home: 1 },
    team: null,
    type: "reconnect_catchup",
  },
  {
    atSeconds: 232,
    description: "The match reaches its tenth corner.",
    id: "arg-fra-demo:corner:10",
    matchMinute: "77'",
    score: { away: 1, home: 1 },
    team: "ARG",
    type: "corner",
  },
  {
    atSeconds: 264,
    description: "Argentina find the winner late in the final.",
    id: "arg-fra-demo:goal:winner",
    matchMinute: "88'",
    score: { away: 1, home: 2 },
    team: "ARG",
    type: "winning_goal",
  },
  {
    atSeconds: DEMO_DURATION_SECONDS,
    description: "Full time. Argentina win 2–1.",
    id: "arg-fra-demo:full-time",
    matchMinute: "FT",
    score: { away: 1, home: 2 },
    team: null,
    type: "full_time",
  },
] as const;

export interface DemoPlayback {
  readonly complete: boolean;
  readonly cursor: number;
  readonly fixtureId: "arg-fra-demo";
  readonly id: string;
}

export function createDemoPlayback(id: string): DemoPlayback {
  const normalizedId = id.trim();
  if (normalizedId.length === 0) {
    throw new Error("Demo playback id is required");
  }
  return {
    complete: false,
    cursor: 0,
    fixtureId: "arg-fra-demo",
    id: normalizedId,
  };
}

export function nextDemoBeat(playback: DemoPlayback): {
  readonly beat: DemoBeat | null;
  readonly playback: DemoPlayback;
} {
  const beat = DEMO_TIMELINE[playback.cursor] ?? null;
  if (beat === null) return { beat, playback };
  const cursor = playback.cursor + 1;
  return {
    beat,
    playback: {
      ...playback,
      complete: cursor >= DEMO_TIMELINE.length,
      cursor,
    },
  };
}
