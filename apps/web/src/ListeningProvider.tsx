import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { TeamCode } from "./product-state.js";

export type ListeningState =
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

export type ListeningPreparationState =
  "idle" | "preparing" | "ready" | "failed";

interface PreparedListeningSession {
  awayTeam: TeamCode;
  fixtureId: string;
  homeTeam: TeamCode;
  id: string;
  perspectiveTeam: TeamCode;
  sourceLabel: string;
  streamUrl: string;
}

interface PreparedAudioElement {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  play(): Promise<void>;
}

interface ResumableAudioElement {
  getAttribute(name: string): string | null;
  load(): void;
  play(): Promise<void>;
}

export function beginPreparedPlayback(options: {
  audio: PreparedAudioElement;
  streamUrl: string;
  afterPlaybackStarts?: () => void | Promise<void>;
}): Promise<void> {
  if (options.audio.getAttribute("src") !== options.streamUrl) {
    options.audio.setAttribute("src", options.streamUrl);
  }
  const playback = options.audio.play();
  return playback.then(async () => {
    await options.afterPlaybackStarts?.();
  });
}

export function resumePreparedPlayback(
  audio: ResumableAudioElement,
): Promise<void> {
  if (!audio.getAttribute("src")) {
    return Promise.reject(new Error("Listening stream source is missing"));
  }
  audio.load();
  return audio.play();
}

export function decidePreparationRelease(input: {
  activeSessionId: string | null;
  preparedKey: string | null;
  preparedSessionId: string | null;
  releasedKey: string;
}) {
  const preservePrepared =
    input.preparedSessionId !== null &&
    input.preparedSessionId === input.activeSessionId;
  return {
    deleteSessionId: preservePrepared ? null : input.preparedSessionId,
    nextPreparationKey: preservePrepared ? input.preparedKey : null,
    preservePrepared,
  };
}

interface ListeningContextValue {
  state: ListeningState;
  sessionId: string | null;
  fixtureId: string | null;
  preparationState: ListeningPreparationState;
  preparedFixtureId: string | null;
  preparedPerspectiveTeam: TeamCode | null;
  prepare(fixtureId: string, perspectiveTeam: TeamCode): Promise<void>;
  releasePreparation(fixtureId: string, perspectiveTeam: TeamCode): void;
  start(): Promise<void>;
  pause(): void;
  resume(): Promise<void>;
  stop(): Promise<void>;
}

const ListeningContext = createContext<ListeningContextValue | null>(null);

