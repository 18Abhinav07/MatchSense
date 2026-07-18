import type { QueryRow, RepositoryClient } from "./repositories.js";

export type ArchiveImportReason =
  "featured_bootstrap" | "live_terminal" | "live_correction";

export type ArchiveImportJobState =
  | "queued"
  | "claimed"
  | "retry_wait"
  | "replay_ready"
  | "blocked_rights"
  | "rejected";

export interface ArchiveImportJobInput {
  awayTeamId: string;
  contextHash: string;
  fixtureId: string;
  homeTeamId: string;
  kickoffAt: string;
  participant1IsHome: boolean;
  reason: ArchiveImportReason;
  sourceTerminalRecordId: string;
}

export interface ArchiveImportJob extends ArchiveImportJobInput {
  archiveManifestId: string | null;
  attemptCount: number;
  availableAt: string;
  claimExpiresAt: string | null;
  claimedBy: string | null;
  createdAt: string;
  lastError: string | null;
  state: ArchiveImportJobState;
  updatedAt: string;
}

export interface RetryArchiveImportJob {
  availableAt: string;
  error: string;
  fixtureId: string;
  workerId: string;
}

export interface TerminalArchiveImportJob {
  error: string;
  fixtureId: string;
  workerId: string;
}

export interface MarkArchiveImportReplayReady {
  archiveManifestId: string;
  fixtureId: string;
  workerId: string;
}

export interface ArchiveImportJobRepository {
  claim(workerId: string, now: Date): Promise<ArchiveImportJob | null>;
  enqueue(input: ArchiveImportJobInput): Promise<ArchiveImportJob>;
  markBlockedRights(input: TerminalArchiveImportJob): Promise<ArchiveImportJob>;
  markRejected(input: TerminalArchiveImportJob): Promise<ArchiveImportJob>;
  markReplayReady(
    input: MarkArchiveImportReplayReady,
  ): Promise<ArchiveImportJob>;
  markRetry(input: RetryArchiveImportJob): Promise<ArchiveImportJob>;
  recoverExpiredClaims(now: Date): Promise<number>;
}

export interface FeaturedReplayConfigInput {
  archiveManifestId: string;
  enabled?: boolean;
  fixtureId: string;
  slot: string;
}

export interface FeaturedReplayConfig {
  archiveManifestId: string;
  enabled: boolean;
  fixtureId: string;
  slot: string;
}

/** A config is readable only while its exact manifest remains replay-ready. */
export interface FeaturedReplayReady {
  archiveManifestId: string;
  fixtureId: string;
  slot: string;
}

export interface FeaturedReplayRepository {
  configure(input: FeaturedReplayConfigInput): Promise<FeaturedReplayConfig>;
  ready(slot: string): Promise<FeaturedReplayReady | null>;
}

const jobColumns = `fixture_id, home_team_id, away_team_id, kickoff_at,
participant1_is_home, context_hash, reason, state, archive_manifest_id,
attempt_count, last_error, available_at, claimed_by, claim_expires_at,
source_terminal_record_id, created_at, updated_at`;

function requiredString(row: QueryRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Database row field ${key} is invalid`);
  }
  return value;
}

function nullableString(row: QueryRow, key: string): string | null {
  return row[key] === null ? null : requiredString(row, key);
}

function timestamp(row: QueryRow, key: string): string {
  const value = row[key];
  if (value instanceof Date) return value.toISOString();
  return requiredString(row, key);
}

function nullableTimestamp(row: QueryRow, key: string): string | null {
  return row[key] === null ? null : timestamp(row, key);
}

function boolean(row: QueryRow, key: string): boolean {
  if (typeof row[key] !== "boolean") {
    throw new Error(`Database row field ${key} is invalid`);
  }
  return row[key] as boolean;
}

function safeInteger(row: QueryRow, key: string): number {
  const value = typeof row[key] === "string" ? Number(row[key]) : row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Database row field ${key} is invalid`);
  }
  return value;
}

function importReason(value: string): ArchiveImportReason {
  if (
    value === "featured_bootstrap" ||
    value === "live_terminal" ||
    value === "live_correction"
  ) {
    return value;
  }
  throw new Error("Database row field reason is invalid");
}

