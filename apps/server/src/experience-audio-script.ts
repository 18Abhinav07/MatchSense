import type { ExperienceBeatKey } from "./experience-runtime.js";

export interface ExperienceAudioScriptEntry {
  readonly beatKey: ExperienceBeatKey;
  readonly transcript: string;
}

export const EXPERIENCE_AUDIO_SCRIPT = [
  {
    beatKey: "kickoff",
    transcript:
      "The final is under way. Argentina in sky blue and white, France in deep blue. Five minutes of MatchSense starts now.",
  },
  {
    beatKey: "opening-goal",
    transcript:
      "Argentina have the ball in the net, but hold the celebration. The goal is still provisional.",
  },
  {
    beatKey: "opening-goal-var-review",
    transcript:
      "VAR is checking Argentina's goal. The score has not been confirmed.",
  },
  {
    beatKey: "opening-goal-var-stands",
    transcript:
      "The check is complete. The goal stands. Argentina lead France one nil.",
  },
  {
    beatKey: "home-yellow",
    transcript: "Yellow card for Argentina in the twenty-fourth minute.",
  },
  {
    beatKey: "away-yellow-first-half",
    transcript: "France now see yellow. One card for each side in this final.",
  },
  {
    beatKey: "away-penalty-awarded",
    transcript:
      "Penalty to France. A huge chance to level the match before half-time.",
  },
  {
    beatKey: "away-penalty-scored",
    transcript:
      "France score from the penalty spot. Argentina one, France one.",
  },
  {
    beatKey: "half-time",
    transcript:
      "Half-time in the final. Argentina one, France one. Everything is still open.",
  },
  {
    beatKey: "second-half",
    transcript:
      "The second half begins. Forty-five minutes in the match, two and a half minutes in this Experience.",
  },
  {
    beatKey: "away-red",
    transcript:
      "Red card for France. They are down to ten with the match level at one each.",
  },
  {
    beatKey: "home-yellow-second-half",
    transcript: "Another yellow card for Argentina as the pressure rises.",
  },
  {
    beatKey: "away-yellow-second-half",
    transcript:
      "France receive another yellow. Two cards arrive almost together.",
  },
  {
    beatKey: "winning-goal",
    transcript:
      "Goal for Argentina! They strike late and lead France two goals to one.",
  },
  {
    beatKey: "apparent-equalizer",
    transcript:
      "France have the ball in the net, but the equaliser is provisional. Celebration is held.",
  },
  {
    beatKey: "equalizer-var-review",
    transcript:
      "VAR is reviewing France's apparent equaliser. MatchSense is holding the score at two one.",
  },
  {
    beatKey: "equalizer-var-overturned",
    transcript:
      "No goal. VAR overturns the equaliser. Argentina still lead France two one.",
  },
  {
    beatKey: "late-corner",
    transcript:
      "Late corner for Argentina. They can take precious seconds out of the match.",
  },
  {
    beatKey: "regulation-end",
    transcript:
      "The final whistle is moments away. Argentina remain two one ahead.",
  },
  {
    beatKey: "full-time",
    transcript:
      "Full-time. Argentina beat France two goals to one after two VAR reviews and a dramatic finish.",
  },
] as const satisfies readonly ExperienceAudioScriptEntry[];

export const EXPERIENCE_MEMORY_INTRO =
  "Here is your MatchSense match summary. Relive the decisive calls from Argentina against France.";
