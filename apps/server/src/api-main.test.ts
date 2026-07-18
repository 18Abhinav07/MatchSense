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

  it("exposes ready live commentary artifacts through the credential-free API role", async () => {
    const webDistPath = await temporaryWebShell();
    const fixtureId = "fixture-arg-fra";
    const familyId = "txline:fixture-arg-fra:action:goal-23";
    const database = {
      check: vi.fn(async () => ({
        databaseReachable: true,
        migrationsCurrent: true,
      })),
      close: vi.fn(async () => undefined),
      commentaryArtifacts: {
        get: vi.fn(async () => ({
          bytes: new Uint8Array([0x49, 0x44, 0x33, 0x04]),
          createdAt: "2026-07-18T12:23:00.000Z",
          fixtureId,
          id: "audio-1",
          language: "en",
          mediaType: "audio/mpeg",
          mode: "live",
          momentId: familyId,
          momentRevision: 3,
          templateVersion: "factual-v1",
          updatedAt: "2026-07-18T12:23:00.000Z",
          voice: "Kore",
        })),
      },
      fans: {},
      fixtureTruth: {
        eventsAfter: vi.fn(async () => [
          {
            createdAt: "2026-07-18T12:23:00.000Z",
            eventId: `${fixtureId}:revision:3`,
            eventType: "moment.created",
            fixtureId,
            mode: "live",
            payload: {
              event: "moment.created",
              moment: {
                familyId,
                fixtureId,
                revision: 3,
                status: "confirmed",
              },
            },
            sequence: 1,
          },
        ]),
      },
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
      const response = await app.inject({
        url: `/api/v1/fixtures/${fixtureId}/moments/${familyId}:3/audio`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("audio/mpeg");
      await app.close();
    } finally {
      await rm(webDistPath, { force: true, recursive: true });
    }
  });
});