export function ListeningProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [state, setState] = useState<ListeningState>("stopped");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [fixtureId, setFixtureId] = useState<string | null>(null);
  const [preparedSession, setPreparedSession] =
    useState<PreparedListeningSession | null>(null);
  const [preparationState, setPreparationState] =
    useState<ListeningPreparationState>("idle");
  const preparedRef = useRef<PreparedListeningSession | null>(null);
  const activeRef = useRef<PreparedListeningSession | null>(null);
  const preparationKeyRef = useRef<string | null>(null);
  const preparationRequest = useRef(0);
  const wantsPlayback = useRef(false);
  const reconnectTimer = useRef<number | null>(null);

  const deleteSession = useCallback(async (id: string) => {
    await fetch(`/api/v1/listening-sessions/${id}`, {
      keepalive: true,
      method: "DELETE",
    }).catch(() => undefined);
  }, []);

  const cancelReconnect = useCallback(() => {
    if (reconnectTimer.current !== null)
      window.clearTimeout(reconnectTimer.current);
    reconnectTimer.current = null;
  }, []);

  const resume = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio?.getAttribute("src")) return;
    wantsPlayback.current = true;
    cancelReconnect();
    setState("connecting");
    try {
      await resumePreparedPlayback(audio);
      setState("listening");
    } catch {
      setState("blocked");
    }
  }, [cancelReconnect]);

  const pause = useCallback(() => {
    wantsPlayback.current = false;
    cancelReconnect();
    audioRef.current?.pause();
    setState("paused");
  }, [cancelReconnect]);

  const stop = useCallback(async () => {
    wantsPlayback.current = false;
    cancelReconnect();
    preparationRequest.current += 1;
    const audio = audioRef.current;
    audio?.pause();
    if (audio?.hasAttribute("src")) {
      audio.removeAttribute("src");
      audio.load();
    }
    const sessions = new Set(
      [activeRef.current?.id, preparedRef.current?.id].filter(
        (id): id is string => Boolean(id),
      ),
    );
    activeRef.current = null;
    preparedRef.current = null;
    preparationKeyRef.current = null;
    setSessionId(null);
    setFixtureId(null);
    setPreparedSession(null);
    setPreparationState("idle");
    setState("stopped");
    await Promise.all([...sessions].map(deleteSession));
  }, [cancelReconnect, deleteSession]);

  const prepare = useCallback(
    async (nextFixtureId: string, perspectiveTeam: TeamCode) => {
      const key = `${nextFixtureId}:${perspectiveTeam}`;
      const existing = preparedRef.current;
      if (
        existing?.fixtureId === nextFixtureId &&
        existing.perspectiveTeam === perspectiveTeam
      ) {
        setPreparationState("ready");
        return;
      }

      const active = activeRef.current;
      if (
        active?.fixtureId === nextFixtureId &&
        active.perspectiveTeam === perspectiveTeam
      ) {
        preparedRef.current = active;
        preparationKeyRef.current = key;
        setPreparedSession(active);
        setPreparationState("ready");
        return;
      }

      const request = ++preparationRequest.current;
      preparationKeyRef.current = key;
      setPreparationState("preparing");
      try {
        const response = await fetch(
          `/api/v1/fixtures/${nextFixtureId}/listening-sessions`,
          {
            body: JSON.stringify({ perspectiveTeam }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          },
        );
        if (!response.ok) throw new Error("Listening preparation failed");
        const session = (await response.json()) as {
          awayTeam: TeamCode;
          homeTeam: TeamCode;
          id: string;
          sourceLabel: string;
        };
        const next: PreparedListeningSession = {
          awayTeam: session.awayTeam,
          fixtureId: nextFixtureId,
          homeTeam: session.homeTeam,
          id: session.id,
          perspectiveTeam,
          sourceLabel: session.sourceLabel,
          streamUrl: `/api/v1/listening-sessions/${session.id}/stream.mp3`,
        };
        if (
          request !== preparationRequest.current ||
          preparationKeyRef.current !== key
        ) {
          await deleteSession(next.id);
          return;
        }
        const previous = preparedRef.current;
        preparedRef.current = next;
        setPreparedSession(next);
        setPreparationState("ready");
        setState((current) => (current === "stopped" ? "prepared" : current));
        if (previous && previous.id !== activeRef.current?.id) {
          await deleteSession(previous.id);
        }
      } catch {
        if (request !== preparationRequest.current) return;
        setPreparationState("failed");
        setState("blocked");
      }
    },
    [deleteSession],
  );

  const releasePreparation = useCallback(
    (releasedFixtureId: string, perspectiveTeam: TeamCode) => {
      const key = `${releasedFixtureId}:${perspectiveTeam}`;
      if (preparationKeyRef.current !== key) return;
      const prepared = preparedRef.current;
      const preparedKey = prepared
        ? `${prepared.fixtureId}:${prepared.perspectiveTeam}`
        : null;
      const decision = decidePreparationRelease({
        activeSessionId: activeRef.current?.id ?? null,
        preparedKey,
        preparedSessionId: prepared?.id ?? null,
        releasedKey: key,
      });
      preparationRequest.current += 1;
      preparationKeyRef.current = decision.nextPreparationKey;
      if (decision.preservePrepared) {
        setPreparationState("ready");
        return;
      }
      preparedRef.current = null;
      setPreparedSession(null);
      setPreparationState("idle");
      if (decision.deleteSessionId)
        void deleteSession(decision.deleteSessionId);
    },
    [deleteSession],
  );

  const start = useCallback(() => {
    const prepared = preparedRef.current;
    const audio = audioRef.current;
    if (!prepared || !audio) {
      setState("blocked");
      return Promise.resolve();
    }
    const previousActive = activeRef.current;
    cancelReconnect();
    setState("connecting");
    wantsPlayback.current = true;
    try {
      return beginPreparedPlayback({
        audio,
        streamUrl: prepared.streamUrl,
        afterPlaybackStarts: async () => {
          activeRef.current = prepared;
          setSessionId(prepared.id);
          setFixtureId(prepared.fixtureId);
          setState("listening");
          if (previousActive && previousActive.id !== prepared.id) {
            await deleteSession(previousActive.id);
          }
        },
      }).catch(() => {
        setState("blocked");
      });
    } catch {
      setState("blocked");
      return Promise.resolve();
    }
  }, [cancelReconnect, deleteSession]);

  useEffect(() => {
    return () => {
      preparationRequest.current += 1;
      const sessions = new Set(
        [activeRef.current?.id, preparedRef.current?.id].filter(
          (id): id is string => Boolean(id),
        ),
      );
      for (const id of sessions) void deleteSession(id);
    };
  }, [deleteSession]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onPlaying = () => setState("listening");
    const onWaiting = () => wantsPlayback.current && setState("buffering");
    const reconnect = () => {
      if (!wantsPlayback.current || reconnectTimer.current !== null) return;
      setState("reconnecting");
      reconnectTimer.current = window.setTimeout(() => {
        reconnectTimer.current = null;
        void resume();
      }, 1_000);
    };
    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("waiting", onWaiting);
    audio.addEventListener("error", reconnect);
    audio.addEventListener("ended", reconnect);
    return () => {
      cancelReconnect();
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("waiting", onWaiting);
      audio.removeEventListener("error", reconnect);
      audio.removeEventListener("ended", reconnect);
    };
  }, [cancelReconnect, resume]);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const active = activeRef.current;
    navigator.mediaSession.metadata = new MediaMetadata({
      album: active
        ? `${active.homeTeam} v ${active.awayTeam}`
        : "World Cup match companion",
      artist: active?.sourceLabel ?? "MatchSense commentary",
      artwork: [
        {
          src: "/icons/matchsense-icon.svg",
          sizes: "512x512",
          type: "image/svg+xml",
        },
      ],
      title: "MatchSense Listening Mode",
    });
    navigator.mediaSession.setActionHandler("play", () => void resume());
    navigator.mediaSession.setActionHandler("pause", pause);
    navigator.mediaSession.setActionHandler("stop", () => void stop());
    return () => {
      for (const action of ["play", "pause", "stop"] as const) {
        navigator.mediaSession.setActionHandler(action, null);
      }
    };
  }, [pause, resume, sessionId, stop]);

  const value = useMemo(
    () => ({
      fixtureId,
      pause,
      preparationState,
      prepare,
      preparedFixtureId: preparedSession?.fixtureId ?? null,
      preparedPerspectiveTeam: preparedSession?.perspectiveTeam ?? null,
      releasePreparation,
      resume,
      sessionId,
      start,
      state,
      stop,
    }),
    [
      fixtureId,
      pause,
      preparationState,
      prepare,
      preparedSession,
      releasePreparation,
      resume,
      sessionId,
      start,
      state,
      stop,
    ],
  );

  return (
    <ListeningContext.Provider value={value}>
      <audio
        ref={audioRef}
        preload="none"
        data-testid="persistent-listening-audio"
      />
      {children}
      {sessionId ? <ListeningDock value={value} /> : null}
    </ListeningContext.Provider>
  );
}

