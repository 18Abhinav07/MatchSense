import type {
  FixtureProjectionRecord,
  FixtureTruthRepository,
  PersistenceMode,
  ProcessSourceEnvelopeResult,
  RawSourceRecordWrite,
  SourceDeliveryIntent,
  SourceFence,
} from "@matchsense/db";
import type {
  CanonicalEventEffect,
  CanonicalEventKind,
  CanonicalMoment,
  FixtureProjection,
  FixtureStats,
  FixtureStreamEvent,
  MatchDecision,
  MatchPhase,
  MatchScores,
  Score,
  SourceFact,
  TeamCode,
} from "@matchsense/contracts";
import {
  createFixtureProjection,
  reduceSourceFact,
  toFixtureSnapshot,
} from "@matchsense/event-engine";

export interface FixtureProcessorFixture {
  awayTeam: TeamCode;
  fixtureId: string;
  homeTeam: TeamCode;
  kickoffAt: string;
}

export interface FixtureProcessorInput {
  deliveryIntent: SourceDeliveryIntent;
  fact: SourceFact;
  fixture: FixtureProcessorFixture;
  mode: PersistenceMode;
  raw: Omit<
    RawSourceRecordWrite,
    "deliveryIntent" | "occurredAt" | "provenance"
  >;
  sourceFence?: SourceFence;
}

export interface FixtureProcessor {
  process(input: FixtureProcessorInput): Promise<FixtureProcessorResult>;
}

export type FixtureProcessorResult =
  | Exclude<ProcessSourceEnvelopeResult, { kind: "committed" }>
  | (Extract<ProcessSourceEnvelopeResult, { kind: "committed" }> & {
      /** The exact canonical event written in the same database transaction. */
      event?: FixtureStreamEvent;
    });

export interface CreateFixtureProcessorOptions {
  repository: Pick<FixtureTruthRepository, "processSourceEnvelope">;
}

const eventKinds = new Set<CanonicalEventKind>([
  "phase.kickoff",
  "goal",
  "card.yellow",
  "card.red",
  "corner",
  "penalty.awarded",
  "penalty.scored",
  "penalty.missed",
  "var.started",
  "var.stands",
  "var.overturned",
  "phase.half_time",
  "phase.second_half_start",
  "phase.regulation_end",
  "phase.extra_time_start",
  "phase.extra_time_half",
  "phase.extra_time_second_half_start",
  "phase.shootout_start",
  "shootout.kick_scored",
  "shootout.kick_missed",
  "phase.full_time",
  "correction",
]);
const phases = new Set<MatchPhase>([
  "scheduled",
  "first_half",
  "half_time",
  "second_half",
  "regulation_end",
  "extra_time_first_half",
  "extra_time_half",
  "extra_time_second_half",
  "shootout",
  "full_time",
]);
const decisions = new Set<MatchDecision>([
  "regulation",
  "extra_time",
  "shootout",
]);

function objectValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function normalizedScore(value: unknown, fallback: Score): Score {
  const record = objectValue(value);
  const home = nonNegativeInteger(record?.home);
  const away = nonNegativeInteger(record?.away);
  return home === null || away === null ? { ...fallback } : { away, home };
}

function normalizedScores(value: unknown, regulation: Score): MatchScores {
  const record = objectValue(value);
  const zero = { away: 0, home: 0 };
  return {
    extraTime: normalizedScore(record?.extraTime, zero),
    regulation: normalizedScore(record?.regulation, regulation),
    shootout: normalizedScore(record?.shootout, zero),
  };
}

function normalizedTeamStats(value: unknown) {
  const record = objectValue(value);
  const number = (field: string) => nonNegativeInteger(record?.[field]) ?? 0;
  return {
    corners: number("corners"),
    penaltiesAwarded: number("penaltiesAwarded"),
    penaltiesMissed: number("penaltiesMissed"),
    penaltiesScored: number("penaltiesScored"),
    redCards: number("redCards"),
    yellowCards: number("yellowCards"),
  };
}

function normalizedStats(value: unknown): FixtureStats {
  const record = objectValue(value);
  return {
    away: normalizedTeamStats(record?.away),
    home: normalizedTeamStats(record?.home),
  };
}

function normalizedPlayer(value: unknown) {
  if (value === null) return null;
  const record = objectValue(value);
  if (
    !record ||
    typeof record.id !== "string" ||
    (record.displayName !== null && typeof record.displayName !== "string")
  ) {
    return null;
  }
  return { displayName: record.displayName, id: record.id };
}

