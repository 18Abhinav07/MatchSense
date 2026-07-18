/// <reference types="node" />

import { readFile } from "node:fs/promises";
import vm from "node:vm";

import { beforeAll, describe, expect, it } from "vitest";

interface PushContract {
  notificationFor(value: unknown): {
    options: {
      data: Record<string, unknown>;
      tag: string;
      timestamp?: number;
    };
    title: string;
  };
  routeFromNotificationData(value: unknown): Record<string, unknown>;
}

let contract: PushContract;

beforeAll(async () => {
  const source = await readFile(
    new URL("../public/push-notification.js", import.meta.url),
    "utf8",
  );
  const self: { MatchSensePush?: PushContract } = {};
  vm.runInNewContext(source, { self });
  if (!self.MatchSensePush) throw new Error("push contract was not installed");
  contract = self.MatchSensePush;
});

const envelope = {
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

describe("service-worker PushPayloadV1 presentation contract", () => {
  it("preserves the server's canonical Moment route and family replacement tag", () => {
    const presentation = contract.notificationFor(envelope);

    expect(presentation.title).toBe("GOAL — ARGENTINA");
    expect(presentation.options).toMatchObject({
      data: {
        familyId: "arg-fra:score:1-0",
        identity: "arg-fra:score:1-0:1",
        intentId: "intent_0123456789abcdef",
        kind: "moment",
        route: envelope.route,
        url: envelope.route,
      },
      tag: "matchsense:arg-fra-demo:arg-fra:score:1-0",
      timestamp: Date.parse("2026-07-16T12:12:07.000Z"),
    });
  });

  it("keeps a test delivery in its separate namespace while retaining its real target", () => {
    const testEnvelope = {
      ...envelope,
      identity: "test:registration-1:arg-fra:score:1-0:1",
      intentId: "test_0123456789abcdef",
      kind: "test",
      tag: "matchsense:test:registration-1:arg-fra-demo:arg-fra:score:1-0",
    };

    const presentation = contract.notificationFor(testEnvelope);

    expect(presentation.options).toMatchObject({
      data: {
        kind: "test",
        route: envelope.route,
      },
      tag: "matchsense:test:registration-1:arg-fra-demo:arg-fra:score:1-0",
    });
    expect(
      contract.routeFromNotificationData(presentation.options.data),
    ).toMatchObject({
      fixtureId: "arg-fra-demo",
      momentIdentity: "arg-fra:score:1-0:1",
      url: envelope.route,
    });
  });

  it.each([
    "/rooms/attacker",
    "https://attacker.example/matches/a/moments/b",
    "/matches/arg-fra-demo/moments/another%3A9",
  ])("rejects an unsafe or mismatched server route %s", (route) => {
    const presentation = contract.notificationFor({ ...envelope, route });

    expect(presentation.title).toBe("MatchSense update");
    expect(presentation.options.data).toEqual({ url: "/" });
  });
});
