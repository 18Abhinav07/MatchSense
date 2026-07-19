import type { ListeningApi, ListeningSessionInput } from "./listening-api.js";

export type StreamListeningState =
  "blocked" | "connecting" | "listening" | "paused" | "stopped";

export interface ListeningMoment {
  familyId: string;
  fixtureId: string;
  revision: number;
  text?: string | null;
}

export interface StreamListeningSnapshot {
  commentaryPending: boolean;
  error: string | null;
  lastCueText: string | null;
  prepared: boolean;
  state: StreamListeningState;
}

type AudioEvent = "ended" | "error" | "pause" | "playing" | "waiting";

export interface StreamAudioElement {
  addEventListener(event: AudioEvent, listener: () => void): void;
  getAttribute(name: string): string | null;
  load(): void;
  pause(): void;
  play(): Promise<void>;
  removeAttribute(name: string): void;
  removeEventListener(event: AudioEvent, listener: () => void): void;
  setAttribute(name: string, value: string): void;
}

export interface StreamListeningController {
  announce(moment: ListeningMoment): void;
  pause(): void;
  prepare(input: ListeningSessionInput): Promise<void>;
  resumeFromGesture(): Promise<void>;
  snapshot(): StreamListeningSnapshot;
  startFromGesture(): Promise<void>;
  stop(): Promise<void>;
  subscribe(listener: (snapshot: StreamListeningSnapshot) => void): () => void;
}

export function createStreamListeningController(dependencies: {
  api: ListeningApi;
  audio: StreamAudioElement;
  clearSchedule?: (timer: ReturnType<typeof setTimeout>) => void;
  schedule?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
}): StreamListeningController {
  const schedule = dependencies.schedule ?? setTimeout;
  const clearSchedule = dependencies.clearSchedule ?? clearTimeout;
  const listeners = new Set<(snapshot: StreamListeningSnapshot) => void>();
  let error: string | null = null;
  let inputKey: string | null = null;
  let lastCueText: string | null = null;
  let prepared = false;
  let sessionId: string | null = null;
  let state: StreamListeningState = "stopped";
  let preparation = 0;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let wantsPlayback = false;

  const snapshot = (): StreamListeningSnapshot => ({
    commentaryPending: state === "connecting",
    error,
    lastCueText,
    prepared,
    state,
  });
  const notify = () => {
    const next = snapshot();
    for (const listener of listeners) listener(next);
  };
  const setState = (
    next: StreamListeningState,
    nextError: string | null = null,
  ) => {
    state = next;
    error = nextError;
    notify();
  };

  const cancelReconnect = () => {
    if (reconnectTimer !== null) clearSchedule(reconnectTimer);
    reconnectTimer = null;
  };
  const onPlaying = () => {
    cancelReconnect();
    reconnectAttempt = 0;
    setState("listening");
  };
  const onPause = () => {
    if (state === "connecting" && wantsPlayback) return;
    if (state !== "stopped" && state !== "blocked") setState("paused");
  };
  const reconnect = () => {
    if (!wantsPlayback || reconnectTimer !== null) return;
    setState("connecting");
    const delayMs = Math.min(1_500 * 2 ** reconnectAttempt, 10_000);
    reconnectAttempt += 1;
    reconnectTimer = schedule(() => {
      reconnectTimer = null;
      if (!wantsPlayback) return;
      void play(true, true);
    }, delayMs);
  };
  const onError = () => {
    if (state === "stopped") return;
    if (wantsPlayback) reconnect();
    else
      setState("blocked", "The listening stream was interrupted. Tap resume.");
  };
  const onWaiting = () => {
    // iOS emits `waiting` while a live MP3 first buffers. Reloading here
    // aborts the gesture-owned play() and prevents Now Playing from attaching.
    if (wantsPlayback && state === "listening") setState("connecting");
  };

  dependencies.audio.addEventListener("playing", onPlaying);
  dependencies.audio.addEventListener("pause", onPause);
  dependencies.audio.addEventListener("error", onError);
  dependencies.audio.addEventListener("ended", reconnect);
  dependencies.audio.addEventListener("waiting", onWaiting);

  const play = async (reload: boolean, automatic = false) => {
    if (!prepared || !sessionId || !dependencies.audio.getAttribute("src")) {
      setState("blocked", "Listening is not ready for this match yet.");
      return;
    }
    setState("connecting");
    if (reload) dependencies.audio.load();
    try {
      await dependencies.audio.play();
    } catch (reason) {
      if (automatic && wantsPlayback) {
        reconnect();
        return;
      }
      wantsPlayback = false;
      setState(
        "blocked",
        reason instanceof Error
          ? reason.message
          : "This device blocked audio playback.",
      );
    }
  };

  return {
    announce(moment) {
      lastCueText =
        moment.text?.trim() || "A confirmed MatchSense update just arrived.";
      notify();
    },

    pause() {
      if (state === "stopped") return;
      wantsPlayback = false;
      cancelReconnect();
      dependencies.audio.pause();
      setState("paused");
    },

    async prepare(input) {
      const nextKey = `${input.fixtureId}:${input.perspectiveTeam}`;
      if (prepared && inputKey === nextKey) return;
      const token = ++preparation;
      const previousSession = sessionId;
      sessionId = null;
      prepared = false;
      inputKey = nextKey;
      if (previousSession) {
        await dependencies.api.remove(previousSession).catch(() => undefined);
      }
      try {
        const session = await dependencies.api.create(input);
        if (token !== preparation) {
          await dependencies.api.remove(session.id).catch(() => undefined);
          return;
        }
        sessionId = session.id;
        const url = dependencies.api.streamUrl(session.id);
        if (dependencies.audio.getAttribute("src") !== url) {
          dependencies.audio.setAttribute("src", url);
        }
        prepared = true;
        error = null;
        if (state === "blocked") state = "stopped";
        notify();
      } catch (reason) {
        if (token !== preparation) return;
        setState(
          "blocked",
          reason instanceof Error
            ? reason.message
            : "Listening could not be prepared.",
        );
      }
    },

    resumeFromGesture() {
      wantsPlayback = true;
      return play(true);
    },

    snapshot,

    startFromGesture() {
      // The stream source is already prepared. Playing that persistent media
      // element directly preserves iOS' user activation and lets Now Playing
      // attach before any reconnect logic is allowed to reload the source.
      wantsPlayback = true;
      return play(false);
    },

    async stop() {
      wantsPlayback = false;
      cancelReconnect();
      reconnectAttempt = 0;
      ++preparation;
      const released = sessionId;
      sessionId = null;
      inputKey = null;
      prepared = false;
      lastCueText = null;
      dependencies.audio.pause();
      dependencies.audio.removeAttribute("src");
      dependencies.audio.load();
      setState("stopped");
      if (released)
        await dependencies.api.remove(released).catch(() => undefined);
    },

    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    },
  };
}
