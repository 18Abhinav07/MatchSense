import {
  VERIFIED_TXLINE_DEVNET_ENDPOINTS,
  type TxlineAuthenticatedClient,
} from "./client.js";

export interface TxlineScheduleFixture {
  competition: string;
  competitionId: string;
  fixtureGroupId: string;
  fixtureId: string;
  gameState: number;
  participant1: { id: string; name: string };
  participant1IsHome: boolean;
  participant2: { id: string; name: string };
  sourceTimestampMs: number;
  startTimeMs: number;
}

export interface TxlineFixtureSnapshotQuery {
  competitionId?: number | undefined;
  startEpochDay?: number | undefined;
}

export interface TxlineWorldCupScheduleOptions {
  signal?: AbortSignal | undefined;
  startEpochDay?: number | undefined;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function numericIdentifier(value: unknown): string | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function parseTxlineScheduleFixture(
  payload: unknown,
): TxlineScheduleFixture | null {
  if (!isObject(payload)) return null;
  const competition = nonEmptyString(payload.Competition);
  const competitionId = numericIdentifier(payload.CompetitionId);
  const fixtureGroupId = numericIdentifier(payload.FixtureGroupId);
  const fixtureId = numericIdentifier(payload.FixtureId);
  const participant1Id = numericIdentifier(payload.Participant1Id);
  const participant1 = nonEmptyString(payload.Participant1);
  const participant2Id = numericIdentifier(payload.Participant2Id);
  const participant2 = nonEmptyString(payload.Participant2);
  const sourceTimestampMs = finiteNumber(payload.Ts);
  const startTimeMs = finiteNumber(payload.StartTime);
  const gameState = finiteNumber(payload.GameState);
  if (
    competition === null ||
    competitionId === null ||
    fixtureGroupId === null ||
    fixtureId === null ||
    participant1Id === null ||
    participant1 === null ||
    participant2Id === null ||
    participant2 === null ||
    sourceTimestampMs === null ||
    startTimeMs === null ||
    gameState === null ||
    typeof payload.Participant1IsHome !== "boolean"
  ) {
    return null;
  }
  return {
    competition,
    competitionId,
    fixtureGroupId,
    fixtureId,
    gameState,
    participant1: { id: participant1Id, name: participant1 },
    participant1IsHome: payload.Participant1IsHome,
    participant2: { id: participant2Id, name: participant2 },
    sourceTimestampMs,
    startTimeMs,
  };
}

function optionalQueryInteger(value: number | undefined, label: string) {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return String(value);
}

export function buildTxlineFixtureSnapshotPath(
  query: TxlineFixtureSnapshotQuery = {},
) {
  const parameters = new URLSearchParams();
  const startEpochDay = optionalQueryInteger(
    query.startEpochDay,
    "startEpochDay",
  );
  const competitionId = optionalQueryInteger(
    query.competitionId,
    "competitionId",
  );
  if (startEpochDay !== null) parameters.set("startEpochDay", startEpochDay);
  if (competitionId !== null) parameters.set("competitionId", competitionId);
  const suffix = parameters.toString();
  return `${VERIFIED_TXLINE_DEVNET_ENDPOINTS.fixtureSnapshotPath}${
    suffix.length === 0 ? "" : `?${suffix}`
  }`;
}

export async function fetchTxlineWorldCupSchedule(
  client: TxlineAuthenticatedClient,
  options: TxlineWorldCupScheduleOptions = {},
) {
  const path = buildTxlineFixtureSnapshotPath({
    competitionId: 72,
    startEpochDay: options.startEpochDay,
  });
  const response = await client.get(path, {
    accept: "application/json",
    signal: options.signal,
  });
  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error("TxLINE fixture snapshot was not an array");
  }
  return payload
    .map(parseTxlineScheduleFixture)
    .filter(
      (fixture): fixture is TxlineScheduleFixture =>
        fixture !== null && fixture.competitionId === "72",
    );
}
