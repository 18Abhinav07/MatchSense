import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OnboardingFlow } from "./OnboardingFlow.js";

const argentina = {
  code: "ARG",
  name: "Argentina",
  primary: "#75aadb",
  secondary: "#f4f1e8",
};

describe("OnboardingFlow", () => {
  it("makes the real team choice the first durable profile action", () => {
    const markup = renderToStaticMarkup(
      createElement(OnboardingFlow, {
        catalog: { teams: [argentina] },
        initialStage: "team",
        onComplete: () => undefined,
        profileApi: {
          checkHandle: async (handle) => ({ available: true, handle }),
          updateProfile: async () => ({
            avatarVariant: "arg-pulse",
            createdAt: "2026-07-18T00:00:00.000Z",
            deletedAt: null,
            favoriteTeam: "ARG",
            handle: "supporter",
            handleNormalized: "supporter",
            id: "fan-test",
            preferences: {},
            profile: {},
            updatedAt: "2026-07-18T00:00:00.000Z",
          }),
        },
      }),
    );

    expect(markup).toContain("Who do you support?");
    expect(markup).toContain("Argentina flag");
    expect(markup).toContain("ms-team-flag--hero");
    expect(markup).not.toContain("Experience Match");
    expect(markup).not.toContain("Demo Mode");
  });

  it("uses an honest unavailable state when the catalog has not arrived", () => {
    const markup = renderToStaticMarkup(
      createElement(OnboardingFlow, {
        catalog: { teams: [] },
        initialStage: "team",
        onComplete: () => undefined,
        profileApi: {
          checkHandle: async (handle) => ({ available: true, handle }),
          updateProfile: async () => {
            throw new Error("not called");
          },
        },
      }),
    );

    expect(markup).toContain("Team catalogue unavailable");
    expect(markup).not.toContain("Argentina");
  });
});
