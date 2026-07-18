export const CALL_THREE_TARGETS = ["result", "goals", "cards"] as const;

export type CallThreeTarget = (typeof CALL_THREE_TARGETS)[number];
export type CallThreeConfidence = 1 | 2 | 3;
export type ResultAnswer = "HOME" | "DRAW" | "AWAY";
export type ThresholdAnswer = "YES" | "NO";
export type CallThreeAnswer = ResultAnswer | ThresholdAnswer;

export interface CallThreeDraftEntry {
  readonly answer: CallThreeAnswer | null;
  readonly confidence: CallThreeConfidence;
}

export type CallThreeDraft = Readonly<
  Record<CallThreeTarget, CallThreeDraftEntry>
>;

export type CallThreeSubmission =
  | {
      readonly target: "result";
      readonly answer: ResultAnswer;
      readonly confidence: CallThreeConfidence;
    }
  | {
      readonly target: "goals";
      readonly answer: ThresholdAnswer;
      readonly confidence: CallThreeConfidence;
    }
  | {
      readonly target: "cards";
      readonly answer: ThresholdAnswer;
      readonly confidence: CallThreeConfidence;
    };

export function createInitialCallThreeDraft(): CallThreeDraft {
  return {
    cards: { answer: null, confidence: 1 },
    goals: { answer: null, confidence: 2 },
    result: { answer: null, confidence: 3 },
  };
}

function isAnswerForTarget(
  target: CallThreeTarget,
  answer: CallThreeAnswer,
): boolean {
  if (target === "result") {
    return answer === "HOME" || answer === "DRAW" || answer === "AWAY";
  }
  return answer === "YES" || answer === "NO";
}

export function selectCallThreeAnswer(
  draft: CallThreeDraft,
  target: CallThreeTarget,
  answer: CallThreeAnswer,
): CallThreeDraft {
  if (!isAnswerForTarget(target, answer)) return draft;
  return { ...draft, [target]: { ...draft[target], answer } };
}

/**
 * Confidence is a permutation rather than an allocation. Selecting a number
 * swaps it with the target that already holds it, preserving 3/2/1 exactly.
 */
export function assignCallThreeConfidence(
  draft: CallThreeDraft,
  target: CallThreeTarget,
  confidence: CallThreeConfidence,
): CallThreeDraft {
  const current = draft[target].confidence;
  if (current === confidence) return draft;
  const counterpart = CALL_THREE_TARGETS.find(
    (candidate) => draft[candidate].confidence === confidence,
  );
  if (!counterpart) return draft;
  return {
    ...draft,
    [counterpart]: { ...draft[counterpart], confidence: current },
    [target]: { ...draft[target], confidence },
  };
}

export function isCallThreeDraftComplete(draft: CallThreeDraft): boolean {
  const confidences = CALL_THREE_TARGETS.map(
    (target) => draft[target].confidence,
  ).sort();
  return (
    CALL_THREE_TARGETS.every((target) => {
      const answer = draft[target].answer;
      return answer !== null && isAnswerForTarget(target, answer);
    }) && confidences.join(",") === "1,2,3"
  );
}

export function toCallThreeSubmission(
  draft: CallThreeDraft,
): readonly CallThreeSubmission[] {
  if (!isCallThreeDraftComplete(draft)) {
    throw new Error(
      "Choose all three calls and assign confidence 3, 2, and 1 once each.",
    );
  }
  return CALL_THREE_TARGETS.map((target) => {
    const entry = draft[target];
    if (target === "result") {
      return {
        answer: entry.answer as ResultAnswer,
        confidence: entry.confidence,
        target,
      };
    }
    return {
      answer: entry.answer as ThresholdAnswer,
      confidence: entry.confidence,
      target,
    };
  });
}
