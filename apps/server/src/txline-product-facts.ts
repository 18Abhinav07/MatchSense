import type {
  CanonicalEventFact,
  FixtureSnapshot,
  FixtureStats,
  MatchScores,
  TeamCode,
} from "@matchsense/contracts";
import type { TxlineCanonicalEvent } from "@matchsense/txline-adapter";

export interface TxlineProductFixture {
  awayTeam: TeamCode;
  fixtureId: string;
  homeTeam: TeamCode;
  participant1IsHome?: boolean | undefined;
}

function sourceEventId(event: TxlineCanonicalEvent) {
  return event.actionId ?? event.source.actionId ?? event.source.payloadHash;
}

function sourceEnvelopeId(event: TxlineCanonicalEvent, suffix?: string) {
  return [
    "txline",
    event.fixtureId,
    event.source.observedSeq ?? event.revision,
    event.source.payloadHash,
    ...(suffix ? [suffix] : []),
  ].join(":");
}

function occurredAt(event: TxlineCanonicalEvent) {
  return event.source.sourceTimestampMs === null
    ? null
    : new Date(event.source.sourceTimestampMs).toISOString();
}

function minuteFor(event: TxlineCanonicalEvent, fallback = "—") {
  return event.clockSeconds === null
    ? fallback
    : `${Math.floor(event.clockSeconds / 60)}'`;
}

function participantTeam(
  participant: 1 | 2 | null,
  fixture: TxlineProductFixture,
) {
  if (participant === null) return null;
  const participant1IsHome = fixture.participant1IsHome ?? true;
  if (participant === 1) {
    return participant1IsHome ? fixture.homeTeam : fixture.awayTeam;
  }
  return participant1IsHome ? fixture.awayTeam : fixture.homeTeam;
}

function scoresFor(
  event: TxlineCanonicalEvent,
  current: FixtureSnapshot,
): MatchScores {
  const currentScores = current.scores ?? {
    extraTime: { away: 0, home: 0 },
    regulation: current.score,
    shootout: { away: 0, home: 0 },
  };
  const score = event.score ?? current.score;
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
  event: TxlineCanonicalEvent,
  fixture: TxlineProductFixture,
): FixtureStats | undefined {
  if (!event.participantStats) return undefined;
  const teamStats = (value: typeof event.participantStats.participant1) => ({
    corners: value.corners,
    penaltiesAwarded: 0,
    penaltiesMissed: 0,
    penaltiesScored: 0,
    redCards: value.redCards,
    yellowCards: value.yellowCards,
  });
  return (fixture.participant1IsHome ?? true)
    ? {
        away: teamStats(event.participantStats.participant2),
        home: teamStats(event.participantStats.participant1),
      }
    : {
        away: teamStats(event.participantStats.participant1),
        home: teamStats(event.participantStats.participant2),
      };
}

function common(event: TxlineCanonicalEvent) {
  return {
    fixtureId: event.fixtureId,
    occurredAt: occurredAt(event),
    player:
      event.playerId === null
        ? null
        : { displayName: null, id: event.playerId },
    provenance: "live_txline" as const,
    receivedAt: event.receivedAt,
    sourceEventId: sourceEventId(event),
    type: "canonical_event" as const,
  };
}

