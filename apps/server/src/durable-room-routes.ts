import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { RoomsDomainError } from "@matchsense/rooms";

import type { FanSessionService } from "./fan-session.js";
import { requireFanMutationSession, requireFanSession } from "./fan-routes.js";
import { RoomServiceError, type RoomServiceErrorCode } from "./room-service.js";
import type { DurableRoomService } from "./durable-room-service.js";
import type { RoomStreamEvent } from "./room-service.js";

const nickname = z.string().trim().min(1).max(30);
const teamCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{2,12}$/u);
const roomIdParams = z.object({ roomId: z.string().min(1).max(120) }).strict();
const createBody = z
  .object({
    fixtureId: z.string().min(1).max(120),
    host: z.object({ nickname, teamCode: teamCode.optional() }).strict(),
    name: z.string().trim().min(1).max(60),
  })
  .strict();
const joinBody = z
  .object({
    inviteCode: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
    nickname,
    teamCode: teamCode.optional(),
  })
  .strict();
const sensePicksBody = z
  .object({
    picks: z
      .array(
        z
          .object({
            allocation: z.number().int().min(5).max(80).multipleOf(5),
            marketId: z.enum([
              "winner",
              "goals_2_5",
              "cards_4_5",
              "corners_9_5",
              "btts",
            ]),
            selection: z.enum([
              "HOME",
              "DRAW",
              "AWAY",
              "OVER",
              "UNDER",
              "YES",
              "NO",
            ]),
          })
          .strict(),
      )
      .length(5),
  })
  .strict();
const reactionBody = z
  .object({
    kind: z.enum(["ROAR", "COLD", "CALLED_IT"]),
    momentId: z.string().trim().min(1).max(160),
    recipientParticipantId: z.string().min(1).max(120),
    revision: z.number().int().positive(),
  })
  .strict();
const emptyBody = z.object({}).strict();

interface DurableRoomRouteService {
  create(input: Parameters<DurableRoomService["create"]>[0]): Promise<unknown>;
  get(...input: Parameters<DurableRoomService["get"]>): Promise<unknown>;
  join(input: Parameters<DurableRoomService["join"]>[0]): Promise<unknown>;
  list(...input: Parameters<DurableRoomService["list"]>): Promise<unknown>;
  openPicks(
    ...input: Parameters<DurableRoomService["openPicks"]>
  ): Promise<unknown>;
  preview(
    ...input: Parameters<DurableRoomService["preview"]>
  ): Promise<unknown>;
  react(input: Parameters<DurableRoomService["react"]>[0]): Promise<unknown>;
  saveSensePicks(
    input: Parameters<DurableRoomService["saveSensePicks"]>[0],
  ): Promise<unknown>;
  startExperience(
    ...input: Parameters<DurableRoomService["startExperience"]>
  ): Promise<unknown>;
  subscribe(
    ...input: Parameters<DurableRoomService["subscribe"]>
  ): Promise<() => void>;
}

export interface DurableRoomRouteDependencies {
  service: DurableRoomRouteService;
  sessions: FanSessionService;
}

function invalidRequest(reply: FastifyReply) {
  return reply.code(400).send({
    error: { code: "INVALID_REQUEST", message: "Request is invalid" },
  });
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof RoomServiceError) {
    return reply.code(error.statusCode).send({
      error: { code: error.code, message: error.safeMessage },
    });
  }
  if (error instanceof RoomsDomainError) {
    const status =
      error.code === "MEMBER_NOT_FOUND" || error.code === "MOMENT_NOT_FOUND"
        ? 404
        : error.code === "INVALID_CALLS" || error.code.startsWith("INVALID_")
          ? 400
          : 409;
    return reply.code(status).send({
      error: { code: error.code, message: "Room prediction is invalid" },
    });
  }
  return reply.code(500).send({
    error: {
      code: "ROOM_OPERATION_FAILED" satisfies RoomServiceErrorCode | string,
      message: "Room operation failed",
    },
  });
}

