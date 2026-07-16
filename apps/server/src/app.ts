import path from "node:path";

import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";

export interface ReadinessResult {
  databaseReachable: boolean;
  migrationsCurrent: boolean;
}

export interface ReadinessProbe {
  check(): Promise<ReadinessResult>;
}

export interface BuildAppOptions {
  readinessProbe: ReadinessProbe;
  webDistPath: string;
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

const segment = "[A-Za-z0-9_-]+";

const canonicalShellRoutes = [
  { pattern: /^\/$/u, template: "/" },
  { pattern: /^\/onboarding$/u, template: "/onboarding" },
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

  app.get("/health/live", async () => ({ status: "ok" }));

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

    if (acceptsShell && isCanonicalShellPath(pathname)) {
      return sendShell(reply);
    }

    return notFound(reply);
  });

  return app;
}
