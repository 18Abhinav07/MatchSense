import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BUNDLED_FLAG_CODES, TeamFlag } from "./TeamFlag.js";

const argentina = {
  code: "ARG",
  name: "Argentina",
  primary: "#75aadb",
  secondary: "#ffffff",
};

describe("TeamFlag", () => {
  it.each(["compact", "standard", "hero"] as const)(
    "renders accessible bundled national artwork in the %s frame",
    (size) => {
      const markup = renderToStaticMarkup(
        createElement(TeamFlag, { size, team: argentina }),
      );

      expect(markup).toContain(`ms-team-flag--${size}`);
      expect(markup).toContain('aria-label="Argentina flag"');
      expect(markup).toContain('data-flag-code="ARG"');
      expect(markup).toContain("ms-team-flag__art");
      expect(markup).toContain("<svg");
      expect(markup).not.toContain("ms-team-flag__textile");
      expect(markup).not.toContain("<img");
    },
  );

  it("bundles every product-catalog flag and a broad 2026 team set", () => {
    expect(BUNDLED_FLAG_CODES).toEqual(
      expect.arrayContaining([
        "ARG",
        "BRA",
        "ENG",
        "ESP",
        "FRA",
        "JPN",
        "GER",
        "POR",
        "NED",
        "BEL",
        "BIH",
        "ITA",
        "CRO",
        "URU",
        "COL",
        "USA",
        "CAN",
        "MEX",
        "MAR",
        "SEN",
        "KOR",
        "AUS",
        "NZL",
      ]),
    );
    expect(new Set(BUNDLED_FLAG_CODES).size).toBe(BUNDLED_FLAG_CODES.length);

    for (const code of BUNDLED_FLAG_CODES) {
      const markup = renderToStaticMarkup(
        createElement(TeamFlag, {
          team: {
            code,
            name: code,
            primary: "#244f42",
            secondary: "#f7f1df",
          },
        }),
      );
      expect(markup, code).toContain(`data-flag-code="${code}"`);
      expect(markup, code).toContain("<svg");
      expect(markup, code).not.toContain("ms-team-flag__textile");
    }
  });

  it("keeps the textured color fallback for unknown participants", () => {
    const markup = renderToStaticMarkup(
      createElement(TeamFlag, {
        team: {
          code: "N25-1001",
          name: "Nation 25",
          primary: "#244f42",
          secondary: "#f7f1df",
        },
      }),
    );

    expect(markup).toContain("ms-team-flag__textile");
    expect(markup).not.toContain("<svg");
  });

  it("renders a supplied flag image without using it as the accessible label", () => {
    const markup = renderToStaticMarkup(
      createElement(TeamFlag, {
        size: "standard",
        team: {
          code: "N25-1001",
          flagUrl: "/flags/nation-25.svg",
          name: "Nation 25",
          primary: "#244f42",
          secondary: "#f7f1df",
        },
      }),
    );

    expect(markup).toContain('src="/flags/nation-25.svg"');
    expect(markup).toContain('alt=""');
    expect(markup).not.toContain("ms-team-flag__textile");
  });
});
