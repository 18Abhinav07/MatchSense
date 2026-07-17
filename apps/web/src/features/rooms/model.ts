import type {
  SenseMarketId,
  SensePick,
  SenseSelection,
  SenseSlate,
} from "./types.js";

export const SENSE_MARKET_IDS = [
  "winner",
  "goals_2_5",
  "cards_4_5",
  "corners_9_5",
  "btts",
] as const;

export interface SenseDraftEntry {
  readonly allocation: number;
  readonly selection: SenseSelection | null;
}

export type SenseDraft = Readonly<Record<SenseMarketId, SenseDraftEntry>>;

export function createInitialSenseDraft(): SenseDraft {
  return {
    btts: { allocation: 20, selection: null },
    cards_4_5: { allocation: 20, selection: null },
    corners_9_5: { allocation: 20, selection: null },
    goals_2_5: { allocation: 20, selection: null },
    winner: { allocation: 20, selection: null },
  };
}

export function createSenseDraftFromSlate(slate: SenseSlate): SenseDraft {
  return slate.picks.reduce<SenseDraft>(
    (draft, pick) => ({
      ...draft,
      [pick.marketId]: {
        allocation: pick.allocation,
        selection: pick.selection,
      },
    }),
    createInitialSenseDraft(),
  );
}

export function selectSenseOption(
  draft: SenseDraft,
  marketId: SenseMarketId,
  selection: SenseSelection,
): SenseDraft {
  return { ...draft, [marketId]: { ...draft[marketId], selection } };
}

export function moveSense(
  draft: SenseDraft,
  marketId: SenseMarketId,
  direction: 1 | -1,
): SenseDraft {
  const current = draft[marketId];
  if (direction === -1 && current.allocation <= 5) return draft;
  const others = SENSE_MARKET_IDS.filter((id) => id !== marketId);
  const counterpart =
    direction === 1
      ? [...others].sort(
          (left, right) => draft[right].allocation - draft[left].allocation,
        )[0]
      : others[0];
  if (!counterpart || (direction === 1 && draft[counterpart].allocation <= 5)) {
    return draft;
  }
  return {
    ...draft,
    [counterpart]: {
      ...draft[counterpart],
      allocation: draft[counterpart].allocation - direction * 5,
    },
    [marketId]: { ...current, allocation: current.allocation + direction * 5 },
  };
}

export function senseAllocated(draft: SenseDraft): number {
  return SENSE_MARKET_IDS.reduce(
    (total, marketId) => total + draft[marketId].allocation,
    0,
  );
}

export function isSenseDraftComplete(draft: SenseDraft): boolean {
  return (
    senseAllocated(draft) === 100 &&
    SENSE_MARKET_IDS.every(
      (marketId) =>
        draft[marketId].selection !== null &&
        draft[marketId].allocation >= 5 &&
        draft[marketId].allocation % 5 === 0,
    )
  );
}

export function toSensePicks(draft: SenseDraft): readonly SensePick[] {
  if (!isSenseDraftComplete(draft)) {
    throw new Error("Choose one side in all five markets before locking picks");
  }
  return SENSE_MARKET_IDS.map((marketId) => ({
    allocation: draft[marketId].allocation,
    marketId,
    selection: draft[marketId].selection as SenseSelection,
  }));
}
