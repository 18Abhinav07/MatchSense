import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import {
  createMomentPushEnvelope,
  createTestPushEnvelope,
  registerPushRoutes,
  type WebPushSender,
} from "./push-delivery.js";
import { InMemoryPushSubscriptionStore } from "./push-subscriptions.js";

const validSubscription = {
  endpoint: "https://push.example.test/send/device-1",
  expirationTime: null,
  keys: {
    auth: "AQIDBAUGBwgJCgsMDQ4PEA",
    p256dh:
      "BAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-P0A",
  },
};

const moment = {
  body: "Argentina lead France 1–0 in the 23rd minute.",
  familyId: "arg-fra-demo:score:1-0",
  fixtureId: "arg-fra-demo",
  momentId: "arg-fra-demo:score:1-0",
  occurredAt: "2026-07-16T12:12:07.000Z",
  revision: 1,
  title: "GOAL — ARGENTINA",
};

describe("canonical Moment push envelope", () => {
  it("derives identity and safe deep-link data rather than accepting a URL", () => {
    expect(createMomentPushEnvelope(moment)).toEqual({
      body: moment.body,
      familyId: moment.familyId,
      fixtureId: moment.fixtureId,
      identity: "arg-fra-demo:score:1-0:1",
      intentId: expect.stringMatching(/^intent_[a-f0-9]{32}$/u),
      kind: "moment",
      momentId: moment.momentId,
      occurredAt: moment.occurredAt,
      revision: 1,
      route: "/matches/arg-fra-demo/moments/arg-fra-demo%3Ascore%3A1-0%3A1",
      schemaVersion: 1,
      tag: "matchsense:arg-fra-demo:arg-fra-demo:score:1-0",
      title: moment.title,
      type: "matchsense.moment",
    });
  });

  it("uses a separate test-only tag namespace that cannot be mistaken for live sport", () => {
    expect(createTestPushEnvelope(moment, "run-20260718")).toMatchObject({
      familyId: moment.familyId,
      kind: "test",
      route: "/matches/arg-fra-demo/moments/arg-fra-demo%3Ascore%3A1-0%3A1",
      tag: "matchsense:test:run-20260718:arg-fra-demo:arg-fra-demo:score:1-0",
    });
  });
});

describe("push delivery routes", () => {
  it("registers once and passes the canonical JSON payload to the sender", async () => {
    const store = new InMemoryPushSubscriptionStore({
      id: () => "push-registration-1",
      now: () => Date.parse("2026-07-16T12:00:00.000Z"),
    });
    const send = vi.fn<WebPushSender["send"]>(async () => ({
      accepted: true,
    }));
    const app = Fastify({ logger: false });
    registerPushRoutes(app, {
      applicationServerKey:
        "BAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-P0A",
      sender: { send },
      store,
    });

    const config = await app.inject({ url: "/api/v1/push/config" });
    const registered = await app.inject({
      method: "POST",
      payload: { subscription: validSubscription },
      url: "/api/v1/push/subscriptions",
    });
    const registration = registered.json() as { id: string };
    const delivered = await app.inject({
      method: "POST",
      payload: moment,
      url: `/api/v1/push/subscriptions/${registration.id}/test`,
    });

    expect(config.json()).toEqual({
      applicationServerKey:
        "BAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-P0A",
      supported: true,
    });
    expect(registered.statusCode).toBe(201);
    expect(delivered.statusCode).toBe(202);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      validSubscription,
      JSON.stringify(createTestPushEnvelope(moment, "push-registration-1")),
    );
    await app.close();
  });

  it("fails closed for malformed subscription, missing registration, and sender failure", async () => {
    const store = new InMemoryPushSubscriptionStore({
      id: () => "push-registration-1",
    });
    const app = Fastify({ logger: false });
    registerPushRoutes(app, {
      applicationServerKey:
        "BAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-P0A",
      sender: {
        send: async () => {
          throw new Error("https://push.example.test/sensitive/device-token");
        },
      },
      store,
    });

    const malformed = await app.inject({
      method: "POST",
      payload: {
        subscription: { ...validSubscription, endpoint: "javascript:alert(1)" },
      },
      url: "/api/v1/push/subscriptions",
    });
    const missing = await app.inject({
      method: "POST",
      payload: moment,
      url: "/api/v1/push/subscriptions/missing/test",
    });
    store.upsert(validSubscription);
    const failed = await app.inject({
      method: "POST",
      payload: moment,
      url: "/api/v1/push/subscriptions/push-registration-1/test",
    });

    expect(malformed.statusCode).toBe(400);
    expect(missing.statusCode).toBe(404);
    expect(failed.statusCode).toBe(502);
    expect(failed.body).not.toContain("device-token");
    await app.close();
  });
});