function importState(value: string): ArchiveImportJobState {
  if (
    value === "queued" ||
    value === "claimed" ||
    value === "retry_wait" ||
    value === "replay_ready" ||
    value === "blocked_rights" ||
    value === "rejected"
  ) {
    return value;
  }
  throw new Error("Database row field state is invalid");
}

function parseJob(row: QueryRow): ArchiveImportJob {
  return {
    archiveManifestId: nullableString(row, "archive_manifest_id"),
    attemptCount: safeInteger(row, "attempt_count"),
    availableAt: timestamp(row, "available_at"),
    awayTeamId: requiredString(row, "away_team_id"),
    claimExpiresAt: nullableTimestamp(row, "claim_expires_at"),
    claimedBy: nullableString(row, "claimed_by"),
    contextHash: requiredString(row, "context_hash"),
    createdAt: timestamp(row, "created_at"),
    fixtureId: requiredString(row, "fixture_id"),
    homeTeamId: requiredString(row, "home_team_id"),
    kickoffAt: timestamp(row, "kickoff_at"),
    lastError: nullableString(row, "last_error"),
    participant1IsHome: boolean(row, "participant1_is_home"),
    reason: importReason(requiredString(row, "reason")),
    sourceTerminalRecordId: requiredString(row, "source_terminal_record_id"),
    state: importState(requiredString(row, "state")),
    updatedAt: timestamp(row, "updated_at"),
  };
}

function assertNonempty(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`${label} is required`);
}

function assertTimestamp(value: string, label: string): void {
  if (Number.isNaN(new Date(value).valueOf())) {
    throw new Error(`${label} is invalid`);
  }
}

function assertSha256(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} must be lowercase SHA-256 hex`);
  }
}

function assertJobInput(input: ArchiveImportJobInput): void {
  for (const [value, label] of [
    [input.fixtureId, "Fixture id"],
    [input.homeTeamId, "Home team id"],
    [input.awayTeamId, "Away team id"],
    [input.sourceTerminalRecordId, "Source terminal record id"],
  ] as const) {
    assertNonempty(value, label);
  }
  if (input.homeTeamId.trim() === input.awayTeamId.trim()) {
    throw new Error("Archive import teams must be distinct");
  }
  assertTimestamp(input.kickoffAt, "Kickoff time");
  assertSha256(input.contextHash, "Frozen fixture context hash");
}

function assertWorkerTransition(
  input: TerminalArchiveImportJob | RetryArchiveImportJob,
): void {
  assertNonempty(input.fixtureId, "Fixture id");
  assertNonempty(input.workerId, "Archive import worker id");
  assertNonempty(input.error, "Archive import error");
}

function jobSelectColumns(alias = "job"): string {
  return jobColumns
    .split(",")
    .map((column) => `${alias}.${column.trim()}`)
    .join(", ");
}

export function createArchiveImportJobRepository(
  client: RepositoryClient,
): ArchiveImportJobRepository {
  return {
    enqueue: async (input) => {
      assertJobInput(input);
      return client.begin(async (transaction) => {
        const inserted = await transaction.unsafe(
          `INSERT INTO matchsense.archive_import_jobs (
  fixture_id, home_team_id, away_team_id, kickoff_at, participant1_is_home,
  context_hash, reason, source_terminal_record_id
)
VALUES ($1, $2, $3, $4::timestamptz, $5, $6, $7, $8)
ON CONFLICT (fixture_id) DO UPDATE
SET reason = EXCLUDED.reason,
    state = 'queued',
    archive_manifest_id = NULL,
    available_at = clock_timestamp(),
    claimed_by = NULL,
    claim_expires_at = NULL,
    last_error = NULL,
    source_terminal_record_id = EXCLUDED.source_terminal_record_id,
    updated_at = clock_timestamp()
WHERE matchsense.archive_import_jobs.source_terminal_record_id
      IS DISTINCT FROM EXCLUDED.source_terminal_record_id
   OR matchsense.archive_import_jobs.reason IS DISTINCT FROM EXCLUDED.reason
RETURNING ${jobColumns};`,
          [
            input.fixtureId,
            input.homeTeamId,
            input.awayTeamId,
            input.kickoffAt,
            input.participant1IsHome,
            input.contextHash,
            input.reason,
            input.sourceTerminalRecordId,
          ],
        );
        if (inserted[0]) return parseJob(inserted[0]);

        const existing = await transaction.unsafe(
          `SELECT ${jobColumns}
