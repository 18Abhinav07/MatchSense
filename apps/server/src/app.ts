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
  type CommentaryArtifactRouteDependencies,
  registerCommentaryArtifactRoutes,
} from "./commentary-artifact-routes.js";
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
import {
  isFixedExperienceFixture,
  type ExperienceRuntime,
} from "./experience-runtime.js";
import {
  type FanRouteDependencies,
  registerFanRoutes,
  requireFanMutationSession,
  requireFanSession,
} from "./fan-routes.js";
import type { FanSessionService } from "./fan-session.js";
import {
  type FixtureReadRouteDependencies,
  registerFixtureReadRoutes,
} from "./fixture-read-routes.js";
import { registerFixtureStreamRoutes } from "./fixture-stream-routes.js";
import {
  type MemoryRouteDependencies,
  registerMemoryRoutes,
} from "./memory-routes.js";
import type { ProductRuntime } from "./product-runtime.js";
import {
  type PushRouteDependencies,
  registerPushRoutes,
} from "./push-delivery.js";
import { registerReplayRoutes } from "./replay-routes.js";
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
  commentaryArtifacts?: CommentaryArtifactRouteDependencies;
  demo?: DemoSessionRuntime | false;
  durablePush?: DurablePushRouteDependencies;
  durableRooms?: DurableRoomRouteDependencies;
  experience?: ExperienceRuntime;
  experienceRunAccess?: (input: {
    fanId: string;
    runId: string;
  }) => boolean | Promise<boolean>;
  experienceRuntime?: ProductRuntime;
  fan?: FanRouteDependencies;
  fixtureRead?: FixtureReadRouteDependencies;
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

const segment = "(?!\\.{1,2}(?:/|$))[A-Za-z0-9_.:-]+";

