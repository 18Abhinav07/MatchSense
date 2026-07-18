import path from "node:path";
import { createHash } from "node:crypto";

import fastifyStatic from "@fastify/static";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { z } from "zod";

import {
  TEAM_CODE_PATTERN,
  type FixtureStreamEvent,
  type TeamCode,
} from "@matchsense/contracts";

import type { AudioWritable } from "./audio-hub.js";
import { registerDemoRoutes } from "./demo-routes.js";
import {
  createDemoSessionRuntime,
  type DemoSessionRuntime,
} from "./demo-runtime.js";
import {
  type DurablePushRouteDependencies,
  registerDurablePushRoutes,
} from "./durable-push.js";
import {
  type DurableRoomRouteDependencies,
  registerDurableRoomRoutes,
} from "./durable-room-routes.js";
import type { ExperienceRuntime } from "./experience-runtime.js";
import {
  type FanRouteDependencies,
  registerFanRoutes,
  requireFanMutationSession,
} from "./fan-routes.js";
import type { FanSessionService } from "./fan-session.js";
import {
  type MemoryRouteDependencies,
  registerMemoryRoutes,
} from "./memory-routes.js";
import type { ProductRuntime } from "./product-runtime.js";
import {
  type PushRouteDependencies,
  registerPushRoutes,
} from "./push-delivery.js";
import { registerRoomRoutes } from "./room-routes.js";
import { createRoomService, type RoomService } from "./room-service.js";

export interface ReadinessResult {
  databaseReachable: boolean;
  migrationsCurrent: boolean;
}

export interface ReadinessProbe {
  check(): Promise<ReadinessResult>;
}

export interface BuildAppOptions {
  allowDemoShell?: boolean;
  demo?: DemoSessionRuntime | false;
  durablePush?: DurablePushRouteDependencies;
  durableRooms?: DurableRoomRouteDependencies;
  experience?: ExperienceRuntime;
  fan?: FanRouteDependencies;
  manageRuntimeLifecycle?: boolean;
  readinessProbe: ReadinessProbe;
  memory?: MemoryRouteDependencies;
  webDistPath: string;
  runtime?: ProductRuntime;
  push?: PushRouteDependencies;
  rooms?: RoomService;
}

function readinessPayload(result: ReadinessResult) {
  return {
    checks: {
      database: result.databaseReachable ? "reachable" : "unreachable",
      migrations: result.migrationsCurrent ? "current" : "pending",
    },
    status:
      result.databaseReachable && result.migrationsCurrent
        ? "ready"
        : "not_ready",
  } as const;
}

const segment = "[A-Za-z0-9_:%-]+";

const canonicalShellRoutes = [
  { pattern: /^\/$/u, template: "/" },
  { pattern: /^\/onboarding$/u, template: "/onboarding" },
  {
    pattern: /^\/experience\/with-friends$/u,
    template: "/experience/with-friends",
  },
  {
    pattern: new RegExp(`^/matches/${segment}$`, "u"),
    template: "/matches/:fixtureId",
  },
  {
    pattern: new RegExp(`^/matches/${segment}/live$`, "u"),
    template: "/matches/:fixtureId/live",
  },
  {
    pattern: new RegExp(`^/matches/${segment}/moments/${segment}$`, "u"),
    template: "/matches/:fixtureId/moments/:momentId",
  },
  {
    pattern: new RegExp(`^/matches/${segment}/memory$`, "u"),
    template: "/matches/:fixtureId/memory",
  },
  { pattern: /^\/rooms$/u, template: "/rooms" },
  { pattern: /^\/rooms\/new$/u, template: "/rooms/new" },
  {
    pattern: new RegExp(`^/rooms/new/${segment}$`, "u"),
    template: "/rooms/new/:fixtureId",
  },
  {
    pattern: new RegExp(`^/rooms/join/${segment}$`, "u"),
    template: "/rooms/join/:inviteCode",
  },
  {
    pattern: new RegExp(`^/rooms/${segment}$`, "u"),
    template: "/rooms/:roomId",
  },
  {
    pattern: new RegExp(`^/you/${segment}(?:/${segment})*$`, "u"),
    template: "/you/*",
  },
  { pattern: /^\/history$/u, template: "/history" },
  { pattern: /^\/demo$/u, template: "/demo" },
  { pattern: /^\/offline$/u, template: "/offline" },
] as const;

