export type TeamCode = string;

export type FixtureLifecycle =
  | "SCHEDULED"
  | "TRACKING"
  | "LIVE"
  | "TERMINAL_FACT_COMMITTED"
  | "FINAL"
  | "FINAL_REVISED"
  | "RESULT_UNAVAILABLE";

export type FixtureFreshness = "live" | "cached" | "stale" | "offline";

export type FixtureArchiveStatus = "PENDING" | "REPLAY_READY" | "INVALID";

export interface LiveSnapshot {
  archiveStatus?: FixtureArchiveStatus | undefined;
  fixtureId: string;
  freshness?: FixtureFreshness | undefined;
  kickoffAt?: string | undefined;
  homeTeam: TeamCode;
  awayTeam: TeamCode;
  homeTeamName?: string | undefined;
  awayTeamName?: string | undefined;
  competition?: string | undefined;
  venue?: string | undefined;
  minute: string;
  score: { home: number; away: number };
  phase?: string | undefined;
  provenance?: string | undefined;
  sourceLabel?: string | undefined;
  revision?: number | undefined;
  updatedAt?: string | undefined;
  lastEvent?: LiveMoment | null | undefined;
  lifecycle?: FixtureLifecycle | undefined;
}

export interface LiveMoment {
  celebratesGoal: boolean;
  eventTeam: TeamCode;
  id: string;
  identity: string;
  kind: string;
  minute: string;
  revision: number;
  score: { home: number; away: number };
  status: string;
  title?: string | undefined;
  detail?: string | undefined;
  playerName?: string | undefined;
}

export interface CanonicalEventPayload {
  /** Reconciled events belong in history but must never replay as new cinema. */
  deliveryIntent?: "realtime" | "reconcile" | undefined;
  event: "moment.created" | "moment.revised";
  id: string;
  moment: LiveMoment;
  /** The durable stream sequence; a gap requires a server resync. */
  sequence?: number | undefined;
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
  dataMode: "unavailable" | "live" | "recorded";
  snapshot: LiveSnapshot | null;
  currentRevision: number;
  timeline: LiveMoment[];
  pendingMoment: LiveMoment | null;
  openMoment: LiveMoment | null;
  transportHealth: "connecting" | "reconciled" | "stale" | "offline";
  lastEventId: string | null;
  commentaryByMoment: Record<string, LiveCommentary>;
  catchup: { fromEventId: string; moments: LiveMoment[] } | null;
  /** True only when a durable sequence gap prevented safe local application. */
  resetRequired: boolean;
  lastAppliedSequence: number | null;
}

export type LiveViewAction =
  | { type: "snapshot"; snapshot: LiveSnapshot; sequence?: number | undefined }
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
    dataMode: "unavailable",
    currentRevision: 0,
    commentaryByMoment: {},
    catchup: null,
    lastEventId: null,
    openMoment: null,
    pendingMoment: null,
    snapshot: null,
    timeline: [],
    transportHealth: "connecting",
    resetRequired: false,
    lastAppliedSequence: null,
  };
}

function dataModeFor(snapshot: LiveSnapshot): LiveViewState["dataMode"] {
  if (snapshot.provenance === "live_txline") return "live";
  if (snapshot.provenance === "recorded_txline_authorised") return "recorded";
  return "unavailable";
}

function isContiguous(current: number | null, incoming: number | undefined) {
  return incoming === undefined || current === null || incoming === current + 1;
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
      dataMode: dataModeFor(action.snapshot),
      lastAppliedSequence: action.sequence ?? state.lastAppliedSequence,
      resetRequired: false,
      snapshot: action.snapshot,
      transportHealth: "reconciled",
    };
  }
  if (action.type === "canonical_event") {
    if (state.lastEventId === action.payload.id) return state;
    if (!isContiguous(state.lastAppliedSequence, action.payload.sequence)) {
      return {
        ...state,
        pendingMoment: null,
        resetRequired: true,
        transportHealth: "stale",
      };
    }
    const priorIndex = state.timeline.findIndex(
      (moment) =>
        moment.identity === action.payload.moment.identity ||
        moment.id === action.payload.moment.id,
    );
    const timeline =
      priorIndex < 0
        ? [action.payload.moment, ...state.timeline]
        : state.timeline.map((moment, index) =>
            index === priorIndex ? action.payload.moment : moment,
          );
    const canOpenMoment =
      action.payload.deliveryIntent === "realtime" &&
      action.payload.moment.status === "confirmed" &&
      action.payload.snapshot.freshness === "live";
    return {
      ...state,
      currentRevision: action.payload.moment.revision,
      dataMode: dataModeFor(action.payload.snapshot),
      lastAppliedSequence: action.payload.sequence ?? state.lastAppliedSequence,
      lastEventId: action.payload.id,
      openMoment: null,
      pendingMoment: canOpenMoment ? action.payload.moment : null,
      resetRequired: false,
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
      dataMode: dataModeFor(action.payload.snapshot),
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
