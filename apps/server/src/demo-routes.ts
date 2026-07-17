import type { FastifyInstance, FastifyReply } from "fastify";

import type { DemoBeatEvent, DemoSessionRuntime } from "./demo-runtime.js";

function notFound(reply: FastifyReply) {
  return reply.code(404).send({
    error: { code: "NOT_FOUND", message: "Demo session not found" },
  });
}

function beatFrame(event: DemoBeatEvent) {
  return `id: ${event.cursor}\nevent: demo.beat\ndata: ${JSON.stringify(event)}\n\n`;
}

export function registerDemoRoutes(
  app: FastifyInstance,
  runtime: DemoSessionRuntime,
) {
  app.post("/api/v1/demo/sessions", async (_request, reply) =>
    reply.header("Cache-Control", "no-store").code(201).send(runtime.create()),
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/demo/sessions/:id",
    async (request, reply) => {
      const session = runtime.get(request.params.id);
      return session
        ? reply.header("Cache-Control", "no-store").send(session)
        : notFound(reply);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/demo/sessions/:id/timeline",
    async (request, reply) => {
      const timeline = runtime.timeline(request.params.id);
      return timeline
        ? reply.header("Cache-Control", "no-store").send(timeline)
        : notFound(reply);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/demo/sessions/:id/restart",
    async (request, reply) => {
      const session = runtime.restart(request.params.id);
      return session
        ? reply.header("Cache-Control", "no-store").send(session)
        : notFound(reply);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/demo/sessions/:id/stream",
    (request, reply) => {
      if (!runtime.get(request.params.id)) return notFound(reply);
      reply.hijack();
      reply.raw.writeHead(200, {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      });
      const unsubscribe = runtime.subscribe(request.params.id, {
        onBeat: (event) => reply.raw.write(beatFrame(event)),
        onEnd: () => reply.raw.end(),
      });
      if (!unsubscribe) {
        reply.raw.end();
        return reply;
      }
      request.raw.once("close", unsubscribe);
      return reply;
    },
  );
}
