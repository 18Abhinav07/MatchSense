import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { FanRepository, FanSessionRecord } from "@matchsense/db";

import type { FanSessionService } from "./fan-session.js";

const SESSION_COOKIE = "matchsense_session";
const CSRF_COOKIE = "matchsense_csrf";
const SESSION_SECONDS = 30 * 24 * 60 * 60;

const profileInput = z.object({
  avatarVariant: z.string().trim().min(1).max(80),
  favoriteTeam: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9-]{1,19}$/u),
  handle: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_]{3,24}$/u),
  preferences: z.record(z.string(), z.unknown()).default({}),
  profile: z.record(z.string(), z.unknown()).default({}),
});
const followInput = z
  .object({
    eventPreferences: z
      .object({
        fullTime: z.boolean().default(true),
        goals: z.boolean().default(true),
        redCards: z.boolean().default(true),
      })
      .default({ fullTime: true, goals: true, redCards: true }),
  })
  .strict();

export interface FanRouteDependencies {
  repository: FanRepository;
  sessions: FanSessionService;
}

function cookieValue(header: string | undefined, name: string) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key !== name) continue;
    try {
      return decodeURIComponent(rest.join("="));
    } catch {
      return null;
    }
  }
  return null;
}

function secureRequest(request: FastifyRequest) {
  const forwarded = request.headers["x-forwarded-proto"];
  const protocol = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return protocol?.split(",", 1)[0]?.trim() === "https";
}

function sessionCookie(token: string, secure: boolean) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function csrfCookie(token: string, secure: boolean) {
  return `${CSRF_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${SESSION_SECONDS}; SameSite=Strict${secure ? "; Secure" : ""}`;
}

export async function requireFanSession(
  request: FastifyRequest,
  reply: FastifyReply,
  sessions: FanSessionService,
): Promise<FanSessionRecord | null> {
  const token = cookieValue(request.headers.cookie, SESSION_COOKIE);
  const session = token ? await sessions.resolve(token) : null;
  if (!session) {
    await reply.code(401).send({ error: "fan_session_required" });
    return null;
  }
  reply.header("cache-control", "no-store");
  return session;
}

export async function requireFanMutationSession(
  request: FastifyRequest,
  reply: FastifyReply,
  sessions: FanSessionService,
) {
  const session = await requireFanSession(request, reply, sessions);
  if (!session) return null;
  const header = request.headers["x-matchsense-csrf"];
  const csrf = Array.isArray(header) ? header[0] : header;
  if (!csrf || !sessions.verifyCsrf(session, csrf)) {
    await reply.code(403).send({ error: "csrf_invalid" });
    return null;
  }
  return session;
}

export function registerFanRoutes(
  app: FastifyInstance,
  dependencies: FanRouteDependencies,
) {
  app.post("/api/v1/session/guest", async (request, reply) => {
    const created = await dependencies.sessions.createGuest();
    const secure = secureRequest(request);
    reply.header("cache-control", "no-store");
    reply.header("set-cookie", [
      sessionCookie(created.sessionToken, secure),
      csrfCookie(created.csrfToken, secure),
    ]);
    return reply.code(201).send({
      csrfToken: created.csrfToken,
      expiresAt: created.expiresAt,
      fan: created.fan,
    });
  });

  app.get("/api/v1/bootstrap", async (request, reply) => {
    const session = await requireFanSession(
      request,
      reply,
      dependencies.sessions,
    );
    if (!session) return;
    const follows = await dependencies.repository.listFollows(session.fan.id);
    return reply.send({
      fan: session.fan,
      follows,
      memories: [],
      rooms: [],
    });
  });

  app.get<{ Params: { handle: string } }>(
    "/api/v1/profile/handles/:handle/availability",
    async (request, reply) => {
      const session = await requireFanSession(
        request,
        reply,
        dependencies.sessions,
      );
      if (!session) return;
      const handle = request.params.handle.trim();
      if (!/^[A-Za-z0-9_]{3,24}$/u.test(handle)) {
        return reply.code(400).send({ error: "handle_invalid" });
      }
      return reply.send({
        available: await dependencies.repository.isHandleAvailable({
          excludeFanId: session.fan.id,
          handle,
        }),
        handle,
      });
    },
  );

  app.patch("/api/v1/profile", async (request, reply) => {
    const session = await requireFanMutationSession(
      request,
      reply,
      dependencies.sessions,
    );
    if (!session) return;
    const parsed = profileInput.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "profile_invalid" });
    }
    const available = await dependencies.repository.isHandleAvailable({
      excludeFanId: session.fan.id,
      handle: parsed.data.handle,
    });
    if (!available) {
      return reply.code(409).send({ error: "handle_unavailable" });
    }
    try {
      return reply.send(
        await dependencies.repository.updateProfile({
          ...parsed.data,
          fanId: session.fan.id,
        }),
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        return reply.code(409).send({ error: "handle_unavailable" });
      }
      throw error;
    }
  });

  app.put<{
    Params: { fixtureId: string; mode: "demo" | "live" };
  }>("/api/v1/follows/:mode/:fixtureId", async (request, reply) => {
    const session = await requireFanMutationSession(
      request,
      reply,
      dependencies.sessions,
    );
    if (!session) return;
    const parsed = followInput.safeParse(request.body);
    if (
      !parsed.success ||
      !["demo", "live"].includes(request.params.mode) ||
      !/^[A-Za-z0-9_:-]{1,120}$/u.test(request.params.fixtureId)
    ) {
      return reply.code(400).send({ error: "follow_invalid" });
    }
    await dependencies.repository.upsertFollow({
      eventPreferences: parsed.data.eventPreferences,
      fanId: session.fan.id,
      fixtureId: request.params.fixtureId,
      mode: request.params.mode,
    });
    return reply.code(204).send();
  });

  app.delete<{
    Params: { fixtureId: string; mode: "demo" | "live" };
  }>("/api/v1/follows/:mode/:fixtureId", async (request, reply) => {
    const session = await requireFanMutationSession(
      request,
      reply,
      dependencies.sessions,
    );
    if (!session) return;
    if (
      !["demo", "live"].includes(request.params.mode) ||
      !/^[A-Za-z0-9_:-]{1,120}$/u.test(request.params.fixtureId)
    ) {
      return reply.code(400).send({ error: "follow_invalid" });
    }
    await dependencies.repository.removeFollow({
      fanId: session.fan.id,
      fixtureId: request.params.fixtureId,
      mode: request.params.mode,
    });
    return reply.code(204).send();
  });

  app.delete("/api/v1/profile", async (request, reply) => {
    const session = await requireFanMutationSession(
      request,
      reply,
      dependencies.sessions,
    );
    if (!session) return;
    await dependencies.repository.deleteFan(session.fan.id);
    reply.header("set-cookie", [
      `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
      `${CSRF_COOKIE}=; Path=/; Max-Age=0; SameSite=Strict`,
    ]);
    return reply.code(204).send();
  });
}
