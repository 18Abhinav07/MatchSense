import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("mobile team catalog layout", () => {
  it("lets dynamic team copy shrink and wrap inside the viewport", () => {
    const styles = readFileSync(
      new URL("./styles.css", import.meta.url),
      "utf8",
    );

    expect(styles).toMatch(
      /@media \(max-width: 820px\)[\s\S]*?\.team-choice\s*\{[\s\S]*?grid-template-columns:\s*78px minmax\(0, 1fr\) 24px;/u,
    );
    expect(styles).toMatch(
      /@media \(max-width: 820px\)[\s\S]*?\.team-pick-grid\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/u,
    );
    expect(styles).toMatch(
      /\.team-choice span:nth-child\(2\)\s*\{[\s\S]*?min-width:\s*0;/u,
    );
  });
});
