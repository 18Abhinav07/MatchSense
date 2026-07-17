import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { createDemoSessionRuntime } from "./demo-runtime.js";

let webDistPath: string;

beforeAll(async () => {
  webDistPath = await mkdtemp(path.join(tmpdir(), "matchsense-demo-routes-"));
  await mkdir(path.join(webDistPath, "assets"));
  await writeFile(path.join(webDistPath, "index.html"), "<!doctype html>");
});

afterAll(async () => {
  await rm(webDistPath, { force: true, recursive: true });
});

function buildDemoApp() {
  return buildApp({
    demo: createDemoSessionRuntime({ millisecondsPerDemoSecond: 0.1 }),
    readinessProbe: {
      check: async () => ({
        databaseReachable: true,
        migrationsCurrent: true,
      }),
    },
    webDistPath,
  });
}

describe("five-minute demo routes", () => {
  it("creates, reads, describes and restarts an isolated demo session", async () => {
    const app = buildDemoApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/demo/sessions",
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      cursor: 0,
      durationSeconds: 300,
      fixtureId: "arg-fra-demo",
      simulation: true,
      sourceLabel: "SIMULATION · ARGENTINA VS FRANCE · 5 MIN",
      status: "ready",
      totalBeats: 16,
    });
    const { id } = created.json<{ id: string }>();

    const state = await app.inject({ url: `/api/v1/demo/sessions/${id}` });
    expect(state.statusCode).toBe(200);
    expect(state.headers["cache-control"]).toBe("no-store");

    const timeline = await app.inject({
      url: `/api/v1/demo/sessions/${id}/timeline`,
    });
    expect(timeline.statusCode).toBe(200);
    expect(timeline.json()).toMatchObject({
      durationSeconds: 300,
      sessionId: id,
      simulation: true,
    });
    expect(timeline.json<{ beats: unknown[] }>().beats).toHaveLength(16);

    const restarted = await app.inject({
      method: "POST",
      url: `/api/v1/demo/sessions/${id}/restart`,
    });
    expect(restarted.statusCode).toBe(200);
    expect(restarted.json()).toMatchObject({ cursor: 0, status: "ready" });
    await app.close();
  });

  it("streams all sixteen explicitly simulated beats automatically", async () => {
    const app = buildDemoApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/demo/sessions",
    });
    const { id } = created.json<{ id: string }>();

    const stream = await app.inject({
      method: "GET",
      url: `/api/v1/demo/sessions/${id}/stream`,
    });

    expect(stream.statusCode).toBe(200);
    expect(stream.headers["content-type"]).toContain("text/event-stream");
    const frames = stream.body
      .split("\n\n")
      .filter((frame) => frame.includes("event: demo.beat"));
    expect(frames).toHaveLength(16);
    const first = JSON.parse(frames[0]!.split("data: ")[1]!);
    const last = JSON.parse(frames.at(-1)!.split("data: ")[1]!);
    expect(first).toMatchObject({
      cursor: 1,
      matchMinute: "1'",
      simulation: true,
      type: "kickoff",
    });
    expect(last).toMatchObject({
      cursor: 16,
      progress: { percent: 100 },
      score: { away: 1, home: 2 },
      simulation: true,
      type: "full_time",
    });
    await app.close();
  });

  it("does not replace the existing goal replay contract", async () => {
    const app = buildDemoApp();
    const legacy = await app.inject({
      method: "POST",
      payload: { fixtureId: "arg-fra-demo" },
      url: "/api/v1/replay/sessions",
    });

    // The compatibility route still exists; without a ProductRuntime it
    // remains unavailable rather than being claimed by the demo API.
    expect(legacy.statusCode).toBe(404);
    await app.close();
  });

  it("returns JSON 404s for unknown demo sessions", async () => {
    const app = buildDemoApp();
    for (const request of [
      { method: "GET" as const, url: "/api/v1/demo/sessions/missing" },
      {
        method: "POST" as const,
        url: "/api/v1/demo/sessions/missing/restart",
      },
      {
        method: "GET" as const,
        url: "/api/v1/demo/sessions/missing/timeline",
      },
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(404);
    }
    await app.close();
  });
});
