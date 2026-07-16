import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import * as serverModule from "./main.js";

interface TestDatabaseRuntime {
  check(): Promise<{
    databaseReachable: boolean;
    migrationsCurrent: boolean;
  }>;
  close(): Promise<void>;
}

type StartServerContract = (options: {
  databaseFactory: (databaseUrl: string) => TestDatabaseRuntime;
  environment: Record<string, string | undefined>;
  listen: boolean;
  signalSource: EventEmitter;
  webDistPath: string;
}) => Promise<{
  close(): Promise<void>;
  inject(options: { url: string }): Promise<{
    json(): unknown;
    statusCode: number;
  }>;
}>;

async function temporaryWebShell() {
  const directory = await mkdtemp(path.join(tmpdir(), "matchsense-main-"));
  await mkdir(path.join(directory, "assets"));
  await writeFile(
    path.join(directory, "index.html"),
    "<!doctype html><title>MatchSense</title>",
  );
  return directory;
}

describe("server entrypoint", () => {
  it("is safe to import without parsing environment or opening a listener", async () => {
    const entrypoint = await import("./main.js");

    expect(entrypoint.startServer).toBeTypeOf("function");
  });

  it("uses real database readiness by default and closes HTTP plus DB once", async () => {
    const webDistPath = await temporaryWebShell();
    const signalSource = new EventEmitter();
    const runtime = {
      check: vi.fn(async () => ({
        databaseReachable: true,
        migrationsCurrent: true,
      })),
      close: vi.fn(async () => undefined),
    };
    const databaseFactory = vi.fn(() => runtime);
    const startServer = serverModule.startServer as StartServerContract;
    let app: Awaited<ReturnType<StartServerContract>> | undefined;

    try {
      app = await startServer({
        databaseFactory,
        environment: {
          DATABASE_URL: "postgresql://db.example/matchsense",
        },
        listen: false,
        signalSource,
        webDistPath,
      });

      expect(databaseFactory).toHaveBeenCalledExactlyOnceWith(
        "postgresql://db.example/matchsense",
      );
      const ready = await app.inject({ url: "/health/ready" });
      expect(ready.statusCode).toBe(200);
      expect(ready.json()).toEqual({
        checks: { database: "reachable", migrations: "current" },
        status: "ready",
      });

      signalSource.emit("SIGTERM");
      signalSource.emit("SIGINT");
      await vi.waitFor(() => expect(runtime.close).toHaveBeenCalledTimes(1));
      await app.close();
      expect(runtime.close).toHaveBeenCalledTimes(1);
      expect(signalSource.listenerCount("SIGINT")).toBe(0);
      expect(signalSource.listenerCount("SIGTERM")).toBe(0);
    } finally {
      if (app) {
        await app.close();
      }
      await rm(webDistPath, { force: true, recursive: true });
    }
  });
});
