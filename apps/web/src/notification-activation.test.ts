import { describe, expect, it, vi } from "vitest";

import {
  consumePendingActivation,
  installNotificationActivation,
  parseMomentActivation,
} from "./notification-activation.js";

const activation = {
  familyId: "arg-fra:score:1-0",
  fixtureId: "arg-fra-demo",
  intentId: "intent_0123456789abcdef",
  kind: "moment" as const,
  momentIdentity: "arg-fra:score:1-0:1",
  revision: 1,
  route: "/matches/arg-fra-demo/moments/arg-fra%3Ascore%3A1-0%3A1",
};

describe("notification activation", () => {
  it("accepts the canonical same-origin PushPayloadV1 route message", () => {
    expect(
      parseMomentActivation(
        {
          activation,
          type: "matchsense:open-route",
        },
        "https://matchsense.example",
      ),
    ).toEqual({
      ...activation,
      url: activation.route,
    });
  });

  it.each([
    { type: "other", url: "/matches/a/moments/b" },
    {
      activation: {
        ...activation,
        route: "https://attacker.example/matches/a/moments/b",
      },
      type: "matchsense:open-route",
    },
    {
      activation: { ...activation, momentIdentity: "goal:9" },
      type: "matchsense:open-route",
    },
  ])("rejects malformed or foreign activation %#", (value) => {
    expect(
      parseMomentActivation(value, "https://matchsense.example"),
    ).toBeNull();
  });

  it("consumes a cold pending activation once before routing", async () => {
    const consume = vi.fn(async () => activation);

    await expect(
      consumePendingActivation({ consume }, "https://matchsense.example"),
    ).resolves.toEqual({ ...activation, url: activation.route });
    expect(consume).toHaveBeenCalledOnce();
  });

  it("routes a warm worker message once and ignores a duplicate intent", async () => {
    const listeners = new Set<(event: MessageEvent<unknown>) => void>();
    const worker = {
      addEventListener: (
        _type: "message",
        listener: (event: MessageEvent<unknown>) => void,
      ) => listeners.add(listener),
      removeEventListener: (
        _type: "message",
        listener: (event: MessageEvent<unknown>) => void,
      ) => listeners.delete(listener),
    };
    const onActivation = vi.fn();
    const stop = installNotificationActivation({
      onActivation,
      origin: "https://matchsense.example",
      pendingStore: { consume: async () => null },
      serviceWorker: worker,
    });

    for (const listener of listeners) {
      listener({
        data: { activation, type: "matchsense:open-route" },
      } as MessageEvent);
      listener({
        data: { activation, type: "matchsense:open-route" },
      } as MessageEvent);
    }
    await Promise.resolve();

    expect(onActivation).toHaveBeenCalledOnce();
    expect(onActivation).toHaveBeenCalledWith({
      ...activation,
      url: activation.route,
    });
    stop();
  });
});
