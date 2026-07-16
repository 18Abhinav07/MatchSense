import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp, type ReadinessProbe } from "./app.js";

const indexShell = "<!doctype html><html><body>MatchSense shell</body></html>";
let webDistPath: string;

beforeAll(async () => {
  webDistPath = await mkdtemp(path.join(tmpdir(), "matchsense-web-"));
  await mkdir(path.join(webDistPath, "assets"));
  await writeFile(path.join(webDistPath, "index.html"), indexShell);
  await writeFile(path.join(webDistPath, "assets", "app.js"), "export {};");
});

afterAll(async () => {
  await rm(webDistPath, { force: true, recursive: true });
});

function appWithProbe(readinessProbe: ReadinessProbe) {
  return buildApp({ readinessProbe, webDistPath });
}

describe("health endpoints", () => {
  it("reports liveness without calling dependency probes", async () => {
    const check = vi.fn<ReadinessProbe["check"]>();
    const app = appWithProbe({ check });

    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(check).not.toHaveBeenCalled();
    await app.close();
  });

  it("reports ready only when database and migrations are ready", async () => {
    const readyApp = appWithProbe({
      check: async () => ({
        databaseReachable: true,
        migrationsCurrent: true,
      }),
    });
    const blockedApp = appWithProbe({
      check: async () => ({
        databaseReachable: true,
        migrationsCurrent: false,
      }),
    });

    const ready = await readyApp.inject({ url: "/health/ready" });
    const blocked = await blockedApp.inject({ url: "/health/ready" });

    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({
      checks: { database: "reachable", migrations: "current" },
      status: "ready",
    });
    expect(blocked.statusCode).toBe(503);
    expect(blocked.json()).toEqual({
      checks: { database: "reachable", migrations: "pending" },
      status: "not_ready",
    });

    await Promise.all([readyApp.close(), blockedApp.close()]);
  });

  it("returns a generic 503 when the readiness probe fails", async () => {
    const app = appWithProbe({
      check: async () => {
        throw new Error("postgresql://user:secret@internal.example/database");
      },
    });

    const response = await app.inject({ url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      checks: { database: "unreachable", migrations: "unknown" },
      status: "not_ready",
    });
    expect(response.body).not.toContain("secret");
    await app.close();
  });
});

describe("same-origin web shell", () => {
  const readinessProbe: ReadinessProbe = {
    check: async () => ({
      databaseReachable: true,
      migrationsCurrent: true,
    }),
  };

  it.each([
    "/",
    "/onboarding",
    "/matches/fixture-1",
    "/matches/fixture-1/live",
    "/matches/fixture-1/moments/moment-9",
    "/matches/fixture-1/memory",
    "/rooms",
    "/rooms/new",
    "/rooms/join/invite-code",
    "/rooms/room-1",
    "/you/profile",
    "/you/settings/notifications",
    "/demo",
    "/offline",
  ])("serves the SPA shell for %s", async (url) => {
    const app = appWithProbe(readinessProbe);
    const response = await app.inject({ url });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["cache-control"]).toContain("max-age=0");
    expect(response.body).toBe(indexShell);
    await app.close();
  });

  it("serves fingerprinted assets with MIME and immutable caching", async () => {
    const app = appWithProbe(readinessProbe);
    const response = await app.inject({ url: "/assets/app.js" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("javascript");
    expect(response.headers["cache-control"]).toContain("immutable");
    await app.close();
  });

  it.each([
    "/today",
    "/settings",
    "/diagnostics",
    "/moments/moment-1",
    "/memories/memory-1",
    "/api",
    "/api/v1/missing",
    "/health",
    "/health/missing",
    "/missing.png",
    "/you",
    "/you/",
    "/matches/fixture-1/unknown",
    "/matches/fixture-1/memory/extra",
    "/rooms/join/invite-code/extra",
  ])("does not turn %s into the SPA shell", async (url) => {
    const app = appWithProbe(readinessProbe);
    const response = await app.inject({ url });

    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Route not found" },
    });
    expect(response.body).not.toContain("MatchSense shell");
    await app.close();
  });
});
