import type {
  CanonicalEventKind,
  CanonicalEventFact,
  FixtureSnapshot,
  FixtureStats,
  MatchScores,
  TeamCode,
} from "@matchsense/contracts";

import {
  normalizeTxlineScoreUpdate,
  type TxlineCanonicalizeResult,
  type TxlineNormalizeMetadata,
  type TxlineNormalizedUpdate,
  type TxlineSourceOnlyRecord,
  type TxlineWarning,
} from "./live.js";

/**
 * Stable fixture context required to reduce a raw TxLINE score delivery. It is
 * supplied by the durable schedule, never inferred from an incoming score.
 */
export interface DurableTxlineFixture {
  awayTeam: TeamCode;
  fixtureId: string;
  homeTeam: TeamCode;
  kickoffAt: string;
  participant1IsHome: boolean;
}

export type DurableTxlineReduction =
  | {
      facts: readonly CanonicalEventFact[];
      invalidatesArchive: boolean;
      kind: "canonical";
      update: TxlineNormalizedUpdate;
    }
  | { kind: "source_only"; source: TxlineSourceOnlyRecord }
  | { kind: "unsupported"; warning: TxlineWarning };

type DurableTxlineProvenance = "live_txline" | "recorded_txline_authorised";

function durableTxlineProvenance(
  provenance: TxlineNormalizedUpdate["provenance"],
): DurableTxlineProvenance | null {
  return provenance === "live_txline" ||
    provenance === "recorded_txline_authorised"
    ? provenance
    : null;
}

function sourceEventId(update: TxlineNormalizedUpdate) {
  return update.actionId ?? update.source.actionId ?? update.source.payloadHash;
}

function sourceEnvelopeId(update: TxlineNormalizedUpdate, suffix?: string) {
  return [
    "txline",
    update.fixtureId,
    update.source.observedSeq ?? update.source.payloadHash,
    update.source.payloadHash,
    ...(suffix ? [suffix] : []),
  ].join(":");
}

function occurredAt(update: TxlineNormalizedUpdate) {
  return update.source.sourceTimestampMs === null
    ? null
    : new Date(update.source.sourceTimestampMs).toISOString();
}

function minuteFor(update: TxlineNormalizedUpdate, fallback = "—") {
  return update.clockSeconds === null
    ? fallback
    : `${Math.floor(update.clockSeconds / 60)}'`;
}

function participantTeam(
  participant: 1 | 2 | null,
  fixture: DurableTxlineFixture,
) {
  if (participant === null) return null;
  if (participant === 1) {
    return fixture.participant1IsHome ? fixture.homeTeam : fixture.awayTeam;
  }
  return fixture.participant1IsHome ? fixture.awayTeam : fixture.homeTeam;
}

/**
 * A verified final is authoritative even when an upstream historical slice
 * omitted intermediate phase markers. These bridge facts are deterministic
 * lifecycle transitions (not invented match actions) so the event engine can
 * reach the same final projection from a sparse and a complete archive.
 */
function phaseBridgeToFinal(
  phase: FixtureSnapshot["phase"],
): readonly CanonicalEventKind[] {
  switch (phase) {
    case "first_half":
      return [
        "phase.half_time",
        "phase.second_half_start",
        "phase.regulation_end",
      ];
    case "half_time":
      return ["phase.second_half_start", "phase.regulation_end"];
    case "second_half":
      return ["phase.regulation_end"];
    case "extra_time_first_half":
      return ["phase.extra_time_half", "phase.extra_time_second_half_start"];
    case "extra_time_half":
      return ["phase.extra_time_second_half_start"];
    default:
      return [];
  }
}

function phaseBridgeMinute(kind: CanonicalEventKind) {
  if (kind === "phase.half_time" || kind === "phase.extra_time_half") {
    return "HT";
  }
  if (kind === "phase.regulation_end") return "90'";
  return "—";
}

function scoresFor(
  update: TxlineNormalizedUpdate,
  current: FixtureSnapshot,
): MatchScores {
  const currentScores = current.scores ?? {
    extraTime: { away: 0, home: 0 },
    regulation: current.score,
    shootout: { away: 0, home: 0 },
  };
  const score = update.score ?? current.score;
  const extraTime =
    current.phase === "extra_time_first_half" ||
    current.phase === "extra_time_half" ||
    current.phase === "extra_time_second_half";
  return extraTime
    ? {
        ...currentScores,
        extraTime: {
          away: Math.max(0, score.away - currentScores.regulation.away),
          home: Math.max(0, score.home - currentScores.regulation.home),
        },
      }
    : { ...currentScores, regulation: score };
}

