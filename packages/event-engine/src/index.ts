import type {
  CanonicalMoment,
  DataProvenance,
  FixtureProjection,
  FixtureSnapshot,
  SourceFact,
  TeamCode,
} from "@matchsense/contracts";
import {
  SIMULATION_SOURCE_LABEL,
  TXLINE_DEVNET_SOURCE_LABEL,
} from "@matchsense/contracts";

export function toFixtureSnapshot(
  projection: FixtureProjection,
): FixtureSnapshot {
  const { appliedSourceEnvelopeIds: _ignored, ...snapshot } = projection;
  return snapshot;
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
    fixtureId: input.fixtureId,
    homeTeam: input.homeTeam,
    kickoffAt: input.kickoffAt,
    lastEvent: null,
    minute: "—",
    phase: "scheduled",
    provenance,
    revision: 0,
    score: { away: 0, home: 0 },
    sourceLabel:
      provenance === "live_txline"
        ? TXLINE_DEVNET_SOURCE_LABEL
        : SIMULATION_SOURCE_LABEL,
    updatedAt: input.observedAt,
  };
}

export interface ReduceResult {
  changed: boolean;
  moment: CanonicalMoment | null;
  projection: FixtureProjection;
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

  const scoreChanged =
    fact.score.home !== current.score.home ||
    fact.score.away !== current.score.away;
  const revision = current.revision + 1;
  const momentId = `${current.fixtureId}:score:${fact.score.home}-${fact.score.away}`;
  const moment: CanonicalMoment | null = scoreChanged
    ? {
        eventTeam:
          fact.score.home > current.score.home
            ? current.homeTeam
            : current.awayTeam,
        fixtureId: current.fixtureId,
        id: momentId,
        identity: `${momentId}:${revision}`,
        kind: "goal",
        minute: fact.minute,
        provenance: fact.provenance,
        revision,
        score: fact.score,
        sourceEnvelopeId: fact.sourceEnvelopeId,
        status: "confirmed",
      }
    : null;

  const projection: FixtureProjection = {
    ...current,
    appliedSourceEnvelopeIds: [
      ...current.appliedSourceEnvelopeIds,
      fact.sourceEnvelopeId,
    ],
    lastEvent: moment ?? current.lastEvent,
    minute: fact.minute,
    phase: "first_half",
    revision,
    score: fact.score,
    updatedAt: fact.receivedAt,
  };

  return { changed: true, moment, projection };
}
