import { afterEach, describe, expect, it, vi } from "vitest";

import { DEMO_TIMELINE } from "@matchsense/replay";

import { createDemoSessionRuntime } from "./demo-runtime.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("demo session runtime", () => {
  it("plays every beat in order on the accelerated test clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T12:00:00.000Z"));
    const runtime = createDemoSessionRuntime({
      millisecondsPerDemoSecond: 10,
      nowMs: () => Date.now(),
    });
    const session = runtime.create();
    const events: unknown[] = [];
    const ended: string[] = [];

    runtime.subscribe(session.id, {
      onBeat: (event) => events.push(event),
      onEnd: (reason) => ended.push(reason),
    });
    await vi.advanceTimersByTimeAsync(3_000);

    expect(events).toHaveLength(DEMO_TIMELINE.length);
    expect(events.map((event) => (event as { type: string }).type)).toEqual(
      DEMO_TIMELINE.map(({ type }) => type),
    );
    expect(events.at(-1)).toMatchObject({
      cursor: 16,
      progress: { elapsedSeconds: 300, percent: 100, total: 16 },
      score: { away: 1, home: 2 },
      simulation: true,
      type: "full_time",
    });
    expect(ended).toEqual(["complete"]);
    expect(runtime.get(session.id)).toMatchObject({
      cursor: 16,
      status: "complete",
    });
  });

  it("cancels a subscriber's timer when it disconnects", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T12:00:00.000Z"));
    const runtime = createDemoSessionRuntime({
      millisecondsPerDemoSecond: 10,
      nowMs: () => Date.now(),
    });
    const session = runtime.create();
    const beatIds: string[] = [];
    const unsubscribe = runtime.subscribe(session.id, {
      onBeat: ({ id }) => beatIds.push(id),
      onEnd: () => undefined,
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(beatIds).toEqual(["arg-fra-demo:kickoff"]);
    unsubscribe?.();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(beatIds).toEqual(["arg-fra-demo:kickoff"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps judges isolated and restarts only the requested session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T12:00:00.000Z"));
    let sequence = 0;
    const runtime = createDemoSessionRuntime({
      id: () => `judge-${++sequence}`,
      millisecondsPerDemoSecond: 10,
      nowMs: () => Date.now(),
    });
    const first = runtime.create();
    const second = runtime.create();
    runtime.subscribe(first.id, {
      onBeat: () => undefined,
      onEnd: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(700);

    expect(runtime.get(first.id)?.cursor).toBe(5);
    expect(runtime.get(second.id)).toMatchObject({
      cursor: 0,
      status: "ready",
    });

    const restarted = runtime.restart(first.id);
    expect(restarted).toMatchObject({ cursor: 0, status: "ready" });
    expect(runtime.get(second.id)).toMatchObject({
      cursor: 0,
      status: "ready",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the full 300-second production timeline by default", () => {
    const runtime = createDemoSessionRuntime();
    const session = runtime.create();
    const timeline = runtime.timeline(session.id);

    expect(session.durationSeconds).toBe(300);
    expect(timeline?.beats.at(-1)).toMatchObject({
      atSeconds: 300,
      cursor: 16,
      progress: { elapsedSeconds: 300, percent: 100 },
    });
  });
});
