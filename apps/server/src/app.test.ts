import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp, isCanonicalShellPath, type ReadinessProbe } from "./app.js";

const indexShell = "<!doctype html><html><body>MatchSense shell</body></html>";
let webDistPath: string;

const dotOnlySegments = [".", "..", "%2E", "%2E%2E"] as const;
const dotOnlyShellPaths = dotOnlySegments.flatMap((segment) => [
  `/you/${segment}`,
  `/you/profile/${segment}`,
  `/matches/${segment}`,
  `/matches/${segment}/live`,
  `/matches/${segment}/memory`,
  `/matches/fixture-1/moments/${segment}`,
  `/rooms/new/${segment}`,
  `/rooms/join/${segment}`,
  `/rooms/${segment}`,
  `/replays/${segment}`,
]);

beforeAll(async () => {
  webDistPath = await mkdtemp(path.join(tmpdir(), "matchsense-web-"));
  await mkdir(path.join(webDistPath, "assets"));
  await mkdir(path.join(webDistPath, "icons"));
  await writeFile(path.join(webDistPath, "index.html"), indexShell);
  await writeFile(
    path.join(webDistPath, "assets", "index-AbC123xy.js"),
    "export {};",
  );
  await writeFile(
    path.join(webDistPath, "manifest.webmanifest"),
    JSON.stringify({ name: "MatchSense" }),
  );
  await writeFile(path.join(webDistPath, "sw.js"), "self.addEventListener;");
  await writeFile(path.join(webDistPath, "icons", "app-icon.png"), "png");
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
    "/you",
    "/you/profile",
    "/you/settings/notifications",
    "/experience",
    "/experience/run-1",
    "/experience/run-1/moments/run-1%3Agoal%3A3",
    "/matches/fixture-1",
    "/matches/fixture%3Alive",
    "/matches/fixture-1/live",
    "/matches/fixture-1/moments/moment-9",
    "/matches/fixture-1/memory",
    "/rooms",
    "/rooms/new/fixture-1",
    "/rooms/join/invite-code",
    "/rooms/room-1",
    "/replays",
    "/replays/replay.abc.def",
  ])("serves the SPA shell for %s", async (url) => {
    const app = appWithProbe(readinessProbe);
    const response = await app.inject({ url });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["cache-control"]).toBe("no-cache");
    expect(response.body).toBe(indexShell);
    await app.close();
  });

  it("serves fingerprinted assets with MIME and immutable caching", async () => {
    const app = appWithProbe(readinessProbe);
    const response = await app.inject({ url: "/assets/index-AbC123xy.js" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("javascript");
    expect(response.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
    await app.close();
  });

  it.each([
    "/index.html",
    "/manifest.webmanifest",
    "/sw.js",
    "/icons/app-icon.png",
  ])(
    "never caches stable application resource %s as immutable",
    async (url) => {
      const app = appWithProbe(readinessProbe);
      const response = await app.inject({ url });

      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-cache");
      expect(response.headers["cache-control"]).not.toContain("immutable");
      await app.close();
    },
  );

  it.each([
    "/onboarding",
    "/experience/run-1/moments",
    "/experience/run-1/moments/moment-1/extra",
    "/history",
    "/demo",
    "/offline",
    "/rooms/new",
    "/rooms/join",
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
    "/you/",
    "/matches/fixture-1/unknown",
    "/matches/fixture-1/memory/extra",
    "/matches/fixture-1/moments/moment-9/extra",
    "/rooms/join/invite-code/extra",
    "/replays/replay.abc.def/extra",
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

  it.each([
    "/matches/a%2Fb",
    "/matches/a%2fb",
    "/matches/a%5Cb",
    "/matches/a%5cb",
    "/matches/a%252Fb",
    "/rooms/new%2Ffixture",
    "/rooms/new%5Cfixture",
    "/matches/a%3Fb",
    "/matches/a%40b",
    "/matches/a%25b",
    "/matches/a@b",
    "/matches/a\\fixture",
  ])("rejects unsafe encoded shell path %s", async (url) => {
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

  it.each(["/matches/a%ZZb", "/matches/a%", "/matches/a%2"])(
    "rejects malformed path escape %s before serving the shell",
    async (url) => {
      const app = appWithProbe(readinessProbe);
      const response = await app.inject({ url });

      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain("MatchSense shell");
      await app.close();
    },
  );

  it.each(dotOnlyShellPaths)(
    "does not recognize dot-only route segment %s as a shell path",
    (url) => {
      // app.inject parses with WHATWG URL semantics, which resolves dot segments
      // before Fastify receives them. Exercise the server's shell matcher directly.
      expect(isCanonicalShellPath(decodeURIComponent(url))).toBe(false);
    },
  );
});
