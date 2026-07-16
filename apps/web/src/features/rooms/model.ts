import type {
  CallAnswer,
  CallConfidence,
  CallStat,
  CallThreePick,
} from "./types.js";

export const CALL_STATS = ["goals", "cards", "corners"] as const;

export interface CallDraftEntry {
  readonly answer: CallAnswer | null;
  readonly confidence: CallConfidence;
}

export type CallDraft = Readonly<Record<CallStat, CallDraftEntry>>;

export function createInitialCallDraft(): CallDraft {
  return {
    cards: { answer: null, confidence: 1 },
    corners: { answer: null, confidence: 2 },
    goals: { answer: null, confidence: 3 },
  };
}

export function createCallDraftFromPicks(
  picks: readonly CallThreePick[],
): CallDraft {
  const initial = createInitialCallDraft();
  return CALL_STATS.reduce<CallDraft>((draft, stat) => {
    const pick = picks.find((candidate) => candidate.stat === stat);
    return pick === undefined
      ? draft
      : {
          ...draft,
          [stat]: { answer: pick.answer, confidence: pick.confidence },
        };
  }, initial);
}

export function answerCall(
  draft: CallDraft,
  stat: CallStat,
  answer: CallAnswer,
): CallDraft {
  return { ...draft, [stat]: { ...draft[stat], answer } };
}

export function assignConfidence(
  draft: CallDraft,
  stat: CallStat,
  confidence: CallConfidence,
): CallDraft {
  const displacedStat = CALL_STATS.find(
    (candidate) =>
      candidate !== stat && draft[candidate].confidence === confidence,
  );
  if (displacedStat === undefined) {
    return { ...draft, [stat]: { ...draft[stat], confidence } };
  }

  const previousConfidence = draft[stat].confidence;
  return {
    ...draft,
    [displacedStat]: {
      ...draft[displacedStat],
      confidence: previousConfidence,
    },
    [stat]: { ...draft[stat], confidence },
  };
}

export function isCallDraftComplete(draft: CallDraft): boolean {
  return CALL_STATS.every((stat) => draft[stat].answer !== null);
}

export function toCallPicks(draft: CallDraft): readonly CallThreePick[] {
  if (!isCallDraftComplete(draft)) {
    throw new Error(
      "All three calls must be answered before they can be saved",
    );
  }
  return CALL_STATS.map((stat) => ({
    answer: draft[stat].answer as CallAnswer,
    confidence: draft[stat].confidence,
    stat,
  }));
}
