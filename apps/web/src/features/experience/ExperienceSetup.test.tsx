import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ExperienceSetup } from "./ExperienceSetup.js";

describe("Experience setup", () => {
  it("labels simulation and explains the complete device experience before start", () => {
    const markup = renderToStaticMarkup(
      createElement(ExperienceSetup, {
        catalog: {
          teams: [
            {
              code: "ARG",
              name: "Argentina",
              primary: "#72b9e8",
              secondary: "#fff",
            },
            {
              code: "FRA",
              name: "France",
              primary: "#173f8a",
              secondary: "#fff",
            },
          ],
        },
        error: null,
        favoriteTeam: "ARG",
        onBack: vi.fn(),
        onCreateRoom: vi.fn(),
        onEnableAlerts: vi.fn(),
        onStart: vi.fn(),
        pushState: "idle",
        starting: false,
      }),
    );

    expect(markup).toContain("SIMULATED TXLINE-SHAPED DATA");
    expect(markup).toContain("Enable factual alerts");
    expect(markup).toContain("Start Pocket Listening");
    expect(markup).toContain("Start five-minute match");
    expect(markup).toContain("Create a five-minute friend room");
    expect(markup).toContain("ms-team-flag");
  });
});
