import type { MatchMemoryRecord } from "./memory-api.js";
import type { LiveMoment, LiveSnapshot } from "./product-state.js";

type JsonObject = Record<string, unknown>;

export interface MatchMemoryView {
  moments: LiveMoment[];
  savedAt: string;
  snapshot: LiveSnapshot;
  stats: { away: number | string; home: number | string; label: string }[];
  summary: string;
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function count(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function uiKind(kind: string) {
  const kinds: Record<string, string> = {
    "card.red": "red_card",
    "card.yellow": "yellow_card",
    "phase.full_time": "full_time",
    "phase.half_time": "half_time",
  };
  return kinds[kind] ?? kind;
}

function cardCount(team: JsonObject | null) {
  const yellow = count(team?.yellowCards);
  const red = count(team?.redCards);
  return yellow === null || red === null ? "—" : yellow + red;
}

function statCount(team: JsonObject | null, key: string) {
  return count(team?.[key]) ?? "—";
}

export function matchMemoryView(memory: MatchMemoryRecord): MatchMemoryView {
  const payload = memory.payload;
  const moments = payload.keyMoments.map((moment): LiveMoment => ({
    celebratesGoal: moment.kind === "goal" && moment.status === "confirmed",
    eventTeam: moment.eventTeam ?? payload.homeTeam,
    id: moment.familyId,
    identity: moment.identity,
    kind: uiKind(moment.kind),
    minute: moment.minute,
    ...(moment.player?.displayName
      ? { playerName: moment.player.displayName }
      : {}),
    revision: moment.revision,
    score: moment.score,
    status: moment.status,
  }));
  const rawStats = object(payload.stats);
  const homeStats = object(rawStats?.home);
  const awayStats = object(rawStats?.away);
  const snapshot: LiveSnapshot = {
    awayTeam: payload.awayTeam,
    fixtureId: memory.fixtureId,
    homeTeam: payload.homeTeam,
    kickoffAt: payload.kickoffAt,
    lastEvent: moments.at(-1) ?? null,
    minute: "FT",
    phase: "full_time",
    provenance: payload.provenance,
    revision: memory.revision,
    score: payload.score,
    sourceLabel: payload.sourceLabel,
    updatedAt: payload.finalizedAt,
  };
  return {
    moments,
    savedAt: memory.createdAt,
    snapshot,
    stats: [
      {
        away: payload.score.away,
        home: payload.score.home,
        label: "Goals",
      },
      {
        away: cardCount(awayStats),
        home: cardCount(homeStats),
        label: "Cards",
      },
      {
        away: statCount(awayStats, "corners"),
        home: statCount(homeStats, "corners"),
        label: "Corners",
      },
    ],
    summary: payload.summary,
  };
}
