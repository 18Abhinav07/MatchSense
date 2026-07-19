import type { TeamCode } from "@matchsense/contracts";

export const EXPERIENCE_HOME_TEAM: TeamCode = "ARG";
export const EXPERIENCE_AWAY_TEAM: TeamCode = "FRA";

export function isFixedExperienceFixture(input: {
  awayTeam: TeamCode;
  homeTeam: TeamCode;
}): boolean {
  return (
    input.homeTeam === EXPERIENCE_HOME_TEAM &&
    input.awayTeam === EXPERIENCE_AWAY_TEAM
  );
}
