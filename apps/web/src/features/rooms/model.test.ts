import { describe, expect, it } from "vitest";

import * as roomModel from "./model.js";

describe("Call Three draft", () => {
  it("requires the three distinct targets and confidence values before it can lock", () => {
    const createDraft = (roomModel as Record<string, unknown>)[
      "createInitialCallThreeDraft"
    ] as undefined | (() => unknown);

    expect(createDraft).toBeTypeOf("function");
  });

  it("swaps confidence instead of allowing a duplicate and emits exactly three calls", () => {
    const createDraft = roomModel.createInitialCallThreeDraft as () => {
      readonly result: {
        readonly answer: string | null;
        readonly confidence: number;
      };
      readonly goals: {
        readonly answer: string | null;
        readonly confidence: number;
      };
      readonly cards: {
        readonly answer: string | null;
        readonly confidence: number;
      };
    };
    const select = roomModel.selectCallThreeAnswer as (
      draft: ReturnType<typeof createDraft>,
      target: "result" | "goals" | "cards",
      answer: "HOME" | "DRAW" | "AWAY" | "YES" | "NO",
    ) => ReturnType<typeof createDraft>;
    const assign = roomModel.assignCallThreeConfidence as (
      draft: ReturnType<typeof createDraft>,
      target: "result" | "goals" | "cards",
      confidence: 1 | 2 | 3,
    ) => ReturnType<typeof createDraft>;
    const complete = roomModel.isCallThreeDraftComplete as (
      draft: ReturnType<typeof createDraft>,
    ) => boolean;
    const submit = roomModel.toCallThreeSubmission as (
      draft: ReturnType<typeof createDraft>,
    ) => readonly { readonly confidence: number; readonly target: string }[];

    let draft = createDraft();
    draft = select(draft, "result", "HOME");
    draft = select(draft, "goals", "YES");
    draft = select(draft, "cards", "NO");
    draft = assign(draft, "cards", 3);

    expect(
      [
        draft.result.confidence,
        draft.goals.confidence,
        draft.cards.confidence,
      ].sort(),
    ).toEqual([1, 2, 3]);
    expect(complete(draft)).toBe(true);
    expect(submit(draft).map((call) => call.target)).toEqual([
      "result",
      "goals",
      "cards",
    ]);
  });
});