function ListeningDock({ value }: { value: ListeningContextValue }) {
  const active = [
    "listening",
    "speaking",
    "buffering",
    "reconnecting",
  ].includes(value.state);
  return (
    <aside
      className="listening-dock"
      aria-live="polite"
      aria-label="Listening Mode"
    >
      <span
        className={`listening-wave ${active ? "is-active" : ""}`}
        aria-hidden="true"
      >
        <i />
        <i />
        <i />
        <i />
      </span>
      <span>
        <b>Listening Mode</b>
        <small>{stateLabels[value.state]}</small>
      </span>
      <button
        type="button"
        onClick={active ? value.pause : () => void value.resume()}
      >
        {active ? "Pause" : "Play"}
      </button>
      <button
        type="button"
        className="dock-stop"
        onClick={() => void value.stop()}
      >
        Stop
      </button>
    </aside>
  );
}

const stateLabels: Record<ListeningState, string> = {
  blocked: "Playback needs another tap",
  buffering: "Holding the stream",
  connecting: "Opening the commentary channel",
  ended: "Match audio ended",
  listening: "Waiting for the next event",
  paused: "Paused",
  prepared: "Ready",
  reconnecting: "Reconnecting to audio",
  speaking: "Calling the moment",
  stopped: "Stopped",
};

export function useListening() {
  const value = useContext(ListeningContext);
  if (!value)
    throw new Error("useListening must be used inside ListeningProvider");
  return value;
}
