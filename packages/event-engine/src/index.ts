import type {
  CanonicalEventEffect,
  CanonicalEventFact,
  CanonicalEventKind,
  CanonicalEventStatus,
  CanonicalMoment,
  DataProvenance,
  FixtureProjection,
  FixtureSnapshot,
  FixtureStats,
  MatchDecision,
  MatchPhase,
  MatchScores,
  Score,
  ScoreSnapshotFact,
  SourceFact,
  TeamCode,
  TeamMatchStats,
} from "@matchsense/contracts";
import {
  SIMULATION_SOURCE_LABEL,
  TXLINE_DEVNET_SOURCE_LABEL,
  TXLINE_RECORDED_SOURCE_LABEL,
} from "@matchsense/contracts";

const ZERO_SCORE: Score = { away: 0, home: 0 };
const ZERO_TEAM_STATS: TeamMatchStats = {
  corners: 0,
  penaltiesAwarded: 0,
  penaltiesMissed: 0,
  penaltiesScored: 0,
  redCards: 0,
  yellowCards: 0,
};

function copyScore(score: Score): Score {
  return { away: score.away, home: score.home };
}

function frozenScore(score: Score): Score {
  return Object.freeze(copyScore(score));
}

function zeroScores(): MatchScores {
  return {
    extraTime: copyScore(ZERO_SCORE),
    regulation: copyScore(ZERO_SCORE),
    shootout: copyScore(ZERO_SCORE),
  };
}

function copyScores(scores: MatchScores): MatchScores {
  return {
    extraTime: copyScore(scores.extraTime),
    regulation: copyScore(scores.regulation),
    shootout: copyScore(scores.shootout),
  };
}

function frozenScores(scores: MatchScores): MatchScores {
  return Object.freeze({
    extraTime: frozenScore(scores.extraTime),
    regulation: frozenScore(scores.regulation),
    shootout: frozenScore(scores.shootout),
  });
}

function zeroStats(): FixtureStats {
  return {
    away: { ...ZERO_TEAM_STATS },
    home: { ...ZERO_TEAM_STATS },
  };
}

function copyStats(stats: FixtureStats): FixtureStats {
  return { away: { ...stats.away }, home: { ...stats.home } };
}

function frozenStats(stats: FixtureStats): FixtureStats {
  return Object.freeze({
    away: Object.freeze({ ...stats.away }),
    home: Object.freeze({ ...stats.home }),
  });
}

function frozenMoment(moment: CanonicalMoment): CanonicalMoment {
  return Object.freeze({
    ...moment,
    player: moment.player ? Object.freeze({ ...moment.player }) : null,
    score: frozenScore(moment.score),
    scores: moment.scores ? frozenScores(moment.scores) : undefined,
    stats: moment.stats ? frozenStats(moment.stats) : undefined,
  });
}

function canonicalScores(projection: FixtureProjection): MatchScores {
  return projection.scores
    ? copyScores(projection.scores)
    : {
        extraTime: copyScore(ZERO_SCORE),
        regulation: copyScore(projection.score),
        shootout: copyScore(ZERO_SCORE),
      };
}

function canonicalStats(projection: FixtureProjection): FixtureStats {
  return projection.stats ? copyStats(projection.stats) : zeroStats();
}

function displayScore(scores: MatchScores): Score {
  return {
    away: scores.regulation.away + scores.extraTime.away,
    home: scores.regulation.home + scores.extraTime.home,
  };
}

function addScore(left: Score, right: Score, direction = 1): Score {
  return {
    away: Math.max(0, left.away + right.away * direction),
    home: Math.max(0, left.home + right.home * direction),
  };
}

function addScores(
  left: MatchScores,
  right: MatchScores,
  direction = 1,
): MatchScores {
  return {
    extraTime: addScore(left.extraTime, right.extraTime, direction),
    regulation: addScore(left.regulation, right.regulation, direction),
    shootout: addScore(left.shootout, right.shootout, direction),
  };
}

