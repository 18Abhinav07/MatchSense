import type { FastifyInstance } from "fastify";

import type { PersistenceMode } from "@matchsense/db";

import { requireFanSession } from "./fan-routes.js";
import type { FanSessionService } from "./fan-session.js";
import type { MatchMemoryService } from "./memory-service.js";

const FIXTURE_ID = /^[A-Za-z0-9_:-]{1,120}$/u;

export interface MemoryRouteDependencies {
  service: MatchMemoryService;
  sessions: FanSessionService;
}

function persistenceMode(value: string): PersistenceMode | null {
  return value === "demo" || value === "live" ? value : null;
}

export function registerMemoryRoutes(
  app: FastifyInstance,
  dependencies: MemoryRouteDependencies,
) {
  app.get("/api/v1/memories", async (request, reply) => {
    const session = await requireFanSession(
      request,
      reply,
      dependencies.sessions,
    );
    if (!session) return;
    return reply.send({
      memories: await dependencies.service.listForFan(session.fan.id),
    });
  });

  app.get<{ Params: { fixtureId: string } }>(
    "/api/v1/memories/:fixtureId",
    async (request, reply) => {
      const session = await requireFanSession(
        request,
        reply,
        dependencies.sessions,
      );
      if (!session) return;
      if (!FIXTURE_ID.test(request.params.fixtureId)) {
        return reply.code(400).send({ error: "memory_request_invalid" });
      }
      const common = {
        fanId: session.fan.id,
        fixtureId: request.params.fixtureId,
      };
      const live = await dependencies.service.getForFan({
        ...common,
        mode: "live",
      });
      const memory =
        live ??
        (await dependencies.service.getForFan({ ...common, mode: "demo" }));
      if (!memory) {
        return reply.code(404).send({ error: "memory_not_found" });
      }
      return reply.send({ memory });
    },
  );

  app.get<{ Params: { fixtureId: string; mode: string } }>(
    "/api/v1/memories/:mode/:fixtureId",
    async (request, reply) => {
      const session = await requireFanSession(
        request,
        reply,
        dependencies.sessions,
      );
      if (!session) return;
      const mode = persistenceMode(request.params.mode);
      if (!mode || !FIXTURE_ID.test(request.params.fixtureId)) {
        return reply.code(400).send({ error: "memory_request_invalid" });
      }
      const memory = await dependencies.service.getForFan({
        fanId: session.fan.id,
        fixtureId: request.params.fixtureId,
        mode,
      });
      if (!memory) {
        return reply.code(404).send({ error: "memory_not_found" });
      }
      return reply.send({ memory });
    },
  );
}