export function isCanonicalShellPath(pathname: string) {
  return canonicalShellRoutes.some(({ pattern }) => pattern.test(pathname));
}

function notFound(reply: FastifyReply) {
  return reply.code(404).send({
    error: { code: "NOT_FOUND", message: "Route not found" },
  });
}

function cacheControlForStaticFile(root: string, filePath: string) {
  const relativePath = path.relative(root, filePath).split(path.sep).join("/");
  const isFingerprintAsset =
    /^assets\/(?:.+\/)*[^/]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/u.test(
      relativePath,
    );

  return isFingerprintAsset
    ? "public, max-age=31536000, immutable"
    : "no-cache";
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const demo =
    options.demo === false
      ? null
      : (options.demo ?? createDemoSessionRuntime());

  app.get("/health/live", async () => ({ status: "ok" }));

  if (demo) {
    registerDemoRoutes(app, demo);
    app.addHook("preClose", () => demo.close());
  }

  app.get("/health/ready", async (_request, reply) => {
    try {
      const result = await options.readinessProbe.check();
      const payload = readinessPayload(result);
      return reply.code(payload.status === "ready" ? 200 : 503).send(payload);
    } catch {
      return reply.code(503).send({
        checks: { database: "unreachable", migrations: "unknown" },
        status: "not_ready",
      });
    }
  });

  if (options.runtime) {
    registerProductRoutes(app, options.runtime);
    if (options.manageRuntimeLifecycle !== false) {
      app.addHook("preClose", () => {
        options.runtime?.close();
      });
    }
  }
  if (options.experience) {
    registerExperienceRoutes(app, options.experience, options.fan?.sessions);
    app.addHook("preClose", () => options.experience?.close());
  }
  if (options.fan) {
    registerFanRoutes(app, options.fan);
  }
  if (options.durablePush) {
    registerDurablePushRoutes(app, options.durablePush);
  } else if (options.push) {
    registerPushRoutes(app, options.push);
  }
  if (options.memory) {
    registerMemoryRoutes(app, options.memory);
  }
  if (options.durableRooms) {
    registerDurableRoomRoutes(app, options.durableRooms);
  }
  const rooms = options.durableRooms
    ? null
    : (options.rooms ??
      (options.runtime
        ? createRoomService({
            fixture: (fixtureId) => options.runtime?.fixture(fixtureId) ?? null,
          })
        : null));
  if (rooms) {
    registerRoomRoutes(app, rooms);
    if (options.runtime) {
      const productRuntime = options.runtime;
      const unsubscribeRooms: (() => void)[] = [];
      const subscribedFixtures = new Set<string>();
      const subscribeRoomFixture = (fixtureId: string) => {
        if (subscribedFixtures.has(fixtureId)) return;
        subscribedFixtures.add(fixtureId);
        const unsubscribeCanonical = productRuntime.subscribeCanonicalEvent(
          fixtureId,
          (event) => rooms.applyCanonicalEvent(event),
        );
        const unsubscribeFixture = productRuntime.subscribeFixture(
          fixtureId,
          (event) => rooms.applyFixtureEvent(event),
        );
        if (unsubscribeCanonical) unsubscribeRooms.push(unsubscribeCanonical);
        if (unsubscribeFixture) unsubscribeRooms.push(unsubscribeFixture);
      };
      for (const fixture of productRuntime.fixtures()) {
        subscribeRoomFixture(fixture.fixtureId);
      }
      if (typeof productRuntime.onFixtureRegistered === "function") {
        unsubscribeRooms.push(
          productRuntime.onFixtureRegistered(subscribeRoomFixture),
        );
      }
      app.addHook("preClose", () => {
        for (const unsubscribe of unsubscribeRooms) unsubscribe();
      });
    }
  }

  void app.register(fastifyStatic, {
    cacheControl: false,
    index: false,
    root: options.webDistPath,
    setHeaders: (reply, filePath) => {
      reply.header(
        "Cache-Control",
        cacheControlForStaticFile(options.webDistPath, filePath),
      );
    },
    wildcard: false,
  });

  const sendShell = (reply: FastifyReply) =>
    reply
      .type("text/html; charset=utf-8")
      .sendFile("index.html", { immutable: false, maxAge: 0 });

  app.setNotFoundHandler((request, reply) => {
    const pathname = new URL(request.url, "http://matchsense.local").pathname;
    const acceptsShell = request.method === "GET" || request.method === "HEAD";

    const demoShellBlocked =
      pathname === "/demo" && options.allowDemoShell === false;
    if (acceptsShell && !demoShellBlocked && isCanonicalShellPath(pathname)) {
      return sendShell(reply);
    }

    return notFound(reply);
  });

  return app;
}