export function productFactsFromTxlineEvent(
  event: TxlineCanonicalEvent,
  fixture: TxlineProductFixture,
  current: FixtureSnapshot,
): CanonicalEventFact[] {
  if (
    event.provenance !== "live_txline" ||
    event.fixtureId !== fixture.fixtureId
  ) {
    return [];
  }
  const facts: CanonicalEventFact[] = [];
  if (current.phase === "scheduled" && event.action !== "game_finalised") {
    facts.push({
      ...common(event),
      familyId: `txline:${event.fixtureId}:phase:kickoff`,
      kind: "phase.kickoff",
      minute: "0'",
      player: null,
      sourceEnvelopeId: `txline:${event.fixtureId}:implicit-kickoff`,
      sourceEventId: `txline:${event.fixtureId}:implicit-kickoff`,
      status: "confirmed",
      team: null,
    });
  }

  const familyId = `txline:${event.fixtureId}:action:${sourceEventId(event)}`;
  const minute = minuteFor(event);
  const aggregate = {
    scores: scoresFor(event, current),
    ...(statsFor(event, fixture) ? { stats: statsFor(event, fixture)! } : {}),
  };
  if (event.action === "game_finalised") {
    facts.push({
      ...common(event),
      ...aggregate,
      familyId,
      kind: "phase.full_time",
      minute: "FT",
      player: null,
      sourceEnvelopeId: sourceEnvelopeId(event),
      status: "confirmed",
      team: null,
    });
  } else if (event.action === "halftime_finalised") {
    facts.push({
      ...common(event),
      ...aggregate,
      familyId,
      kind: "phase.half_time",
      minute: "HT",
      player: null,
      sourceEnvelopeId: sourceEnvelopeId(event),
      status: "confirmed",
      team: null,
    });
  } else if (event.action === "var") {
    facts.push({
      ...common(event),
      familyId,
      kind: "var.started",
      minute,
      player: null,
      sourceEnvelopeId: sourceEnvelopeId(event),
      status: "under_review",
      team: null,
    });
  } else if (event.action === "var_end" && event.varOutcome) {
    facts.push({
      ...common(event),
      ...aggregate,
      familyId,
      kind: event.varOutcome === "overturned" ? "var.overturned" : "var.stands",
      minute,
      player: null,
      sourceEnvelopeId: sourceEnvelopeId(event),
      status: "confirmed",
      team: null,
    });
  } else if (
    event.action === "goal" &&
    event.confirmed === true &&
    event.score !== null
  ) {
    const participant1IsHome = fixture.participant1IsHome ?? true;
    const team =
      event.participant === 1
        ? participant1IsHome
          ? fixture.homeTeam
          : fixture.awayTeam
        : event.participant === 2
          ? participant1IsHome
            ? fixture.awayTeam
            : fixture.homeTeam
          : event.score.home > current.score.home
            ? fixture.homeTeam
            : fixture.awayTeam;
    facts.push({
      ...common(event),
      ...aggregate,
      familyId,
      kind: "goal",
      minute,
      sourceEnvelopeId: sourceEnvelopeId(event),
      status: "confirmed",
      team,
    });
  } else if (event.action === "penalty" && event.confirmed !== false) {
    const team = participantTeam(event.participant, fixture);
    if (team) {
      facts.push({
        ...common(event),
        familyId,
        kind: "penalty.awarded",
        minute,
        sourceEnvelopeId: sourceEnvelopeId(event),
        status: "confirmed",
        team,
      });
    }
  } else if (
    (event.action === "score_adjustment" ||
      event.action === "action_amend" ||
      event.action === "action_discarded") &&
    (event.score !== null || event.participantStats !== null)
  ) {
    facts.push({
      ...common(event),
      ...aggregate,
      familyId,
      kind: "correction",
      minute,
      player: null,
      sourceEnvelopeId: sourceEnvelopeId(event),
      status: "confirmed",
      team: participantTeam(event.participant, fixture),
    });
  }

  const nextStats = statsFor(event, fixture);
  if (
    nextStats &&
    event.action !== "game_finalised" &&
    event.action !== "halftime_finalised"
  ) {
    const previousStats = current.stats;
    const counters = [
      ["corners", "corner"],
      ["yellowCards", "card.yellow"],
      ["redCards", "card.red"],
    ] as const;
    for (const side of ["home", "away"] as const) {
      const team = side === "home" ? fixture.homeTeam : fixture.awayTeam;
      for (const [counter, kind] of counters) {
        const previous = previousStats?.[side][counter] ?? 0;
        const next = nextStats[side][counter];
        for (let count = previous + 1; count <= next; count += 1) {
          const suffix = `stat:${side}:${counter}:${count}`;
          facts.push({
            ...common(event),
            ...aggregate,
            familyId: `txline:${event.fixtureId}:${suffix}`,
            kind,
            minute,
            player: null,
            sourceEnvelopeId: sourceEnvelopeId(event, suffix),
            sourceEventId: `${sourceEventId(event)}:${suffix}`,
            status: "confirmed",
            team,
          });
        }
      }
    }
  }
  return facts;
}
