import { Buffer } from "node:buffer";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { FixtureReadRepository, ReplayReadyFixture } from "@matchsense/db";

const fixtureId = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9_:%-]+$/u);
const createBody = z.object({ fixtureId }).strict();

export interface RecordedReplaySession {
  archiveManifestId: string;
  fixtureId: string;
  id: string;
  mode: "recorded";
  replaySeq: 0;
}

export interface ReplayRouteDependencies {
  reads: FixtureReadRepository;
}

function base64Url(value: string) {
  return Buffer.from(value).toString("base64url");
}

function parseSessionId(
  value: string,
): { archiveManifestId: string; fixtureId: string } | null {
  if (!value.startsWith("recorded_")) return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value.slice("recorded_".length), "base64url").toString(
        "utf8",
      ),
    );
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as { fixtureId?: unknown }).fixtureId !== "string" ||
      typeof (parsed as { archiveManifestId?: unknown }).archiveManifestId !==
        "string"
    ) {
      return null;
    }
    const fixture = fixtureId.safeParse(
      (parsed as { fixtureId: string }).fixtureId,
    );
    const manifestId = (parsed as { archiveManifestId: string })
      .archiveManifestId;
    if (!fixture.success || !/^[A-Za-z0-9_:%-]{1,160}$/u.test(manifestId))
      return null;
    return { archiveManifestId: manifestId, fixtureId: fixture.data };
  } catch {
    return null;
  }
}

export function recordedReplaySession(
  replay: ReplayReadyFixture,
): RecordedReplaySession {
  const id = `recorded_${base64Url(
    JSON.stringify({
      archiveManifestId: replay.archiveManifestId,
      fixtureId: replay.fixture.fixtureId,
      v: 1,
    }),
  )}`;
  return {
    archiveManifestId: replay.archiveManifestId,
    fixtureId: replay.fixture.fixtureId,
    id,
    mode: "recorded",
    replaySeq: 0,
  };
}

async function resolveSession(
  reads: FixtureReadRepository,
  sessionId: string,
): Promise<RecordedReplaySession | null> {
  const parsed = parseSessionId(sessionId);
  if (!parsed) return null;
  const replay = await reads.getReplayReady(parsed.fixtureId);
  if (!replay || replay.archiveManifestId !== parsed.archiveManifestId)
    return null;
  return recordedReplaySession(replay);
}

function replayEvent(
  session: RecordedReplaySession,
  sequence: number,
  payload: unknown,
) {
  return `id: ${session.id}:${sequence}\nevent: replay.event\ndata: ${JSON.stringify(
    {
      mode: "recorded",
      replaySeq: sequence,
      replaySessionId: session.id,
      ...(payload && typeof payload === "object"
        ? { event: payload }
        : { event: { payload } }),
    },
  )}\n\n`;
}

export function registerReplayRoutes(
  app: FastifyInstance,
  dependencies: ReplayRouteDependencies,
) {
  app.post("/api/v1/replay/sessions", async (request, reply) => {
    const body = createBody.safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ error: "replay_request_invalid" });
    const replay = await dependencies.reads.getReplayReady(body.data.fixtureId);
    return replay
      ? reply
          .code(201)
          .header("Cache-Control", "no-store")
          .send(recordedReplaySession(replay))
      : reply.code(404).send({ error: "replay_not_ready" });
  });

  app.get<{ Params: { id: string } }>(
    "/api/v1/replay/sessions/:id",
    async (request, reply) => {
      const session = await resolveSession(
        dependencies.reads,
        request.params.id,
      );
      return session
        ? reply.header("Cache-Control", "no-store").send(session)
        : reply.code(404).send({ error: "replay_not_ready" });
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: { after?: string };
  }>("/api/v1/replay/sessions/:id/timeline", async (request, reply) => {
    const session = await resolveSession(dependencies.reads, request.params.id);
    if (!session) return reply.code(404).send({ error: "replay_not_ready" });
    const after =
      request.query.after === undefined ? 0 : Number(request.query.after);
    if (!Number.isSafeInteger(after) || after < 0) {
      return reply.code(400).send({ error: "replay_request_invalid" });
    }
    const feed = await dependencies.reads.readFixtureFeed({
      afterSequence: after,
      fixtureId: session.fixtureId,
    });
    if (!feed) return reply.code(404).send({ error: "replay_not_ready" });
    return reply.header("Cache-Control", "no-store").send({
      ...session,
      events: feed.events.map((event) => ({
        event: event.payload,
        replaySeq: event.sequence,
      })),
      highWaterSequence: feed.highWaterSequence,
      snapshot: feed.snapshot,
    });
  });

  app.get<{
    Params: { id: string };
    Querystring: { after?: string };
  }>("/api/v1/replay/sessions/:id/stream", async (request, reply) => {
    const session = await resolveSession(dependencies.reads, request.params.id);
    if (!session) return reply.code(404).send({ error: "replay_not_ready" });
    const after =
      request.query.after === undefined ? 0 : Number(request.query.after);
    if (!Number.isSafeInteger(after) || after < 0) {
      return reply.code(400).send({ error: "replay_request_invalid" });
    }
    const feed = await dependencies.reads.readFixtureFeed({
      afterSequence: after,
      fixtureId: session.fixtureId,
    });
    if (!feed) return reply.code(404).send({ error: "replay_not_ready" });
    reply.hijack();
    reply.raw.writeHead(200, {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    });
    reply.raw.write(
      `event: replay.snapshot\ndata: ${JSON.stringify({
        ...session,
        highWaterSequence: feed.highWaterSequence,
        snapshot: feed.snapshot,
      })}\n\n`,
    );
    for (const event of feed.events) {
      reply.raw.write(replayEvent(session, event.sequence, event.payload));
    }
    reply.raw.end();
    return reply;
  });
}
