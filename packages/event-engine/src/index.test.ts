import { describe, expect, it } from "vitest";

import type { CanonicalEventFact } from "@matchsense/contracts";
import { adaptSyntheticEnvelope } from "@matchsense/txline-adapter";

import {
  createFixtureProjection,
  reduceSourceFact,
  toFixtureSnapshot,
} from "./index.js";

function canonicalFact(
  overrides: Partial<CanonicalEventFact>,
): CanonicalEventFact {
  return {
    familyId: "txline:fixture-1:event-1",
    fixtureId: "fixture-1",
    kind: "goal",
    minute: "23'",
    occurredAt: "2026-07-16T12:00:00.000Z",
    player: null,
    provenance: "live_txline",
    receivedAt: "2026-07-16T12:00:01.000Z",
    sourceEnvelopeId: "envelope-1",
    sourceEventId: "event-1",
    status: "confirmed",
    team: "ARG",
    type: "canonical_event",
    ...overrides,
  };
}

function reduce(
  projection: ReturnType<typeof createFixtureProjection>,
  fact: CanonicalEventFact,
) {
  return reduceSourceFact(projection, fact);
}

describe("canonical fixture reducer", () => {
  it("creates one revision-linked goal moment and ignores duplicate source delivery", () => {
    const envelope = {
      id: "synthetic-goal-arg-fra-1",
      fixtureId: "arg-fra-demo",
      provenance: "synthetic_txline_shaped" as const,
      receivedAt: "2026-07-16T12:00:00.000Z",
      source: "replay" as const,
      supportedFact: {
        awayGoals: 0,
        homeGoals: 1,
        minute: "23'",
        type: "score_snapshot" as const,
      },
    };
    const fact = adaptSyntheticEnvelope(envelope);
    const cold = createFixtureProjection({
      awayTeam: "FRA",
      fixtureId: envelope.fixtureId,
      homeTeam: "ARG",
      kickoffAt: "2026-07-16T18:00:00.000Z",
      observedAt: "2026-07-16T11:59:00.000Z",
    });

    const first = reduceSourceFact(cold, fact);
    const duplicate = reduceSourceFact(first.projection, fact);

    expect(first.changed).toBe(true);
    expect(first.projection.score).toEqual({ away: 0, home: 1 });
    expect(first.projection.minute).toBe("23'");
    expect(cold.updatedAt).toBe("2026-07-16T11:59:00.000Z");
    expect(first.projection.updatedAt).toBe(envelope.receivedAt);
    expect(first.moment).toMatchObject({
      familyId: "arg-fra-demo:event:synthetic-goal-arg-fra-1",
      id: "arg-fra-demo:event:synthetic-goal-arg-fra-1",
      revision: 1,
      sourceEnvelopeId: envelope.id,
      status: "confirmed",
    });
    expect(first.moment?.identity).toBe(
      "arg-fra-demo:event:synthetic-goal-arg-fra-1:1",
    );
    expect(duplicate).toEqual({
      changed: false,
      moment: null,
      projection: first.projection,
    });
  });

  it("applies every canonical event kind and advances every match phase", () => {
    let projection = createFixtureProjection({
      awayTeam: "FRA",
      fixtureId: "fixture-1",
      homeTeam: "ARG",
      kickoffAt: "2026-07-16T18:00:00.000Z",
      observedAt: "2026-07-16T17:59:00.000Z",
      provenance: "live_txline",
    });

    const facts = [
      canonicalFact({
        familyId: "phase-kickoff",
        kind: "phase.kickoff",
        sourceEnvelopeId: "phase-kickoff",
        sourceEventId: "phase-kickoff",
        team: null,
      }),
      canonicalFact({
        familyId: "yellow-1",
        kind: "card.yellow",
        sourceEnvelopeId: "yellow-1",
        sourceEventId: "yellow-1",
      }),
      canonicalFact({
        familyId: "red-1",
        kind: "card.red",
        sourceEnvelopeId: "red-1",
        sourceEventId: "red-1",
        team: "FRA",
      }),
      canonicalFact({
        familyId: "corner-1",
        kind: "corner",
        sourceEnvelopeId: "corner-1",
        sourceEventId: "corner-1",
      }),
      canonicalFact({
        familyId: "penalty-awarded-1",
        kind: "penalty.awarded",
        sourceEnvelopeId: "penalty-awarded-1",
        sourceEventId: "penalty-awarded-1",
      }),
      canonicalFact({
        familyId: "penalty-scored-1",
        kind: "penalty.scored",
        sourceEnvelopeId: "penalty-scored-1",
        sourceEventId: "penalty-scored-1",
      }),
      canonicalFact({
        familyId: "penalty-missed-1",
        kind: "penalty.missed",
        sourceEnvelopeId: "penalty-missed-1",
        sourceEventId: "penalty-missed-1",
        team: "FRA",
      }),
      canonicalFact({
        familyId: "phase-half-time",
        kind: "phase.half_time",
        sourceEnvelopeId: "phase-half-time",
        sourceEventId: "phase-half-time",
        team: null,
      }),
    ];

    for (const fact of facts) projection = reduce(projection, fact).projection;

    expect(projection.phase).toBe("half_time");
    expect(projection.score).toEqual({ away: 0, home: 1 });
    expect(projection.scores).toEqual({
      extraTime: { away: 0, home: 0 },
      regulation: { away: 0, home: 1 },
      shootout: { away: 0, home: 0 },
    });
    expect(projection.stats).toEqual({
      away: {
        corners: 0,
        penaltiesAwarded: 0,
        penaltiesMissed: 1,
        penaltiesScored: 0,
        redCards: 1,
        yellowCards: 0,
      },
      home: {
        corners: 1,
        penaltiesAwarded: 1,
        penaltiesMissed: 0,
        penaltiesScored: 1,
        redCards: 0,
        yellowCards: 1,
      },
    });

    const secondHalfGoal = reduce(
      reduce(
        projection,
        canonicalFact({
          familyId: "phase-second-half-start",
          kind: "phase.second_half_start",
          sourceEnvelopeId: "phase-second-half-start",
          sourceEventId: "phase-second-half-start",
          team: null,
        }),
      ).projection,
      canonicalFact({
        familyId: "goal-second-half",
        sourceEnvelopeId: "goal-second-half",
        sourceEventId: "goal-second-half",
      }),
    );
    expect(secondHalfGoal.projection.phase).toBe("second_half");
    expect(secondHalfGoal.projection.scores?.regulation).toEqual({
      away: 0,
      home: 2,
    });

    projection = secondHalfGoal.projection;
    for (const fact of [
      canonicalFact({
        familyId: "phase-regulation-end",
        kind: "phase.regulation_end",
        sourceEnvelopeId: "phase-regulation-end",
        sourceEventId: "phase-regulation-end",
        team: null,
      }),
      canonicalFact({
        familyId: "phase-et-start",
        kind: "phase.extra_time_start",
        sourceEnvelopeId: "phase-et-start",
        sourceEventId: "phase-et-start",
        team: null,
      }),
      canonicalFact({
        familyId: "et-goal",
        sourceEnvelopeId: "et-goal",
        sourceEventId: "et-goal",
        team: "FRA",
      }),
      canonicalFact({
        familyId: "phase-et-half",
        kind: "phase.extra_time_half",
        sourceEnvelopeId: "phase-et-half",
        sourceEventId: "phase-et-half",
        team: null,
      }),
      canonicalFact({
        familyId: "phase-et-second-half-start",
        kind: "phase.extra_time_second_half_start",
        sourceEnvelopeId: "phase-et-second-half-start",
        sourceEventId: "phase-et-second-half-start",
        team: null,
      }),
      canonicalFact({
        familyId: "et-second-half-yellow",
        kind: "card.yellow",
        sourceEnvelopeId: "et-second-half-yellow",
        sourceEventId: "et-second-half-yellow",
      }),
      canonicalFact({
        familyId: "phase-shootout-start",
        kind: "phase.shootout_start",
        sourceEnvelopeId: "phase-shootout-start",
        sourceEventId: "phase-shootout-start",
        team: null,
      }),
      canonicalFact({
        familyId: "shootout-scored-home",
        kind: "shootout.kick_scored",
        sourceEnvelopeId: "shootout-scored-home",
        sourceEventId: "shootout-scored-home",
      }),
      canonicalFact({
        familyId: "shootout-missed-away",
        kind: "shootout.kick_missed",
        sourceEnvelopeId: "shootout-missed-away",
        sourceEventId: "shootout-missed-away",
        team: "FRA",
      }),
      canonicalFact({
        familyId: "shootout-scored-away",
        kind: "shootout.kick_scored",
        sourceEnvelopeId: "shootout-scored-away",
        sourceEventId: "shootout-scored-away",
        team: "FRA",
      }),
      canonicalFact({
        familyId: "phase-full-time",
        kind: "phase.full_time",
        sourceEnvelopeId: "phase-full-time",
        sourceEventId: "phase-full-time",
        team: null,
      }),
    ]) {
      projection = reduce(projection, fact).projection;
    }

    expect(projection.phase).toBe("full_time");
    expect(projection.decidedBy).toBe("shootout");
    expect(projection.score).toEqual({ away: 1, home: 2 });
    expect(projection.scores).toEqual({
      extraTime: { away: 1, home: 0 },
      regulation: { away: 0, home: 2 },
      shootout: { away: 1, home: 1 },
    });
    expect(projection.lastEvent).toMatchObject({
      eventTeam: null,
      kind: "phase.full_time",
      team: null,
    });
  });

  it("keeps one family across VAR revisions and rolls back only its goal", () => {
    let projection = createFixtureProjection({
      awayTeam: "FRA",
      fixtureId: "fixture-1",
      homeTeam: "ARG",
      kickoffAt: "2026-07-16T18:00:00.000Z",
      observedAt: "2026-07-16T17:59:00.000Z",
      provenance: "live_txline",
    });
    projection = reduce(
      projection,
      canonicalFact({
        familyId: "phase-kickoff",
        kind: "phase.kickoff",
        sourceEnvelopeId: "phase-kickoff",
        sourceEventId: "phase-kickoff",
        team: null,
      }),
    ).projection;
    const goal = reduce(
      projection,
      canonicalFact({
        familyId: "txline:goal:77",
        player: { displayName: "Lionel Messi", id: "player-10" },
      }),
    );
    const unrelatedCorner = reduce(
      goal.projection,
      canonicalFact({
        familyId: "corner-after-goal",
        kind: "corner",
        sourceEnvelopeId: "corner-after-goal",
        sourceEventId: "corner-after-goal",
        team: "FRA",
      }),
    );
    const reviewing = reduce(
      unrelatedCorner.projection,
      canonicalFact({
        familyId: "txline:goal:77",
        kind: "var.started",
        sourceEnvelopeId: "var-started-77",
        sourceEventId: "var-started-77",
        targetFamilyId: "txline:goal:77",
        team: null,
      }),
    );
    const overturned = reduce(
      reviewing.projection,
      canonicalFact({
        familyId: "txline:goal:77",
        kind: "var.overturned",
        sourceEnvelopeId: "var-overturned-77",
        sourceEventId: "var-overturned-77",
        targetFamilyId: "txline:goal:77",
        team: null,
      }),
    );

    expect(goal.moment).toMatchObject({
      familyId: "txline:goal:77",
      id: "txline:goal:77",
      identity: "txline:goal:77:2",
      status: "confirmed",
    });
    expect(reviewing.moment).toMatchObject({
      eventTeam: "ARG",
      familyId: "txline:goal:77",
      identity: "txline:goal:77:4",
      player: { displayName: "Lionel Messi", id: "player-10" },
      status: "under_review",
      team: "ARG",
    });
    expect(overturned.moment).toMatchObject({
      eventTeam: "ARG",
      familyId: "txline:goal:77",
      identity: "txline:goal:77:5",
      kind: "var.overturned",
      player: { displayName: "Lionel Messi", id: "player-10" },
      status: "overturned",
      team: "ARG",
    });
    expect(overturned.projection.score).toEqual({ away: 0, home: 0 });
    expect(overturned.projection.stats?.away.corners).toBe(1);
  });

  it("replaces a corrected event effect without changing its family", () => {
    const cold = createFixtureProjection({
      awayTeam: "FRA",
      fixtureId: "fixture-1",
      homeTeam: "ARG",
      kickoffAt: "2026-07-16T18:00:00.000Z",
      observedAt: "2026-07-16T17:59:00.000Z",
      provenance: "live_txline",
    });
    const red = reduce(
      cold,
      canonicalFact({
        familyId: "txline:card:9",
        kind: "card.red",
        sourceEnvelopeId: "red-card-9",
        sourceEventId: "red-card-9",
        team: "FRA",
      }),
    );
    const corrected = reduce(
      red.projection,
      canonicalFact({
        familyId: "txline:card:9",
        kind: "correction",
        replacement: {
          kind: "card.yellow",
          player: { displayName: "Kylian Mbappe", id: "player-9" },
          team: "FRA",
        },
        sourceEnvelopeId: "amend-card-9",
        sourceEventId: "amend-card-9",
        targetFamilyId: "txline:card:9",
        team: null,
      }),
    );

    expect(corrected.projection.stats?.away).toMatchObject({
      redCards: 0,
      yellowCards: 1,
    });
    expect(corrected.moment).toMatchObject({
      familyId: "txline:card:9",
      identity: "txline:card:9:2",
      kind: "correction",
      player: { displayName: "Kylian Mbappe", id: "player-9" },
      status: "corrected",
    });
  });

  it("ignores a duplicate canonical source envelope exactly", () => {
    const cold = createFixtureProjection({
      awayTeam: "FRA",
      fixtureId: "fixture-1",
      homeTeam: "ARG",
      kickoffAt: "2026-07-16T18:00:00.000Z",
      observedAt: "2026-07-16T17:59:00.000Z",
      provenance: "live_txline",
    });
    const fact = canonicalFact({ familyId: "txline:goal:88" });
    const first = reduce(cold, fact);
    const duplicate = reduce(first.projection, fact);

    expect(duplicate).toEqual({
      changed: false,
      moment: null,
      projection: first.projection,
    });
  });

  it("replaces an existing family effect instead of double-counting new envelopes", () => {
    const cold = createFixtureProjection({
      awayTeam: "FRA",
      fixtureId: "fixture-1",
      homeTeam: "ARG",
      kickoffAt: "2026-07-16T18:00:00.000Z",
      observedAt: "2026-07-16T17:59:00.000Z",
      provenance: "live_txline",
    });
    const first = reduce(cold, canonicalFact({ familyId: "txline:goal:99" }));
    const sameContent = reduce(
      first.projection,
      canonicalFact({
        familyId: "txline:goal:99",
        receivedAt: "2026-07-16T12:00:02.000Z",
        sourceEnvelopeId: "envelope-2",
        sourceEventId: "event-1-revision-2",
      }),
    );
    const changedContent = reduce(
      sameContent.projection,
      canonicalFact({
        familyId: "txline:goal:99",
        receivedAt: "2026-07-16T12:00:03.000Z",
        sourceEnvelopeId: "envelope-3",
        sourceEventId: "event-1-revision-3",
        team: "FRA",
      }),
    );

    expect(first.projection.score).toEqual({ away: 0, home: 1 });
    expect(sameContent.projection.score).toEqual({ away: 0, home: 1 });
    expect(changedContent.projection.score).toEqual({ away: 1, home: 0 });
    expect(changedContent.moment).toMatchObject({
      familyId: "txline:goal:99",
      identity: "txline:goal:99:3",
      team: "FRA",
    });
  });

  it("holds provisional and reviewed goals until confirmation or VAR stands", () => {
    const cold = createFixtureProjection({
      awayTeam: "FRA",
      fixtureId: "fixture-1",
      homeTeam: "ARG",
      kickoffAt: "2026-07-16T18:00:00.000Z",
      observedAt: "2026-07-16T17:59:00.000Z",
      provenance: "live_txline",
    });
    const provisional = reduce(
      cold,
      canonicalFact({
        familyId: "txline:goal:provisional",
        player: { displayName: "Lionel Messi", id: "player-10" },
        status: "provisional",
      }),
    );
    const confirmed = reduce(
      provisional.projection,
      canonicalFact({
        familyId: "txline:goal:provisional",
        player: { displayName: "Lionel Messi", id: "player-10" },
        receivedAt: "2026-07-16T12:00:02.000Z",
        sourceEnvelopeId: "envelope-confirmed",
        sourceEventId: "event-confirmed",
        status: "confirmed",
      }),
    );
    const reviewed = reduce(
      confirmed.projection,
      canonicalFact({
        familyId: "txline:goal:reviewed",
        player: { displayName: "Kylian Mbappe", id: "player-9" },
        receivedAt: "2026-07-16T12:00:03.000Z",
        sourceEnvelopeId: "envelope-reviewed",
        sourceEventId: "event-reviewed",
        status: "under_review",
        team: "FRA",
      }),
    );
    const stands = reduce(
      reviewed.projection,
      canonicalFact({
        familyId: "txline:goal:reviewed",
        kind: "var.stands",
        player: null,
        receivedAt: "2026-07-16T12:00:04.000Z",
        sourceEnvelopeId: "envelope-stands",
        sourceEventId: "event-stands",
        status: "confirmed",
        targetFamilyId: "txline:goal:reviewed",
        team: null,
      }),
    );
    const anotherReviewed = reduce(
      stands.projection,
      canonicalFact({
        familyId: "txline:goal:overturned",
        receivedAt: "2026-07-16T12:00:05.000Z",
        sourceEnvelopeId: "envelope-another-reviewed",
        sourceEventId: "event-another-reviewed",
        status: "under_review",
      }),
    );
    const overturned = reduce(
      anotherReviewed.projection,
      canonicalFact({
        familyId: "txline:goal:overturned",
        kind: "var.overturned",
        receivedAt: "2026-07-16T12:00:06.000Z",
        sourceEnvelopeId: "envelope-overturned",
        sourceEventId: "event-overturned",
        status: "confirmed",
        targetFamilyId: "txline:goal:overturned",
        team: null,
      }),
    );

    expect(provisional.projection.score).toEqual({ away: 0, home: 0 });
    expect(provisional.moment?.status).toBe("provisional");
    expect(confirmed.projection.score).toEqual({ away: 0, home: 1 });
    expect(reviewed.projection.score).toEqual({ away: 0, home: 1 });
    expect(reviewed.moment?.status).toBe("under_review");
    expect(stands.projection.score).toEqual({ away: 1, home: 1 });
    expect(stands.moment).toMatchObject({
      eventTeam: "FRA",
      player: { displayName: "Kylian Mbappe", id: "player-9" },
      team: "FRA",
    });
    expect(anotherReviewed.projection.score).toEqual({ away: 1, home: 1 });
    expect(overturned.projection.score).toEqual({ away: 1, home: 1 });
    expect(overturned.moment).toMatchObject({
      eventTeam: "ARG",
      player: null,
      team: "ARG",
    });
  });

  it("signals a goal celebration for VAR stands only when the reviewed family is a goal", () => {
    const cold = createFixtureProjection({
      awayTeam: "FRA",
      fixtureId: "fixture-1",
      homeTeam: "ARG",
      kickoffAt: "2026-07-16T18:00:00.000Z",
      observedAt: "2026-07-16T17:59:00.000Z",
      provenance: "live_txline",
    });
    const goal = reduce(
      cold,
      canonicalFact({ familyId: "goal-under-review", status: "under_review" }),
    );
    const goalStands = reduce(
      goal.projection,
      canonicalFact({
        familyId: "goal-under-review",
        kind: "var.stands",
        sourceEnvelopeId: "goal-stands-envelope",
        sourceEventId: "goal-stands",
        targetFamilyId: "goal-under-review",
        team: null,
      }),
    );
    const card = reduce(
      goalStands.projection,
      canonicalFact({
        familyId: "card-under-review",
        kind: "card.red",
        sourceEnvelopeId: "card-envelope",
        sourceEventId: "card",
        status: "under_review",
      }),
    );
    const cardStands = reduce(
      card.projection,
      canonicalFact({
        familyId: "card-under-review",
        kind: "var.stands",
        sourceEnvelopeId: "card-stands-envelope",
        sourceEventId: "card-stands",
        targetFamilyId: "card-under-review",
        team: null,
      }),
    );

    expect(goal.moment).toMatchObject({ celebratesGoal: false, kind: "goal" });
    expect(goalStands.moment).toMatchObject({
      celebratesGoal: true,
      eventTeam: "ARG",
      kind: "var.stands",
      status: "confirmed",
    });
    expect(cardStands.moment).toMatchObject({
      celebratesGoal: false,
      kind: "var.stands",
    });
  });

  it("changes halves only on explicit phase events and keeps teamless events honest", () => {
    let projection = createFixtureProjection({
      awayTeam: "FRA",
      fixtureId: "fixture-1",
      homeTeam: "ARG",
      kickoffAt: "2026-07-16T18:00:00.000Z",
      observedAt: "2026-07-16T17:59:00.000Z",
      provenance: "live_txline",
    });
    projection = reduce(
      projection,
      canonicalFact({
        familyId: "kickoff",
        kind: "phase.kickoff",
        sourceEnvelopeId: "kickoff",
        sourceEventId: "kickoff",
        team: null,
      }),
    ).projection;
    projection = reduce(
      projection,
      canonicalFact({
        familyId: "half-time",
        kind: "phase.half_time",
        occurredAt: null,
        sourceEnvelopeId: "half-time",
        sourceEventId: "half-time",
        team: null,
      }),
    ).projection;
    for (const fact of [
      canonicalFact({
        familyId: "review-at-break",
        kind: "var.started",
        sourceEnvelopeId: "review-at-break",
        sourceEventId: "review-at-break",
        status: "under_review",
        targetFamilyId: "missing-family",
        team: null,
      }),
      canonicalFact({
        familyId: "correction-at-break",
        kind: "correction",
        sourceEnvelopeId: "correction-at-break",
        sourceEventId: "correction-at-break",
        targetFamilyId: "missing-family",
        team: null,
      }),
    ]) {
      projection = reduce(projection, fact).projection;
      expect(projection.phase).toBe("half_time");
    }
    const secondHalf = reduce(
      projection,
      canonicalFact({
        familyId: "second-half",
        kind: "phase.second_half_start",
        sourceEnvelopeId: "second-half",
        sourceEventId: "second-half",
        team: null,
      }),
    );

    expect(secondHalf.projection.phase).toBe("second_half");
    expect(secondHalf.moment).toMatchObject({
      eventTeam: null,
      familyId: "second-half",
      occurredAt: "2026-07-16T12:00:00.000Z",
      team: null,
    });
  });

  it("reapplies a delayed extra-time correction to the original score segment", () => {
    let projection = createFixtureProjection({
      awayTeam: "FRA",
      fixtureId: "fixture-1",
      homeTeam: "ARG",
      kickoffAt: "2026-07-16T18:00:00.000Z",
      observedAt: "2026-07-16T17:59:00.000Z",
      provenance: "live_txline",
    });
    for (const fact of [
      canonicalFact({
        familyId: "kickoff",
        kind: "phase.kickoff",
        sourceEnvelopeId: "kickoff",
        sourceEventId: "kickoff",
        team: null,
      }),
      canonicalFact({
        familyId: "half-time",
        kind: "phase.half_time",
        sourceEnvelopeId: "half-time",
        sourceEventId: "half-time",
        team: null,
      }),
      canonicalFact({
        familyId: "second-half",
        kind: "phase.second_half_start",
        sourceEnvelopeId: "second-half",
        sourceEventId: "second-half",
        team: null,
      }),
      canonicalFact({
        familyId: "regulation-end",
        kind: "phase.regulation_end",
        sourceEnvelopeId: "regulation-end",
        sourceEventId: "regulation-end",
        team: null,
      }),
      canonicalFact({
        familyId: "extra-time-start",
        kind: "phase.extra_time_start",
        sourceEnvelopeId: "extra-time-start",
        sourceEventId: "extra-time-start",
        team: null,
      }),
      canonicalFact({
        familyId: "extra-time-goal",
        sourceEnvelopeId: "extra-time-goal",
        sourceEventId: "extra-time-goal",
      }),
      canonicalFact({
        familyId: "extra-time-half",
        kind: "phase.extra_time_half",
        sourceEnvelopeId: "extra-time-half",
        sourceEventId: "extra-time-half",
        team: null,
      }),
      canonicalFact({
        familyId: "extra-time-second-half",
        kind: "phase.extra_time_second_half_start",
        sourceEnvelopeId: "extra-time-second-half",
        sourceEventId: "extra-time-second-half",
        team: null,
      }),
      canonicalFact({
        familyId: "shootout-start",
        kind: "phase.shootout_start",
        sourceEnvelopeId: "shootout-start",
        sourceEventId: "shootout-start",
        team: null,
      }),
    ]) {
      projection = reduce(projection, fact).projection;
    }

    const corrected = reduce(
      projection,
      canonicalFact({
        familyId: "extra-time-goal",
        kind: "correction",
        replacement: { kind: "goal", team: "FRA" },
        sourceEnvelopeId: "extra-time-goal-corrected",
        sourceEventId: "extra-time-goal-corrected",
        targetFamilyId: "extra-time-goal",
        team: null,
      }),
    );

    expect(corrected.projection.phase).toBe("shootout");
    expect(corrected.projection.score).toEqual({ away: 1, home: 0 });
    expect(corrected.projection.scores).toEqual({
      extraTime: { away: 1, home: 0 },
      regulation: { away: 0, home: 0 },
      shootout: { away: 0, home: 0 },
    });
    expect(corrected.projection.eventEffects["extra-time-goal"]).toMatchObject({
      occurredPhase: "extra_time_first_half",
      scoreSegment: "extraTime",
    });
  });

  it("enforces legal phase transitions while accepting deliberate repeats", () => {
    const cold = createFixtureProjection({
      awayTeam: "FRA",
      fixtureId: "fixture-1",
      homeTeam: "ARG",
      kickoffAt: "2026-07-16T18:00:00.000Z",
      observedAt: "2026-07-16T17:59:00.000Z",
      provenance: "live_txline",
    });
    expect(() =>
      reduce(
        cold,
        canonicalFact({
          familyId: "illegal-second-half",
          kind: "phase.second_half_start",
          sourceEnvelopeId: "illegal-second-half",
          sourceEventId: "illegal-second-half",
          team: null,
        }),
      ),
    ).toThrow(/illegal phase transition/i);

    const kickoff = reduce(
      cold,
      canonicalFact({
        familyId: "kickoff",
        kind: "phase.kickoff",
        sourceEnvelopeId: "kickoff",
        sourceEventId: "kickoff",
        team: null,
      }),
    );
    const repeatKickoff = reduce(
      kickoff.projection,
      canonicalFact({
        familyId: "kickoff-repeat",
        kind: "phase.kickoff",
        sourceEnvelopeId: "kickoff-repeat",
        sourceEventId: "kickoff-repeat",
        team: null,
      }),
    );
    expect(repeatKickoff.projection.phase).toBe("first_half");

    let projection = repeatKickoff.projection;
    for (const fact of [
      canonicalFact({
        familyId: "half-time",
        kind: "phase.half_time",
        sourceEnvelopeId: "legal-half-time",
        sourceEventId: "legal-half-time",
        team: null,
      }),
      canonicalFact({
        familyId: "second-half",
        kind: "phase.second_half_start",
        sourceEnvelopeId: "legal-second-half",
        sourceEventId: "legal-second-half",
        team: null,
      }),
      canonicalFact({
        familyId: "regulation-end",
        kind: "phase.regulation_end",
        sourceEnvelopeId: "legal-regulation-end",
        sourceEventId: "legal-regulation-end",
        team: null,
      }),
      canonicalFact({
        familyId: "full-time",
        kind: "phase.full_time",
        sourceEnvelopeId: "legal-full-time",
        sourceEventId: "legal-full-time",
        team: null,
      }),
    ]) {
      projection = reduce(projection, fact).projection;
    }
    expect(() =>
      reduce(
        projection,
        canonicalFact({
          familyId: "illegal-restart",
          kind: "phase.kickoff",
          sourceEnvelopeId: "illegal-restart",
          sourceEventId: "illegal-restart",
          team: null,
        }),
      ),
    ).toThrow(/illegal phase transition/i);
  });

  it("returns a deeply isolated immutable fixture snapshot", () => {
    const projection = reduce(
      createFixtureProjection({
        awayTeam: "FRA",
        fixtureId: "fixture-1",
        homeTeam: "ARG",
        kickoffAt: "2026-07-16T18:00:00.000Z",
        observedAt: "2026-07-16T17:59:00.000Z",
        provenance: "live_txline",
      }),
      canonicalFact({
        familyId: "goal-with-player",
        player: { displayName: "Lionel Messi", id: "player-10" },
      }),
    ).projection;
    const snapshot = toFixtureSnapshot(projection);

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.score)).toBe(true);
    expect(Object.isFrozen(snapshot.scores?.regulation)).toBe(true);
    expect(Object.isFrozen(snapshot.stats?.home)).toBe(true);
    expect(Object.isFrozen(snapshot.lastEvent)).toBe(true);
    expect(Object.isFrozen(snapshot.lastEvent?.player)).toBe(true);
    expect(() => {
      snapshot.score.home = 99;
    }).toThrow(TypeError);
    expect(() => {
      if (snapshot.lastEvent?.player) {
        snapshot.lastEvent.player.displayName = "Changed";
      }
    }).toThrow(TypeError);
    expect(projection.score.home).toBe(1);
    expect(projection.lastEvent?.player?.displayName).toBe("Lionel Messi");
  });
});