function statsFor(
  update: TxlineNormalizedUpdate,
  fixture: DurableTxlineFixture,
): FixtureStats | undefined {
  if (!update.participantStats) return undefined;
  const teamStats = (value: typeof update.participantStats.participant1) => ({
    corners: value.corners,
    penaltiesAwarded: 0,
    penaltiesMissed: 0,
    penaltiesScored: 0,
    redCards: value.redCards,
    yellowCards: value.yellowCards,
  });
  return fixture.participant1IsHome
    ? {
        away: teamStats(update.participantStats.participant2),
        home: teamStats(update.participantStats.participant1),
      }
    : {
        away: teamStats(update.participantStats.participant1),
        home: teamStats(update.participantStats.participant2),
      };
}

function common(update: TxlineNormalizedUpdate) {
  const provenance = durableTxlineProvenance(update.provenance);
  if (!provenance) {
    throw new Error(
      "Synthetic TxLINE-shaped data cannot enter durable reduction",
    );
  }
  return {
    fixtureId: update.fixtureId,
    occurredAt: occurredAt(update),
    player:
      update.playerId === null
        ? null
        : { displayName: null, id: update.playerId },
    provenance,
    receivedAt: update.receivedAt,
    sourceEventId: sourceEventId(update),
    type: "canonical_event" as const,
  };
}

/**
 * Converts one already-normalised TxLINE action into the source facts that the
 * event engine understands. The mapping is deliberately pure: delivery
 * intent, fan effects, and persistence are owned by the collector.
 */
