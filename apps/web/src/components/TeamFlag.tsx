import type { CSSProperties } from "react";

import "./team-flag.css";
import { BundledTeamFlagArt, hasBundledTeamFlagArt } from "./team-flag-art.js";

export { BUNDLED_FLAG_CODES } from "./team-flag-art.js";

export interface FlagTeam {
  code: string;
  name: string;
  primary: string;
  secondary: string;
  foreground?: string | undefined;
  flagUrl?: string | undefined;
}

export interface TeamFlagProps {
  className?: string | undefined;
  size?: "compact" | "standard" | "hero";
  team: FlagTeam;
}

export function TeamFlag({
  className,
  size = "standard",
  team,
}: TeamFlagProps) {
  const hasBundledArtwork = hasBundledTeamFlagArt(team.code);
  const classes = ["ms-team-flag", `ms-team-flag--${size}`, className]
    .filter(Boolean)
    .join(" ");

  return (
    <span
      aria-label={`${team.name} flag`}
      className={classes}
      role="img"
      style={
        {
          "--ms-flag-primary": team.primary,
          "--ms-flag-secondary": team.secondary,
          "--ms-flag-ink": team.foreground ?? "#f7f4ea",
        } as CSSProperties
      }
    >
      {hasBundledArtwork ? (
        <BundledTeamFlagArt code={team.code} />
      ) : team.flagUrl ? (
        <img alt="" decoding="async" loading="lazy" src={team.flagUrl} />
      ) : (
        <span aria-hidden="true" className="ms-team-flag__textile" />
      )}
    </span>
  );
}
