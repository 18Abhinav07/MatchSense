import { createHash } from "node:crypto";

import {
  hashArchiveImportSourceContext,
  type ArchiveImportSourceContext,
  type FixtureTruthRepository,
  type SourceFence,
} from "@matchsense/db";
import type {
  DurableTxlineFixture,
  TxlineScheduleFixture,
} from "@matchsense/txline-adapter";
import { buildTxlineFixtureSnapshotPath } from "@matchsense/txline-adapter";

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

/**
 * A team identity is durable catalogue data, independent from whether one of
 * its historical fixtures is eligible to enter the live fixture lifecycle.
 */
export interface DurableTeamCatalogEntry {
  code: string;
  name: string;
  participantId: string;
  sourceTimestampMs: number;
}

export interface ArchiveImportScheduleContext {
  contextHash: string;
  sourceContext: ArchiveImportSourceContext;
}

/**
 * The live collector carries the exact schedule evidence that created its
 * durable fixture, so a terminal can freeze it without inspecting a score
 * payload or inventing provider participant identities later.
 */
export interface DurableCollectorFixture extends DurableTxlineFixture {
  archiveImport: ArchiveImportScheduleContext;
}

const COUNTRY_CODES = new Map<string, string>(
  Object.entries({
    Algeria: "ALG",
    Argentina: "ARG",
    Australia: "AUS",
    Austria: "AUT",
    Belgium: "BEL",
    Bolivia: "BOL",
    "Bosnia & Herzegovina": "BIH",
    Brazil: "BRA",
    Cameroon: "CMR",
    Canada: "CAN",
    "Cape Verde": "CPV",
    Chile: "CHI",
    Colombia: "COL",
    "Congo DR": "COD",
    "Costa Rica": "CRC",
    "Cote d'Ivoire": "CIV",
    "Côte d'Ivoire": "CIV",
    Croatia: "CRO",
    Curacao: "CUW",
    Curaçao: "CUW",
    "DR Congo": "COD",
    Denmark: "DEN",
    "Democratic Republic of the Congo": "COD",
    Ecuador: "ECU",
    Egypt: "EGY",
    England: "ENG",
    Finland: "FIN",
    France: "FRA",
    Germany: "GER",
    Ghana: "GHA",
    Haiti: "HAI",
    Iceland: "ISL",
    Iran: "IRN",
    Iraq: "IRQ",
    "Ivory Coast": "CIV",
    Jamaica: "JAM",
    Japan: "JPN",
    Jordan: "JOR",
    "Korea Republic": "KOR",
    Mexico: "MEX",
    Morocco: "MAR",
    Netherlands: "NED",
    "New Zealand": "NZL",
    Nigeria: "NGA",
    Norway: "NOR",
    Panama: "PAN",
    Paraguay: "PAR",
    Poland: "POL",
    Portugal: "POR",
    Qatar: "QAT",
    "Saudi Arabia": "KSA",
    Scotland: "SCO",
    Senegal: "SEN",
    Serbia: "SRB",
    "South Africa": "RSA",
    "South Korea": "KOR",
    Spain: "ESP",
    Sweden: "SWE",
    Switzerland: "SUI",
    Tunisia: "TUN",
    Turkey: "TUR",
    Türkiye: "TUR",
    USA: "USA",
    Ukraine: "UKR",
    "United States": "USA",
    Uruguay: "URU",
    Uzbekistan: "UZB",
    Wales: "WAL",
  }).map(([name, code]) => [name.toLowerCase(), code]),
);

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

function scheduleSourcePath(fixture: TxlineScheduleFixture) {
  const competitionId = Number(fixture.competitionId);
  if (!Number.isSafeInteger(competitionId) || competitionId < 0) {
    throw new Error("TxLINE schedule fixture competition id is invalid");
  }
  return buildTxlineFixtureSnapshotPath({ competitionId });
}

