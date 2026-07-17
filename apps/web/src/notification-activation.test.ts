import { describe, expect, it } from "vitest";

import { parseMomentActivation } from "./notification-activation.js";

describe("notification activation", () => {
  it("accepts the canonical same-origin Moment message", () => {
    expect(
      parseMomentActivation(
        {
          fixtureId: "arg-fra-demo",
          momentIdentity: "arg-fra-demo:event:goal-1:3",
          revision: 3,
          type: "matchsense:open-moment",
          url: "/matches/arg-fra-demo/moments/arg-fra-demo%3Aevent%3Agoal-1%3A3",
        },
        "https://matchsense.example",
      ),
    ).toEqual({
      fixtureId: "arg-fra-demo",
      momentIdentity: "arg-fra-demo:event:goal-1:3",
      revision: 3,
      url: "/matches/arg-fra-demo/moments/arg-fra-demo%3Aevent%3Agoal-1%3A3",
    });
  });

  it.each([
    { type: "other", url: "/matches/a/moments/b" },
    {
      fixtureId: "arg-fra-demo",
      momentIdentity: "goal:1",
      revision: 1,
      type: "matchsense:open-moment",
      url: "https://attacker.example/matches/a/moments/b",
    },
    {
      fixtureId: "different",
      momentIdentity: "goal:1",
      revision: 1,
      type: "matchsense:open-moment",
      url: "/matches/arg-fra-demo/moments/goal%3A1",
    },
  ])("rejects malformed or foreign activation %#", (value) => {
    expect(
      parseMomentActivation(value, "https://matchsense.example"),
    ).toBeNull();
  });
});
