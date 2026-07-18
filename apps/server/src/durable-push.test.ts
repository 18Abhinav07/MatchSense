import { describe, expect, it, vi } from "vitest";

import type {
  FanFollowRecord,
  PushDeliveryStatus,
  PushDeviceRecord,
} from "@matchsense/db";

import {
  createDurablePushRegistrationService,
  createDurablePushService,
} from "./durable-push.js";
import { createPushSubscriptionCipher } from "./push-crypto.js";

const subscription = {
  endpoint: "https://push.example.test/fan-one",
  expirationTime: null,
  keys: {
    auth: "AQIDBAUGBwgJCgsMDQ4PEA",
    p256dh:
      "BAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-P0A",
  },
};

function harness(options: { goals?: boolean; redCards?: boolean } = {}) {
  const devices = new Map<string, PushDeviceRecord>();
  const deliveries: Array<{ status: PushDeliveryStatus }> = [];
  const follow: FanFollowRecord = {
    createdAt: "2026-07-17T12:00:00.000Z",
    eventPreferences: {
      goals: options.goals ?? true,
      redCards: options.redCards ?? true,
    },
    fanId: "fan-1",
    fixtureId: "experience:run-1",
    mode: "demo",
  };
  const repository = {
    getActiveForFan: async (input: { deviceId: string; fanId: string }) => {
      const record = devices.get(input.deviceId) ?? null;
      return record?.fanId === input.fanId ? record : null;
    },
    invalidate: vi.fn(async ({ deviceId }: { deviceId: string }) => {
      const current = devices.get(deviceId);
      if (!current) return false;
      devices.set(deviceId, {
        ...current,
        invalidatedAt: "2026-07-17T12:30:00.000Z",
      });
      return true;
    }),
    listActiveForFan: async (fanId: string) =>
      [...devices.values()].filter(
        (device) => device.fanId === fanId && !device.invalidatedAt,
      ),
    recordDelivery: vi.fn(async (input: { status: PushDeliveryStatus }) => {
      deliveries.push(input);
    }),
    upsertDevice: vi.fn(async (input) => {
      const record: PushDeviceRecord = {
        ...input,
        createdAt: "2026-07-17T12:00:00.000Z",
        invalidatedAt: null,
        lastFailureAt: null,
        lastSuccessAt: null,
        updatedAt: "2026-07-17T12:00:00.000Z",
      };
      devices.set(record.id, record);
      return record;
    }),
  };
  const sender = {
    send: vi.fn(async () => ({ accepted: true })),
  };
  const service = createDurablePushService({
    cipher: createPushSubscriptionCipher({
      randomBytes: () => Buffer.alloc(12, 4),
      secret: "fixture-matchsense-secret-with-enough-entropy",
    }),
    devices: repository,
    fans: { listFollowers: async () => [follow] },
    id: (() => {
      let value = 0;
      return () => `generated-${++value}`;
    })(),
    now: () => "2026-07-17T12:30:00.000Z",
    sender,
  });
  return { deliveries, devices, repository, sender, service };
}

describe("durable targeted push delivery", () => {
  it("registers encrypted subscriptions without a VAPID sender", async () => {
    const devices = new Map<string, PushDeviceRecord>();
    const registration = createDurablePushRegistrationService({
      cipher: createPushSubscriptionCipher({
        randomBytes: () => Buffer.alloc(12, 4),
        secret: "fixture-matchsense-secret-with-enough-entropy",
      }),
      devices: {
        getActiveForFan: async (input) => {
          const record = devices.get(input.deviceId) ?? null;
          return record?.fanId === input.fanId ? record : null;
        },
        invalidate: async ({ deviceId }) => {
          const record = devices.get(deviceId);
          if (!record) return false;
          devices.set(deviceId, {
            ...record,
            invalidatedAt: "2026-07-17T12:30:00.000Z",
          });
          return true;
        },
        upsertDevice: async (input) => {
          const record: PushDeviceRecord = {
            ...input,
            createdAt: "2026-07-17T12:00:00.000Z",
            invalidatedAt: null,
            lastFailureAt: null,
            lastSuccessAt: null,
            updatedAt: "2026-07-17T12:00:00.000Z",
          };
          devices.set(record.id, record);
          return record;
        },
      },
      id: () => "api-registration-only",
    });

    const device = await registration.register({
      fanId: "fan-1",
      preferences: { goals: true },
      subscription,
    });

    expect(device).toMatchObject({ id: "api-registration-only" });
    expect(device.ciphertext.byteLength).toBeGreaterThan(0);
    await expect(
      registration.invalidate("fan-1", "api-registration-only"),
    ).resolves.toBe(true);
  });

  it("encrypts a fan device and sends one confirmed Moment only to followers", async () => {
    const { deliveries, sender, service } = harness();
    const device = await service.register({
      fanId: "fan-1",
      preferences: { goals: true },
      subscription,
    });

    await expect(
      service.deliverToFixture(
        {
          body: "Argentina lead.",
          fixtureId: "experience:run-1",
          momentId: "run-1:goal",
          occurredAt: "2026-07-17T12:12:00.000Z",
          revision: 3,
          title: "GOAL — Argentina 1–0 France",
        },
        "demo",
      ),
    ).resolves.toEqual({ accepted: 1, attempted: 1 });
    expect(device).toMatchObject({ id: "generated-1" });
    expect(sender.send).toHaveBeenCalledWith(subscription, expect.any(String));
    expect(deliveries).toEqual([expect.objectContaining({ status: "sent" })]);
  });

  it("keeps a followed fixture quiet when the fan disabled goal alerts", async () => {
    const { sender, service } = harness({ goals: false });
    await service.register({
      fanId: "fan-1",
      preferences: { goals: false },
      subscription,
    });

    await expect(
      service.deliverToFixture(
        {
          body: "Argentina lead.",
          fixtureId: "experience:run-1",
          momentId: "run-1:goal",
          occurredAt: "2026-07-17T12:12:00.000Z",
          revision: 3,
          title: "GOAL — Argentina 1–0 France",
        },
        "demo",
      ),
    ).resolves.toEqual({ accepted: 0, attempted: 0 });
    expect(sender.send).not.toHaveBeenCalled();
  });

  it("delivers a red-card alert through its independent preference", async () => {
    const { sender, service } = harness({ goals: false, redCards: true });
    await service.register({
      fanId: "fan-1",
      preferences: { goals: false, redCards: true },
      subscription,
    });

    await expect(
      service.deliverToFixture(
        {
          body: "France are down to ten.",
          eventKind: "card.red",
          fixtureId: "experience:run-1",
          momentId: "run-1:red-card",
          occurredAt: "2026-07-17T12:48:00.000Z",
          revision: 8,
          title: "🟥 RED CARD — France",
        },
        "demo",
      ),
    ).resolves.toEqual({ accepted: 1, attempted: 1 });
    expect(sender.send).toHaveBeenCalledOnce();
  });
});