const canonicalShellRoutes = [
  { pattern: /^\/$/u, template: "/" },
  { pattern: /^\/you$/u, template: "/you" },
  { pattern: /^\/experience$/u, template: "/experience" },
  {
    pattern: new RegExp(`^/experience/rooms/new/${segment}/${segment}$`, "u"),
    template: "/experience/rooms/new/:homeTeam/:awayTeam",
  },
  {
    pattern: new RegExp(`^/experience/rooms/join/${segment}$`, "u"),
    template: "/experience/rooms/join/:inviteCode",
  },
  {
    pattern: new RegExp(`^/experience/rooms/${segment}$`, "u"),
    template: "/experience/rooms/:roomId",
  },
  {
    pattern: new RegExp(`^/experience/${segment}$`, "u"),
    template: "/experience/:runId",
  },
  {
    pattern: new RegExp(`^/experience/${segment}/moments/${segment}$`, "u"),
    template: "/experience/:runId/moments/:identity",
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
  {
    pattern: new RegExp(`^/rooms/new/${segment}$`, "u"),
    template: "/rooms/new/:fixtureId",
  },
  {
    pattern: new RegExp(`^/rooms/join/${segment}$`, "u"),
    template: "/rooms/join/:inviteCode",
  },
  {
    pattern: new RegExp(`^/rooms/(?!new$|join$)${segment}$`, "u"),
    template: "/rooms/:roomId",
  },
  {
    pattern: new RegExp(`^/you/${segment}(?:/${segment})*$`, "u"),
    template: "/you/*",
  },
  { pattern: /^\/replays$/u, template: "/replays" },
  {
    pattern: new RegExp(`^/replays/${segment}$`, "u"),
    template: "/replays/:id",
  },
] as const;

export function isCanonicalShellPath(pathname: string) {
  return canonicalShellRoutes.some(({ pattern }) => pattern.test(pathname));
}

function decodedShellPathname(url: string) {
  const rawPathname = url.split(/[?#]/u, 1)[0] ?? "";
  if (/%(?:2f|5c)/iu.test(rawPathname)) return null;
  try {
    const pathname = decodeURIComponent(rawPathname);
    return pathname
      .split("/")
      .some((segment) => segment === "." || segment === "..")
      ? null
      : pathname;
  } catch {
    return null;
  }
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

  if (options.fixtureRead) {
    registerFixtureReadRoutes(app, options.fixtureRead);
    registerFixtureStreamRoutes(app, options.fixtureRead);
    registerReplayRoutes(app, options.fixtureRead);
  } else if (options.runtime) {
    registerProductRoutes(app, options.runtime);
    if (options.manageRuntimeLifecycle !== false) {
      app.addHook("preClose", () => {
        options.runtime?.close();
      });
    }
  }
  if (options.commentaryArtifacts) {
    registerCommentaryArtifactRoutes(app, options.commentaryArtifacts);
  }
  if (options.experience) {
    if (options.fan?.sessions) {
      registerExperienceRoutes(
        app,
        options.experience,
        options.fan.sessions,
        options.experienceRunAccess,
      );
    }
    app.addHook("preClose", () => options.experience?.close());
  }
  if (options.experienceRuntime) {
    if (options.experience && options.fan?.sessions) {
      registerExperienceProductRoutes(
        app,
        options.experienceRuntime,
        options.experience,
        options.fan.sessions,
        options.experienceRunAccess,
      );
    }
    app.addHook("preClose", () => options.experienceRuntime?.close());
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
    const pathname = decodedShellPathname(request.url);
    const acceptsShell = request.method === "GET" || request.method === "HEAD";

    if (acceptsShell && pathname && isCanonicalShellPath(pathname)) {
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
  fanSessions: FanSessionService,
  canAccessRun?: BuildAppOptions["experienceRunAccess"],
) {
  const startRun = async (request: FastifyRequest, reply: FastifyReply) => {
    const session = await requireFanMutationSession(
      request,
      reply,
      fanSessions,
    );
    if (!session) return;
    const body = experienceRunBody.safeParse(request.body);
    if (!body.success || !isFixedExperienceFixture(body.data)) {
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
          .update(`${session.fan.id}|${idempotencyKey}`)
          .digest("hex")
          .slice(0, 32)}`
      : undefined;
    const run = await experience.startRun({
      awayTeam: body.data.awayTeam,
      homeTeam: body.data.homeTeam,
      ownerFanId: session.fan.id,
      ...(runId ? { runId } : {}),
    });
    return reply.code(201).send({ run: publicExperienceRun(run) });
  };
  app.post("/api/v1/experience/runs", startRun);
  app.post("/api/v1/experience/runs/start", startRun);
  app.get<{ Params: { runId: string } }>(
    "/api/v1/experience/runs/:runId",
    async (request, reply) => {
      const session = await requireFanSession(request, reply, fanSessions);
      if (!session) return;
      const run = await experience.getRun(request.params.runId);
      return run &&
        (run.ownerFanId === session.fan.id ||
          (await canAccessRun?.({
            fanId: session.fan.id,
            runId: request.params.runId,
          })))
        ? reply.send({ run: publicExperienceRun(run) })
        : notFound(reply);
    },
  );
}

function publicExperienceRun(
  run: NonNullable<Awaited<ReturnType<ExperienceRuntime["getRun"]>>>,
) {
  const { ownerFanId: _ownerFanId, ...publicRun } = run;
  return publicRun;
}

function experienceFixtureId(runId: string) {
  return /^[A-Za-z0-9_.:-]{1,120}$/u.test(runId) ? `experience:${runId}` : null;
}

function registerExperienceProductRoutes(
  app: FastifyInstance,
  runtime: ProductRuntime,
  experience: ExperienceRuntime,
  fanSessions: FanSessionService,
  canAccessRun?: BuildAppOptions["experienceRunAccess"],
) {
  const listeningSessionOwners = new Map<string, string>();
  const requireRunAccess = async (
    request: FastifyRequest,
    reply: FastifyReply,
    runId: string,
    mutation = false,
  ) => {
    const session = mutation
      ? await requireFanMutationSession(request, reply, fanSessions)
      : await requireFanSession(request, reply, fanSessions);
    if (!session) return null;
    const run = await experience.getRun(runId);
    const allowed =
      !!run &&
      (run.ownerFanId === session.fan.id ||
        (await canAccessRun?.({ fanId: session.fan.id, runId })) === true);
    if (!run || !allowed) {
      notFound(reply);
      return null;
    }
    return { run, session };
  };

  const runIdFromFixtureId = (fixtureId: string) =>
    fixtureId.startsWith("experience:")
      ? fixtureId.slice("experience:".length)
      : null;

  const requireListeningOwner = async (
    request: FastifyRequest,
    reply: FastifyReply,
    listeningSessionId: string,
    mutation = false,
  ) => {
    const fanSession = mutation
      ? await requireFanMutationSession(request, reply, fanSessions)
      : await requireFanSession(request, reply, fanSessions);
    if (!fanSession) return null;
    const listeningSession = runtime.listeningSession(listeningSessionId);
    const runId = listeningSession
      ? runIdFromFixtureId(listeningSession.fixtureId)
      : null;
    if (!listeningSession || !runId) {
      notFound(reply);
      return null;
    }
    const run = await experience.getRun(runId);
    const ownerFanId = listeningSessionOwners.get(listeningSessionId);
    const allowed =
      !!run &&
      (run.ownerFanId === fanSession.fan.id ||
        (await canAccessRun?.({ fanId: fanSession.fan.id, runId })) === true);
    if (!run || !allowed || ownerFanId !== fanSession.fan.id) {
      notFound(reply);
      return null;
    }
    return listeningSession;
  };

  app.get<{ Params: { runId: string } }>(
    "/api/v1/experience/runs/:runId/fixture",
    async (request, reply) => {
      if (!(await requireRunAccess(request, reply, request.params.runId))) {
        return;
      }
      const fixtureId = experienceFixtureId(request.params.runId);
      const fixture = fixtureId ? runtime.fixture(fixtureId) : null;
      return fixture
        ? reply.header("Cache-Control", "no-store").send(fixture)
        : notFound(reply);
    },
  );
  app.get<{ Params: { runId: string; identity: string } }>(
    "/api/v1/experience/runs/:runId/moments/:identity",
    async (request, reply) => {
      if (!(await requireRunAccess(request, reply, request.params.runId))) {
        return;
      }
      const fixtureId = experienceFixtureId(request.params.runId);
      const resolved = fixtureId
        ? runtime.resolveMoment(fixtureId, request.params.identity)
        : null;
      return resolved
        ? reply.header("Cache-Control", "no-store").send(resolved)
        : notFound(reply);
    },
  );
  app.get<{ Params: { runId: string; identity: string } }>(
    "/api/v1/experience/runs/:runId/moments/:identity/audio",
    async (request, reply) => {
      if (!(await requireRunAccess(request, reply, request.params.runId))) {
        return;
      }
      const fixtureId = experienceFixtureId(request.params.runId);
      const bytes = fixtureId
        ? await runtime.commentaryAudio(fixtureId, request.params.identity)
        : null;
      return bytes
        ? reply
            .header("Cache-Control", "no-store")
            .header("Content-Disposition", "inline")
            .header("Content-Type", "audio/mpeg")
            .header("X-Content-Type-Options", "nosniff")
            .send(bytes)
        : reply.code(404).send({ error: "commentary_not_ready" });
    },
  );
  app.get<{ Params: { runId: string } }>(
    "/api/v1/experience/runs/:runId/memory/intro.mp3",
    async (request, reply) => {
      if (!(await requireRunAccess(request, reply, request.params.runId))) {
        return;
      }
      const fixtureId = experienceFixtureId(request.params.runId);
      const bytes = fixtureId
        ? await runtime.memoryIntroAudio(fixtureId)
        : null;
      return bytes
        ? reply
            .header("Cache-Control", "private, max-age=300")
            .header("Content-Disposition", "inline")
            .header("Content-Type", "audio/mpeg")
            .header("X-Content-Type-Options", "nosniff")
            .send(bytes)
        : reply.code(404).send({ error: "commentary_not_ready" });
    },
  );
  app.get<{ Params: { runId: string } }>(
    "/api/v1/experience/runs/:runId/timeline",
    async (request, reply) => {
      if (!(await requireRunAccess(request, reply, request.params.runId))) {
        return;
      }
      const fixtureId = experienceFixtureId(request.params.runId);
      const fixture = fixtureId ? runtime.fixture(fixtureId) : null;
      if (!fixtureId || !fixture) return notFound(reply);
      const events = runtime.fixtureEvents(fixtureId);
      return reply.header("Cache-Control", "no-store").send({
        cursor: events.at(-1)?.id ?? null,
        events,
        fixture,
      });
    },
  );
  app.get<{
    Params: { runId: string };
    Querystring: { after?: string };
  }>("/api/v1/experience/runs/:runId/stream", async (request, reply) => {
    if (!(await requireRunAccess(request, reply, request.params.runId))) {
      return;
    }
    const fixtureId = experienceFixtureId(request.params.runId);
    const fixture = fixtureId ? runtime.fixture(fixtureId) : null;
    if (!fixtureId || !fixture) return notFound(reply);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    });
    const lastEventHeader = request.headers["last-event-id"];
    const lastEventId = Array.isArray(lastEventHeader)
      ? lastEventHeader[0]
      : (lastEventHeader ??
        (typeof request.query.after === "string" &&
        /^[A-Za-z0-9_.:-]{1,240}$/u.test(request.query.after)
          ? request.query.after
          : undefined));
    if (lastEventId) {
      const history = runtime.fixtureEvents(fixtureId);
      const cursor = history.findIndex((event) => event.id === lastEventId);
      const missedHistory = cursor >= 0 ? history.slice(cursor + 1) : [];
      const moments = missedHistory
        .map((event) => event.moment)
        .filter((moment) => moment !== undefined);
      if (moments.length) {
        reply.raw.write(
          formatSse({
            catchup: { fromEventId: lastEventId, moments },
            event: "catchup.ready",
            id: missedHistory.at(-1)?.id ?? lastEventId,
            snapshot: fixture,
          }),
        );
      }
    }
    const unsubscribe = runtime.subscribeFixture(fixtureId, (event) => {
      reply.raw.write(formatSse(event));
    });
    if (!unsubscribe) {
      reply.raw.end();
      return reply;
    }
    request.raw.once("close", unsubscribe);
    return reply;
  });
  app.post<{ Params: { fixtureId: string } }>(
    "/api/v1/fixtures/:fixtureId/listening-sessions",
    async (request, reply) => {
      const runId = runIdFromFixtureId(request.params.fixtureId);
      if (!runId) {
        return notFound(reply);
      }
      const access = await requireRunAccess(request, reply, runId, true);
      if (!access) return;
      const body = listeningSessionBody.safeParse(request.body);
      if (!body.success) return invalidRequest(reply);
      const session = runtime.createListeningSession(
        request.params.fixtureId,
        body.data.perspectiveTeam as TeamCode,
      );
      if (session)
        listeningSessionOwners.set(session.id, access.session.fan.id);
      return session ? reply.code(201).send(session) : notFound(reply);
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/listening-sessions/:id",
    async (request, reply) => {
      if (!(await requireListeningOwner(request, reply, request.params.id))) {
        return;
      }
      const session = runtime.listeningSession(request.params.id);
      return session ? reply.send(session) : notFound(reply);
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/v1/listening-sessions/:id",
    async (request, reply) => {
      if (
        !(await requireListeningOwner(request, reply, request.params.id, true))
      ) {
        return;
      }
      if (!runtime.deleteListeningSession(request.params.id)) {
        return notFound(reply);
      }
      listeningSessionOwners.delete(request.params.id);
      return reply.code(204).send();
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/listening-sessions/:id/stream.mp3",
    async (request, reply) => {
      if (!(await requireListeningOwner(request, reply, request.params.id))) {
        return;
      }
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
        reply.raw.end();
      }
      request.raw.once("close", () => {
        reply.raw.destroy();
      });
      return reply;
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
