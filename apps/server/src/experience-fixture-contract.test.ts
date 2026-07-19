import { describe, expect, it } from "vitest";

import {
  EXPERIENCE_AWAY_TEAM,
  EXPERIENCE_HOME_TEAM,
  isFixedExperienceFixture,
} from "./experience-fixture-contract.js";

describe("fixed Experience fixture contract", () => {
  it("defines Argentina at home against France away", () => {
    expect(EXPERIENCE_HOME_TEAM).toBe("ARG");
    expect(EXPERIENCE_AWAY_TEAM).toBe("FRA");
  });

  it("accepts only the authored home and away ordering", () => {
    expect(
      isFixedExperienceFixture({
        awayTeam: "FRA",
        homeTeam: "ARG",
      }),
    ).toBe(true);
    expect(
      isFixedExperienceFixture({
        awayTeam: "ARG",
        homeTeam: "FRA",
      }),
    ).toBe(false);
    expect(
      isFixedExperienceFixture({
        awayTeam: "ESP",
        homeTeam: "ARG",
      }),
    ).toBe(false);
  });
});