function teamCode(name: string, participantId: string) {
  const known = COUNTRY_CODES.get(name.trim().toLowerCase());
  if (known) return known;
  const compact =
    name
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toUpperCase()
      .match(/[A-Z0-9]+/g)
      ?.join("")
      .slice(0, 3) ?? "UNK";
  const identifier = participantId.toUpperCase().replace(/[^A-Z0-9]/gu, "");
  if (identifier.length === 0 || identifier.length > 16) {
    throw new Error("TxLINE participant id cannot form a stable team code");
  }
  // TxLINE parses participant IDs as safe numeric identifiers (at most sixteen
  // digits), so retaining the whole identifier gives every unknown team a
  // collision-safe code within the 20-character public team-code contract.
  return `${compact}-${identifier}`;
}

function teamCatalogEntry(
  participant: TxlineScheduleFixture["participant1"],
  sourceTimestampMs: number,
): DurableTeamCatalogEntry {
  return {
    code: teamCode(participant.name, participant.id),
    name: participant.name,
    participantId: participant.id,
    sourceTimestampMs,
  };
}

function replacesCatalogEntry(
  candidate: DurableTeamCatalogEntry,
  existing: DurableTeamCatalogEntry,
) {
  if (candidate.sourceTimestampMs !== existing.sourceTimestampMs) {
    return candidate.sourceTimestampMs > existing.sourceTimestampMs;
  }
  if (candidate.name !== existing.name || candidate.code !== existing.code) {
    throw new Error("Team catalogue same timestamp has conflicting identity");
  }
  return false;
}

/**
 * Builds the durable World Cup team roster from schedule facts alone. This
 * deliberately does not create fixtures: a past schedule row can contribute
 * a team identity without being presented as a future live match.
 */
export function durableTeamCatalogFromSchedule(
  fixtures: readonly TxlineScheduleFixture[],
): readonly DurableTeamCatalogEntry[] {
  const teams = new Map<string, DurableTeamCatalogEntry>();
  for (const fixture of fixtures) {
    for (const participant of [fixture.participant1, fixture.participant2]) {
      const candidate = teamCatalogEntry(
        participant,
        fixture.sourceTimestampMs,
      );
      const existing = teams.get(candidate.participantId);
      if (!existing || replacesCatalogEntry(candidate, existing)) {
        teams.set(candidate.participantId, candidate);
      }
    }
  }
  return [...teams.values()].sort(
    (left, right) =>
      left.code.localeCompare(right.code) ||
      left.participantId.localeCompare(right.participantId),
  );
}

export function durableFixtureFromSchedule(fixture: TxlineScheduleFixture) {
  const participant1Code = teamCode(
    fixture.participant1.name,
    fixture.participant1.id,
  );
  const participant2Code = teamCode(
    fixture.participant2.name,
    fixture.participant2.id,
  );
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

export function archiveImportSourceContextFromSchedule(
  fixture: TxlineScheduleFixture,
): ArchiveImportScheduleContext {
  const durable = durableFixtureFromSchedule(fixture);
  const sourceContext: ArchiveImportSourceContext = {
    fixtureGroupId: fixture.fixtureGroupId,
    fixtureId: fixture.fixtureId,
    gameState: fixture.gameState,
    kickoffAt: durable.kickoffAt,
    participant1: {
      code: teamCode(fixture.participant1.name, fixture.participant1.id),
      id: fixture.participant1.id,
      name: fixture.participant1.name,
    },
    participant1IsHome: fixture.participant1IsHome,
    participant2: {
      code: teamCode(fixture.participant2.name, fixture.participant2.id),
      id: fixture.participant2.id,
      name: fixture.participant2.name,
    },
    schedule: {
      competition: fixture.competition,
      competitionId: fixture.competitionId,
      responseHash: digest(fixture),
      source: "txline_world_cup_schedule",
      sourcePath: scheduleSourcePath(fixture),
      sourceTimestampMs: fixture.sourceTimestampMs,
    },
  };
  return {
    contextHash: hashArchiveImportSourceContext(sourceContext),
    sourceContext,
  };
}

export function durableCollectorFixtureFromSchedule(
  fixture: TxlineScheduleFixture,
): DurableCollectorFixture {
  return {
    ...durableFixtureFromSchedule(fixture),
    archiveImport: archiveImportSourceContextFromSchedule(fixture),
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
    sourcePath: scheduleSourcePath(fixture),
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