export function productFactsFromTxlineUpdate(
  update: TxlineNormalizedUpdate,
  fixture: DurableTxlineFixture,
  current: FixtureSnapshot,
): CanonicalEventFact[] {
  if (
    !durableTxlineProvenance(update.provenance) ||
    update.fixtureId !== fixture.fixtureId
  ) {
    return [];
  }
  const facts: CanonicalEventFact[] = [];
  if (current.phase === "scheduled" && update.action !== "game_finalised") {
    facts.push({
      ...common(update),
      familyId: `txline:${update.fixtureId}:phase:kickoff`,
      kind: "phase.kickoff",
      minute: "0'",
      player: null,
      sourceEnvelopeId: `txline:${update.fixtureId}:implicit-kickoff`,
      sourceEventId: `txline:${update.fixtureId}:implicit-kickoff`,
      status: "confirmed",
      team: null,
    });
  }

  const familyId = `txline:${update.fixtureId}:action:${sourceEventId(update)}`;
  const minute = minuteFor(update);
  const aggregate = {
    scores: scoresFor(update, current),
    ...(statsFor(update, fixture) ? { stats: statsFor(update, fixture)! } : {}),
  };
  if (update.action === "game_finalised") {
    for (const [index, kind] of phaseBridgeToFinal(current.phase).entries()) {
      const suffix = `phase-bridge:${index}:${kind}`;
      facts.push({
        ...common(update),
        familyId: `txline:${update.fixtureId}:action:${sourceEventId(update)}:${suffix}`,
        kind,
        minute: phaseBridgeMinute(kind),
        player: null,
        sourceEnvelopeId: sourceEnvelopeId(update, suffix),
        sourceEventId: `${sourceEventId(update)}:${suffix}`,
        status: "confirmed",
        team: null,
      });
    }
    facts.push({
      ...common(update),
      ...aggregate,
      familyId,
      kind: "phase.full_time",
      minute: "FT",
      player: null,
      sourceEnvelopeId: sourceEnvelopeId(update),
      status: "confirmed",
      team: null,
    });
  } else if (update.action === "halftime_finalised") {
    facts.push({
      ...common(update),
      ...aggregate,
      familyId,
      kind: "phase.half_time",
      minute: "HT",
      player: null,
      sourceEnvelopeId: sourceEnvelopeId(update),
      status: "confirmed",
      team: null,
    });
  } else if (update.action === "var") {
    facts.push({
      ...common(update),
      familyId,
      kind: "var.started",
      minute,
      player: null,
      sourceEnvelopeId: sourceEnvelopeId(update),
      status: "under_review",
      team: null,
    });
  } else if (update.action === "var_end" && update.varOutcome) {
    facts.push({
      ...common(update),
      ...aggregate,
      familyId,
      kind:
        update.varOutcome === "overturned" ? "var.overturned" : "var.stands",
      minute,
      player: null,
      sourceEnvelopeId: sourceEnvelopeId(update),
      status: "confirmed",
      team: null,
    });
  } else if (
    update.action === "goal" &&
    update.confirmed === true &&
    update.score !== null
  ) {
    const team =
      update.participant === 1
        ? fixture.participant1IsHome
          ? fixture.homeTeam
          : fixture.awayTeam
        : update.participant === 2
          ? fixture.participant1IsHome
            ? fixture.awayTeam
            : fixture.homeTeam
          : update.score.home > current.score.home
            ? fixture.homeTeam
            : fixture.awayTeam;
    facts.push({
      ...common(update),
      ...aggregate,
      familyId,
      kind: "goal",
      minute,
      sourceEnvelopeId: sourceEnvelopeId(update),
      status: "confirmed",
      team,
    });
  } else if (update.action === "penalty" && update.confirmed !== false) {
    const team = participantTeam(update.participant, fixture);
    if (team) {
      facts.push({
        ...common(update),
        familyId,
        kind: "penalty.awarded",
        minute,
        sourceEnvelopeId: sourceEnvelopeId(update),
        status: "confirmed",
        team,
      });
    }
  } else if (
    (update.action === "score_adjustment" ||
      update.action === "action_amend" ||
      update.action === "action_discarded") &&
    (update.score !== null || update.participantStats !== null)
  ) {
    facts.push({
      ...common(update),
      ...aggregate,
      familyId,
      kind: "correction",
      minute,
      player: null,
      sourceEnvelopeId: sourceEnvelopeId(update),
      status: "confirmed",
      team: participantTeam(update.participant, fixture),
    });
  }

  const nextStats = statsFor(update, fixture);
  if (
    nextStats &&
    update.action !== "game_finalised" &&
    update.action !== "halftime_finalised"
  ) {
    const counters = [
      ["corners", "corner"],
      ["yellowCards", "card.yellow"],
      ["redCards", "card.red"],
    ] as const;
    for (const side of ["home", "away"] as const) {
      const team = side === "home" ? fixture.homeTeam : fixture.awayTeam;
      for (const [counter, kind] of counters) {
        const previous = current.stats?.[side][counter] ?? 0;
        const next = nextStats[side][counter];
        for (let count = previous + 1; count <= next; count += 1) {
          const suffix = `stat:${side}:${counter}:${count}`;
          facts.push({
            ...common(update),
            ...aggregate,
            familyId: `txline:${update.fixtureId}:${suffix}`,
            kind,
            minute,
            player: null,
            sourceEnvelopeId: sourceEnvelopeId(update, suffix),
            sourceEventId: `${sourceEventId(update)}:${suffix}`,
            status: "confirmed",
            team,
          });
        }
      }
    }
  }
  return facts;
}

/**
 * Classifies and maps a raw provider delivery without retaining process-local
 * state. Durable ordering and dedupe are enforced by the database, making the
 * same archive replay reduce identically after a worker restart.
 */
export function reduceDurableTxlineDelivery(input: {
  current: FixtureSnapshot;
  fixture: DurableTxlineFixture;
  metadata: TxlineNormalizeMetadata;
  payload: unknown;
}): DurableTxlineReduction {
  const normalized = normalizeTxlineScoreUpdate(input.payload, {
    ...input.metadata,
    fixtureContext: {
      fixtureId: input.fixture.fixtureId,
      participant1: { id: "participant-1", name: input.fixture.homeTeam },
      participant1IsHome: input.fixture.participant1IsHome,
      participant2: { id: "participant-2", name: input.fixture.awayTeam },
    },
  });
  if (normalized.kind === "source_only") {
    return { kind: "source_only", source: normalized.record };
  }
  if (normalized.kind === "unsupported") return normalized;
  const update = normalized.update;
  const facts = productFactsFromTxlineUpdate(
    update,
    input.fixture,
    input.current,
  );
  return {
    facts,
    invalidatesArchive:
      update.action === "action_amend" ||
      update.action === "action_discarded" ||
      update.action === "score_adjustment" ||
      facts.some(
        (fact) => fact.kind === "correction" || fact.kind === "var.overturned",
      ),
    kind: "canonical",
    update,
  };
}

/** Re-exported as a structural guard for consumers that persist source truth. */
export type DurableTxlineCanonicalizeResult = TxlineCanonicalizeResult;