function addTeamStats(
  left: TeamMatchStats,
  right: TeamMatchStats,
  direction = 1,
): TeamMatchStats {
  return {
    corners: Math.max(0, left.corners + right.corners * direction),
    penaltiesAwarded: Math.max(
      0,
      left.penaltiesAwarded + right.penaltiesAwarded * direction,
    ),
    penaltiesMissed: Math.max(
      0,
      left.penaltiesMissed + right.penaltiesMissed * direction,
    ),
    penaltiesScored: Math.max(
      0,
      left.penaltiesScored + right.penaltiesScored * direction,
    ),
    redCards: Math.max(0, left.redCards + right.redCards * direction),
    yellowCards: Math.max(0, left.yellowCards + right.yellowCards * direction),
  };
}

function addStats(
  left: FixtureStats,
  right: FixtureStats,
  direction = 1,
): FixtureStats {
  return {
    away: addTeamStats(left.away, right.away, direction),
    home: addTeamStats(left.home, right.home, direction),
  };
}

function scoreSegment(phase: MatchPhase): keyof MatchScores {
  if (
    phase === "extra_time_first_half" ||
    phase === "extra_time_half" ||
    phase === "extra_time_second_half"
  ) {
    return "extraTime";
  }
  return "regulation";
}

function requireSide(
  team: TeamCode | null,
  projection: FixtureProjection,
  kind: CanonicalEventKind,
): "home" | "away" {
  if (team === projection.homeTeam) return "home";
  if (team === projection.awayTeam) return "away";
  throw new Error(`${kind} requires a fixture participant team`);
}

function effectFor(
  kind: CanonicalEventKind,
  team: TeamCode | null,
  player: CanonicalEventEffect["player"],
  projection: FixtureProjection,
  phase: MatchPhase,
): CanonicalEventEffect {
  const appliedScoreSegment: keyof MatchScores | null =
    kind === "shootout.kick_scored"
      ? "shootout"
      : kind === "goal" || kind === "penalty.scored"
        ? scoreSegment(phase)
        : null;
  const effect: CanonicalEventEffect = {
    active: true,
    kind,
    occurredPhase: phase,
    pending: false,
    player,
    scoreSegment: appliedScoreSegment,
    scores: zeroScores(),
    stats: zeroStats(),
    team,
  };
  if (
    kind.startsWith("phase.") ||
    kind.startsWith("var.") ||
    kind === "correction"
  ) {
    return effect;
  }

  const side = requireSide(team, projection, kind);
  if (kind === "shootout.kick_scored") {
    effect.scores["shootout"][side] = 1;
    return effect;
  }
  if (kind === "shootout.kick_missed") return effect;

  if (kind === "goal" || kind === "penalty.scored") {
    effect.scores[effect.scoreSegment!][side] = 1;
  }
  if (kind === "card.yellow") effect.stats[side].yellowCards = 1;
  if (kind === "card.red") effect.stats[side].redCards = 1;
  if (kind === "corner") effect.stats[side].corners = 1;
  if (kind === "penalty.awarded") effect.stats[side].penaltiesAwarded = 1;
  if (kind === "penalty.scored") effect.stats[side].penaltiesScored = 1;
  if (kind === "penalty.missed") effect.stats[side].penaltiesMissed = 1;
  return effect;
}

const PHASE_TRANSITIONS: Partial<
  Record<CanonicalEventKind, { from: readonly MatchPhase[]; to: MatchPhase }>
> = {
  "phase.extra_time_half": {
    from: ["extra_time_first_half"],
    to: "extra_time_half",
  },
  "phase.extra_time_second_half_start": {
    from: ["extra_time_half"],
    to: "extra_time_second_half",
  },
  "phase.extra_time_start": {
    from: ["regulation_end"],
    to: "extra_time_first_half",
  },
  "phase.full_time": {
    from: [
      "scheduled",
      "second_half",
      "regulation_end",
      "extra_time_second_half",
      "shootout",
    ],
    to: "full_time",
  },
  "phase.half_time": { from: ["first_half"], to: "half_time" },
  "phase.kickoff": { from: ["scheduled"], to: "first_half" },
  "phase.regulation_end": {
    from: ["second_half"],
    to: "regulation_end",
  },
  "phase.second_half_start": {
    from: ["half_time"],
    to: "second_half",
  },
  "phase.shootout_start": {
    from: ["regulation_end", "extra_time_second_half"],
    to: "shootout",
  },
};

