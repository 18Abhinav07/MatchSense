import type {
  QueryRow,
  RepositoryClient,
  SqlExecutor,
} from "./repositories.js";

/** Public presentation modes. Synthetic modes never parse at this boundary. */
export type FixtureReadMode = "live" | "recorded";

export type FixtureLifecycle =
  | "discovered"
  | "scheduled"
  | "tracking"
  | "live"
  | "terminal_fact_committed"
  | "final"
  | "final_revised"
  | "postponed"
  | "cancelled"
  | "result_unavailable";

export type FixtureBucket = "upcoming" | "live" | "final";

/** Every durable read is pinned to its persisted source mode. */
export interface FixtureReadKey {
  fixtureId: string;
  mode: FixtureReadMode;
}

export interface FixtureReadSnapshot {
  archiveManifestId: string | null;
  bucket: FixtureBucket | null;
  fixtureId: string;
  lifecycle: FixtureLifecycle;
  metadata: Record<string, unknown>;
  mode: FixtureReadMode;
  projection: {
    payload: unknown;
    revision: number;
    sourceSequence: string | null;
    updatedAt: string;
  } | null;
  provenance: "live_txline" | "recorded_txline_authorised";
  replayReady: boolean;
  scheduledAt: string;
  teams: { away: string; home: string };
}

export interface FixtureFeedEvent {
  createdAt: string;
  eventId: string;
  eventType: string;
  payload: unknown;
  sequence: number;
}

export interface FixtureFeed {
  events: readonly FixtureFeedEvent[];
  highWaterSequence: number;
  reset: boolean;
  snapshot: FixtureReadSnapshot;
}

export interface FixtureMomentRevision {
  createdAt: string;
  payload: unknown;
  revision: number;
  sourceRecordId: string;
}

export interface FixtureMomentResolution {
  latest: FixtureMomentRevision | null;
  requested: FixtureMomentRevision | null;
  snapshot: FixtureReadSnapshot;
  superseded: boolean;
}

export interface FixtureMemoryRead {
  fixture: FixtureReadSnapshot;
  timeline: readonly FixtureFeedEvent[];
}

export interface ReplayReadyFixture {
  archiveManifestId: string;
  fixture: FixtureReadSnapshot;
}

export interface FixtureReadRepository {
  getFixture(input: FixtureReadKey): Promise<FixtureReadSnapshot | null>;
  getReplayReady(input: FixtureReadKey): Promise<ReplayReadyFixture | null>;
  listFixtures(input: {
    bucket?: FixtureBucket | undefined;
    limit?: number | undefined;
    mode: FixtureReadMode;
  }): Promise<readonly FixtureReadSnapshot[]>;
  readFixtureFeed(input: {
    afterSequence: number | null;
    fixtureId: string;
    mode: FixtureReadMode;
  }): Promise<FixtureFeed | null>;
  readHistory(input?: {
    limit?: number | undefined;
  }): Promise<readonly FixtureReadSnapshot[]>;
  readMemory(input: FixtureReadKey): Promise<FixtureMemoryRead | null>;
  readMoment(input: {
    familyId: string;
    fixtureId: string;
    mode: FixtureReadMode;
    revision: number;
  }): Promise<FixtureMomentResolution | null>;
}

const fixtureColumns = `fixture.mode AS fixture_mode,
fixture.id AS fixture_id,
fixture.provenance,
fixture.home_team_id,
fixture.away_team_id,
fixture.scheduled_at AS kickoff_at,
fixture.status AS fixture_status,
fixture.metadata,
projection.revision AS projection_revision,
projection.source_sequence AS projection_source_sequence,
projection.payload AS projection_payload,
projection.updated_at AS projection_updated_at,
archive.id AS archive_manifest_id,
archive.status AS archive_status`;

function json(value: unknown, field: string): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Database row field ${field} is invalid`);
  }
}

function object(value: unknown, field: string): Record<string, unknown> {
  const parsed = json(value, field);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Database row field ${field} is invalid`);
  }
  return parsed as Record<string, unknown>;
}

