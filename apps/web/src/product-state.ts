export type TeamCode = "ARG" | "BRA" | "ESP" | "FRA" | "JPN";

export interface LiveSnapshot {
  fixtureId: string;
  kickoffAt?: string;
  homeTeam: TeamCode;
  awayTeam: TeamCode;
  minute: string;
  score: { home: number; away: number };
  phase?: string;
  provenance?: string;
  sourceLabel?: string;
  revision?: number;
  updatedAt?: string;
  lastEvent?: LiveMoment | null;
}

export interface LiveMoment {
  eventTeam: TeamCode;
  id: string;
  identity: string;
  kind: "goal";
  minute: string;
  revision: number;
  score: { home: number; away: number };
  status: "confirmed";
}

export interface CanonicalEventPayload {
  event: "moment.created" | "moment.revised";
  id: string;
  moment: LiveMoment;
  snapshot: LiveSnapshot;
}

export interface LiveCommentary {
  generatedAt: string;
  language: "en";
  momentIdentity: string;
  provider: "gemini" | "deterministic";
  text: string;
  usedFallback: boolean;
}

export interface CommentaryEventPayload {
  event: "commentary.ready";
  id: string;
  commentary: LiveCommentary;
  snapshot: LiveSnapshot;
}

export interface CatchupEventPayload {
  event: "catchup.ready";
  id: string;
  catchup: { fromEventId: string; moments: LiveMoment[] };
  snapshot: LiveSnapshot;
}

export interface LiveViewState {
  dataMode: "simulation" | "txline";
  snapshot: LiveSnapshot;
  currentRevision: number;
  timeline: LiveMoment[];
  pendingMoment: LiveMoment | null;
  openMoment: LiveMoment | null;
  transportHealth: "connecting" | "reconciled" | "stale" | "offline";
  lastEventId: string | null;
  commentaryByMoment: Record<string, LiveCommentary>;
  catchup: { fromEventId: string; moments: LiveMoment[] } | null;
}

export type LiveViewAction =
  | { type: "snapshot"; snapshot: LiveSnapshot }
  | { type: "canonical_event"; payload: CanonicalEventPayload }
  | { type: "commentary_ready"; payload: CommentaryEventPayload }
  | { type: "catchup_ready"; payload: CatchupEventPayload }
  | { type: "acknowledge_catchup" }
  | { type: "open_moment"; identity: string }
  | { type: "close_moment" }
  | {
      type: "transport";
      transportHealth: LiveViewState["transportHealth"];
    };

export function createInitialLiveState(): LiveViewState {
  return {
    dataMode: "simulation",
    currentRevision: 0,
    commentaryByMoment: {},
    catchup: null,
    lastEventId: null,
    openMoment: null,
    pendingMoment: null,
    snapshot: {
      awayTeam: "FRA",
      fixtureId: "arg-fra-demo",
      homeTeam: "ARG",
      minute: "—",
      provenance: "synthetic_txline_shaped",
      score: { away: 0, home: 0 },
      sourceLabel: "SIMULATION · TXLINE-SHAPED DATA",
    },
    timeline: [],
    transportHealth: "connecting",
  };
}

export function liveViewReducer(
  state: LiveViewState,
  action: LiveViewAction,
): LiveViewState {
  if (action.type === "snapshot") {
    const snapshotRevision = action.snapshot.revision ?? state.currentRevision;
    if (snapshotRevision < state.currentRevision) return state;
    return {
      ...state,
      currentRevision: snapshotRevision,
      dataMode:
        action.snapshot.provenance === "live_txline" ? "txline" : "simulation",
      snapshot: action.snapshot,
      transportHealth: "reconciled",
    };
  }
  if (action.type === "canonical_event") {
    if (state.lastEventId === action.payload.id) return state;
    const timeline = state.timeline.some(
      (moment) => moment.identity === action.payload.moment.identity,
    )
      ? state.timeline
      : [action.payload.moment, ...state.timeline];
    return {
      ...state,
      currentRevision: action.payload.moment.revision,
      dataMode:
        action.payload.snapshot.provenance === "live_txline"
          ? "txline"
          : "simulation",
      lastEventId: action.payload.id,
      openMoment: null,
      pendingMoment: action.payload.moment,
      snapshot: action.payload.snapshot,
      timeline,
      transportHealth: "reconciled",
    };
  }
  if (action.type === "commentary_ready") {
    return {
      ...state,
      commentaryByMoment: {
        ...state.commentaryByMoment,
        [action.payload.commentary.momentIdentity]: action.payload.commentary,
      },
      transportHealth: "reconciled",
    };
  }
  if (action.type === "catchup_ready") {
    const known = new Set(state.timeline.map((moment) => moment.identity));
    const missed = action.payload.catchup.moments.filter(
      (moment) => !known.has(moment.identity),
    );
    return {
      ...state,
      catchup: action.payload.catchup,
      currentRevision:
        action.payload.snapshot.revision ?? state.currentRevision,
      lastEventId: action.payload.id,
      snapshot: action.payload.snapshot,
      timeline: [...missed].reverse().concat(state.timeline),
      transportHealth: "reconciled",
    };
  }
  if (action.type === "acknowledge_catchup") {
    return { ...state, catchup: null };
  }
  if (action.type === "open_moment") {
    if (state.pendingMoment?.identity !== action.identity) return state;
    return {
      ...state,
      openMoment: state.pendingMoment,
      pendingMoment: null,
    };
  }
  if (action.type === "close_moment") {
    return { ...state, openMoment: null };
  }
  return { ...state, transportHealth: action.transportHealth };
}

export function formatFreshness(
  updatedAt: string | undefined,
  now: string,
): string {
  if (!updatedAt) return "UPDATE TIME UNKNOWN";
  const updatedMs = Date.parse(updatedAt);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(updatedMs) || !Number.isFinite(nowMs)) {
    return "UPDATE TIME UNKNOWN";
  }
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - updatedMs) / 1_000));
  if (elapsedSeconds < 2) return "UPDATED JUST NOW";
  if (elapsedSeconds < 60) return `UPDATED ${elapsedSeconds}s AGO`;
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `UPDATED ${elapsedMinutes}m AGO`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  return `UPDATED ${elapsedHours}h AGO`;
}

export function normalizePath(input: string) {
  const clean = input.split(/[?#]/u, 1)[0] || "/";
  return clean.length > 1 ? clean.replace(/\/+$/u, "") : clean;
}
