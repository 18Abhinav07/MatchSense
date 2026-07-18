import { normalizeFixture, normalizeMoment } from "./live-api.js";
import type { LiveMoment, LiveSnapshot } from "./product-state.js";

type JsonRecord = Record<string, unknown>;

export interface RecordedReplaySession {
  archiveManifestId: string;
  fixtureId: string;
  fixtureMode: "recorded";
  id: string;
  mode: "recorded";
  replaySeq: 0;
}

export interface RecordedReplayEvent {
  eventId: string;
  eventType: string;
  moment: LiveMoment | null;
  replaySeq: number;
}

export interface RecordedReplayTimeline extends RecordedReplaySession {
  events: readonly RecordedReplayEvent[];
  highWaterSequence: number;
  snapshot: LiveSnapshot & {
    archiveManifestId: string;
    archiveStatus: "REPLAY_READY";
    mode: "recorded";
    provenance: "recorded_txline_authorised";
    score: { away: number; home: number };
  };
}

export interface RecordedReplayApi {
  fetchTimeline(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<RecordedReplayTimeline>;
  start(
    fixtureId: string,
    signal?: AbortSignal,
  ): Promise<RecordedReplaySession>;
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

export function normalizeRecordedReplaySession(
  value: unknown,
): RecordedReplaySession | null {
  const data = record(value);
  const archiveManifestId = text(data?.archiveManifestId);
  const fixtureId = text(data?.fixtureId);
  const id = text(data?.id);
  if (
    !data ||
    !archiveManifestId ||
    !fixtureId ||
    !id ||
    !id.startsWith("recorded_") ||
    data.mode !== "recorded" ||
    data.fixtureMode !== "recorded" ||
    data.replaySeq !== 0
  ) {
    return null;
  }
  return {
    archiveManifestId,
    fixtureId,
    fixtureMode: "recorded",
    id,
    mode: "recorded",
    replaySeq: 0,
  };
}

function canonicalPayload(value: unknown): JsonRecord | null {
  const initial = record(value);
  if (!initial) return null;
  const fromPayload = record(initial.payload);
  if (fromPayload) return fromPayload;
  const fromEvent = record(initial.event);
  return fromEvent ?? initial;
}

function normalizeReplayEvent(
  value: unknown,
  fixture: LiveSnapshot,
): RecordedReplayEvent | null {
  const entry = record(value);
  const replaySeq = nonNegativeInteger(entry?.replaySeq);
  const payload = canonicalPayload(entry?.event);
  if (!entry || replaySeq === null || !payload) return null;
  const rawMoment = payload.moment;
  return {
    eventId: text(payload.id ?? entry.eventId) ?? `recorded:${replaySeq}`,
    eventType: text(payload.event ?? payload.type) ?? "recorded.event",
    moment:
      rawMoment === undefined ? null : normalizeMoment(rawMoment, fixture),
    replaySeq,
  };
}

export function normalizeRecordedReplayTimeline(
  value: unknown,
): RecordedReplayTimeline | null {
  const data = record(value);
  const session = normalizeRecordedReplaySession(data);
  const snapshot = normalizeFixture(data?.snapshot);
  const highWaterSequence = nonNegativeInteger(data?.highWaterSequence);
  if (
    !data ||
    !session ||
    !snapshot ||
    !snapshot.archiveManifestId ||
    snapshot.archiveStatus !== "REPLAY_READY" ||
    snapshot.mode !== "recorded" ||
    snapshot.provenance !== "recorded_txline_authorised" ||
    (snapshot.lifecycle !== "FINAL" &&
      snapshot.lifecycle !== "FINAL_REVISED") ||
    !snapshot.score ||
    snapshot.fixtureId !== session.fixtureId ||
    snapshot.archiveManifestId !== session.archiveManifestId ||
    !Array.isArray(data.events) ||
    highWaterSequence === null
  ) {
    return null;
  }
  const events = data.events.map((event) =>
    normalizeReplayEvent(event, snapshot),
  );
  if (events.some((event) => event === null)) return null;
  const normalizedEvents = events as RecordedReplayEvent[];
  if (normalizedEvents.some((event) => event.replaySeq > highWaterSequence)) {
    return null;
  }
  return {
    ...session,
    events: normalizedEvents,
    highWaterSequence,
    snapshot: {
      ...snapshot,
      archiveManifestId: snapshot.archiveManifestId,
      archiveStatus: "REPLAY_READY",
      mode: "recorded",
      provenance: "recorded_txline_authorised",
      score: snapshot.score,
    },
  };
}

async function requestJson(
  url: string,
  fetcher: typeof fetch,
  init: RequestInit,
) {
  const response = await fetcher(url, init);
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json() as Promise<unknown>;
}

export function createRecordedReplayApi(
  options: { fetcher?: typeof fetch | undefined } = {},
): RecordedReplayApi {
  const fetcher = options.fetcher ?? fetch;
  return {
    fetchTimeline: async (sessionId, signal) => {
      const timeline = normalizeRecordedReplayTimeline(
        await requestJson(
          `/api/v1/replay/sessions/${encodeURIComponent(sessionId)}/timeline`,
          fetcher,
          {
            headers: { Accept: "application/json" },
            ...(signal ? { signal } : {}),
          },
        ),
      );
      if (!timeline) throw new Error("Recorded replay timeline was invalid");
      return timeline;
    },
    start: async (fixtureId, signal) => {
      const session = normalizeRecordedReplaySession(
        await requestJson("/api/v1/replay/sessions", fetcher, {
          body: JSON.stringify({ fixtureId, mode: "recorded" }),
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          method: "POST",
          ...(signal ? { signal } : {}),
        }),
      );
      if (!session) throw new Error("Recorded replay session was invalid");
      return session;
    },
  };
}

export async function startRecordedReplay(
  fixtureId: string,
  signal?: AbortSignal,
) {
  return createRecordedReplayApi().start(fixtureId, signal);
}

export async function fetchRecordedReplayTimeline(
  sessionId: string,
  signal?: AbortSignal,
) {
  return createRecordedReplayApi().fetchTimeline(sessionId, signal);
}