function phaseForEvent(
  current: MatchPhase,
  kind: CanonicalEventKind,
): MatchPhase {
  const transition = PHASE_TRANSITIONS[kind];
  if (!transition) return current;
  if (current === transition.to) return current;
  if (!transition.from.includes(current)) {
    throw new Error(`Illegal phase transition: ${current} -> ${kind}`);
  }
  return transition.to;
}

function decisionAtFullTime(previous: MatchPhase): MatchDecision {
  if (previous === "shootout") return "shootout";
  if (
    previous === "extra_time_first_half" ||
    previous === "extra_time_half" ||
    previous === "extra_time_second_half"
  ) {
    return "extra_time";
  }
  return "regulation";
}

function statusFor(fact: CanonicalEventFact): CanonicalEventStatus {
  const { kind } = fact;
  if (kind === "var.started") return "under_review";
  if (kind === "var.overturned") return "overturned";
  if (kind === "correction") return "corrected";
  return fact.status;
}

export function toFixtureSnapshot(
  projection: FixtureProjection,
): FixtureSnapshot {
  const {
    appliedSourceEnvelopeIds: _appliedSourceEnvelopeIds,
    eventEffects: _eventEffects,
    ...snapshot
  } = projection;
  return Object.freeze({
    ...snapshot,
    lastEvent: snapshot.lastEvent
      ? frozenMoment(snapshot.lastEvent)
      : snapshot.lastEvent,
    score: frozenScore(snapshot.score),
    scores: snapshot.scores ? frozenScores(snapshot.scores) : undefined,
    stats: snapshot.stats ? frozenStats(snapshot.stats) : undefined,
  });
}

export function createFixtureProjection(input: {
  fixtureId: string;
  homeTeam: TeamCode;
  awayTeam: TeamCode;
  kickoffAt: string;
  observedAt: string;
  provenance?: DataProvenance;
}): FixtureProjection {
  const provenance = input.provenance ?? "synthetic_txline_shaped";
  return {
    awayTeam: input.awayTeam,
    appliedSourceEnvelopeIds: [],
    decidedBy: null,
    eventEffects: {},
    fixtureId: input.fixtureId,
    homeTeam: input.homeTeam,
    kickoffAt: input.kickoffAt,
    lastEvent: null,
    minute: "—",
    phase: "scheduled",
    provenance,
    revision: 0,
    score: copyScore(ZERO_SCORE),
    scores: zeroScores(),
    sourceLabel:
      provenance === "live_txline"
        ? TXLINE_DEVNET_SOURCE_LABEL
        : provenance === "recorded_txline_authorised"
          ? TXLINE_RECORDED_SOURCE_LABEL
          : SIMULATION_SOURCE_LABEL,
    stats: zeroStats(),
    updatedAt: input.observedAt,
  };
}

export interface ReduceResult {
  changed: boolean;
  moment: CanonicalMoment | null;
  projection: FixtureProjection;
}

function addAppliedSource(
  current: FixtureProjection,
  sourceEnvelopeId: string,
): readonly string[] {
  return [...current.appliedSourceEnvelopeIds, sourceEnvelopeId];
}

