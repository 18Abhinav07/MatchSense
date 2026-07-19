import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  createArtifactListeningController,
  type ArtifactAudioElement,
} from "./features/listening/artifact-listening.js";
import { createListeningApi } from "./features/listening/listening-api.js";
import {
  createStreamListeningController,
  type ListeningMoment,
  type StreamAudioElement,
  type StreamListeningController,
  type StreamListeningSnapshot,
  type StreamListeningState,
} from "./features/listening/stream-listening.js";

export {
  createArtifactListeningController,
  type ArtifactAudioElement,
} from "./features/listening/artifact-listening.js";
export type { ListeningMoment } from "./features/listening/stream-listening.js";

/**
 * Kept as pure media helpers for existing product-state tests. The PWA no
 * longer creates listening sessions or uses this helper to open a stream.
 */
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
  return options.audio.play().then(async () => {
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

interface FixtureListeningLease {
  acquire(input: {
    fixtureId: string;
    perspectiveTeam: string;
  }): () => void;
  reconcileRoute(): void;
  stop(): Promise<void>;
}

function fixtureIdFromListeningPath(path: string): string | null {
  const matched =
    /^\/matches\/([^/]+)(?:\/live|\/moments\/[^/]+)?\/?$/u.exec(path);
  if (!matched?.[1]) return null;
  try {
    return decodeURIComponent(matched[1]);
  } catch {
    return null;
  }
}

export function createFixtureListeningLease(dependencies: {
  currentPath?: () => string;
  defer?: (release: () => void) => void;
  prepare(input: {
    fixtureId: string;
    perspectiveTeam: string;
  }): Promise<void>;
  stop(): Promise<void>;
}): FixtureListeningLease {
  const defer = dependencies.defer ?? queueMicrotask;
  const holders = new Map<string, number>();
  let activeKey: string | null = null;
  let activeInput: {
    fixtureId: string;
    perspectiveTeam: string;
  } | null = null;
  let generation = 0;

  const routeRetains = (input: { fixtureId: string }) =>
    dependencies.currentPath !== undefined &&
    fixtureIdFromListeningPath(dependencies.currentPath()) === input.fixtureId;

  const clearOwnership = () => {
    activeKey = null;
    activeInput = null;
    holders.clear();
    generation += 1;
  };

  return {
    acquire(input) {
      const key = `${input.fixtureId}:${input.perspectiveTeam}`;
      const alreadyActive = activeKey === key;
      const existing = holders.get(key) ?? 0;
      holders.set(key, existing + 1);
      activeKey = key;
      activeInput = input;
      if (!alreadyActive) void dependencies.prepare(input);
      const acquiredGeneration = generation;

      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (acquiredGeneration !== generation) return;
        holders.set(key, Math.max((holders.get(key) ?? 1) - 1, 0));
        defer(() => {
          if (acquiredGeneration !== generation) return;
          if ((holders.get(key) ?? 0) > 0) return;
          holders.delete(key);
          if (activeKey !== key) return;
          if (routeRetains(input)) return;
          clearOwnership();
          void dependencies.stop();
        });
      };
    },

    reconcileRoute() {
      defer(() => {
        if (!activeInput || routeRetains(activeInput)) return;
        clearOwnership();
        void dependencies.stop();
      });
    },

    async stop() {
      clearOwnership();
      await dependencies.stop();
    },
  };
}

interface ListeningContextValue extends StreamListeningSnapshot {
  acquire(input: {
    fixtureId: string;
    perspectiveTeam: string;
  }): () => void;
  announce(moment: ListeningMoment): void;
  pause(): void;
  prepare(input: { fixtureId: string; perspectiveTeam: string }): Promise<void>;
  retry(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

const STOPPED_SNAPSHOT: StreamListeningSnapshot = {
  commentaryPending: false,
  error: null,
  lastCueText: null,
  prepared: false,
  state: "stopped",
};

const DEFAULT_CONTEXT: ListeningContextValue = {
  ...STOPPED_SNAPSHOT,
  acquire: () => () => undefined,
  announce: () => undefined,
  pause: () => undefined,
  prepare: async () => undefined,
  retry: async () => undefined,
  start: async () => undefined,
  stop: async () => undefined,
};

const ListeningContext = createContext<ListeningContextValue>(DEFAULT_CONTEXT);

function asStreamAudioElement(audio: HTMLAudioElement): StreamAudioElement {
  return {
    addEventListener: (event, listener) =>
      audio.addEventListener(event, listener),
    getAttribute: (name) => audio.getAttribute(name),
    load: () => audio.load(),
    pause: () => audio.pause(),
    play: () => audio.play(),
    removeAttribute: (name) => audio.removeAttribute(name),
    removeEventListener: (event, listener) =>
      audio.removeEventListener(event, listener),
    setAttribute: (name, value) => audio.setAttribute(name, value),
  };
}

export function ListeningProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const controllerRef = useRef<StreamListeningController | null>(null);
  const fixtureLeaseRef = useRef<FixtureListeningLease | null>(null);
  const mediaSessionConfiguredRef = useRef(false);
  const mediaSessionGenerationRef = useRef(0);
  const providerGenerationRef = useRef(0);
  const preparedInputRef = useRef<{
    fixtureId: string;
    perspectiveTeam: string;
  } | null>(null);
  const [snapshot, setSnapshot] =
    useState<StreamListeningSnapshot>(STOPPED_SNAPSHOT);

  useLayoutEffect(() => {
    const generation = ++providerGenerationRef.current;
    const audio = audioRef.current;
    if (!audio) return;
    const controller =
      controllerRef.current ??
      createStreamListeningController({
        api: createListeningApi(),
        audio: asStreamAudioElement(audio),
      });
    controllerRef.current ??= controller;
    fixtureLeaseRef.current ??= createFixtureListeningLease({
      currentPath: () =>
        typeof window === "undefined" ? "/" : window.location.pathname,
      prepare: (input) => {
        preparedInputRef.current = input;
        return controller.prepare(input);
      },
      stop: async () => {
        preparedInputRef.current = null;
        await controller.stop();
      },
    });
    const unsubscribe = controller.subscribe(setSnapshot);
    return () => {
      unsubscribe();
      queueMicrotask(() => {
        if (providerGenerationRef.current !== generation) return;
        void controller.stop();
        controllerRef.current = null;
        fixtureLeaseRef.current = null;
      });
    };
  }, []);

  const acquire = useCallback(
    (input: { fixtureId: string; perspectiveTeam: string }) =>
      fixtureLeaseRef.current?.acquire(input) ?? (() => undefined),
    [],
  );
  const announce = useCallback((moment: ListeningMoment) => {
    controllerRef.current?.announce(moment);
  }, []);
  const pause = useCallback(() => controllerRef.current?.pause(), []);
  const prepare = useCallback(
    (input: { fixtureId: string; perspectiveTeam: string }) => {
      preparedInputRef.current = input;
      return controllerRef.current?.prepare(input) ?? Promise.resolve();
    },
    [],
  );
  const retry = useCallback(() => {
    if (
      controllerRef.current &&
      !controllerRef.current.snapshot().prepared &&
      preparedInputRef.current
    ) {
      return controllerRef.current.prepare(preparedInputRef.current);
    }
    return controllerRef.current?.resumeFromGesture() ?? Promise.resolve();
  }, []);
  const start = useCallback(() => {
    return controllerRef.current?.startFromGesture() ?? Promise.resolve();
  }, []);
  const stop = useCallback(async () => {
    const controller = controllerRef.current;
    if (!controller) return;
    const lease = fixtureLeaseRef.current;
    if (lease) await lease.stop();
    else {
      preparedInputRef.current = null;
      await controller.stop();
    }
  }, []);

  useEffect(() => {
    const reconcileRoute = () => fixtureLeaseRef.current?.reconcileRoute();
    window.addEventListener("popstate", reconcileRoute);
    return () => window.removeEventListener("popstate", reconcileRoute);
  }, []);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const generation = ++mediaSessionGenerationRef.current;
    const session = navigator.mediaSession;
    if (!mediaSessionConfiguredRef.current) {
      try {
        session.metadata = new MediaMetadata({
          album: "World Cup match companion",
          artist: "MatchSense commentary",
          artwork: [
            {
              sizes: "512x512",
              src: "/icons/matchsense-icon.svg",
              type: "image/svg+xml",
            },
          ],
          title: "MatchSense Listening Mode",
        });
        session.setActionHandler("play", () => void retry());
        session.setActionHandler("pause", pause);
        session.setActionHandler("stop", () => void stop());
        mediaSessionConfiguredRef.current = true;
      } catch {
        // Media Session is a progressive enhancement; the audio contract stays
        // truthful when a browser declines these optional handlers.
      }
    }
    return () => {
      queueMicrotask(() => {
        if (mediaSessionGenerationRef.current !== generation) return;
        try {
          session.setActionHandler("play", null);
          session.setActionHandler("pause", null);
          session.setActionHandler("stop", null);
          session.playbackState = "none";
          mediaSessionConfiguredRef.current = false;
        } catch {
          // Some browsers expose Media Session but reject unsupported actions.
        }
      });
    };
  }, [pause, retry, stop]);

  const value = useMemo<ListeningContextValue>(
    () => ({ ...snapshot, acquire, announce, pause, prepare, retry, start, stop }),
    [acquire, announce, pause, prepare, retry, snapshot, start, stop],
  );

  return (
    <ListeningContext.Provider value={value}>
      <audio
        ref={audioRef}
        data-testid="persistent-listening-audio"
        preload="none"
      />
      {children}
      {snapshot.state !== "stopped" || snapshot.prepared ? (
        <ListeningDock value={value} />
      ) : null}
    </ListeningContext.Provider>
  );
}