FROM matchsense.archive_import_jobs
WHERE fixture_id = $1
FOR SHARE;`,
          [input.fixtureId],
        );
        if (!existing[0]) {
          throw new Error("Archive import job enqueue lost its fixture row");
        }
        return parseJob(existing[0]);
      });
    },
    claim: async (workerId, now) => {
      assertNonempty(workerId, "Archive import worker id");
      if (Number.isNaN(now.valueOf())) throw new Error("Claim time is invalid");
      return client.begin(async (transaction) => {
        const rows = await transaction.unsafe(
          `WITH candidate AS (
  SELECT fixture_id
  FROM matchsense.archive_import_jobs
  WHERE state IN ('queued', 'retry_wait')
    AND available_at <= $2::timestamptz
  ORDER BY available_at ASC, created_at ASC, fixture_id ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE matchsense.archive_import_jobs AS job
SET state = 'claimed',
    claimed_by = $1,
    claim_expires_at = $2::timestamptz + interval '120 seconds',
    attempt_count = job.attempt_count + 1,
    last_error = NULL,
    updated_at = clock_timestamp()
FROM candidate
WHERE job.fixture_id = candidate.fixture_id
RETURNING ${jobSelectColumns()};`,
          [workerId, now.toISOString()],
        );
        return rows[0] ? parseJob(rows[0]) : null;
      });
    },
    recoverExpiredClaims: async (now) => {
      if (Number.isNaN(now.valueOf())) {
        throw new Error("Recovery time is invalid");
      }
      const rows = await client.unsafe(
        `WITH recovered AS (
  UPDATE matchsense.archive_import_jobs
  SET state = 'retry_wait',
      claimed_by = NULL,
      claim_expires_at = NULL,
      available_at = $1::timestamptz,
      last_error = COALESCE(last_error, 'archive import claim lease expired'),
      updated_at = clock_timestamp()
  WHERE state = 'claimed'
    AND claim_expires_at <= $1::timestamptz
  RETURNING fixture_id
)
SELECT COUNT(*)::text AS recovered_count
FROM recovered;`,
        [now.toISOString()],
      );
      const value = rows[0]?.recovered_count;
      const count = typeof value === "string" ? Number(value) : value;
      if (
        typeof count !== "number" ||
        !Number.isSafeInteger(count) ||
        count < 0
      ) {
        throw new Error("Archive import recovery count is invalid");
      }
      return count;
    },
    markRetry: async (input) => {
      assertWorkerTransition(input);
      assertTimestamp(input.availableAt, "Retry available time");
      const rows = await client.unsafe(
        `UPDATE matchsense.archive_import_jobs
SET state = 'retry_wait',
    claimed_by = NULL,
    claim_expires_at = NULL,
    available_at = $1::timestamptz,
    last_error = $2,
    updated_at = clock_timestamp()
WHERE fixture_id = $3
  AND state = 'claimed'
  AND claimed_by = $4
  AND claim_expires_at > clock_timestamp()
RETURNING ${jobColumns};`,
        [input.availableAt, input.error, input.fixtureId, input.workerId],
      );
      if (!rows[0]) {
        throw new Error("Archive import job is not claimed by this worker");
      }
      return parseJob(rows[0]);
    },
    markReplayReady: async (input) => {
      assertNonempty(input.fixtureId, "Fixture id");
      assertNonempty(input.workerId, "Archive import worker id");
      assertNonempty(input.archiveManifestId, "Archive manifest id");
      const rows = await client.unsafe(
        `UPDATE matchsense.archive_import_jobs AS job
SET state = 'replay_ready',
    archive_manifest_id = $1,
    claimed_by = NULL,
    claim_expires_at = NULL,
    last_error = NULL,
    updated_at = clock_timestamp()
WHERE job.fixture_id = $2
  AND job.state = 'claimed'
  AND job.claimed_by = $3
  AND job.claim_expires_at > clock_timestamp()
  AND EXISTS (
    SELECT 1
    FROM matchsense.archive_manifests AS archive
    WHERE archive.id = $1
      AND archive.fixture_id = job.fixture_id
      AND archive.mode = 'recorded'
      AND archive.status = 'REPLAY_READY'
  )
RETURNING ${jobSelectColumns()};`,
        [input.archiveManifestId, input.fixtureId, input.workerId],
      );
      if (!rows[0]) {
        throw new Error(
          "Archive import job claim or replay-ready manifest is invalid",
        );
      }
      return parseJob(rows[0]);
    },
    markBlockedRights: async (input) => {
      assertWorkerTransition(input);
      const rows = await client.unsafe(
        `UPDATE matchsense.archive_import_jobs
SET state = 'blocked_rights',
    claimed_by = NULL,
    claim_expires_at = NULL,
    last_error = $1,
    updated_at = clock_timestamp()
WHERE fixture_id = $2
  AND state = 'claimed'
  AND claimed_by = $3
  AND claim_expires_at > clock_timestamp()
RETURNING ${jobColumns};`,
        [input.error, input.fixtureId, input.workerId],
      );
      if (!rows[0]) {
        throw new Error("Archive import job is not claimed by this worker");
      }
      return parseJob(rows[0]);
    },
    markRejected: async (input) => {
      assertWorkerTransition(input);
      const rows = await client.unsafe(
        `UPDATE matchsense.archive_import_jobs
SET state = 'rejected',
    claimed_by = NULL,
    claim_expires_at = NULL,
    last_error = $1,
    updated_at = clock_timestamp()
WHERE fixture_id = $2
  AND state = 'claimed'
  AND claimed_by = $3
  AND claim_expires_at > clock_timestamp()
RETURNING ${jobColumns};`,
        [input.error, input.fixtureId, input.workerId],
      );
      if (!rows[0]) {
        throw new Error("Archive import job is not claimed by this worker");
      }
      return parseJob(rows[0]);
    },
  };
}

function parseFeaturedConfig(row: QueryRow): FeaturedReplayConfig {
  return {
    archiveManifestId: requiredString(row, "archive_manifest_id"),
    enabled: boolean(row, "enabled"),
    fixtureId: requiredString(row, "fixture_id"),
    slot: requiredString(row, "slot"),
  };
}

function assertFeaturedInput(input: FeaturedReplayConfigInput): void {
  assertNonempty(input.slot, "Featured replay slot");
  assertNonempty(input.fixtureId, "Featured replay fixture id");
  assertNonempty(
    input.archiveManifestId,
    "Featured replay archive manifest id",
  );
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw new Error("Featured replay enabled is invalid");
  }
}

export function createFeaturedReplayRepository(
  client: RepositoryClient,
): FeaturedReplayRepository {
  return {
    configure: async (input) => {
      assertFeaturedInput(input);
      const rows = await client.unsafe(
        `INSERT INTO matchsense.featured_replay_configs (
  slot, fixture_id, archive_manifest_id, enabled
)
VALUES ($1, $2, $3, $4)
ON CONFLICT (slot) DO UPDATE
SET fixture_id = EXCLUDED.fixture_id,
    archive_manifest_id = EXCLUDED.archive_manifest_id,
    enabled = EXCLUDED.enabled,
    updated_at = clock_timestamp()
RETURNING slot, fixture_id, archive_manifest_id, enabled;`,
        [
          input.slot,
          input.fixtureId,
          input.archiveManifestId,
          input.enabled ?? true,
        ],
      );
      if (!rows[0]) {
        throw new Error("Featured replay configuration returned no row");
      }
      return parseFeaturedConfig(rows[0]);
    },
    ready: async (slot) => {
      assertNonempty(slot, "Featured replay slot");
      const rows = await client.unsafe(
        `SELECT config.slot, config.fixture_id, config.archive_manifest_id
FROM matchsense.featured_replay_configs AS config
JOIN matchsense.archive_import_jobs AS job
  ON job.fixture_id = config.fixture_id
JOIN matchsense.archive_manifests AS archive
  ON archive.id = config.archive_manifest_id
WHERE config.slot = $1
  AND config.enabled = true
  AND job.state = 'replay_ready'
  AND job.archive_manifest_id = config.archive_manifest_id
  AND archive.fixture_id = config.fixture_id
  AND archive.mode = 'recorded'
  AND archive.status = 'REPLAY_READY';`,
        [slot],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        archiveManifestId: requiredString(row, "archive_manifest_id"),
        fixtureId: requiredString(row, "fixture_id"),
        slot: requiredString(row, "slot"),
      };
    },
  };
}
