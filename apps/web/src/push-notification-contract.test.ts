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
  fixtureId: "arg-fra-demo",
  identity: "arg-fra-demo:score:1-0:1",
  momentId: "arg-fra-demo:score:1-0",
  occurredAt: "2026-07-16T12:12:07.000Z",
  revision: 1,
  schemaVersion: 1,
  title: "GOAL — ARGENTINA",
  type: "matchsense.moment",
};

describe("service-worker push presentation contract", () => {
  it("renders a factual notification tagged by momentId:revision", () => {
    const presentation = contract.notificationFor(envelope);

    expect(presentation.title).toBe("GOAL — ARGENTINA");
    expect(presentation.options).toMatchObject({
      data: {
        identity: "arg-fra-demo:score:1-0:1",
        url: "/matches/arg-fra-demo/moments/arg-fra-demo%3Ascore%3A1-0%3A1",
      },
      tag: "matchsense:arg-fra-demo:score:1-0:1",
      timestamp: Date.parse("2026-07-16T12:12:07.000Z"),
    });
  });

  it("refuses a mismatched identity and never trusts a supplied URL", () => {
    const presentation = contract.notificationFor({
      ...envelope,
      identity: "another-moment:7",
      url: "https://attacker.example/",
    });
    const route = contract.routeFromNotificationData({
      ...presentation.options.data,
      url: "https://attacker.example/",
    });

    expect(presentation.title).toBe("MatchSense update");
    expect(route).toEqual({ url: "/" });
  });
});