function ListeningDock({ value }: { value: ListeningContextValue }) {
  const active = ["listening", "speaking", "reconnecting"].includes(
    value.state,
  );
  return (
    <aside
      aria-label="Listening Mode"
      aria-live="polite"
      className="listening-dock"
    >
      <span
        aria-hidden="true"
        className={`listening-wave ${active ? "is-active" : ""}`}
      >
        <i />
        <i />
        <i />
        <i />
      </span>
      <span>
        <b>Listening Mode</b>
        <small>{stateLabels[value.state]}</small>
        {value.lastCueText ? <em>{value.lastCueText}</em> : null}
      </span>
      {value.state === "blocked" ? (
        <button onClick={() => void value.retry()} type="button">
          Retry audio
        </button>
      ) : null}
      {value.state === "listening" || value.state === "connecting" ? (
        <button onClick={value.pause} type="button">
          Pause
        </button>
      ) : null}
      <button
        className="dock-stop"
        onClick={() => void value.stop()}
        type="button"
      >
        Stop
      </button>
    </aside>
  );
}

const stateLabels: Record<StreamListeningState, string> = {
  blocked: "Audio blocked — tap Retry audio",
  connecting: "Connecting to the live audio edge",
  listening: "Waiting for a verified update",
  paused: "Paused — tap Play to rejoin live",
  stopped: "Stopped",
};

export function useListening() {
  return useContext(ListeningContext);
}
