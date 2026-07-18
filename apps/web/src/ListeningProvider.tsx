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

import {
  createArtifactListeningController,
  type ArtifactAudioElement,
  type ArtifactListeningController,
  type ListeningMoment,
  type ListeningSnapshot,
  type ListeningState,
} from "./features/listening/artifact-listening.js";

export {
  createArtifactListeningController,
  type ArtifactAudioElement,
  type ListeningMoment,
  type ListeningSnapshot,
  type ListeningState,
} from "./features/listening/artifact-listening.js";

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

interface ListeningContextValue extends ListeningSnapshot {
  announce(moment: ListeningMoment): Promise<void>;
  retry(): Promise<void>;
  start(): Promise<void>;
  stop(): void;
}

const STOPPED_SNAPSHOT: ListeningSnapshot = {
  commentaryPending: false,
  lastCueText: null,
  state: "stopped",
};

const ListeningContext = createContext<ListeningContextValue | null>(null);

function createCuePlayer() {
  let context: AudioContext | null = null;
  const AudioContextConstructor =
    globalThis.AudioContext ??
    (
      globalThis as typeof globalThis & {
        webkitAudioContext?: typeof AudioContext;
      }
    ).webkitAudioContext;

  return {
    async activate() {
      if (!AudioContextConstructor) {
        throw new Error("Web Audio is unavailable on this device");
      }
      context ??= new AudioContextConstructor();
      if (context.state === "suspended") await context.resume();
      if (context.state !== "running") {
        throw new Error("Web Audio could not be activated");
      }
    },
    cue() {
      if (!context || context.state !== "running") {
        throw new Error("Audio must be activated by the fan first");
      }
      const start = context.currentTime;
      for (const [offset, frequency] of [
        [0, 620],
        [0.13, 860],
      ] as const) {
        const gain = context.createGain();
        const oscillator = context.createOscillator();
        oscillator.frequency.setValueAtTime(frequency, start + offset);
        gain.gain.setValueAtTime(0.0001, start + offset);
        gain.gain.exponentialRampToValueAtTime(0.11, start + offset + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.12);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(start + offset);
        oscillator.stop(start + offset + 0.13);
      }
    },
  };
}

function asArtifactAudioElement(audio: HTMLAudioElement): ArtifactAudioElement {
  return {
    addEventListener: (event, listener) =>
      audio.addEventListener(event, listener),
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
  const controllerRef = useRef<ArtifactListeningController | null>(null);
  const [snapshot, setSnapshot] = useState<ListeningSnapshot>(STOPPED_SNAPSHOT);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const cuePlayer = createCuePlayer();
    const controller = createArtifactListeningController({
      activateAudio: cuePlayer.activate,
      audio: asArtifactAudioElement(audio),
      cue: () => cuePlayer.cue(),
    });
    controllerRef.current = controller;
    const unsubscribe = controller.subscribe(setSnapshot);
    return () => {
      unsubscribe();
      controller.stop();
      controllerRef.current = null;
    };
  }, []);

  const announce = useCallback((moment: ListeningMoment) => {
    return controllerRef.current?.announce(moment) ?? Promise.resolve();
  }, []);
  const retry = useCallback(() => {
    return controllerRef.current?.retryFromGesture() ?? Promise.resolve();
  }, []);
  const start = useCallback(() => {
    return controllerRef.current?.startFromGesture() ?? Promise.resolve();
  }, []);
  const stop = useCallback(() => controllerRef.current?.stop(), []);

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;
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
        title:
          snapshot.state === "speaking"
            ? "Live MatchSense commentary"
            : "MatchSense Listening Mode",
      });
      session.setActionHandler("play", () => void retry());
      session.setActionHandler("stop", stop);
    } catch {
      // Media Session is a progressive enhancement; the audio contract stays
      // truthful when a browser declines these optional handlers.
    }
    return () => {
      try {
        session.setActionHandler("play", null);
        session.setActionHandler("stop", null);
      } catch {
        // Some browsers expose Media Session but reject unsupported actions.
      }
    };
  }, [retry, snapshot.state, stop]);

  const value = useMemo<ListeningContextValue>(
    () => ({ ...snapshot, announce, retry, start, stop }),
    [announce, retry, snapshot, start, stop],
  );

  return (
    <ListeningContext.Provider value={value}>
      <audio
        ref={audioRef}
        data-testid="persistent-listening-audio"
        preload="none"
      />
      {children}
      {snapshot.state !== "stopped" ? <ListeningDock value={value} /> : null}
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
      <button className="dock-stop" onClick={value.stop} type="button">
        Stop
      </button>
    </aside>
  );
}

const stateLabels: Record<ListeningState, string> = {
  blocked: "Audio blocked — tap Retry audio",
  connecting: "Activating audio",
  listening: "Waiting for a verified update",
  reconnecting: "Commentary is preparing",
  speaking: "Calling the moment",
  stopped: "Stopped",
};

export function useListening() {
  const value = useContext(ListeningContext);
  if (!value) {
    throw new Error("useListening must be used inside ListeningProvider");
  }
  return value;
}
