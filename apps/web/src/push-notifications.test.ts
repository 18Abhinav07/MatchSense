import { describe, expect, it, vi } from "vitest";

import {
  enableMomentPush,
  serializePushSubscription,
  showLocalMomentNotification,
  triggerTestMomentPush,
  type BrowserPushDependencies,
} from "./push-notifications";

const keyBytes = Uint8Array.from([1, 2, 3, 4]).buffer;
const moment = {
  body: "Argentina lead France 1–0 in the 23rd minute.",
  fixtureId: "arg-fra-demo",
  momentId: "arg-fra-demo:score:1-0",
  occurredAt: "2026-07-16T12:12:07.000Z",
  revision: 1,
  title: "GOAL — ARGENTINA",
};

function subscription() {
  return {
    endpoint: "https://push.example.test/send/device-1",
    expirationTime: null,
    getKey: (name: PushEncryptionKeyName) =>
      name === "auth" ? keyBytes : keyBytes,
    toJSON: () => ({
      endpoint: "https://push.example.test/send/device-1",
      expirationTime: null,
      keys: {
        auth: "AQIDBA",
        p256dh: "AQIDBA",
      },
    }),
    unsubscribe: async () => true,
  } as unknown as PushSubscription;
}

describe("PushSubscription browser serialization", () => {
  it("produces stable JSON with URL-safe keys", () => {
    expect(serializePushSubscription(subscription())).toEqual({
      endpoint: "https://push.example.test/send/device-1",
      expirationTime: null,
      keys: { auth: "AQIDBA", p256dh: "AQIDBA" },
    });
  });

  it("falls back to getKey when a browser omits keys from toJSON", () => {
    const source = subscription();
    source.toJSON = () => ({
      endpoint: source.endpoint,
      expirationTime: null,
    });

    expect(serializePushSubscription(source).keys).toEqual({
      auth: "AQIDBA",
      p256dh: "AQIDBA",
    });
  });
});

describe("browser push activation", () => {
  it("requests permission, subscribes with VAPID, and stores the serialization", async () => {
    const source = subscription();
    const subscribe = vi.fn(async () => source);
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ createdAt: "now", id: "push-registration-1" }),
          { headers: { "Content-Type": "application/json" }, status: 201 },
        ),
    );
    const dependencies: BrowserPushDependencies = {
      fetch,
      notification: {
        get permission(): NotificationPermission {
          return "default";
        },
        requestPermission: async (): Promise<NotificationPermission> =>
          "granted",
      },
      serviceWorkerReady: Promise.resolve({
        pushManager: {
          getSubscription: async () => null,
          subscribe,
        },
      } as unknown as ServiceWorkerRegistration),
    };

    const result = await enableMomentPush({
      applicationServerKey:
        "BAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-P0A",
      dependencies,
      preferences: { fullTime: false, goals: true, redCards: true },
    });

    expect(result).toEqual({
      id: "push-registration-1",
      subscription: serializePushSubscription(source),
    });
    expect(subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true }),
    );
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/push/subscriptions",
      expect.objectContaining({
        body: JSON.stringify({
          preferences: { fullTime: false, goals: true, redCards: true },
          subscription: serializePushSubscription(source),
        }),
        method: "POST",
      }),
    );
  });

  it("returns a useful boundary without prompting on unsupported browsers", async () => {
    await expect(
      enableMomentPush({
        applicationServerKey: "unused",
        dependencies: {
          fetch: vi.fn(),
          notification: null,
          serviceWorkerReady: null,
        },
      }),
    ).rejects.toThrow("Push notifications are not supported");
  });

  it("never subscribes after permission is denied", async () => {
    const subscribe = vi.fn();
    await expect(
      enableMomentPush({
        applicationServerKey:
          "BAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-P0A",
        dependencies: {
          fetch: vi.fn(),
          notification: {
            get permission(): NotificationPermission {
              return "denied";
            },
            requestPermission: async (): Promise<NotificationPermission> =>
              "denied",
          },
          serviceWorkerReady: Promise.resolve({
            pushManager: { subscribe },
          } as unknown as ServiceWorkerRegistration),
        },
      }),
    ).rejects.toThrow("Notification permission was denied");
    expect(subscribe).not.toHaveBeenCalled();
  });
});

describe("test Moment notifications", () => {
  it("keeps a local preview separate from a real Moment replacement tag", async () => {
    const showNotification = vi.fn(async () => undefined);
    await showLocalMomentNotification(moment, {
      pushManager: {} as PushManager,
      showNotification,
    } as unknown as ServiceWorkerRegistration);

    expect(showNotification).toHaveBeenCalledWith(
      moment.title,
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "test",
          identity: "arg-fra-demo:score:1-0:1",
        }),
        tag: "matchsense:preview:arg-fra-demo:arg-fra-demo:score:1-0",
      }),
    );
  });

  it("asks the server to send the same canonical Moment payload", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 202 }));
    await triggerTestMomentPush("push-registration-1", moment, fetch);

    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/push/subscriptions/push-registration-1/test",
      expect.objectContaining({
        body: JSON.stringify(moment),
        method: "POST",
      }),
    );
  });
});