function reduceScoreSnapshot(
  current: FixtureProjection,
  fact: ScoreSnapshotFact,
): ReduceResult {
  const scores = canonicalScores(current);
  const stats = canonicalStats(current);
  const homeDelta = fact.score.home - current.score.home;
  const awayDelta = fact.score.away - current.score.away;
  const isSingleGoal =
    (homeDelta === 1 && awayDelta === 0) ||
    (homeDelta === 0 && awayDelta === 1);
  let nextScores = scores;
  let moment: CanonicalMoment | null = null;
  const revision = current.revision + 1;
  const phase = current.phase === "scheduled" ? "first_half" : current.phase;
  const eventEffects = { ...current.eventEffects };

  if (isSingleGoal) {
    const team = homeDelta === 1 ? current.homeTeam : current.awayTeam;
    const familyId = `${current.fixtureId}:event:${fact.sourceEnvelopeId}`;
    const effect = effectFor("goal", team, null, current, phase);
    nextScores = addScores(scores, effect.scores);
    eventEffects[familyId] = effect;
    moment = {
      celebratesGoal: true,
      eventTeam: team,
      familyId,
      fixtureId: current.fixtureId,
      id: familyId,
      identity: `${familyId}:${revision}`,
      kind: "goal",
      minute: fact.minute,
      occurredAt: fact.receivedAt,
      player: null,
      provenance: fact.provenance,
      receivedAt: fact.receivedAt,
      revision,
      score: displayScore(nextScores),
      scores: copyScores(nextScores),
      sourceEnvelopeId: fact.sourceEnvelopeId,
      sourceEventId: fact.sourceEnvelopeId,
      stats: copyStats(stats),
      status: "confirmed",
      team,
      targetFamilyId: null,
    };
  } else if (
    phase === "extra_time_first_half" ||
    phase === "extra_time_half" ||
    phase === "extra_time_second_half"
  ) {
    nextScores = {
      ...scores,
      extraTime: {
        away: Math.max(0, fact.score.away - scores.regulation.away),
        home: Math.max(0, fact.score.home - scores.regulation.home),
      },
    };
  } else {
    nextScores = { ...scores, regulation: copyScore(fact.score) };
  }

  const projection: FixtureProjection = {
    ...current,
    appliedSourceEnvelopeIds: addAppliedSource(current, fact.sourceEnvelopeId),
    eventEffects,
    lastEvent: moment ?? current.lastEvent,
    minute: fact.minute,
    phase,
    revision,
    score: displayScore(nextScores),
    scores: nextScores,
    stats,
    updatedAt: fact.receivedAt,
  };
  return { changed: true, moment, projection };
}

