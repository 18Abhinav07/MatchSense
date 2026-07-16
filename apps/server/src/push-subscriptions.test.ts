import { describe, expect, it } from "vitest";

import {
  InMemoryPushSubscriptionStore,
  PushSubscriptionExpiredError,
  parsePushSubscription,
} from "./push-subscriptions.js";

const validSubscription = {
  endpoint: "https://push.example.test/send/device-1",
  expirationTime: null,
  keys: {
    auth: "AQIDBAUGBwgJCgsMDQ4PEA",
    p256dh:
      "BAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-P0A",
  },
} as const;

describe("browser PushSubscription validation", () => {
  it("accepts the standards-shaped JSON serialization", () => {
    expect(parsePushSubscription(validSubscription)).toEqual(validSubscription);
  });

  it.each([
    {
      ...validSubscription,
      endpoint: "http://push.example.test/send/device-1",
    },
    {
      ...validSubscription,
      keys: { ...validSubscription.keys, auth: "not+base64" },
    },
    {
      ...validSubscription,
      keys: { ...validSubscription.keys, p256dh: "AQID" },
    },
    { ...validSubscription, extra: "not allowed" },
  ])("rejects malformed or unsafe subscription input", (input) => {
    expect(() => parsePushSubscription(input)).toThrow(
      "Push subscription is invalid",
    );
  });
});

describe("InMemoryPushSubscriptionStore", () => {
  it("upserts by endpoint while preserving the registration identity", () => {
    let currentTime = 1_000;
    const store = new InMemoryPushSubscriptionStore({
      id: () => "push-registration-1",
      now: () => currentTime,
    });

    const first = store.upsert(validSubscription);
    currentTime = 2_000;
    const updated = store.upsert({
      ...validSubscription,
      keys: {
        ...validSubscription.keys,
        auth: "EA8ODQwLCgkIBwYFBAMCAQ",
      },
    });

    expect(updated).toMatchObject({
      createdAt: "1970-01-01T00:00:01.000Z",
      id: first.id,
      updatedAt: "1970-01-01T00:00:02.000Z",
    });
    expect(updated.subscription.keys.auth).toBe("EA8ODQwLCgkIBwYFBAMCAQ");
    expect(store.list()).toHaveLength(1);
  });

  it("removes registrations and never returns mutable store state", () => {
    const store = new InMemoryPushSubscriptionStore({
      id: () => "push-registration-1",
      now: () => 1_000,
    });
    const saved = store.upsert(validSubscription);

    saved.subscription.keys.auth = "mutated";
    expect(store.get(saved.id)?.subscription.keys.auth).toBe(
      validSubscription.keys.auth,
    );
    expect(store.remove(saved.id)).toBe(true);
    expect(store.get(saved.id)).toBeNull();
    expect(store.remove(saved.id)).toBe(false);
  });

  it("rejects already-expired subscriptions and prunes later expiry", () => {
    let currentTime = 10_000;
    const store = new InMemoryPushSubscriptionStore({
      id: () => "push-registration-1",
      now: () => currentTime,
    });
    const expired = { ...validSubscription, expirationTime: 9_999 };

    expect(() => store.upsert(expired)).toThrow(PushSubscriptionExpiredError);

    store.upsert({ ...validSubscription, expirationTime: 10_001 });
    currentTime = 10_002;
    expect(store.list()).toEqual([]);
  });
});