const teamCode = z.string().regex(TEAM_CODE_PATTERN);
const replaySessionBody = z
  .object({ fixtureId: z.string().min(1).max(80) })
  .strict();
const replayCommandBody = z
  .object({
    listeningSessionId: z.string().min(1).max(120).nullable().optional(),
    marker: z.literal("goal"),
    type: z.literal("advance_to_marker"),
  })
  .strict();
const listeningSessionBody = z.object({ perspectiveTeam: teamCode }).strict();
const experienceRunBody = z
  .object({
    awayTeam: teamCode,
    homeTeam: teamCode,
  })
  .strict();

function formatSse(event: FixtureStreamEvent) {
  return `id: ${event.id}\nevent: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`;
}

function invalidRequest(reply: FastifyReply) {
  return reply.code(400).send({
    error: { code: "INVALID_REQUEST", message: "Request is invalid" },
  });
}

function registerExperienceRoutes(
  app: FastifyInstance,
  experience: ExperienceRuntime,
  fanSessions?: FanSessionService,
) {
  const startRun = async (request: FastifyRequest, reply: FastifyReply) => {
    const session = fanSessions
      ? await requireFanMutationSession(request, reply, fanSessions)
      : null;
    if (fanSessions && !session) return;
    const body = experienceRunBody.safeParse(request.body);
    if (!body.success || body.data.homeTeam === body.data.awayTeam) {
      return invalidRequest(reply);
    }
    const rawIdempotencyKey = request.headers["idempotency-key"];
    const idempotencyKey = Array.isArray(rawIdempotencyKey)
      ? rawIdempotencyKey[0]
      : rawIdempotencyKey;
    if (
      idempotencyKey !== undefined &&
      !/^[A-Za-z0-9_.:-]{8,120}$/u.test(idempotencyKey)
    ) {
      return invalidRequest(reply);
    }
    const runId = idempotencyKey
      ? `run_${createHash("sha256")
          .update(`${session?.fan.id ?? "anonymous"}|${idempotencyKey}`)
          .digest("hex")
          .slice(0, 32)}`
      : undefined;
    const run = await experience.startRun({
      awayTeam: body.data.awayTeam,
      homeTeam: body.data.homeTeam,
      ownerFanId: session?.fan.id ?? null,
      ...(runId ? { runId } : {}),
    });
    return reply.code(201).send({ run });
  };
  app.post("/api/v1/experience/runs", startRun);
  app.post("/api/v1/experience/runs/start", startRun);
  app.get<{ Params: { runId: string } }>(
    "/api/v1/experience/runs/:runId",
    async (request, reply) => {
      const run = await experience.getRun(request.params.runId);
      return run ? reply.send({ run }) : notFound(reply);
    },
  );
}