function string(row: QueryRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Database row field ${field} is invalid`);
  }
  return value;
}

function nullableString(row: QueryRow, field: string): string | null {
  return row[field] === null ? null : string(row, field);
}

function timestamp(row: QueryRow, field: string): string {
  const value = row[field];
  return value instanceof Date ? value.toISOString() : string(row, field);
}

function nullableTimestamp(row: QueryRow, field: string): string | null {
  return row[field] === null ? null : timestamp(row, field);
}

function integer(value: unknown, field: string): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < 0) {
    throw new Error(`Database row field ${field} is invalid`);
  }
  return parsed as number;
}

function mode(row: QueryRow): FixtureReadMode {
  const value = string(row, "fixture_mode");
  if (value === "live" || value === "recorded") return value;
  throw new Error("Database row field fixture_mode is invalid");
}

function provenance(
  row: QueryRow,
): "live_txline" | "recorded_txline_authorised" {
  const value = string(row, "provenance");
  if (value === "live_txline" || value === "recorded_txline_authorised") {
    return value;
  }
  throw new Error("Database row field provenance is invalid");
}

function lifecycle(row: QueryRow): FixtureLifecycle {
  const value = string(row, "fixture_status")
    .trim()
    .toLowerCase()
    .replaceAll("-", "_")
    .replaceAll(" ", "_");
  const allowed: readonly FixtureLifecycle[] = [
    "discovered",
    "scheduled",
    "tracking",
    "live",
    "terminal_fact_committed",
    "final",
    "final_revised",
    "postponed",
    "cancelled",
    "result_unavailable",
  ];
  if (allowed.includes(value as FixtureLifecycle)) {
    return value as FixtureLifecycle;
  }
  throw new Error("Database row field fixture_status is invalid");
}

function bucketFor(lifecycleValue: FixtureLifecycle): FixtureBucket | null {
  if (lifecycleValue === "final") return "final";
  if (lifecycleValue === "live") return "live";
  if (
    lifecycleValue === "discovered" ||
    lifecycleValue === "scheduled" ||
    lifecycleValue === "tracking"
  ) {
    return "upcoming";
  }
  return null;
}

function parseFixture(row: QueryRow): FixtureReadSnapshot {
  const fixtureLifecycle = lifecycle(row);
  const fixtureMode = mode(row);
  const archiveStatus = nullableString(row, "archive_status");
  const archiveManifestId = nullableString(row, "archive_manifest_id");
  const projection =
    row.projection_payload === null || row.projection_payload === undefined
      ? null
      : {
          payload: json(row.projection_payload, "projection_payload"),
          revision: integer(row.projection_revision, "projection_revision"),
          sourceSequence: nullableString(row, "projection_source_sequence"),
          updatedAt: timestamp(row, "projection_updated_at"),
        };
  return {
    archiveManifestId,
    bucket: bucketFor(fixtureLifecycle),
    fixtureId: string(row, "fixture_id"),
    lifecycle: fixtureLifecycle,
    metadata: object(row.metadata, "metadata"),
    mode: fixtureMode,
    projection,
    provenance: provenance(row),
    replayReady:
      fixtureMode === "recorded" &&
      fixtureLifecycle === "final" &&
      archiveManifestId !== null &&
      archiveStatus === "REPLAY_READY",
    scheduledAt: timestamp(row, "kickoff_at"),
    teams: {
      away: string(row, "away_team_id"),
      home: string(row, "home_team_id"),
    },
  };
}

function parseEvent(row: QueryRow): FixtureFeedEvent {
  return {
    createdAt: timestamp(row, "created_at"),
    eventId: string(row, "event_id"),
    eventType: string(row, "event_type"),
    payload: json(row.payload, "payload"),
    sequence: integer(row.sequence, "sequence"),
  };
}

function parseMoment(row: QueryRow): FixtureMomentRevision {
  return {
    createdAt: timestamp(row, "created_at"),
    payload: json(row.payload, "payload"),
    revision: integer(row.revision, "revision"),
    sourceRecordId: string(row, "source_record_id"),
  };
}

function limit(value: number | undefined) {
  const requested = value ?? 100;
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > 500) {
    throw new Error("Fixture read limit is invalid");
  }
  return requested;
}

function fixtureQuery(where: string) {
  return `SELECT ${fixtureColumns}
FROM matchsense.fixtures AS fixture
LEFT JOIN matchsense.fixture_projections AS projection
  ON projection.mode = fixture.mode AND projection.fixture_id = fixture.id
LEFT JOIN matchsense.archive_manifests AS archive
  ON archive.mode = fixture.mode AND archive.fixture_id = fixture.id
${where}`;
}

/**
 * Live rows are only meaningful while the source fixture is in progress or
 * upcoming. Historical rows become public only after the archive has a still
 * active replay grant. This prevents an unfinished or revoked archive from
 * looking like a completed MatchSense Memory.
 */
function publicFixtureVisibility() {
  return `(fixture.mode = 'live' AND fixture.status IN (
  'discovered', 'scheduled', 'tracking', 'live'
)) OR (
  fixture.mode = 'recorded'
  AND fixture.status = 'final'
  AND archive.status = 'REPLAY_READY'
  AND (${currentRecordedArchiveImportBinding()})
  AND (${activeReplayRights()})
)`;
}

/**
 * A recorded archive cannot become public on an archive manifest alone. The
 * current terminal archive must be the exact output bound to the generation
 * that transitioned its import job to replay_ready. This prevents a stale
 * manifest, old claim output, or correction-requeued job from resurfacing
 * historical data.
 */
function currentRecordedArchiveImportBinding() {
  return `EXISTS (
    SELECT 1
    FROM matchsense.archive_import_jobs AS archive_job
    JOIN matchsense.archive_import_job_outputs AS archive_output
      ON archive_output.fixture_id = archive_job.fixture_id
      AND archive_output.claim_generation = archive_job.claim_generation
      AND archive_output.archive_manifest_id = archive_job.archive_manifest_id
      AND archive_output.archive_manifest_hash = archive_job.archive_manifest_hash
    WHERE archive_job.fixture_id = fixture.id
      AND archive_job.state = 'replay_ready'
      AND archive_job.archive_manifest_id = archive.id
      AND archive_job.archive_manifest_hash = archive.delivery_manifest_hash
  )`;
}

function activeReplayRights() {
  return `EXISTS (
    SELECT 1
    FROM matchsense.rights_grants AS rights_grant
    WHERE rights_grant.id = archive.rights_grant_id
      AND rights_grant.active = true
      AND rights_grant.revoked_at IS NULL
      AND (rights_grant.expires_at IS NULL OR rights_grant.expires_at > clock_timestamp())
      AND rights_grant.scopes @> ARRAY['replay']::text[]
  )`;
}

function bucketVisibility(bucket: FixtureBucket | undefined) {
  switch (bucket) {
    case "upcoming":
      return "AND fixture.status IN ('discovered', 'scheduled', 'tracking')";
    case "live":
      return "AND fixture.status = 'live'";
    case "final":
      return "AND fixture.status = 'final'";
    default:
      return "";
  }
}

async function readFixture(
  executor: SqlExecutor,
  input: FixtureReadKey,
): Promise<FixtureReadSnapshot | null> {
  const rows = await executor.unsafe(
    `${fixtureQuery(`WHERE fixture.id = $1 AND fixture.mode = $2
  AND (${publicFixtureVisibility()})`)};`,
    [input.fixtureId, input.mode],
  );
  return rows[0] ? parseFixture(rows[0]) : null;
}

async function readEvents(
  executor: SqlExecutor,
  input: {
    afterSequence: number;
    fixtureId: string;
    highWaterSequence: number;
    mode: FixtureReadMode;
  },
) {
  const rows = await executor.unsafe(
    `SELECT sequence, event_id, event_type, payload, created_at
FROM matchsense.fixture_events
WHERE mode = $1 AND fixture_id = $2
  AND sequence > $3 AND sequence <= $4
ORDER BY sequence ASC;`,
    [input.mode, input.fixtureId, input.afterSequence, input.highWaterSequence],
  );
  return rows.map(parseEvent);
}

export function createFixtureReadRepository(
  client: RepositoryClient,
): FixtureReadRepository {
  const listFixtures: FixtureReadRepository["listFixtures"] = async (input) => {
    const rows = await client.unsafe(
      `${fixtureQuery(`WHERE fixture.mode = $1
  AND (${publicFixtureVisibility()})
  ${bucketVisibility(input.bucket)}`)}
ORDER BY fixture.scheduled_at DESC, fixture.id ASC
LIMIT $2;`,
      [input.mode, limit(input.limit)],
    );
    return rows.map(parseFixture).filter((fixture) => fixture.bucket !== null);
  };

  return {
    getFixture: (input) => readFixture(client, input),
    getReplayReady: async (input) => {
      if (input.mode !== "recorded") return null;
      const rows = await client.unsafe(
        `${fixtureQuery(`WHERE fixture.id = $1 AND fixture.mode = $2
  AND fixture.mode = 'recorded'
  AND fixture.status = 'final'
  AND archive.status = 'REPLAY_READY'
  AND (${currentRecordedArchiveImportBinding()})
  AND (${activeReplayRights()})`)};`,
        [input.fixtureId, input.mode],
      );
      const fixture = rows[0] ? parseFixture(rows[0]) : null;
      return fixture?.replayReady && fixture.archiveManifestId
        ? { archiveManifestId: fixture.archiveManifestId, fixture }
        : null;
    },
    listFixtures,
    readFixtureFeed: async ({ afterSequence, fixtureId, mode: fixtureMode }) =>
      client.begin(async (transaction) => {
        const snapshot = await readFixture(transaction, {
          fixtureId,
          mode: fixtureMode,
        });
        if (!snapshot) return null;

        const waterRows = await transaction.unsafe(
          `SELECT COALESCE(MIN(sequence), 0) AS earliest_sequence,
  COALESCE(MAX(sequence), 0) AS high_water_sequence
FROM matchsense.fixture_events
WHERE mode = $1 AND fixture_id = $2;`,
          [snapshot.mode, fixtureId],
        );
        const water = waterRows[0];
        if (!water) throw new Error("Fixture high-water query returned no row");
        const earliestSequence = integer(
          water.earliest_sequence,
          "earliest_sequence",
        );
        const highWaterSequence = integer(
          water.high_water_sequence,
          "high_water_sequence",
        );
        let cursorExists = afterSequence === null || afterSequence === 0;
        if (afterSequence !== null && afterSequence > 0) {
          const cursorRows = await transaction.unsafe(
            `SELECT EXISTS (
  SELECT 1
  FROM matchsense.fixture_events
  WHERE mode = $1 AND fixture_id = $2 AND sequence = $3
) AS cursor_exists;`,
            [snapshot.mode, fixtureId, afterSequence],
          );
          cursorExists = cursorRows[0]?.cursor_exists === true;
        }
        const reset =
          afterSequence !== null &&
          (afterSequence < 0 ||
            afterSequence > highWaterSequence ||
            (afterSequence > 0 &&
              (!cursorExists || afterSequence < earliestSequence)));
        const eventStart =
          afterSequence === null
            ? highWaterSequence
            : Math.min(afterSequence, highWaterSequence);
        return {
          events: await readEvents(transaction, {
            afterSequence: eventStart,
            fixtureId,
            highWaterSequence,
            mode: snapshot.mode,
          }),
          highWaterSequence,
          reset,
          snapshot,
        };
      }),
    readHistory: async (input = {}) =>
      listFixtures({ bucket: "final", limit: input.limit, mode: "recorded" }),
    readMemory: async (input) => {
      const snapshot = await readFixture(client, input);
      if (
        !snapshot ||
        snapshot.mode !== "recorded" ||
        snapshot.lifecycle !== "final" ||
        !snapshot.replayReady
      ) {
        return null;
      }
      const waterRows = await client.unsafe(
        `SELECT COALESCE(MAX(sequence), 0) AS high_water_sequence
FROM matchsense.fixture_events
WHERE mode = $1 AND fixture_id = $2;`,
        [snapshot.mode, input.fixtureId],
      );
      const water = waterRows[0];
      if (!water) throw new Error("Fixture history query returned no row");
      const highWaterSequence = integer(
        water.high_water_sequence,
        "high_water_sequence",
      );
      return {
        fixture: snapshot,
        timeline: await readEvents(client, {
          afterSequence: 0,
          fixtureId: input.fixtureId,
          highWaterSequence,
          mode: snapshot.mode,
        }),
      };
    },
    readMoment: async ({
      familyId,
      fixtureId,
      mode: fixtureMode,
      revision,
    }) => {
      if (!Number.isSafeInteger(revision) || revision < 1) {
        throw new Error("Moment revision is invalid");
      }
      const snapshot = await readFixture(client, {
        fixtureId,
        mode: fixtureMode,
      });
      if (!snapshot) return null;
      const familyRows = await client.unsafe(
        `SELECT current_revision
FROM matchsense.canonical_moments
WHERE mode = $1 AND fixture_id = $2 AND id = $3;`,
        [snapshot.mode, fixtureId, familyId],
      );
      const family = familyRows[0];
      if (!family) return null;
      const currentRevision = integer(
        family.current_revision,
        "current_revision",
      );
      const getRevision = async (targetRevision: number) => {
        const rows = await client.unsafe(
          `SELECT revision, payload, source_record_id, created_at
FROM matchsense.moment_revisions
WHERE mode = $1 AND fixture_id = $2 AND moment_id = $3 AND revision = $4;`,
          [snapshot.mode, fixtureId, familyId, targetRevision],
        );
        return rows[0] ? parseMoment(rows[0]) : null;
      };
      const [requested, latest] = await Promise.all([
        getRevision(revision),
        revision === currentRevision
          ? Promise.resolve(null)
          : getRevision(currentRevision),
      ]);
      if (!requested) return null;
      return {
        latest: revision === currentRevision ? requested : latest,
        requested,
        snapshot,
        superseded: revision !== currentRevision,
      };
    },
  };
}
