import { describe, expect, it } from "vitest";

import { experienceMomentLabel } from "./experience-moment-label.js";

describe("Experience Room fan-facing event labels", () => {
  const label = (momentId: string, varState = "CONFIRMED") =>
    experienceMomentLabel({
      awayTeam: "France",
      homeTeam: "Argentina",
      momentId,
      varState,
    });

  it("names every event in the fixed match without exposing its run identifier", () => {
    expect(label("4aa5dwhfhie:event:opening-goal")).toBe(
      "Goal · Argentina",
    );
    expect(label("4aa5dwhfhie:event:home-yellow")).toBe(
      "Yellow card · Argentina",
    );
    expect(label("4aa5dwhfhie:event:away-red")).toBe("Red card · France");
    expect(label("4aa5dwhfhie:event:equalizer-var-review", "HOLD")).toBe(
      "VAR review · Equaliser under review",
    );
    expect(label("4aa5dwhfhie:event:full-time")).toBe("Full-time");
  });

  it("uses safe football language even for an unknown opaque identifier", () => {
    expect(label("4aa5dwhfhie", "HOLD")).toBe(
      "VAR review · Decision pending",
    );
    expect(label("4aa5dwhfhie")).toBe("Match update confirmed");
  });
});
