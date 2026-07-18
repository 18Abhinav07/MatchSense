import { createHash } from "node:crypto";

import type { FixtureTruthRepository, SourceFence } from "@matchsense/db";
import type { TxlineScheduleFixture } from "@matchsense/txline-adapter";

export interface ScheduleSyncResult {
  observed: number;
  updated: number;
}

export interface CreateScheduleSyncOptions {
  repository: Pick<FixtureTruthRepository, "observeFixtureSchedule">;
  rightsGrantId: string;
  sourceFence: SourceFence;
}

export interface ScheduleSync {
  sync(fixtures: readonly TxlineScheduleFixture[]): Promise<ScheduleSyncResult>;
}

const COUNTRY_CODES = new Map<string, string>([
  ["argentina", "ARG"],
  ["australia", "AUS"],
  ["brazil", "BRA"],
  ["canada", "CAN"],
  ["england", "ENG"],
  ["france", "FRA"],
  ["germany", "GER"],
  ["japan", "JPN"],
  ["mexico", "MEX"],
  ["morocco", "MAR"],
  ["netherlands", "NED"],
  ["portugal", "POR"],
  ["spain", "ESP"],
  ["united states", "USA"],
  ["uruguay", "URU"],
]);

function stableJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : "null";
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(",")}}`;
  }
  return "null";
}

function digest(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function teamCode(name: string) {
  const known = COUNTRY_CODES.get(name.trim().toLowerCase());
  if (known) return known;
  const compact = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .match(/[A-Z0-9]+/g)
    ?.join("")
    .slice(0, 3);
  return compact && compact.length === 3 ? compact : "UNK";
}

export function durableFixtureFromSchedule(fixture: TxlineScheduleFixture) {
  const participant1Code = teamCode(fixture.participant1.name);
  const participant2Code = teamCode(fixture.participant2.name);
  const homeTeam = fixture.participant1IsHome
    ? participant1Code
    : participant2Code;
  const awayTeam = fixture.participant1IsHome
    ? participant2Code
    : participant1Code;
  return {
    awayTeam,
    fixtureId: fixture.fixtureId,
    homeTeam,
    kickoffAt: new Date(fixture.startTimeMs).toISOString(),
    participant1IsHome: fixture.participant1IsHome,
  };
}

function fixtureUpsert(fixture: TxlineScheduleFixture) {
  const product = durableFixtureFromSchedule(fixture);
  return {
    awayTeamId: product.awayTeam,
    homeTeamId: product.homeTeam,
    id: fixture.fixtureId,
    metadata: {
      competition: fixture.competition,
      competitionId: fixture.competitionId,
      fixtureGroupId: fixture.fixtureGroupId,
      participant1: fixture.participant1,
      participant1IsHome: fixture.participant1IsHome,
      participant2: fixture.participant2,
      source: "txline_world_cup_schedule",
      sourceTimestampMs: fixture.sourceTimestampMs,
    },
    mode: "live" as const,
    provenance: "live_txline" as const,
    scheduledAt: product.kickoffAt,
    status: "scheduled",
  };
}

function scheduleObservation(
  fixture: TxlineScheduleFixture,
  input: Pick<CreateScheduleSyncOptions, "rightsGrantId" | "sourceFence">,
) {
  const payloadHash = digest(fixture);
  const observedAt = new Date(fixture.sourceTimestampMs).toISOString();
  return {
    payload: fixture,
    responseHash: payloadHash,
    rightsGrantId: input.rightsGrantId,
    source: input.sourceFence.source,
    sourcePath: "/api/fixtures/snapshot?competitionId=72",
    observedAt,
  };
}

/**
 * Writes each observed schedule fact outside the match-event archive. The
 * repository locks the fixture and only revises participants/kickoff before
 * tracking/live/final truth exists.
 */
export function createScheduleSync(
  options: CreateScheduleSyncOptions,
): ScheduleSync {
  return {
    async sync(fixtures) {
      let observed = 0;
      let updated = 0;
      const ordered = [...fixtures].sort(
        (left, right) =>
          left.sourceTimestampMs - right.sourceTimestampMs ||
          left.fixtureId.localeCompare(right.fixtureId),
      );
      for (const fixture of ordered) {
        const result = await options.repository.observeFixtureSchedule({
          fixture: fixtureUpsert(fixture),
          observation: scheduleObservation(fixture, options),
          sourceFence: options.sourceFence,
        });
        if (result.kind === "fenced") {
          throw new Error("Schedule collector lost its source lease");
        }
        observed += 1;
        if (result.metadataUpdated) updated += 1;
      }
      return { observed, updated };
    },
  };
}
