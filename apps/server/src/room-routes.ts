import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { TEAM_CODE_PATTERN } from "@matchsense/contracts";
import { RoomsDomainError, type RoomsErrorCode } from "@matchsense/rooms";

import {
  RoomServiceError,
  type RoomService,
  type RoomStreamEvent,
} from "./room-service.js";

const participantId = z.string().trim().min(1).max(120);
const nickname = z.string().trim().min(1).max(30);
const roomName = z.string().trim().min(1).max(60);
const teamCode = z.string().trim().regex(TEAM_CODE_PATTERN);
const roomIdParams = z.object({ roomId: z.string().min(1).max(120) }).strict();
const emptyQuery = z.object({}).strict();
const streamQuery = z
  .object({
    fanId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{6,120}$/u)
      .optional(),
  })
  .strict();
const createBody = z
  .object({
    fixtureId: z.string().min(1).max(80),
    host: z.object({ nickname, teamCode: teamCode.optional() }).strict(),
    name: roomName,
  })
  .strict();
const joinBody = z
  .object({
    inviteCode: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
    nickname,
    teamCode: teamCode.optional(),
  })
  .strict();
const call = z
  .object({
    answer: z.enum(["YES", "NO"]),
    category: z.enum(["goals", "cards", "corners"]),
    confidence: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  })
  .strict();
const callsBody = z
  .object({
    calls: z.array(call).length(3),
    lock: z.boolean(),
  })
  .strict();
