import { describe, expect, it, vi } from "vitest";

import { navigateFromNotificationActivation } from "./route-activation.js";

describe("notification route activation", () => {
  it("changes the PWA route in place instead of remounting the audio root", () => {
    const history = { pushState: vi.fn() };
    const dispatchEvent = vi.fn();

    navigateFromNotificationActivation(
      {
        familyId: "goal-1",
        fixtureId: "arg-fra",
        intentId: "intent-1",
        kind: "moment",
        momentIdentity: "goal-1:1",
        revision: 1,
        route: "/matches/arg-fra/moments/goal-1%3A1",
        url: "/matches/arg-fra/moments/goal-1%3A1",
      },
      {
        dispatchEvent,
        history,
      },
    );

    expect(history.pushState).toHaveBeenCalledWith(
      {},
      "",
      "/matches/arg-fra/moments/goal-1%3A1",
    );
    expect(dispatchEvent).toHaveBeenCalledOnce();
  });
});
