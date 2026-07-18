import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type {
  CommentaryArtifactRecord,
  FixtureEventRecord,
} from "@matchsense/db";

import { buildApp } from "./app.js";

const fixtureId = "fixture-arg-fra";
const familyId = "txline:fixture-arg-fra:action:goal-23";
let webDistPath: string;

beforeAll(async () => {
  webDistPath = await mkdtemp(path.join(tmpdir(), "matchsense-commentary-"));
  await mkdir(path.join(webDistPath, "assets"));
  await writeFile(path.join(webDistPath, "index.html"), "<!doctype html>");
});

afterAll(async () => {
  await rm(webDistPath, { force: true, recursive: true });
});

describe("durable commentary artifact registration", () => {
  it("registers the live-only audio artifact route without a process-local runtime", async () => {
    const app = buildApp({
      commentaryArtifacts: {
        artifacts: {
          get: vi.fn(async (): Promise<CommentaryArtifactRecord> => ({
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
        truth: {
          eventsAfter: vi.fn(
            async (): Promise<readonly FixtureEventRecord[]> => [
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
            ],
          ),
        },
      },
      readinessProbe: {
        check: async () => ({
          databaseReachable: true,
          migrationsCurrent: true,
        }),
      },
      webDistPath,
    });

    const response = await app.inject({
      url: `/api/v1/fixtures/${fixtureId}/moments/${familyId}:3/audio`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("audio/mpeg");
    await app.close();
  });
});
