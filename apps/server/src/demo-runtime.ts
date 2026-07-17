import { randomUUID } from "node:crypto";

import {
  DEMO_DURATION_SECONDS,
  DEMO_FIXTURE_ID,
  DEMO_TIMELINE,
  type DemoBeat,
} from "@matchsense/replay";

export const DEMO_SOURCE_LABEL =
  "SIMULATION · ARGENTINA VS FRANCE · 5 MIN" as const;

export interface DemoProgress {
  readonly current: number;
  readonly durationSeconds: number;
  readonly elapsedSeconds: number;
  readonly percent: number;
  readonly total: number;
}

export interface DemoBeatEvent extends DemoBeat {
  readonly cursor: number;
  readonly progress: DemoProgress;
  readonly sessionId: string;
  readonly simulation: true;
  readonly sourceLabel: typeof DEMO_SOURCE_LABEL;
}

export interface DemoSessionView {
  readonly createdAt: string;
  readonly cursor: number;
  readonly durationSeconds: number;
  readonly fixtureId: typeof DEMO_FIXTURE_ID;
  readonly id: string;
  readonly progress: DemoProgress;
  readonly simulation: true;
  readonly sourceLabel: typeof DEMO_SOURCE_LABEL;
  readonly startedAt: string | null;
  readonly status: "complete" | "ready" | "running";
  readonly totalBeats: number;
}

export interface DemoTimelineView {
  readonly beats: readonly DemoBeatEvent[];
  readonly durationSeconds: number;
  readonly fixtureId: typeof DEMO_FIXTURE_ID;
  readonly sessionId: string;
  readonly simulation: true;
  readonly sourceLabel: typeof DEMO_SOURCE_LABEL;
}

export interface DemoSubscription {
  onBeat(event: DemoBeatEvent): void;
  onEnd(reason: "complete" | "restarted" | "runtime_closed"): void;
}

interface MutableDemoSession {
  createdAtMs: number;
  cursor: number;
  generation: number;
  id: string;
  startedAtMs: number | null;
  status: DemoSessionView["status"];
  stops: Set<(reason: "restarted" | "runtime_closed") => void>;
}

export interface DemoSessionRuntimeOptions {
  id?: () => string;
  /** Test-only pacing seam. Production intentionally uses 1,000 ms/second. */
  millisecondsPerDemoSecond?: number;
  nowMs?: () => number;
}

function progress(cursor: number): DemoProgress {
  const beat = cursor > 0 ? DEMO_TIMELINE[cursor - 1] : undefined;
  const elapsedSeconds = beat?.atSeconds ?? 0;
  return {
    current: cursor,
    durationSeconds: DEMO_DURATION_SECONDS,
    elapsedSeconds,
    percent: Number(
      ((elapsedSeconds / DEMO_DURATION_SECONDS) * 100).toFixed(1),
    ),
    total: DEMO_TIMELINE.length,
  };
}

function eventFor(
  sessionId: string,
  beat: DemoBeat,
  index: number,
): DemoBeatEvent {
  const cursor = index + 1;
  return {
    ...beat,
    cursor,
    progress: progress(cursor),
    sessionId,
    simulation: true,
    sourceLabel: DEMO_SOURCE_LABEL,
  };
}

function sessionView(session: MutableDemoSession): DemoSessionView {
  return {
    createdAt: new Date(session.createdAtMs).toISOString(),
    cursor: session.cursor,
    durationSeconds: DEMO_DURATION_SECONDS,
    fixtureId: DEMO_FIXTURE_ID,
    id: session.id,
    progress: progress(session.cursor),
    simulation: true,
    sourceLabel: DEMO_SOURCE_LABEL,
    startedAt:
      session.startedAtMs === null
        ? null
        : new Date(session.startedAtMs).toISOString(),
    status: session.status,
    totalBeats: DEMO_TIMELINE.length,
  };
}

