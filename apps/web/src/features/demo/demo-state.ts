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

export interface DemoProgress {
  current: number;
  durationSeconds: number;
  elapsedSeconds: number;
  percent: number;
  total: number;
}

export interface DemoBeatEvent {
  atSeconds: number;
  cursor: number;
  description: string;
  id: string;
  matchMinute: string;
  progress: DemoProgress;
  score: { away: number; home: number };
  sessionId: string;
  simulation: true;
  sourceLabel: string;
  team: "ARG" | "FRA" | null;
  type: DemoBeatType;
}

export interface DemoViewState {
  currentEvent: DemoBeatEvent | null;
  cursor: number;
  error: string | null;
  minute: string;
  phase: string;
  progress: DemoProgress;
  score: { away: number; home: number };
  status: "idle" | "starting" | "running" | "complete" | "error";
  timeline: DemoBeatEvent[];
}

export type DemoViewAction =
  | { type: "starting" }
  | { type: "beat"; event: DemoBeatEvent }
  | { type: "reset" }
  | { type: "error"; message: string };

const BEAT_TYPES = new Set<DemoBeatType>([
  "kickoff",
  "shot",
  "corner",
  "yellow_card",
  "goal",
  "var_started",
  "var_resolved",
  "red_card",
  "penalty_scored",
  "goal_overturned",
  "reconnect_catchup",
  "winning_goal",
  "full_time",
]);

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function parseDemoBeatEvent(input: string): DemoBeatEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(input) as unknown;
  } catch {
    return null;
  }
  const item = object(value);
  const score = object(item?.score);
  const progress = object(item?.progress);
  if (
    !item ||
    item.simulation !== true ||
    !nonEmpty(item.id) ||
    !nonEmpty(item.sessionId) ||
    !nonEmpty(item.sourceLabel) ||
    !nonEmpty(item.description) ||
    !nonEmpty(item.matchMinute) ||
    !nonEmpty(item.type) ||
    !BEAT_TYPES.has(item.type as DemoBeatType) ||
    !finite(item.atSeconds) ||
    !finite(item.cursor) ||
    !score ||
    !finite(score.home) ||
    !finite(score.away) ||
    !progress ||
    !finite(progress.current) ||
    !finite(progress.durationSeconds) ||
    !finite(progress.elapsedSeconds) ||
    !finite(progress.percent) ||
    !finite(progress.total) ||
    !(item.team === null || item.team === "ARG" || item.team === "FRA")
  ) {
    return null;
  }
  return {
    atSeconds: item.atSeconds,
    cursor: item.cursor,
    description: item.description,
    id: item.id,
    matchMinute: item.matchMinute,
    progress: {
      current: progress.current,
      durationSeconds: progress.durationSeconds,
      elapsedSeconds: progress.elapsedSeconds,
      percent: progress.percent,
      total: progress.total,
    },
    score: { away: score.away, home: score.home },
    sessionId: item.sessionId,
    simulation: true,
    sourceLabel: item.sourceLabel,
    team: item.team,
    type: item.type as DemoBeatType,
  };
}

export function createDemoViewState(): DemoViewState {
  return {
    currentEvent: null,
    cursor: 0,
    error: null,
    minute: "—",
    phase: "Ready for kickoff",
    progress: {
      current: 0,
      durationSeconds: 300,
      elapsedSeconds: 0,
      percent: 0,
      total: 16,
    },
    score: { away: 0, home: 0 },
    status: "idle",
    timeline: [],
  };
}

function phaseFor(type: DemoBeatType) {
  if (type === "kickoff") return "First half";
  if (type === "var_started") return "VAR review";
  if (type === "var_resolved") return "Goal confirmed";
  if (type === "goal_overturned") return "VAR overturned";
  if (type === "reconnect_catchup") return "Back live";
  if (type === "full_time") return "Full time";
  return "Live";
}

export function demoViewReducer(
  state: DemoViewState,
  action: DemoViewAction,
): DemoViewState {
  if (action.type === "starting") {
    return { ...state, error: null, status: "starting" };
  }
  if (action.type === "reset") return createDemoViewState();
  if (action.type === "error") {
    return { ...state, error: action.message, status: "error" };
  }
  if (action.event.cursor <= state.cursor) return state;
  return {
    ...state,
    currentEvent: action.event,
    cursor: action.event.cursor,
    error: null,
    minute: action.event.matchMinute,
    phase: phaseFor(action.event.type),
    progress: action.event.progress,
    score: action.event.score,
    status: action.event.type === "full_time" ? "complete" : "running",
    timeline: [action.event, ...state.timeline],
  };
}

export function demoEventPresentation(type: DemoBeatType): {
  eyebrow: string;
  title: string;
  tone: "neutral" | "positive" | "warning" | "danger" | "review";
} {
  switch (type) {
    case "kickoff":
      return { eyebrow: "The final", title: "Kickoff", tone: "neutral" };
    case "shot":
      return { eyebrow: "Attack", title: "Shot on target", tone: "neutral" };
    case "corner":
      return { eyebrow: "Pressure", title: "Corner", tone: "neutral" };
    case "yellow_card":
      return { eyebrow: "Discipline", title: "Yellow card", tone: "warning" };
    case "goal":
      return { eyebrow: "Celebration held", title: "Goal", tone: "review" };
    case "var_started":
      return {
        eyebrow: "Truth before drama",
        title: "Under review",
        tone: "review",
      };
    case "var_resolved":
      return {
        eyebrow: "VAR decision",
        title: "Goal stands",
        tone: "positive",
      };
    case "red_card":
      return { eyebrow: "Match changed", title: "Red card", tone: "danger" };
    case "penalty_scored":
      return {
        eyebrow: "From the spot",
        title: "Penalty scored",
        tone: "positive",
      };
    case "goal_overturned":
      return { eyebrow: "VAR decision", title: "No goal", tone: "danger" };
    case "reconnect_catchup":
      return {
        eyebrow: "Connection restored",
        title: "Caught you up",
        tone: "neutral",
      };
    case "winning_goal":
      return {
        eyebrow: "Late drama",
        title: "Goal — the winner",
        tone: "positive",
      };
    case "full_time":
      return {
        eyebrow: "Final whistle",
        title: "Argentina win",
        tone: "positive",
      };
  }
}
