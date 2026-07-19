import type { ExperienceBeatKey } from "./experience-runtime.js";

export const EXPERIENCE_AUDIO_SCRIPT: Readonly<
  Record<ExperienceBeatKey, string>
> = Object.freeze({
  "apparent-equalizer":
    "France have the ball in the net, but the equaliser is provisional. Celebration is held.",
  "away-penalty-awarded":
    "Penalty to France. A huge chance to level the match before half-time.",
  "away-penalty-scored":
    "France score from the penalty spot. Argentina one, France one.",
  "away-red":
    "Red card for France. They are down to ten with the match level at one each.",
  "away-yellow-first-half":
    "France now see yellow. One card for each side in this final.",
  "away-yellow-second-half":
    "France receive another yellow. Two cards arrive almost together.",
  "equalizer-var-overturned":
    "No goal. VAR overturns the equaliser. Argentina still lead France two one.",
  "equalizer-var-review":
    "VAR is reviewing France's apparent equaliser. MatchSense is holding the score at two one.",
  "full-time":
    "Full-time. Argentina beat France two goals to one after two VAR reviews and a dramatic finish.",
  "half-time":
    "Half-time in the final. Argentina one, France one. Everything is still open.",
  "home-yellow": "Yellow card for Argentina in the twenty-fourth minute.",
  "home-yellow-second-half":
    "Another yellow card for Argentina as the pressure rises.",
  kickoff:
    "The final is under way. Argentina in sky blue and white, France in deep blue. Five minutes of MatchSense starts now.",
  "late-corner":
    "Late corner for Argentina. They can take precious seconds out of the match.",
  "opening-goal":
    "Argentina have the ball in the net, but hold the celebration. The goal is still provisional.",
  "opening-goal-var-review":
    "VAR is checking Argentina's goal. The score has not been confirmed.",
  "opening-goal-var-stands":
    "The check is complete. The goal stands. Argentina lead France one nil.",
  "regulation-end":
    "The final whistle is moments away. Argentina remain two one ahead.",
  "second-half":
    "The second half begins. Forty-five minutes in the match, two and a half minutes in this Experience.",
  "winning-goal":
    "Goal for Argentina! They strike late and lead France two goals to one.",
} satisfies Record<ExperienceBeatKey, string>);

export const EXPERIENCE_MEMORY_INTRO =
  "Here is your MatchSense match summary. Relive the decisive calls from Argentina against France.";
