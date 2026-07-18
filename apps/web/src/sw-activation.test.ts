/// <reference types="node" />

import { readFile } from "node:fs/promises";
import vm from "node:vm";

import { beforeAll, describe, expect, it, vi } from "vitest";

type WorkerHandler = (event: Record<string, unknown>) => void;

interface WorkerHarness {
  events: string[];
  handlers: Map<string, WorkerHandler>;
  self: Record<string, unknown>;
}

let pushSource = "";
let serviceWorkerSource = "";

beforeAll(async () => {
  [pushSource, serviceWorkerSource] = await Promise.all([
    readFile(
      new URL("../public/push-notification.js", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
  ]);
});

function createHarness(
  options: { windows?: readonly Record<string, unknown>[] } = {},
) {
  const handlers = new Map<string, WorkerHandler>();
  const events: string[] = [];
  const self: Record<string, unknown> = {
    MatchSenseActivationStore: {
      persist: async () => events.push("persist"),
    },
    addEventListener: (type: string, listener: WorkerHandler) => {
      handlers.set(type, listener);
    },
    clients: {
      matchAll: async () => options.windows ?? [],
      openWindow: async () => {
        events.push("open");
        return null;
      },
    },
    location: { origin: "https://matchsense.example" },
    registration: { showNotification: vi.fn(async () => undefined) },
  };
  const context = {
    URL,
    Response,
    caches: {
      delete: vi.fn(async () => true),
      keys: vi.fn(async () => []),
      match: vi.fn(async () => undefined),
      open: vi.fn(async () => ({ addAll: vi.fn(), put: vi.fn() })),
    },
    clearTimeout,
    fetch: vi.fn(async () => new Response("ok", { status: 200 })),
    importScripts: () => undefined,
    self,
    setTimeout,
  };
  vm.runInNewContext(pushSource, context);
  vm.runInNewContext(serviceWorkerSource, context);
  return { events, handlers, self } satisfies WorkerHarness;
}

const payload = {
  body: "Argentina lead France 1–0 in the 23rd minute.",
  familyId: "arg-fra:score:1-0",
  fixtureId: "arg-fra-demo",
  identity: "arg-fra:score:1-0:1",
  intentId: "intent_0123456789abcdef",
  kind: "moment",
  momentId: "arg-fra:score:1-0",
  occurredAt: "2026-07-16T12:12:07.000Z",
  revision: 1,
  route: "/matches/arg-fra-demo/moments/arg-fra%3Ascore%3A1-0%3A1",
  schemaVersion: 1,
  tag: "matchsense:arg-fra-demo:arg-fra:score:1-0",
  title: "GOAL — ARGENTINA",
  type: "matchsense.moment",
};

async function click(harness: WorkerHarness, data: unknown) {
  let completion: Promise<unknown> | null = null;
  harness.handlers.get("notificationclick")?.({
    notification: { close: vi.fn(), data },
    waitUntil: (work: Promise<unknown>) => {
      completion = work;
    },
  });
  await completion;
}

describe("service-worker activation contract", () => {
  it("persists a cold PushPayloadV1 activation before opening the PWA", async () => {
    const harness = createHarness();
    const push = (
      harness.self.MatchSensePush as {
        notificationFor(value: unknown): { options: { data: unknown } };
      }
    ).notificationFor(payload);

    await click(harness, push.options.data);

    expect(harness.events).toEqual(["persist", "open"]);
  });

  it("posts a warm route activation before focusing the already-open PWA", async () => {
    const events: string[] = [];
    const client = {
      focus: async () => {
        events.push("focus");
        return client;
      },
      postMessage: (message: unknown) => events.push(JSON.stringify(message)),
      url: "https://matchsense.example/matches/arg-fra-demo",
    };
    const harness = createHarness({ windows: [client] });
    const push = (
      harness.self.MatchSensePush as {
        notificationFor(value: unknown): { options: { data: unknown } };
      }
    ).notificationFor(payload);

    await click(harness, push.options.data);

    expect(harness.events).toEqual([]);
    expect(events).toEqual([
      expect.stringContaining('"type":"matchsense:open-route"'),
      "focus",
    ]);
  });

  it("does not cache API, SSE, MP3, range, or mutation requests and never forces skipWaiting", () => {
    const harness = createHarness();
    const fetchHandler = harness.handlers.get("fetch");
    const responded = (request: Record<string, unknown>) => {
      let handled = false;
      fetchHandler?.({
        request,
        respondWith: () => {
          handled = true;
        },
      });
      return handled;
    };
    const request = (url: string, overrides: Record<string, unknown> = {}) => ({
      headers: { get: () => null },
      method: "GET",
      mode: "cors",
      url,
      ...overrides,
    });

    expect(
      responded(request("https://matchsense.example/api/v1/fixtures")),
    ).toBe(false);
    expect(
      responded(
        request("https://matchsense.example/live", {
          headers: {
            get: (name: string) =>
              name === "accept" ? "text/event-stream" : null,
          },
        }),
      ),
    ).toBe(false);
    expect(
      responded(request("https://matchsense.example/audio/commentary.mp3")),
    ).toBe(false);
    expect(
      responded(
        request("https://matchsense.example/icon.svg", {
          headers: {
            get: (name: string) => (name === "range" ? "bytes=0-10" : null),
          },
        }),
      ),
    ).toBe(false);
    expect(
      responded(
        request("https://matchsense.example/api/v1/push/subscriptions", {
          method: "POST",
        }),
      ),
    ).toBe(false);
    expect(serviceWorkerSource).not.toContain("skipWaiting");
  });
});
