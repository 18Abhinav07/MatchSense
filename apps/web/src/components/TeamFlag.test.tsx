import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { BUNDLED_FLAG_CODES, TeamFlag } from "./TeamFlag.js";

const CURRENT_TOURNAMENT_CODES = [
  "ALG",
  "ARG",
  "AUS",
  "AUT",
  "BEL",
  "BIH",
  "BRA",
  "CAN",
  "CIV",
  "COD",
  "COL",
  "CPV",
  "CRO",
  "ECU",
  "EGY",
  "ENG",
  "ESP",
  "FRA",
  "GHA",
  "MAR",
  "MEX",
  "NED",
  "NOR",
  "PAR",
  "POR",
  "SEN",
  "SUI",
  "SWE",
  "USA",
] as const;

const argentina = {
  code: "ARG",
  name: "Argentina",
  primary: "#75aadb",
  secondary: "#ffffff",
};

describe("TeamFlag", () => {
  it("uses a sharp unbordered textile plane instead of a rounded badge", () => {
    const stylesheet = readFileSync(
      new URL("./team-flag.css", import.meta.url),
      "utf8",
    );

    expect(stylesheet).toMatch(
      /\.ms-team-flag\s*\{[\s\S]*?border:\s*0;[\s\S]*?border-radius:\s*0;/u,
    );
    expect(stylesheet).toMatch(
      /\.ms-team-flag__weave\s*\{[\s\S]*?repeating-linear-gradient/u,
    );
    expect(stylesheet).not.toMatch(
      /\.ms-team-flag--hero\s*\{[\s\S]*?border-radius/u,
    );
  });

  it.each(["compact", "standard", "hero"] as const)(
    "renders accessible bundled national artwork in the %s frame",
    (size) => {
      const markup = renderToStaticMarkup(
        createElement(TeamFlag, { size, team: argentina }),
      );

      expect(markup).toContain(`ms-team-flag--${size}`);
      expect(markup).toContain('aria-label="Argentina flag"');
      expect(markup).toContain('data-flag-frame="3:2"');
      expect(markup).toContain('data-flag-shape="rectangular"');
      expect(markup).toContain('data-flag-code="ARG"');
      expect(markup).toContain("ms-team-flag__art");
      expect(markup).toContain("ms-team-flag__weave");
      expect(markup).toContain('aria-hidden="true"');
      expect(markup).toContain("<svg");
      expect(markup).not.toContain("ms-team-flag__textile");
      expect(markup).not.toContain("<img");
    },
  );

  it("bundles artwork for every current real tournament participant", () => {
    expect(BUNDLED_FLAG_CODES).toEqual(
      expect.arrayContaining([...CURRENT_TOURNAMENT_CODES]),
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
      expect(markup, code).toContain('data-flag-frame="3:2"');
      expect(markup, code).toContain('data-flag-shape="rectangular"');
      expect(markup, code).toContain("<svg");
      expect(markup, code).toContain("ms-team-flag__weave");
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
    expect(markup).toContain("ms-team-flag__weave");
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
    expect(markup).toContain("ms-team-flag__weave");
    expect(markup).not.toContain("ms-team-flag__textile");
  });
});
