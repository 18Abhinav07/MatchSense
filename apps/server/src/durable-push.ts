import { createHash, randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type {
  FanRepository,
  PersistenceMode,
  PushDeviceRepository,
  PushDeviceRecord,
} from "@matchsense/db";

import {
  createMomentPushEnvelope,
  parseMomentPushInput,
  type MomentPushInput,
  type WebPushSender,
} from "./push-delivery.js";
import type { PushSubscriptionCipher } from "./push-crypto.js";
import { requireFanMutationSession } from "./fan-routes.js";
import type { FanSessionService } from "./fan-session.js";

export interface DurablePushServiceOptions {
  cipher: PushSubscriptionCipher;
  devices: Pick<
    PushDeviceRepository,
    | "getActiveForFan"
    | "invalidate"
    | "listActiveForFan"
    | "recordDelivery"
    | "upsertDevice"
  >;
  fans: Pick<FanRepository, "listFollowers">;
  id?: () => string;
  now?: () => string;
  sender: WebPushSender;
}

export interface DurablePushRegistrationServiceOptions {
  cipher: PushSubscriptionCipher;
  devices: Pick<
    PushDeviceRepository,
    "getActiveForFan" | "invalidate" | "upsertDevice"
  >;
  id?: () => string;
  now?: () => string;
}

function enabled(value: unknown, fallback = true) {
  return typeof value === "boolean" ? value : fallback;
}

function preferenceFor(
  preferences: Record<string, unknown>,
  eventKind: MomentPushInput["eventKind"],
) {
  if (eventKind === "card.red") {
    return enabled(preferences.redCards ?? preferences.redCard);
  }
  if (eventKind === "phase.full_time") {
    return enabled(preferences.fullTime);
  }
  return enabled(preferences.goals ?? preferences.goal);
}

function deliveryId(input: {
  deviceId: string;
  fixtureId: string;
  mode: PersistenceMode;
  momentId: string;
  revision: number;
}) {
  return `push_${createHash("sha256")
    .update(
      [
        input.deviceId,
        input.mode,
        input.fixtureId,
        input.momentId,
        input.revision,
      ].join("|"),
    )
    .digest("hex")
    .slice(0, 32)}`;
}

export function createDurablePushRegistrationService(
  options: DurablePushRegistrationServiceOptions,
) {
  const id = options.id ?? randomUUID;
  const now = options.now ?? (() => new Date().toISOString());

  return {
    invalidate: async (fanId: string, deviceId: string) => {
      const device = await options.devices.getActiveForFan({ deviceId, fanId });
      if (!device) return false;
      return options.devices.invalidate({ deviceId, failedAt: now() });
    },
    register: async (input: {
      fanId: string;
      preferences: Record<string, unknown>;
      subscription: unknown;
    }) => {
      const sealed = options.cipher.seal(input.subscription);
      const parsed = options.cipher.open(sealed);
      return options.devices.upsertDevice({
        ...sealed,
        expiresAt:
          parsed.expirationTime === null
            ? null
            : new Date(parsed.expirationTime).toISOString(),
        fanId: input.fanId,
        id: id(),
        preferences: input.preferences,
      });
    },
  };
}

export type DurablePushRegistrationService = ReturnType<
  typeof createDurablePushRegistrationService
>;

export function createDurablePushService(options: DurablePushServiceOptions) {
  const now = options.now ?? (() => new Date().toISOString());
  const registration = createDurablePushRegistrationService({
    cipher: options.cipher,
    devices: options.devices,
    ...(options.id ? { id: options.id } : {}),
    now,
  });

  const sendDevice = async (
    device: PushDeviceRecord,
    input: MomentPushInput,
    mode: PersistenceMode,
  ) => {
    const record = {
      deviceId: device.id,
      fixtureId: input.fixtureId,
      id: deliveryId({
        deviceId: device.id,
        fixtureId: input.fixtureId,
        mode,
        momentId: input.momentId,
        revision: input.revision,
      }),
      mode,
      momentId: input.momentId,
      momentRevision: input.revision,
    };
    try {
      const subscription = options.cipher.open(device);
      const result = await options.sender.send(
        subscription,
        JSON.stringify(createMomentPushEnvelope(input)),
      );
      await options.devices.recordDelivery({
        ...record,
        lastError: result.accepted ? null : "push_not_accepted",
        sentAt: result.accepted ? now() : null,
        status: result.accepted ? "sent" : "failed",
      });
      return result.accepted;
    } catch (error) {
      await options.devices.recordDelivery({
        ...record,
        lastError:
          error instanceof Error ? error.message.slice(0, 300) : "push_failed",
        sentAt: null,
        status: "failed",
      });
      return false;
    }
  };

  return {
    ...registration,
    deliverToFixture: async (input: MomentPushInput, mode: PersistenceMode) => {
      const followers = await options.fans.listFollowers({
        fixtureId: input.fixtureId,
        mode,
      });
      const fanIds = [
        ...new Set(
          followers
            .filter((follow) =>
              preferenceFor(follow.eventPreferences, input.eventKind),
            )
            .map((follow) => follow.fanId),
        ),
      ];
      const devices = (
        await Promise.all(
          fanIds.map((fanId) => options.devices.listActiveForFan(fanId)),
        )
      )
        .flat()
        .filter((device) => preferenceFor(device.preferences, input.eventKind));
      const results = await Promise.all(
        devices.map((device) => sendDevice(device, input, mode)),
      );
      return {
        accepted: results.filter(Boolean).length,
        attempted: results.length,
      };
    },
    sendTest: async (
      fanId: string,
      deviceId: string,
      input: MomentPushInput,
      mode: PersistenceMode,
    ) => {
      const device = await options.devices.getActiveForFan({ deviceId, fanId });
      return device ? sendDevice(device, input, mode) : null;
    },
  };
}

export type DurablePushService = ReturnType<typeof createDurablePushService>;

const durableRegistrationBody = z
  .object({
    preferences: z.record(z.string(), z.unknown()).default({ goals: true }),
    subscription: z.unknown(),
  })
  .strict();

export interface DurablePushRouteDependencies {
  applicationServerKey: string;
  service: DurablePushRegistrationService;
  sessions: FanSessionService;
  testService?: Pick<DurablePushService, "sendTest">;
}

function testDeliveryService(
  dependencies: DurablePushRouteDependencies,
): Pick<DurablePushService, "sendTest"> | null {
  if (dependencies.testService) return dependencies.testService;
  const candidate = dependencies.service as {
    sendTest?: DurablePushService["sendTest"];
  };
  return typeof candidate.sendTest === "function"
    ? { sendTest: candidate.sendTest }
    : null;
}

export function registerDurablePushRoutes(
  app: FastifyInstance,
  dependencies: DurablePushRouteDependencies,
) {
  app.get("/api/v1/push/config", async (_request, reply) =>
    reply.header("Cache-Control", "no-store").send({
      applicationServerKey: dependencies.applicationServerKey,
      supported: true,
    }),
  );
  app.post("/api/v1/push/subscriptions", async (request, reply) => {
    const session = await requireFanMutationSession(
      request,
      reply,
      dependencies.sessions,
    );
    if (!session) return;
    const parsed = durableRegistrationBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "push_subscription_invalid" });
    }
    try {
      const device = await dependencies.service.register({
        fanId: session.fan.id,
        preferences: parsed.data.preferences,
        subscription: parsed.data.subscription,
      });
      return reply.code(201).send({ id: device.id });
    } catch {
      return reply.code(400).send({ error: "push_subscription_invalid" });
    }
  });
  app.delete<{ Params: { id: string } }>(
    "/api/v1/push/subscriptions/:id",
    async (request, reply) => {
      const session = await requireFanMutationSession(
        request,
        reply,
        dependencies.sessions,
      );
      if (!session) return;
      return (await dependencies.service.invalidate(
        session.fan.id,
        request.params.id,
      ))
        ? reply.code(204).send()
        : reply.code(404).send({ error: "push_device_not_found" });
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/push/subscriptions/:id/test",
    async (request, reply) => {
      const session = await requireFanMutationSession(
        request,
        reply,
        dependencies.sessions,
      );
      if (!session) return;
      let input: MomentPushInput;
      try {
        input = parseMomentPushInput(request.body);
      } catch {
        return reply.code(400).send({ error: "push_moment_invalid" });
      }
      const testService = testDeliveryService(dependencies);
      if (!testService) {
        return reply.code(501).send({ error: "push_test_unavailable" });
      }
      const accepted = await testService.sendTest(
        session.fan.id,
        request.params.id,
        input,
        input.fixtureId.startsWith("experience:") ? "demo" : "live",
      );
      if (accepted === null) {
        return reply.code(404).send({ error: "push_device_not_found" });
      }
      return accepted
        ? reply.code(202).send({ accepted: true })
        : reply.code(502).send({ error: "push_delivery_failed" });
    },
  );
}
