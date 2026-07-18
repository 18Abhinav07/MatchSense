import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { FixtureReadRepository } from "@matchsense/db";

import { buildApp } from "./app.js";

let webDistPath: string;

beforeAll(async () => {
  webDistPath = await mkdtemp(path.join(tmpdir(), "matchsense-api-read-"));
  await mkdir(path.join(webDistPath, "icons"));
  await writeFile(path.join(webDistPath, "index.html"), "<!doctype html>");
  await writeFile(path.join(webDistPath, "icons", "app.svg"), "svg");
});

afterAll(async () => {
  await rm(webDistPath, { force: true, recursive: true });
});

function reads(): FixtureReadRepository {
  return {
    getFixture: vi.fn(async () => null),
    getReplayReady: vi.fn(async () => null),
    listFixtures: vi.fn(async () => []),
    readFixtureFeed: vi.fn(async () => null),
    readHistory: vi.fn(async () => []),
    readMemory: vi.fn(async () => null),
    readMoment: vi.fn(async () => null),
  };
}

describe("durable read API registration", () => {
  it("registers fixture, cursor stream, and recorded replay routes without ProductRuntime", async () => {
    const app = buildApp({
      fixtureRead: { reads: reads() },
      readinessProbe: {
        check: async () => ({
          databaseReachable: true,
          migrationsCurrent: true,
        }),
      },
      webDistPath,
    });

    const fixtures = await app.inject({
      method: "GET",
      url: "/api/v1/fixtures",
    });
    const replay = await app.inject({
      method: "POST",
      payload: { fixtureId: "fx-final" },
      url: "/api/v1/replay/sessions",
    });

    expect(fixtures.statusCode).toBe(200);
    expect(replay.statusCode).toBe(404);
    await app.close();
  });
});
