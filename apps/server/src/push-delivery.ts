import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import {
  type InMemoryPushSubscriptionStore,
  type SerializedPushSubscription,
} from "./push-subscriptions.js";

const registrationBody = z.object({ subscription: z.unknown() }).strict();
const momentPushInput = z
  .object({
    body: z.string().trim().min(1).max(300),
    fixtureId: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z0-9_-]+$/u),
    momentId: z.string().min(1).max(240),
    occurredAt: z.iso.datetime({ offset: true }),
    revision: z.number().int().positive().safe(),
    title: z.string().trim().min(1).max(80),
  })
  .strict();

export type MomentPushInput = z.infer<typeof momentPushInput>;

export interface MomentPushEnvelope extends MomentPushInput {
  identity: string;
  schemaVersion: 1;
  type: "matchsense.moment";
}

export interface WebPushSender {
  send(
    subscription: SerializedPushSubscription,
    payload: string,
  ): Promise<{ accepted: boolean }>;
}

export interface PushRouteDependencies {
  applicationServerKey: string;
  sender: WebPushSender;
  store: InMemoryPushSubscriptionStore;
}

export async function deliverMomentPush(
  input: MomentPushInput,
  dependencies: Pick<PushRouteDependencies, "sender" | "store">,
) {
  const payload = JSON.stringify(createMomentPushEnvelope(input));
  const results = await Promise.allSettled(
    dependencies.store
      .list()
      .map((registration) =>
        dependencies.sender.send(registration.subscription, payload),
      ),
  );
  return {
    accepted: results.filter(
      (result) => result.status === "fulfilled" && result.value.accepted,
    ).length,
    attempted: results.length,
  };
}

export function createMomentPushEnvelope(
  input: MomentPushInput,
): MomentPushEnvelope {
  const parsed = momentPushInput.parse(input);
  return {
    ...parsed,
    identity: `${parsed.momentId}:${parsed.revision}`,
    schemaVersion: 1,
    type: "matchsense.moment",
  };
}

function invalidRequest(reply: FastifyReply) {
  return reply.code(400).send({
    error: { code: "INVALID_REQUEST", message: "Request is invalid" },
  });
}

function notFound(reply: FastifyReply) {
  return reply.code(404).send({
    error: { code: "NOT_FOUND", message: "Push registration not found" },
  });
}

/**
 * Installs the browser-facing API without choosing a Web Push provider.
 * Production must inject a sender that performs VAPID signing and RFC 8291
 * payload encryption; this module never handles or logs private VAPID keys.
 */
export function registerPushRoutes(
  app: FastifyInstance,
  dependencies: PushRouteDependencies,
) {
  app.get("/api/v1/push/config", async (_request, reply) =>
    reply.header("Cache-Control", "no-store").send({
      applicationServerKey: dependencies.applicationServerKey,
      supported: true,
    }),
  );

  app.post("/api/v1/push/subscriptions", async (request, reply) => {
    const body = registrationBody.safeParse(request.body);
    if (!body.success) return invalidRequest(reply);
    try {
      const registration = dependencies.store.upsert(body.data.subscription);
      return reply.code(201).send(registration);
    } catch {
      return invalidRequest(reply);
    }
  });

  app.delete<{ Params: { id: string } }>(
    "/api/v1/push/subscriptions/:id",
    async (request, reply) =>
      dependencies.store.remove(request.params.id)
        ? reply.code(204).send()
        : notFound(reply),
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/push/subscriptions/:id/test",
    async (request, reply) => {
      const input = momentPushInput.safeParse(request.body);
      if (!input.success) return invalidRequest(reply);
      const registration = dependencies.store.get(request.params.id);
      if (!registration) return notFound(reply);
      try {
        const payload = JSON.stringify(createMomentPushEnvelope(input.data));
        const result = await dependencies.sender.send(
          registration.subscription,
          payload,
        );
        if (!result.accepted) {
          return reply.code(502).send({
            error: {
              code: "PUSH_DELIVERY_FAILED",
              message: "Push service did not accept the notification",
            },
          });
        }
        return reply.code(202).send({ accepted: true });
      } catch {
        return reply.code(502).send({
          error: {
            code: "PUSH_DELIVERY_FAILED",
            message: "Push service did not accept the notification",
          },
        });
      }
    },
  );
}
