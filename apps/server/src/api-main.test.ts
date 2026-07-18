import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { parseServerEnv } from "./config.js";
import { startApi } from "./api-main.js";

async function temporaryWebShell() {
  const directory = await mkdtemp(path.join(tmpdir(), "matchsense-api-"));
  await mkdir(path.join(directory, "assets"));
  await writeFile(
    path.join(directory, "index.html"),
    "<!doctype html><title>MatchSense</title>",
  );
  return directory;
}

describe("API-only runtime", () => {
  it("boots static/readiness routes without migrations or public demo routes", async () => {
    const webDistPath = await temporaryWebShell();
    const database = {
      check: vi.fn(async () => ({
        databaseReachable: true,
        migrationsCurrent: true,
      })),
      close: vi.fn(async () => undefined),
      fans: {},
      migrate: vi.fn(async () => undefined),
      pushDevices: {},
    };

    try {
      const app = await startApi(
        parseServerEnv({
          DATABASE_URL: "postgresql://db.example/matchsense",
          ROLE: "api",
        }),
        { databaseRuntime: database as never, listen: false, webDistPath },
      );

      expect((await app.inject({ url: "/health/ready" })).statusCode).toBe(200);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/demo/sessions",
          })
        ).statusCode,
      ).toBe(404);
      expect((await app.inject({ url: "/demo" })).statusCode).toBe(404);
      expect(database.migrate).not.toHaveBeenCalled();
      await app.close();
      expect(database.close).toHaveBeenCalledOnce();
    } finally {
      await rm(webDistPath, { force: true, recursive: true });
    }
  });
});