export function createDemoSessionRuntime(
  options: DemoSessionRuntimeOptions = {},
) {
  const nextId = options.id ?? randomUUID;
  const nowMs = options.nowMs ?? Date.now;
  const millisecondsPerDemoSecond = options.millisecondsPerDemoSecond ?? 1_000;
  if (
    !Number.isFinite(millisecondsPerDemoSecond) ||
    millisecondsPerDemoSecond <= 0
  ) {
    throw new Error("Demo pacing must be a positive finite number");
  }
  const sessions = new Map<string, MutableDemoSession>();
  let closed = false;

  const create = (): DemoSessionView => {
    if (closed) throw new Error("Demo runtime is closed");
    let id = nextId();
    while (sessions.has(id)) id = nextId();
    const createdAtMs = nowMs();
    const session: MutableDemoSession = {
      createdAtMs,
      cursor: 0,
      generation: 0,
      id,
      startedAtMs: null,
      status: "ready",
      stops: new Set(),
    };
    sessions.set(id, session);
    return sessionView(session);
  };

  const get = (id: string): DemoSessionView | null => {
    const session = sessions.get(id);
    return session ? sessionView(session) : null;
  };

  const timeline = (id: string): DemoTimelineView | null => {
    if (!sessions.has(id)) return null;
    return {
      beats: DEMO_TIMELINE.map((beat, index) => eventFor(id, beat, index)),
      durationSeconds: DEMO_DURATION_SECONDS,
      fixtureId: DEMO_FIXTURE_ID,
      sessionId: id,
      simulation: true,
      sourceLabel: DEMO_SOURCE_LABEL,
    };
  };

  const subscribe = (
    id: string,
    subscriber: DemoSubscription,
  ): (() => void) | null => {
    const session = sessions.get(id);
    if (!session || closed) return null;
    if (session.status === "complete") {
      queueMicrotask(() => subscriber.onEnd("complete"));
      return () => undefined;
    }
    if (session.startedAtMs === null) {
      session.startedAtMs = nowMs();
      session.status = "running";
    }
    const generation = session.generation;
    let cursor = session.cursor;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let active = true;

    const remove = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      session.stops.delete(stopForRuntime);
    };
    const unsubscribe = () => {
      if (!active) return;
      active = false;
      remove();
    };
    const end = (reason: "complete" | "restarted" | "runtime_closed") => {
      if (!active) return;
      active = false;
      remove();
      subscriber.onEnd(reason);
    };
    const stopForRuntime = (reason: "restarted" | "runtime_closed") =>
      end(reason);

    const schedule = () => {
      if (!active || generation !== session.generation) return;
      const beat = DEMO_TIMELINE[cursor];
      if (!beat) {
        session.status = "complete";
        end("complete");
        return;
      }
      const target =
        session.startedAtMs! + beat.atSeconds * millisecondsPerDemoSecond;
      const delay = Math.max(0, target - nowMs());
      timer = setTimeout(() => {
        timer = null;
        if (!active || generation !== session.generation) return;
        const event = eventFor(session.id, beat, cursor);
        cursor += 1;
        session.cursor = Math.max(session.cursor, cursor);
        subscriber.onBeat(event);
        schedule();
      }, delay);
      timer.unref?.();
    };

    session.stops.add(stopForRuntime);
    schedule();
    return unsubscribe;
  };

  const restart = (id: string): DemoSessionView | null => {
    const session = sessions.get(id);
    if (!session || closed) return null;
    for (const stop of [...session.stops]) stop("restarted");
    session.cursor = 0;
    session.generation += 1;
    session.startedAtMs = null;
    session.status = "ready";
    return sessionView(session);
  };

  const close = () => {
    if (closed) return;
    closed = true;
    for (const session of sessions.values()) {
      for (const stop of [...session.stops]) stop("runtime_closed");
    }
  };

  return { close, create, get, restart, subscribe, timeline };
}

export type DemoSessionRuntime = ReturnType<typeof createDemoSessionRuntime>;
