const EVENT_KEY = ":event:";

function experienceEventKey(momentId: string) {
  const marker = momentId.lastIndexOf(EVENT_KEY);
  return (marker >= 0 ? momentId.slice(marker + EVENT_KEY.length) : momentId)
    .trim()
    .toLowerCase();
}

function withTeam(label: string, team: string) {
  return `${label} · ${team}`;
}

/**
 * Converts the authored Experience match's stable canonical identifiers into
 * fan-facing football language. The identifier remains available to reaction
 * mutations, but is never suitable as visible copy.
 */
export function experienceMomentLabel(input: {
  awayTeam: string;
  homeTeam: string;
  momentId: string;
  varState: string;
}) {
  const key = experienceEventKey(input.momentId);
  const exact: Readonly<Record<string, string>> = {
    kickoff: "Kickoff",
    "opening-goal": withTeam("Goal", input.homeTeam),
    "opening-goal-var-review": "VAR review · Goal under review",
    "opening-goal-var-stands": withTeam("Goal confirmed", input.homeTeam),
    "home-yellow": withTeam("Yellow card", input.homeTeam),
    "away-yellow-first-half": withTeam("Yellow card", input.awayTeam),
    "away-penalty-awarded": withTeam("Penalty awarded", input.awayTeam),
    "away-penalty-scored": withTeam("Penalty scored", input.awayTeam),
    "half-time": "Half-time",
    "second-half": "Second half begins",
    "away-red": withTeam("Red card", input.awayTeam),
    "home-yellow-second-half": withTeam("Yellow card", input.homeTeam),
    "away-yellow-second-half": withTeam("Yellow card", input.awayTeam),
    "winning-goal": withTeam("Goal", input.homeTeam),
    "apparent-equalizer": withTeam("Goal under review", input.awayTeam),
    "equalizer-var-review": "VAR review · Equaliser under review",
    "equalizer-var-overturned": "No goal · VAR overturned it",
    "late-corner": withTeam("Corner", input.homeTeam),
    "regulation-end": "Regulation time ends",
    "full-time": "Full-time",
  };
  const known = exact[key];
  if (known) return known;

  // Defensive fallbacks cover changed authored keys without leaking opaque
  // UUIDs/run identifiers into the fan experience.
  if (key.includes("var") && key.includes("overturn")) {
    return "No goal · VAR overturned it";
  }
  if (key.includes("var")) return "VAR review";
  if (key.includes("yellow")) return "Yellow card";
  if (key.includes("red")) return "Red card";
  if (key.includes("penalty") && key.includes("scored")) {
    return "Penalty scored";
  }
  if (key.includes("penalty")) return "Penalty awarded";
  if (key.includes("goal")) return "Goal";
  if (key.includes("corner")) return "Corner";
  if (key.includes("half-time") || key.includes("halftime")) {
    return "Half-time";
  }
  if (key.includes("full-time") || key.includes("fulltime")) {
    return "Full-time";
  }
  if (key.includes("kickoff")) return "Kickoff";
  if (input.varState === "HOLD") return "VAR review · Decision pending";
  if (input.varState === "OVERTURNED") return "Decision overturned";
  return "Match update confirmed";
}
