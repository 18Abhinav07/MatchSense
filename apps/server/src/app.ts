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

function isProductShellPath(pathname: string) {
  if (["/", "/today", "/settings", "/diagnostics"].includes(pathname)) {
    return true;
  }

  return /^\/(?:matches|moments|memories|rooms)\/[A-Za-z0-9_-]+(?:\/(?:transcript|memory))?$/u.test(
    pathname,
  );
}

function notFound(reply: FastifyReply) {
  return reply.code(404).send({
    error: { code: "NOT_FOUND", message: "Route not found" },
  });
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
    immutable: true,
    index: false,
    maxAge: "365d",
    root: options.webDistPath,
    wildcard: false,
  });

  const sendShell = (reply: FastifyReply) =>
    reply
      .type("text/html; charset=utf-8")
      .sendFile("index.html", { immutable: false, maxAge: 0 });

  app.get("/", async (_request, reply) => sendShell(reply));

  app.setNotFoundHandler((request, reply) => {
    const pathname = new URL(request.url, "http://matchsense.local").pathname;
    const acceptsShell = request.method === "GET" || request.method === "HEAD";

    if (acceptsShell && isProductShellPath(pathname)) {
      return sendShell(reply);
    }

    return notFound(reply);
  });

  return app;
}
