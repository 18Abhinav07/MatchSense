import type { FastifyInstance } from "fastify";

import type { FixtureFeed, FixtureReadRepository } from "@matchsense/db";

export interface FixtureStreamCursor {
  afterSequence: number | null;
  forceReset: boolean;
}

export interface FixtureStreamSession {
  close(): void;
}

export interface CreateFixtureStreamSessionOptions {
  afterSequence: number | null;
  fixtureId: string;
  forceReset?: boolean | undefined;
  heartbeatMs?: number | undefined;
  pollMs?: number | undefined;
  reads: FixtureReadRepository;
  write(value: string): void;
}

export interface FixtureStreamRouteDependencies {
  heartbeatMs?: number | undefined;
  pollMs?: number | undefined;
  reads: FixtureReadRepository;
}

function safeSequence(value: string): number | null {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) return null;
  const sequence = Number(value);
  return Number.isSafeInteger(sequence) ? sequence : null;
}

function cursorFromEventId(fixtureId: string, eventId: string): number | null {
  const prefix = `${fixtureId}:`;
  return eventId.startsWith(prefix)
    ? safeSequence(eventId.slice(prefix.length))
    : null;
}

/** Native EventSource reconnect headers intentionally outrank URL query state. */
export function resolveFixtureStreamCursor(input: {
  fixtureId: string;
  header: string | undefined;
  query: string | undefined;
}): FixtureStreamCursor {
  if (input.header !== undefined) {
    const sequence = cursorFromEventId(input.fixtureId, input.header);
    return sequence === null
      ? { afterSequence: null, forceReset: true }
      : { afterSequence: sequence, forceReset: false };
  }
  if (input.query === undefined) {
    return { afterSequence: null, forceReset: false };
  }
  const sequence = safeSequence(input.query);
  return sequence === null
    ? { afterSequence: null, forceReset: true }
    : { afterSequence: sequence, forceReset: false };
}

function format(event: string, id: string, payload: unknown) {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function snapshotEvent(feed: FixtureFeed) {
  return format(
    "snapshot",
    `${feed.snapshot.fixtureId}:${feed.highWaterSequence}`,
    {
      highWaterSequence: feed.highWaterSequence,
      snapshot: feed.snapshot,
    },
  );
}

function resetEvent(feed: FixtureFeed) {
  return format(
    "stream.reset",
    `${feed.snapshot.fixtureId}:${feed.highWaterSequence}`,
    {
      highWaterSequence: feed.highWaterSequence,
      snapshot: feed.snapshot,
    },
  );
}

function eventEnvelope(
  fixtureId: string,
  event: FixtureFeed["events"][number],
) {
  return format(event.eventType, `${fixtureId}:${event.sequence}`, {
    event: {
      createdAt: event.createdAt,
      eventId: event.eventId,
      eventType: event.eventType,
      payload: event.payload,
      sequence: event.sequence,
    },
  });
}

function interval(value: number | undefined, fallback: number, label: string) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 100) {
    throw new Error(`${label} interval is invalid`);
  }
  return result;
}

export async function createFixtureStreamSession(
  options: CreateFixtureStreamSessionOptions,
): Promise<FixtureStreamSession | null> {
  const heartbeatMs = interval(options.heartbeatMs, 15_000, "Heartbeat");
  const pollMs = interval(options.pollMs, 5_000, "Fixture poll");
  let closed = false;
  let lastSentSequence = options.afterSequence ?? 0;
  let initial = true;

  const flush = async () => {
    const feed = await options.reads.readFixtureFeed({
      afterSequence: initial ? options.afterSequence : lastSentSequence,
      fixtureId: options.fixtureId,
    });
    if (!feed) return false;

    if (initial) {
      options.write(snapshotEvent(feed));
      if (options.forceReset || feed.reset) options.write(resetEvent(feed));
      initial = false;
    }
    for (const event of feed.events) {
      if (event.sequence <= lastSentSequence) continue;
      options.write(eventEnvelope(options.fixtureId, event));
      lastSentSequence = event.sequence;
    }
    lastSentSequence = Math.max(lastSentSequence, feed.highWaterSequence);
    return true;
  };

  if (!(await flush())) return null;
  const heartbeat = setInterval(() => {
    if (!closed) options.write(`: heartbeat ${Date.now()}\n\n`);
  }, heartbeatMs);
  const poll = setInterval(() => {
    if (closed) return;
    void flush().catch(() => undefined);
  }, pollMs);
  heartbeat.unref?.();
  poll.unref?.();

  return {
    close: () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearInterval(poll);
    },
  };
}

export function registerFixtureStreamRoutes(
  app: FastifyInstance,
  dependencies: FixtureStreamRouteDependencies,
) {
  app.get<{
    Params: { fixtureId: string };
    Querystring: { after?: string };
  }>("/api/v1/fixtures/:fixtureId/stream", async (request, reply) => {
    const fixtureId = request.params.fixtureId;
    if (!/^[A-Za-z0-9_:%-]{1,120}$/u.test(fixtureId)) {
      return reply.code(400).send({ error: "fixture_request_invalid" });
    }
    const fixture = await dependencies.reads.getFixture(fixtureId);
    if (!fixture) return reply.code(404).send({ error: "fixture_not_found" });

    const header = request.headers["last-event-id"];
    const cursor = resolveFixtureStreamCursor({
      fixtureId,
      header: Array.isArray(header) ? header[0] : header,
      query: request.query.after,
    });
    reply.hijack();
    reply.raw.writeHead(200, {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    });
    const session = await createFixtureStreamSession({
      afterSequence: cursor.afterSequence,
      fixtureId,
      forceReset: cursor.forceReset,
      ...(dependencies.heartbeatMs === undefined
        ? {}
        : { heartbeatMs: dependencies.heartbeatMs }),
      ...(dependencies.pollMs === undefined
        ? {}
        : { pollMs: dependencies.pollMs }),
      reads: dependencies.reads,
      write: (value) => {
        reply.raw.write(value);
      },
    });
    if (!session) {
      reply.raw.end();
      return reply;
    }
    request.raw.once("close", () => session.close());
    return reply;
  });
}