const senseMarketId = z.enum([
  "winner",
  "goals_2_5",
  "cards_4_5",
  "corners_9_5",
  "btts",
]);
const senseSelection = z.enum([
  "HOME",
  "DRAW",
  "AWAY",
  "OVER",
  "UNDER",
  "YES",
  "NO",
]);
const sensePicksBody = z
  .object({
    picks: z
      .array(
        z
          .object({
            allocation: z.number().int().min(5).max(80).multipleOf(5),
            marketId: senseMarketId,
            selection: senseSelection,
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
    recipientParticipantId: participantId,
    revision: z.number().int().positive(),
  })
  .strict();
const statsBody = z
  .object({
    cards: z.enum(["YES", "NO"]),
    corners: z.enum(["YES", "NO"]),
    goals: z.enum(["YES", "NO"]),
    revision: z.number().int().positive(),
  })
  .strict();
const registerMomentBody = z
  .object({
    momentId: z.string().trim().min(1).max(160),
    revision: z.number().int().positive(),
    varState: z.enum(["CLEAR", "HOLD"]),
  })
  .strict();
const resolveMomentBody = z
  .object({
    momentId: z.string().trim().min(1).max(160),
    resolution: z.enum(["CONFIRMED", "OVERTURNED"]),
    revision: z.number().int().positive(),
  })
  .strict();
const emptyBody = z.object({}).strict();

const ROOM_SESSION_COOKIE = "matchsense_room_session";

function roomSessionCapability(request: FastifyRequest) {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) return undefined;
  const values = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${ROOM_SESSION_COOKIE}=`))
    .map((part) => part.slice(ROOM_SESSION_COOKIE.length + 1));
  return values.length === 1 ? values[0] : undefined;
}

function requestIsSecure(request: FastifyRequest) {
  const forwarded = request.headers["x-forwarded-proto"];
  const forwardedProtocol = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (
    request.protocol === "https" ||
    forwardedProtocol?.split(",", 1)[0]?.trim().toLowerCase() === "https"
  );
}

function setRoomSessionCookie(
  request: FastifyRequest,
  reply: FastifyReply,
  capability: string,
) {
  reply.header("Cache-Control", "no-store");
  reply.header(
    "Set-Cookie",
    `${ROOM_SESSION_COOKIE}=${capability}; Path=/; HttpOnly; SameSite=Lax${requestIsSecure(request) ? "; Secure" : ""}`,
  );
}

const safeDomainErrors: Record<
  RoomsErrorCode,
  { statusCode: 400 | 404 | 409; message: string }
> = {
  BEFORE_KICKOFF: { statusCode: 409, message: "Match has not started" },
  CALLS_LOCKED: { statusCode: 409, message: "Calls are already locked" },
  CALLS_REQUIRED: {
    statusCode: 409,
    message: "Complete Call Three before locking",
  },
  INVALID_CALLS: { statusCode: 400, message: "Call Three is invalid" },
  INVALID_FINAL_EVENT: {
    statusCode: 400,
    message: "Final event is invalid",
  },
  INVALID_NICKNAME: { statusCode: 400, message: "Nickname is invalid" },
  INVALID_PARTICIPANT: {
    statusCode: 400,
    message: "Participant is invalid",
  },
  INVALID_REACTION: { statusCode: 400, message: "Reaction is invalid" },
  INVALID_REACTION_POLICY: {
    statusCode: 400,
    message: "Reaction policy is invalid",
  },
  INVALID_REVISION: { statusCode: 400, message: "Revision is invalid" },
  INVALID_ROOM: { statusCode: 400, message: "Room is invalid" },
  KICKOFF_LOCKED: {
    statusCode: 409,
    message: "Calls locked at kickoff",
  },
  MEMBER_NOT_FOUND: { statusCode: 404, message: "Room member not found" },
  MOMENT_NOT_CONFIRMED: {
    statusCode: 409,
    message: "Moment is not confirmed",
  },
  MOMENT_NOT_FOUND: { statusCode: 404, message: "Moment not found" },
  MOMENT_RESOLUTION_CONFLICT: {
    statusCode: 409,
    message: "Moment resolution conflicts with current truth",
  },
  NICKNAME_TAKEN: {
    statusCode: 409,
    message: "Nickname is already in use",
  },
  NOT_PLAYER: {
    statusCode: 409,
    message: "Spectators cannot submit calls",
  },
  PARTICIPANT_EXISTS: {
    statusCode: 409,
    message: "Participant has already joined",
  },
  REVISION_CONFLICT: {
    statusCode: 409,
    message: "Revision conflicts with current truth",
  },
  ROOM_NOT_ELIGIBLE: {
    statusCode: 409,
    message: "Fixture is not eligible for Call Three",
  },
  ROOM_FINAL: { statusCode: 409, message: "Room is already final" },
};

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
    const safe = safeDomainErrors[error.code];
    return reply.code(safe.statusCode).send({
      error: { code: error.code, message: safe.message },
    });
  }
  return reply.code(500).send({
    error: { code: "ROOM_OPERATION_FAILED", message: "Room operation failed" },
  });
}

function formatSse(event: RoomStreamEvent) {
  return `id: ${event.id}\nevent: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function registerRoomRoutes(app: FastifyInstance, service: RoomService) {
  const headerFanId = (request: FastifyRequest) => {
    const raw = request.headers["x-matchsense-fan-id"];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === "string" && /^[A-Za-z0-9_-]{6,120}$/u.test(value)
      ? value
      : undefined;
  };
  const openSession = (request: FastifyRequest, reply: FastifyReply) => {
    const fanId = headerFanId(request);
    if (fanId) return service.openFanIdentity(fanId);
    const session = service.openSession(roomSessionCapability(request));
    if (session.isNew) {
      setRoomSessionCookie(request, reply, session.capability);
    }
    return session.participantId;
  };
  const authenticate = (request: FastifyRequest) => {
    const fanId = headerFanId(request);
    return fanId
      ? service.openFanIdentity(fanId)
      : service.authenticateSession(roomSessionCapability(request));
  };

  app.post("/api/v1/rooms", async (request, reply) => {
    const body = createBody.safeParse(request.body);
    if (!body.success) return invalidRequest(reply);
    try {
      const participantId = openSession(request, reply);
      return reply.code(201).send(
        service.create({
          ...body.data,
          host: { ...body.data.host, participantId },
        }),
      );
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/api/v1/rooms", async (request, reply) => {
    const query = emptyQuery.safeParse(request.query);
    if (!query.success) return invalidRequest(reply);
    try {
      return reply.send({ rooms: service.list(authenticate(request)) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: { inviteCode: string } }>(
    "/api/v1/rooms/invites/:inviteCode/preview",
    async (request, reply) => {
      const invite = z
        .string()
        .regex(/^[A-Za-z0-9_-]{22}$/u)
        .safeParse(request.params.inviteCode);
      if (!invite.success) return invalidRequest(reply);
      try {
        return reply.send(service.preview(invite.data));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post("/api/v1/rooms/join", async (request, reply) => {
    const body = joinBody.safeParse(request.body);
    if (!body.success) return invalidRequest(reply);
    try {
      return reply.send(
        service.join({
          ...body.data,
          participantId: openSession(request, reply),
        }),
      );
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: { roomId: string } }>(
    "/api/v1/rooms/:roomId",
    async (request, reply) => {
      const params = roomIdParams.safeParse(request.params);
      const query = emptyQuery.safeParse(request.query);
      if (!params.success || !query.success) return invalidRequest(reply);
      try {
        return reply.send(
          service.get(params.data.roomId, authenticate(request)),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.get<{ Params: { roomId: string } }>(
    "/api/v1/rooms/:roomId/stream",
    (request, reply) => {
      const params = roomIdParams.safeParse(request.params);
      const query = streamQuery.safeParse(request.query);
      if (!params.success || !query.success) return invalidRequest(reply);
      let participantId: string;
      try {
        participantId = query.data.fanId
          ? service.openFanIdentity(query.data.fanId)
          : authenticate(request);
        service.get(params.data.roomId, participantId);
      } catch (error) {
        return sendError(reply, error);
      }
      reply.hijack();
      reply.raw.writeHead(200, {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      });
      const unsubscribe = service.subscribe(
        params.data.roomId,
        participantId,
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
    },
  );

  app.put<{ Params: { roomId: string } }>(
    "/api/v1/rooms/:roomId/calls",
    async (request, reply) => {
      const params = roomIdParams.safeParse(request.params);
      const body = callsBody.safeParse(request.body);
      if (!params.success || !body.success) return invalidRequest(reply);
      try {
        return reply.send(
          service.saveCalls({
            roomId: params.data.roomId,
            ...body.data,
            participantId: authenticate(request),
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Params: { roomId: string } }>(
    "/api/v1/rooms/:roomId/picks/open",
    async (request, reply) => {
      const params = roomIdParams.safeParse(request.params);
      const body = emptyBody.safeParse(request.body ?? {});
      if (!params.success || !body.success) return invalidRequest(reply);
      try {
        return reply.send(
          service.openPicks(params.data.roomId, authenticate(request)),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.put<{ Params: { roomId: string } }>(
    "/api/v1/rooms/:roomId/picks",
    async (request, reply) => {
      const params = roomIdParams.safeParse(request.params);
      const body = sensePicksBody.safeParse(request.body);
      if (!params.success || !body.success) return invalidRequest(reply);
      try {
        return reply.send(
          service.saveSensePicks({
            participantId: authenticate(request),
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
      const params = roomIdParams.safeParse(request.params);
      const body = reactionBody.safeParse(request.body);
      if (!params.success || !body.success) return invalidRequest(reply);
      try {
        return reply.code(201).send(
          service.react({
            roomId: params.data.roomId,
            ...body.data,
            participantId: authenticate(request),
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Params: { roomId: string } }>(
    "/api/v1/rooms/:roomId/demo/start",
    async (request, reply) => {
      const params = roomIdParams.safeParse(request.params);
      const body = emptyBody.safeParse(request.body ?? {});
      if (!params.success || !body.success) return invalidRequest(reply);
      try {
        const participantId = authenticate(request);
        return reply.send(service.startDemo(params.data.roomId, participantId));
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Params: { roomId: string } }>(
    "/api/v1/rooms/:roomId/demo/resolve-stats",
    async (request, reply) => {
      const params = roomIdParams.safeParse(request.params);
      const body = statsBody.safeParse(request.body);
      if (!params.success || !body.success) {
        return invalidRequest(reply);
      }
      try {
        const participantId = authenticate(request);
        return reply.send(
          service.resolveDemoStats({
            ...body.data,
            participantId,
            roomId: params.data.roomId,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Params: { roomId: string } }>(
    "/api/v1/rooms/:roomId/demo/register-moment",
    async (request, reply) => {
      const params = roomIdParams.safeParse(request.params);
      const body = registerMomentBody.safeParse(request.body);
      if (!params.success || !body.success) {
        return invalidRequest(reply);
      }
      try {
        const participantId = authenticate(request);
        return reply.send(
          service.registerDemoMoment({
            ...body.data,
            participantId,
            roomId: params.data.roomId,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Params: { roomId: string } }>(
    "/api/v1/rooms/:roomId/demo/resolve-moment",
    async (request, reply) => {
      const params = roomIdParams.safeParse(request.params);
      const body = resolveMomentBody.safeParse(request.body);
      if (!params.success || !body.success) {
        return invalidRequest(reply);
      }
      try {
        const participantId = authenticate(request);
        return reply.send(
          service.resolveDemoMoment({
            ...body.data,
            participantId,
            roomId: params.data.roomId,
          }),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.post<{ Params: { roomId: string } }>(
    "/api/v1/rooms/:roomId/demo/finalise",
    async (request, reply) => {
      const params = roomIdParams.safeParse(request.params);
      const body = emptyBody.safeParse(request.body ?? {});
      if (!params.success || !body.success) {
        return invalidRequest(reply);
      }
      try {
        const participantId = authenticate(request);
        return reply.send(
          service.finaliseDemo(params.data.roomId, participantId),
        );
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );
}