function registerProductRoutes(app: FastifyInstance, runtime: ProductRuntime) {
  app.get("/api/v1/catalog", async (_request, reply) =>
    reply.header("Cache-Control", "no-store").send(runtime.catalog()),
  );
  app.get("/api/v1/fixtures", async (_request, reply) =>
    reply
      .header("Cache-Control", "no-store")
      .send({ fixtures: runtime.fixtures() }),
  );
  app.get<{ Params: { fixtureId: string } }>(
    "/api/v1/fixtures/:fixtureId",
    async (request, reply) => {
      const fixture = runtime.fixture(request.params.fixtureId);
      return fixture ? reply.send(fixture) : notFound(reply);
    },
  );
  app.get<{ Params: { fixtureId: string; identity: string } }>(
    "/api/v1/fixtures/:fixtureId/moments/:identity",
    async (request, reply) => {
      const resolved = runtime.resolveMoment(
        request.params.fixtureId,
        request.params.identity,
      );
      return resolved
        ? reply.header("Cache-Control", "no-store").send(resolved)
        : notFound(reply);
    },
  );
  app.get<{ Params: { fixtureId: string } }>(
    "/api/v1/fixtures/:fixtureId/stream",
    (request, reply) => {
      const fixture = runtime.fixture(request.params.fixtureId);
      if (!fixture) return notFound(reply);
      reply.hijack();
      reply.raw.writeHead(200, {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      });
      const lastEventIdHeader = request.headers["last-event-id"];
      const lastEventId =
        typeof lastEventIdHeader === "string" ? lastEventIdHeader : null;
      if (lastEventId) {
        const history = runtime.fixtureEvents(request.params.fixtureId);
        const cursor = history.findIndex((event) => event.id === lastEventId);
        const missedMoments = (cursor >= 0 ? history.slice(cursor + 1) : [])
          .map((event) => event.moment)
          .filter((moment) => moment !== undefined);
        if (missedMoments.length > 0) {
          reply.raw.write(
            formatSse({
              catchup: { fromEventId: lastEventId, moments: missedMoments },
              event: "catchup.ready",
              id: `catchup:${missedMoments.at(-1)?.identity ?? lastEventId}`,
              snapshot: fixture,
            }),
          );
        }
      }
      const unsubscribe = runtime.subscribeFixture(
        request.params.fixtureId,
        (event) => reply.raw.write(formatSse(event)),
      );
      if (!unsubscribe) {
        reply.raw.end();
        return reply;
      }
      const heartbeat = setInterval(() => {
        reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
      }, 15_000);
      heartbeat.unref?.();
      request.raw.once("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
      return reply;
    },
  );
  app.post("/api/v1/replay/sessions", async (request, reply) => {
    const body = replaySessionBody.safeParse(request.body);
    if (!body.success) return invalidRequest(reply);
    try {
      return reply
        .code(201)
        .send(runtime.createReplaySession(body.data.fixtureId));
    } catch {
      return notFound(reply);
    }
  });
  app.post<{ Params: { id: string } }>(
    "/api/v1/replay/sessions/:id/commands",
    async (request, reply) => {
      const body = replayCommandBody.safeParse(request.body);
      if (!body.success) return invalidRequest(reply);
      const result = runtime.commandReplay(request.params.id, body.data);
      if (result.kind === "missing") return notFound(reply);
      if (result.kind === "invalid_listening_session") {
        return invalidRequest(reply);
      }
      if (result.kind === "duplicate") {
        return reply.send({ accepted: false, duplicate: true });
      }
      return reply.code(result.kind === "replayed" ? 200 : 202).send({
        accepted: true,
        duplicate: false,
        moment: result.moment,
        replayed: result.kind === "replayed",
        snapshot: result.snapshot,
      });
    },
  );
  app.post<{ Params: { fixtureId: string } }>(
    "/api/v1/fixtures/:fixtureId/listening-sessions",
    async (request, reply) => {
      const body = listeningSessionBody.safeParse(request.body);
      if (!body.success) return invalidRequest(reply);
      const session = runtime.createListeningSession(
        request.params.fixtureId,
        body.data.perspectiveTeam as TeamCode,
      );
      return session ? reply.code(201).send(session) : notFound(reply);
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/listening-sessions/:id",
    async (request, reply) => {
      const session = runtime.listeningSession(request.params.id);
      return session ? reply.send(session) : notFound(reply);
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/v1/listening-sessions/:id",
    async (request, reply) =>
      runtime.deleteListeningSession(request.params.id)
        ? reply.code(204).send()
        : notFound(reply),
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/listening-sessions/:id/stream.mp3",
    (request, reply) => {
      if (!runtime.listeningSession(request.params.id)) return notFound(reply);
      reply.hijack();
      reply.raw.writeHead(200, {
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "Content-Type": "audio/mpeg",
        "X-Content-Type-Options": "nosniff",
      });
      if (
        !runtime.attachListeningClient(
          request.params.id,
          reply.raw as AudioWritable,
        )
      ) {
        reply.raw.destroy();
      }
      return reply;
    },
  );
}
