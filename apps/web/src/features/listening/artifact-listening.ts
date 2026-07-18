export type ListeningState =
  | "connecting"
  | "listening"
  | "speaking"
  | "reconnecting"
  | "blocked"
  | "stopped";

export interface ListeningMoment {
  familyId: string;
  fixtureId: string;
  revision: number;
  text?: string | null;
}

export interface ArtifactAudioElement {
  addEventListener(event: "ended" | "error", listener: () => void): void;
  load(): void;
  pause(): void;
  play(): Promise<void>;
  removeAttribute(name: string): void;
  removeEventListener(event: "ended" | "error", listener: () => void): void;
  setAttribute(name: string, value: string): void;
}

export interface ListeningSnapshot {
  commentaryPending: boolean;
  lastCueText: string | null;
  state: ListeningState;
}

interface ArtifactResponse {
  blob(): Promise<Blob>;
  ok: boolean;
  status: number;
}

interface PendingDelivery {
  deadline: number;
  moment: ListeningMoment;
  token: number;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export interface ArtifactListeningDependencies {
  activateAudio(): Promise<void>;
  audio: ArtifactAudioElement;
  cue(moment: ListeningMoment): void;
  clearSchedule?(timer: TimerHandle): void;
  createObjectUrl?(blob: Blob): string;
  fetcher?(
    input: string,
    init: { signal: AbortSignal },
  ): Promise<ArtifactResponse>;
  now?(): number;
  revokeObjectUrl?(url: string): void;
  schedule?(callback: () => void, delayMs: number): TimerHandle;
}

export interface ArtifactListeningController {
  announce(moment: ListeningMoment): Promise<void>;
  retryFromGesture(): Promise<void>;
  snapshot(): ListeningSnapshot;
  startFromGesture(): Promise<void>;
  stop(): void;
  subscribe(listener: (snapshot: ListeningSnapshot) => void): () => void;
}

const RETRY_DELAY_MS = 3_000;
const RETRY_WINDOW_MS = 45_000;

function artifactRoute(moment: ListeningMoment) {
  const identity = `${moment.familyId}:${moment.revision}`;
  return `/api/v1/fixtures/${encodeURIComponent(moment.fixtureId)}/moments/${encodeURIComponent(identity)}/audio`;
}

function fallbackCueText(moment: ListeningMoment) {
  return moment.text?.trim() || "A verified match update just arrived.";
}

/**
 * Owns one persistent HTMLAudioElement but never starts it until the fan taps
 * Listening Mode. Commentary is fetched only after a confirmed Moment arrives;
 * a 404 means the shared artifact is still being prepared, never that speech
 * started successfully.
 */
export function createArtifactListeningController(
  dependencies: ArtifactListeningDependencies,
): ArtifactListeningController {
  const fetcher = dependencies.fetcher ?? globalThis.fetch.bind(globalThis);
  const createObjectUrl =
    dependencies.createObjectUrl ?? ((blob: Blob) => URL.createObjectURL(blob));
  const revokeObjectUrl = dependencies.revokeObjectUrl ?? URL.revokeObjectURL;
  const schedule =
    dependencies.schedule ??
    ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearSchedule = dependencies.clearSchedule ?? clearTimeout;
  const now = dependencies.now ?? Date.now;
  const listeners = new Set<(snapshot: ListeningSnapshot) => void>();
  let abort: AbortController | null = null;
  let artifactUrl: string | null = null;
  let commentaryPending = false;
  let enabled = false;
  let lastCueText: string | null = null;
  let lifecycle = 0;
  let pending: PendingDelivery | null = null;
  let retryTimer: TimerHandle | null = null;
  let state: ListeningState = "stopped";

  const snapshot = (): ListeningSnapshot => ({
    commentaryPending,
    lastCueText,
    state,
  });

  const notify = () => {
    const next = snapshot();
    for (const listener of listeners) listener(next);
  };

  const setState = (next: ListeningState) => {
    state = next;
    notify();
  };

  const clearRetry = () => {
    if (retryTimer !== null) clearSchedule(retryTimer);
    retryTimer = null;
  };

  const releaseArtifact = () => {
    dependencies.audio.pause();
    dependencies.audio.removeAttribute("src");
    dependencies.audio.load();
    if (artifactUrl) revokeObjectUrl(artifactUrl);
    artifactUrl = null;
  };

  const current = (delivery: PendingDelivery) =>
    enabled && pending?.token === delivery.token;

  const finishWithoutSpeech = (delivery: PendingDelivery) => {
    if (!current(delivery)) return;
    pending = null;
    commentaryPending = false;
    setState("listening");
  };

  const requestSpeech = async (delivery: PendingDelivery): Promise<void> => {
    if (!current(delivery)) return;
    abort?.abort();
    abort = new AbortController();
    let response: ArtifactResponse;
    try {
      response = await fetcher(artifactRoute(delivery.moment), {
        signal: abort.signal,
      });
    } catch {
      if (current(delivery)) queueRetry(delivery);
      return;
    }
    if (!current(delivery)) return;
    if (!response.ok) {
      queueRetry(delivery);
      return;
    }
    let bytes: Blob;
    try {
      bytes = await response.blob();
    } catch {
      if (current(delivery)) queueRetry(delivery);
      return;
    }
    if (!current(delivery)) return;

    releaseArtifact();
    artifactUrl = createObjectUrl(bytes);
    dependencies.audio.setAttribute("src", artifactUrl);
    dependencies.audio.load();
    try {
      await dependencies.audio.play();
    } catch {
      if (!current(delivery)) return;
      commentaryPending = false;
      setState("blocked");
      return;
    }
    if (!current(delivery)) return;
    commentaryPending = false;
    setState("speaking");
  };

  const queueRetry = (delivery: PendingDelivery) => {
    if (!current(delivery)) return;
    abort = null;
    if (now() >= delivery.deadline) {
      finishWithoutSpeech(delivery);
      return;
    }
    commentaryPending = true;
    setState("reconnecting");
    clearRetry();
    retryTimer = schedule(() => {
      retryTimer = null;
      void requestSpeech(delivery);
    }, RETRY_DELAY_MS);
  };

  const onEnded = () => {
    if (state !== "speaking") return;
    releaseArtifact();
    pending = null;
    commentaryPending = false;
    if (enabled) setState("listening");
  };

  const onError = () => {
    if (!pending || !enabled) return;
    queueRetry(pending);
  };

  dependencies.audio.addEventListener("ended", onEnded);
  dependencies.audio.addEventListener("error", onError);

  return {
    async announce(moment) {
      if (!enabled) return;
      lifecycle += 1;
      clearRetry();
      abort?.abort();
      const delivery: PendingDelivery = {
        deadline: now() + RETRY_WINDOW_MS,
        moment,
        token: lifecycle,
      };
      pending = delivery;
      commentaryPending = false;
      lastCueText = fallbackCueText(moment);
      try {
        dependencies.cue(moment);
      } catch {
        commentaryPending = false;
        setState("blocked");
        return;
      }
      notify();
      await requestSpeech(delivery);
    },

    async retryFromGesture() {
      if (!pending) return;
      clearRetry();
      if (state === "blocked") setState("connecting");
      await requestSpeech(pending);
    },

    snapshot,

    async startFromGesture() {
      if (enabled && state !== "stopped") return;
      const startToken = ++lifecycle;
      setState("connecting");
      try {
        await dependencies.activateAudio();
      } catch {
        if (startToken === lifecycle) setState("blocked");
        return;
      }
      if (startToken !== lifecycle || state === "stopped") return;
      enabled = true;
      setState("listening");
    },

    stop() {
      lifecycle += 1;
      enabled = false;
      clearRetry();
      abort?.abort();
      abort = null;
      pending = null;
      commentaryPending = false;
      releaseArtifact();
      setState("stopped");
    },

    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    },
  };
}
