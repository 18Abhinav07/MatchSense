import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { OnboardingFlow } from "./OnboardingFlow.js";

const argentina = {
  code: "ARG",
  name: "Argentina",
  primary: "#75aadb",
  secondary: "#f4f1e8",
};

describe("OnboardingFlow", () => {
  it("keeps the pitch intro copy white and readable against its green field", () => {
    const stylesheet = readFileSync(
      new URL("./onboarding.css", import.meta.url),
      "utf8",
    );

    expect(stylesheet).toMatch(
      /\.ms-onboarding--intro\s*\{[\s\S]*?color:\s*#ffffff;/u,
    );
    expect(stylesheet).toMatch(
      /\.ms-onboarding-intro-copy h1\s*\{[\s\S]*?color:\s*#ffffff;/u,
    );
  });

  it("keeps the active handle field borderless and the onboarding header concise", () => {
    const source = readFileSync(
      new URL("./OnboardingFlow.tsx", import.meta.url),
      "utf8",
    );
    const stylesheet = readFileSync(
      new URL("./onboarding.css", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain("supporter identity");
    expect(source).toContain("Choose handle");
    expect(stylesheet).toMatch(
      /\.ms-onboarding-handle-input\s*\{[\s\S]*?border:\s*0;/u,
    );
    expect(stylesheet).not.toContain("border-bottom: 2px solid #9fd16e");
  });

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