function reduceCanonicalEvent(
  current: FixtureProjection,
  fact: CanonicalEventFact,
): ReduceResult {
  const revision = current.revision + 1;
  const phase = phaseForEvent(current.phase, fact.kind);
  const familyId = fact.targetFamilyId ?? fact.familyId;
  const eventEffects = { ...current.eventEffects };
  let scores = canonicalScores(current);
  let stats = canonicalStats(current);
  const prior = eventEffects[familyId];
  let effectiveTeam = fact.team;
  let effectivePlayer = fact.player;

  if (fact.kind === "var.started") {
    if (prior) {
      effectiveTeam = prior.team;
      effectivePlayer = prior.player;
      if (prior.active) {
        scores = addScores(scores, prior.scores, -1);
        stats = addStats(stats, prior.stats, -1);
      }
      eventEffects[familyId] = {
        ...prior,
        active: false,
        pending: true,
      };
    }
  } else if (fact.kind === "var.stands") {
    if (prior) {
      effectiveTeam = prior.team;
      effectivePlayer = prior.player;
      if (prior.pending && !prior.active) {
        scores = addScores(scores, prior.scores);
        stats = addStats(stats, prior.stats);
      }
      eventEffects[familyId] = {
        ...prior,
        active: prior.active || prior.pending,
        pending: false,
      };
    }
  } else if (fact.kind === "var.overturned") {
    if (prior) {
      effectiveTeam = prior.team;
      effectivePlayer = prior.player;
      if (prior.active) {
        scores = addScores(scores, prior.scores, -1);
        stats = addStats(stats, prior.stats, -1);
      }
      eventEffects[familyId] = {
        ...prior,
        active: false,
        pending: false,
      };
    }
  } else if (fact.kind === "correction") {
    if (prior?.active) {
      scores = addScores(scores, prior.scores, -1);
      stats = addStats(stats, prior.stats, -1);
    }
    effectiveTeam = prior?.team ?? fact.team;
    effectivePlayer = prior?.player ?? fact.player;
    if (fact.replacement) {
      effectiveTeam = fact.replacement.team;
      effectivePlayer =
        fact.replacement.player === undefined
          ? effectivePlayer
          : fact.replacement.player;
      const replacement = effectFor(
        fact.replacement.kind,
        effectiveTeam,
        effectivePlayer,
        current,
        prior?.occurredPhase ?? phase,
      );
      replacement.active = fact.status === "confirmed";
      replacement.pending = fact.status !== "confirmed";
      if (replacement.active) {
        scores = addScores(scores, replacement.scores);
        stats = addStats(stats, replacement.stats);
      }
      eventEffects[familyId] = replacement;
    } else if (prior) {
      eventEffects[familyId] = {
        ...prior,
        active: false,
        pending: false,
      };
    }
  } else if (!fact.kind.startsWith("phase.")) {
    if (prior?.active) {
      scores = addScores(scores, prior.scores, -1);
      stats = addStats(stats, prior.stats, -1);
    }
    const effect = effectFor(
      fact.kind,
      fact.team,
      fact.player,
      current,
      prior?.occurredPhase ?? phase,
    );
    effect.active = fact.status === "confirmed";
    effect.pending = fact.status !== "confirmed";
    if (effect.active) {
      scores = addScores(scores, effect.scores);
      stats = addStats(stats, effect.stats);
    }
    eventEffects[familyId] = effect;
  }

  if (fact.status === "confirmed" && fact.scores) {
    scores = copyScores(fact.scores);
  }
  if (fact.status === "confirmed" && fact.stats) {
    stats = copyStats(fact.stats);
  }

  const decidedBy =
    fact.kind === "phase.full_time"
      ? decisionAtFullTime(current.phase)
      : (current.decidedBy ?? null);
  const status = statusFor(fact);
  const effect = eventEffects[familyId];
  const celebratesGoal = Boolean(
    status === "confirmed" &&
    effectiveTeam &&
    effect?.active &&
    effect.kind === "goal" &&
    (fact.kind === "goal" || fact.kind === "var.stands"),
  );
  const moment: CanonicalMoment = {
    celebratesGoal,
    eventTeam: effectiveTeam,
    familyId,
    fixtureId: current.fixtureId,
    id: familyId,
    identity: `${familyId}:${revision}`,
    kind: fact.kind,
    minute: fact.minute,
    occurredAt: fact.occurredAt,
    player: effectivePlayer,
    provenance: fact.provenance,
    receivedAt: fact.receivedAt,
    revision,
    score: displayScore(scores),
    scores: copyScores(scores),
    sourceEnvelopeId: fact.sourceEnvelopeId,
    sourceEventId: fact.sourceEventId,
    stats: copyStats(stats),
    status,
    team: effectiveTeam,
    targetFamilyId: fact.targetFamilyId ?? null,
  };
  const projection: FixtureProjection = {
    ...current,
    appliedSourceEnvelopeIds: addAppliedSource(current, fact.sourceEnvelopeId),
    decidedBy,
    eventEffects,
    lastEvent: moment,
    minute: fact.minute,
    phase,
    revision,
    score: moment.score,
    scores,
    stats,
    updatedAt: fact.receivedAt,
  };
  return { changed: true, moment, projection };
}

export function reduceSourceFact(
  current: FixtureProjection,
  fact: SourceFact,
): ReduceResult {
  if (current.appliedSourceEnvelopeIds.includes(fact.sourceEnvelopeId)) {
    return { changed: false, moment: null, projection: current };
  }
  if (fact.fixtureId !== current.fixtureId) {
    throw new Error("Source fact fixture does not match projection");
  }
  return fact.type === "score_snapshot"
    ? reduceScoreSnapshot(current, fact)
    : reduceCanonicalEvent(current, fact);
}
