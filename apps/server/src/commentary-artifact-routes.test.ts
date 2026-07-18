import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type {
  CommentaryArtifactRecord,
  FixtureEventRecord,
} from "@matchsense/db";

import { registerCommentaryArtifactRoutes } from "./commentary-artifact-routes.js";

const fixtureId = "fixture-arg-fra";
const familyId = "txline:fixture-arg-fra:action:goal-23";
const identity = `${familyId}:3`;

function app(options: { latestRevision?: number } = {}) {
  const artifacts = {
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
  };
  const truth = {
    eventsAfter: vi.fn(async (): Promise<readonly FixtureEventRecord[]> => [
      {
        createdAt: "2026-07-18T12:23:00.000Z",
        eventId: `${fixtureId}:revision:${options.latestRevision ?? 3}`,
        eventType: "moment.created",
        fixtureId,
        mode: "live",
        payload: {
          event: "moment.created",
          moment: {
            familyId,
            fixtureId,
            revision: options.latestRevision ?? 3,
            status: "confirmed",
          },
        },
        sequence: 1,
      },
    ]),
  };
  const server = Fastify({ logger: false });
  registerCommentaryArtifactRoutes(server, { artifacts, truth });
  return { artifacts, server, truth };
}

describe("ready commentary artifact route", () => {
  it("serves only the current confirmed live revision as MP3", async () => {
    const { artifacts, server, truth } = app();

    const response = await server.inject({
      method: "GET",
      url: `/api/v1/fixtures/${fixtureId}/moments/${identity}/audio`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("audio/mpeg");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.rawPayload).toEqual(Buffer.from([0x49, 0x44, 0x33, 0x04]));
    expect(truth.eventsAfter).toHaveBeenCalledWith({
      afterSequence: 0,
      fixtureId,
      limit: 1_000,
      mode: "live",
    });
    expect(artifacts.get).toHaveBeenCalledWith({
      fixtureId,
      language: "en",
      mode: "live",
      momentId: familyId,
      momentRevision: 3,
      templateVersion: "factual-v1",
      voice: "Kore",
    });
    await server.close();
  });

  it("never serves a stale/corrected revision or accepts recorded-mode input", async () => {
    const { artifacts, server } = app({ latestRevision: 4 });

    const stale = await server.inject({
      method: "GET",
      url: `/api/v1/fixtures/${fixtureId}/moments/${identity}/audio`,
    });
    const recorded = await server.inject({
      method: "GET",
      url: `/api/v1/fixtures/${fixtureId}/moments/${identity}/audio?mode=recorded`,
    });

    expect(stale.statusCode).toBe(404);
    expect(recorded.statusCode).toBe(400);
    expect(artifacts.get).not.toHaveBeenCalled();
    await server.close();
  });
});