function normalizedEventEffects(value: unknown, fallbackPhase: MatchPhase) {
  const record = objectValue(value);
  const effects: Record<string, CanonicalEventEffect> = {};
  if (!record) return effects;
  for (const [familyId, candidate] of Object.entries(record)) {
    const effect = objectValue(candidate);
    if (
      !effect ||
      typeof effect.active !== "boolean" ||
      typeof effect.pending !== "boolean" ||
      typeof effect.kind !== "string" ||
      !eventKinds.has(effect.kind as CanonicalEventKind) ||
      (effect.team !== null && typeof effect.team !== "string")
    ) {
      continue;
    }
    const occurredPhase =
      typeof effect.occurredPhase === "string" &&
      phases.has(effect.occurredPhase as MatchPhase)
        ? (effect.occurredPhase as MatchPhase)
        : fallbackPhase;
    const scoreSegment =
      effect.scoreSegment === "regulation" ||
      effect.scoreSegment === "extraTime" ||
      effect.scoreSegment === "shootout"
        ? effect.scoreSegment
        : effect.scoreSegment === null
          ? null
          : effect.kind === "shootout.kick_scored"
            ? "shootout"
            : effect.kind === "goal" || effect.kind === "penalty.scored"
              ? occurredPhase === "extra_time_first_half" ||
                occurredPhase === "extra_time_half" ||
                occurredPhase === "extra_time_second_half"
                ? "extraTime"
                : "regulation"
              : null;
    effects[familyId] = {
      active: effect.active,
      kind: effect.kind as CanonicalEventKind,
      occurredPhase,
      pending: effect.pending,
      player: normalizedPlayer(effect.player),
      scoreSegment,
      scores: normalizedScores(effect.scores, { away: 0, home: 0 }),
      stats: normalizedStats(effect.stats),
      team: effect.team,
    };
  }
  return effects;
}

function normalizedMoment(value: unknown): CanonicalMoment | null {
  if (value === null) return null;
  const moment = objectValue(value);
  if (
    !moment ||
    typeof moment.familyId !== "string" ||
    typeof moment.id !== "string" ||
    typeof moment.identity !== "string" ||
    typeof moment.fixtureId !== "string" ||
    typeof moment.kind !== "string" ||
    !eventKinds.has(moment.kind as CanonicalEventKind) ||
    typeof moment.minute !== "string" ||
    typeof moment.sourceEnvelopeId !== "string" ||
    typeof moment.provenance !== "string" ||
    (moment.provenance !== "live_txline" &&
      moment.provenance !== "synthetic_txline_shaped") ||
    (moment.eventTeam !== null && typeof moment.eventTeam !== "string") ||
    (moment.occurredAt !== null && typeof moment.occurredAt !== "string") ||
    nonNegativeInteger(moment.revision) === null
  ) {
    return null;
  }
  const status = moment.status;
  if (
    status !== "provisional" &&
    status !== "confirmed" &&
    status !== "under_review" &&
    status !== "overturned" &&
    status !== "corrected"
  ) {
    return null;
  }
  const score = normalizedScore(moment.score, { away: 0, home: 0 });
  return {
    celebratesGoal: moment.celebratesGoal === true,
    eventTeam: moment.eventTeam,
    familyId: moment.familyId,
    fixtureId: moment.fixtureId,
    id: moment.id,
    identity: moment.identity,
    kind: moment.kind as CanonicalEventKind,
    minute: moment.minute,
    occurredAt: moment.occurredAt,
    player: normalizedPlayer(moment.player),
    provenance: moment.provenance,
    ...(typeof moment.receivedAt === "string"
      ? { receivedAt: moment.receivedAt }
      : {}),
    revision: nonNegativeInteger(moment.revision)!,
    score,
    scores: normalizedScores(moment.scores, score),
    sourceEnvelopeId: moment.sourceEnvelopeId,
    ...(typeof moment.sourceEventId === "string"
      ? { sourceEventId: moment.sourceEventId }
      : {}),
    stats: normalizedStats(moment.stats),
    status,
    team:
      moment.team === null || typeof moment.team === "string"
        ? moment.team
        : moment.eventTeam,
    targetFamilyId:
      moment.targetFamilyId === null ||
      typeof moment.targetFamilyId === "string"
        ? moment.targetFamilyId
        : null,
  };
}

function storedProjection(
  record: FixtureProjectionRecord,
  fixture: FixtureProcessorFixture,
  provenance: SourceFact["provenance"],
): FixtureProjection {
  const value = objectValue(record.payload);
  if (!value) throw new Error("Stored fixture projection is invalid");
  const base = createFixtureProjection({
    awayTeam: fixture.awayTeam,
    fixtureId: fixture.fixtureId,
    homeTeam: fixture.homeTeam,
    kickoffAt: fixture.kickoffAt,
    observedAt: record.updatedAt,
    provenance,
  });
  const score = normalizedScore(value.score, base.score);
  const phase =
    typeof value.phase === "string" && phases.has(value.phase as MatchPhase)
      ? (value.phase as MatchPhase)
      : base.phase;
  const decidedBy =
    typeof value.decidedBy === "string" &&
    decisions.has(value.decidedBy as MatchDecision)
      ? (value.decidedBy as MatchDecision)
      : null;
  return {
    ...base,
    appliedSourceEnvelopeIds: Array.isArray(value.appliedSourceEnvelopeIds)
      ? value.appliedSourceEnvelopeIds.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [],
    decidedBy,
    eventEffects: normalizedEventEffects(value.eventEffects, phase),
    lastEvent: normalizedMoment(value.lastEvent),
    minute: typeof value.minute === "string" ? value.minute : base.minute,
    phase,
    revision: record.revision,
    score,
    scores: normalizedScores(value.scores, score),
    stats: normalizedStats(value.stats),
    updatedAt:
      typeof value.updatedAt === "string" ? value.updatedAt : record.updatedAt,
  };
}