function formatSse(event: RoomStreamEvent) {
  return `id: ${event.id}\nevent: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function registerDurableRoomRoutes(
  app: FastifyInstance,
  dependencies: DurableRoomRouteDependencies,
) {
  app.post("/api/v1/rooms", async (request, reply) => {
    const session = await requireFanMutationSession(
      request,
      reply,
      dependencies.sessions,
    );
    if (!session) return;
    const parsed = createBody.safeParse(request.body);
    if (!parsed.success) return invalidRequest(reply);
    try {
      return reply.code(201).send(
        await dependencies.service.create({
          fixtureId: parsed.data.fixtureId,
          host: {
            fanId: session.fan.id,
            nickname: parsed.data.host.nickname,
            ...(parsed.data.host.teamCode
              ? { teamCode: parsed.data.host.teamCode }
              : {}),
          },
          name: parsed.data.name,
        }),
      );
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/api/v1/rooms", async (request, reply) => {
    const session = await requireFanSession(
      request,
      reply,
      dependencies.sessions,
    );
    if (!session) return;
    try {
      return reply.send({
        rooms: await dependencies.service.list(session.fan.id),
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: { inviteCode: string } }>(
    "/api/v1/rooms/invites/:inviteCode/preview",
    async (request, reply) => {
      const inviteCode = z
        .string()
        .regex(/^[A-Za-z0-9_-]{22}$/u)
        .safeParse(request.params.inviteCode);
      if (!inviteCode.success) return invalidRequest(reply);
      try {
        return reply.send(await dependencies.service.preview(inviteCode.data));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post("/api/v1/rooms/join", async (request, reply) => {
    const session = await requireFanMutationSession(
      request,
      reply,
      dependencies.sessions,
    );
    if (!session) return;
    const parsed = joinBody.safeParse(request.body);
    if (!parsed.success) return invalidRequest(reply);
    try {
      return reply.send(
        await dependencies.service.join({
          fanId: session.fan.id,
          inviteCode: parsed.data.inviteCode,
          nickname: parsed.data.nickname,
          ...(parsed.data.teamCode ? { teamCode: parsed.data.teamCode } : {}),
        }),
      );
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: { roomId: string } }>(
    "/api/v1/rooms/:roomId",
    async (request, reply) => {
      const session = await requireFanSession(
        request,
        reply,
        dependencies.sessions,
      );
      if (!session) return;
      const params = roomIdParams.safeParse(request.params);
      if (!params.success) return invalidRequest(reply);
      try {
        return reply.send(
          await dependencies.service.get(params.data.roomId, session.fan.id),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get<{ Params: { roomId: string } }>(
    "/api/v1/rooms/:roomId/stream",
    async (request, reply) => {
      const session = await requireFanSession(
        request,
        reply,
        dependencies.sessions,
      );
      if (!session) return;
      const params = roomIdParams.safeParse(request.params);
      if (!params.success) return invalidRequest(reply);
      try {
        reply.hijack();
        reply.raw.writeHead(200, {
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "Content-Type": "text/event-stream; charset=utf-8",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        });
        const unsubscribe = await dependencies.service.subscribe(
          params.data.roomId,
          session.fan.id,
          (event) => reply.raw.write(formatSse(event)),
        );
        const heartbeat = setInterval(() => {
          reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
        }, 15_000);
        heartbeat.unref?.();
        request.raw.once("close", () => {
          clearInterval(heartbeat);
          unsubscribe();
        });
        return reply;
      } catch (error) {
        if (!reply.sent) return sendError(reply, error);
        reply.raw.end();
        return reply;
      }
    },
  );

  app.post<{ Params: { roomId: string } }>(
    "/api/v1/rooms/:roomId/picks/open",
    async (request, reply) => {
      const session = await requireFanMutationSession(
        request,
        reply,
        dependencies.sessions,
      );
      if (!session) return;
      const params = roomIdParams.safeParse(request.params);
      const body = emptyBody.safeParse(request.body ?? {});
      if (!params.success || !body.success) return invalidRequest(reply);
      try {
        return reply.send(
          await dependencies.service.openPicks(
            params.data.roomId,
            session.fan.id,
          ),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.put<{ Params: { roomId: string } }>(
    "/api/v1/rooms/:roomId/picks",
    async (request, reply) => {
      const session = await requireFanMutationSession(
        request,
        reply,
        dependencies.sessions,
      );
      if (!session) return;
      const params = roomIdParams.safeParse(request.params);
      const body = sensePicksBody.safeParse(request.body);
      if (!params.success || !body.success) return invalidRequest(reply);
      try {
        return reply.send(
          await dependencies.service.saveSensePicks({
            fanId: session.fan.id,
            picks: body.data.picks,
            roomId: params.data.roomId,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Params: { roomId: string } }>(
    "/api/v1/rooms/:roomId/reactions",
    async (request, reply) => {
      const session = await requireFanMutationSession(
        request,
        reply,
        dependencies.sessions,
      );
      if (!session) return;
      const params = roomIdParams.safeParse(request.params);
      const body = reactionBody.safeParse(request.body);
      if (!params.success || !body.success) return invalidRequest(reply);
      try {
        return reply.code(201).send(
          await dependencies.service.react({
            fanId: session.fan.id,
            roomId: params.data.roomId,
            ...body.data,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  const startExperience = async (
    request: FastifyRequest<{ Params: { roomId: string } }>,
    reply: FastifyReply,
  ) => {
    const session = await requireFanMutationSession(
      request,
      reply,
      dependencies.sessions,
    );
    if (!session) return;
    const params = roomIdParams.safeParse(request.params);
    const body = emptyBody.safeParse(request.body ?? {});
    if (!params.success || !body.success) return invalidRequest(reply);
    try {
      return reply.send(
        await dependencies.service.startExperience(
          params.data.roomId,
          session.fan.id,
        ),
      );
    } catch (error) {
      return sendError(reply, error);
    }
  };

  app.post<{ Params: { roomId: string } }>(
    "/api/v1/rooms/:roomId/start",
    startExperience,
  );
  app.post<{ Params: { roomId: string } }>(
    "/api/v1/rooms/:roomId/demo/start",
    startExperience,
  );
}