export function restoreFixtureProjection(input: {
  fixture: FixtureProcessorFixture;
  provenance: SourceFact["provenance"];
  record: FixtureProjectionRecord;
}) {
  return storedProjection(input.record, input.fixture, input.provenance);
}

function eventAlreadyExists(projection: FixtureProjection, fact: SourceFact) {
  if (fact.type !== "canonical_event") return false;
  const familyId = fact.targetFamilyId ?? fact.familyId;
  return projection.eventEffects[familyId] !== undefined;
}

function outboxId(
  mode: PersistenceMode,
  fixtureId: string,
  revision: number,
  topic: string,
) {
  return `outbox:${mode}:${fixtureId}:${revision}:${topic}`;
}

export function createFixtureProcessor(
  options: CreateFixtureProcessorOptions,
): FixtureProcessor {
  return {
    process: async (input) => {
      if (input.fact.fixtureId !== input.fixture.fixtureId) {
        throw new Error(
          "Source fact fixture does not match fixture definition",
        );
      }
      const occurredAt =
        input.fact.type === "canonical_event"
          ? input.fact.occurredAt
          : input.fact.receivedAt;
      let committedEvent: FixtureStreamEvent | undefined;
      const persisted = await options.repository.processSourceEnvelope({
        derive: (currentRecord) => {
          const current = currentRecord
            ? storedProjection(
                currentRecord,
                input.fixture,
                input.fact.provenance,
              )
            : createFixtureProjection({
                awayTeam: input.fixture.awayTeam,
                fixtureId: input.fixture.fixtureId,
                homeTeam: input.fixture.homeTeam,
                kickoffAt: input.fixture.kickoffAt,
                observedAt: input.fact.receivedAt,
                provenance: input.fact.provenance,
              });
          const existed = eventAlreadyExists(current, input.fact);
          const reduced = reduceSourceFact(current, input.fact);
          if (!reduced.changed) return null;

          const snapshot = toFixtureSnapshot(reduced.projection);
          const revision = reduced.projection.revision;
          const eventName: FixtureStreamEvent["event"] = reduced.moment
            ? existed
              ? "moment.revised"
              : "moment.created"
            : "snapshot";
          const event: FixtureStreamEvent = {
            event: eventName,
            id: `${input.fixture.fixtureId}:revision:${revision}`,
            ...(reduced.moment ? { moment: reduced.moment } : {}),
            snapshot,
          };
          committedEvent = event;
          const celebratesGoal = reduced.moment?.celebratesGoal === true;
          const alertsFan = Boolean(
            reduced.moment &&
            reduced.moment.status === "confirmed" &&
            (celebratesGoal ||
              reduced.moment.kind === "card.red" ||
              reduced.moment.kind === "phase.full_time"),
          );
          const payload = {
            celebratesGoal,
            deliveryIntent: input.deliveryIntent,
            event,
            fact: input.fact,
            fixtureId: input.fixture.fixtureId,
            mode: input.mode,
            moment: reduced.moment,
            revision,
            snapshot,
          };
          const topics =
            input.deliveryIntent === "reconcile"
              ? ["fixture.reconcile", "room.reconcile", "memory.reconcile"]
              : [
                  "fixture.broadcast",
                  ...(alertsFan
                    ? ["push.candidate", "commentary.prepare"]
                    : []),
                  "room.project",
                  "memory.project",
                ];

          return {
            event: {
              id: event.id,
              payload: event,
              type: event.event,
            },
            ...(reduced.moment
              ? {
                  moment: {
                    id: reduced.moment.familyId,
                    kind: reduced.moment.kind,
                    payload: reduced.moment,
                    revision: reduced.moment.revision,
                  },
                }
              : {}),
            outbox: topics.map((topic) => ({
              id: outboxId(
                input.mode,
                input.fixture.fixtureId,
                revision,
                topic,
              ),
              idempotencyKey: `${input.fixture.fixtureId}:${revision}:${topic}`,
              payload,
              topic,
            })),
            projection: {
              payload: reduced.projection,
              revision,
            },
          };
        },
        fixtureId: input.fixture.fixtureId,
        mode: input.mode,
        raw: {
          ...input.raw,
          deliveryIntent: input.deliveryIntent,
          occurredAt,
          payload: input.mode === "live" ? null : input.raw.payload,
          provenance: input.fact.provenance,
        },
        ...(input.sourceFence ? { sourceFence: input.sourceFence } : {}),
      });
      if (persisted.kind !== "committed") return persisted;
      if (
        !committedEvent ||
        committedEvent.snapshot.revision !== persisted.revision
      ) {
        throw new Error(
          "Committed fixture event does not match persistence result",
        );
      }
      return { ...persisted, event: committedEvent };
    },
  };
}
