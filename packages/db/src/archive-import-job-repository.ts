import { createHash } from "node:crypto";

import type {
  QueryRow,
  RepositoryClient,
  SqlExecutor,
} from "./repositories.js";

export type ArchiveImportReason =
  "featured_bootstrap" | "live_terminal" | "live_correction";

export type ArchiveImportJobState =
  | "queued"
  | "claimed"
  | "retry_wait"
  | "replay_ready"
  | "blocked_rights"
  | "rejected";

/**
 * Immutable, provider-derived fixture facts used to reproduce one live
 * terminal as a recorded archive. This is intentionally the schedule context,
 * never an inferred score payload or a product-facing fixture label.
 */
export interface ArchiveImportSourceContext {
  fixtureGroupId: string;
  fixtureId: string;
  gameState: number;
  kickoffAt: string;
  participant1: {
    code: string;
    id: string;
    name: string;
  };
  participant1IsHome: boolean;
  participant2: {
    code: string;
    id: string;
    name: string;
  };
  schedule: {
    competition: string;
    competitionId: string;
    responseHash: string;
    source: string;
    sourcePath: string;
    sourceTimestampMs: number;
  };
}

export interface ArchiveImportJobInput {
  awayTeamId: string;
  contextHash: string;
  fixtureId: string;
  homeTeamId: string;
  kickoffAt: string;
  participant1IsHome: boolean;
  reason: ArchiveImportReason;
  sourceContext: ArchiveImportSourceContext;
  sourceTerminalRecordId: string;
}

/** A collector can only request the live-terminal enqueue path. */
export type LiveTerminalArchiveImportJobInput = Omit<
  ArchiveImportJobInput,
  "reason"
>;

export interface ArchiveImportJob extends Omit<
  ArchiveImportJobInput,
  "sourceContext"
> {
  archiveManifestHash: string | null;
  archiveManifestId: string | null;
  attemptCount: number;
  availableAt: string;
  claimExpiresAt: string | null;
  claimGeneration: number;
  claimStartedAt: string | null;
  claimedBy: string | null;
  createdAt: string;
  lastError: string | null;
  state: ArchiveImportJobState;
  /** Legacy rows predating migration 9 have no reconstructable schedule context. */
  sourceContext: ArchiveImportSourceContext | null;
  updatedAt: string;
}

export interface ClaimedArchiveImportJob {
  claimGeneration: number;
  fixtureId: string;
  workerId: string;
}

export interface RetryArchiveImportJob extends ClaimedArchiveImportJob {
  availableAt: string;
  error: string;
}

/** Extends one current, generation-fenced archive-import claim. */
export interface RenewArchiveImportJobClaim extends ClaimedArchiveImportJob {
  claimExpiresAt: string;
}

export interface TerminalArchiveImportJob extends ClaimedArchiveImportJob {
  error: string;
}

export interface BindVerifiedArchiveOutput extends ClaimedArchiveImportJob {
  archiveManifestHash: string;
  archiveManifestId: string;
}

/**
 * A generic live correction invalidates any non-terminal archive work for its
 * fixture without inventing a replacement terminal. The caller must already
 * hold the live collector source-frame transaction and fence.
 */
export interface SupersedeLiveTerminalArchiveImportJobForCorrectionInput {
  fixtureId: string;
  reason: string;
}

/** Immutable verification evidence for one concrete archive-import claim. */
export interface ArchiveImportVerifiedOutput {
  archiveManifestHash: string;
  archiveManifestId: string;
  archiveTerminalDeliveryId: string;
  archiveVerifiedAt: string;
  claimGeneration: number;
  claimStartedAt: string;
  fixtureId: string;
  sourceTerminalRecordId: string;
  workerId: string;
}

export interface ArchiveImportJobRepository {
  bindVerifiedArchiveOutput(
    input: BindVerifiedArchiveOutput,
  ): Promise<ArchiveImportVerifiedOutput>;
  claim(workerId: string, now: Date): Promise<ArchiveImportJob | null>;
  enqueue(input: ArchiveImportJobInput): Promise<ArchiveImportJob>;
  markBlockedRights(input: TerminalArchiveImportJob): Promise<ArchiveImportJob>;
  markRejected(input: TerminalArchiveImportJob): Promise<ArchiveImportJob>;
  markReplayReady(input: ClaimedArchiveImportJob): Promise<ArchiveImportJob>;
  markRetry(input: RetryArchiveImportJob): Promise<ArchiveImportJob>;
  recoverExpiredClaims(now: Date): Promise<number>;
  renewClaim(
    input: RenewArchiveImportJobClaim,
  ): Promise<ArchiveImportJob | null>;
}

export interface FeaturedReplayConfigInput {
  archiveManifestId: string;
  enabled?: boolean;
  fixtureId: string;
  slot: string;
}

export interface FeaturedReplayConfig {
  archiveManifestHash: string;
  archiveManifestId: string;
  enabled: boolean;
  fixtureId: string;
  slot: string;
}

/** A config is readable only while its exact manifest remains replay-ready. */
export interface FeaturedReplayReady {
  archiveManifestHash: string;
  archiveManifestId: string;
  fixtureId: string;
  slot: string;
}

export interface FeaturedReplayRepository {
  configure(input: FeaturedReplayConfigInput): Promise<FeaturedReplayConfig>;
  ready(slot: string): Promise<FeaturedReplayReady | null>;
}

const jobColumns = `fixture_id, home_team_id, away_team_id, kickoff_at,
participant1_is_home, context_hash, source_context, reason, state, archive_manifest_id,
archive_manifest_hash, attempt_count, last_error, available_at, claimed_by, claim_expires_at,
claim_generation, claim_started_at, source_terminal_record_id, created_at, updated_at`;

const outputColumns = `fixture_id, claim_generation, claim_started_at,
source_terminal_record_id, worker_id, archive_manifest_id, archive_manifest_hash,
archive_terminal_delivery_id, archive_verified_at, created_at`;

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

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function sourceContextString(
  value: Record<string, unknown>,
  key: string,
): string {
  const field = value[key];
  if (typeof field !== "string" || field.trim().length === 0) {
    throw new Error(`Archive import source context ${key} is invalid`);
  }
  return field;
}

function sourceContextSafeInteger(
  value: Record<string, unknown>,
  key: string,
): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
    throw new Error(`Archive import source context ${key} is invalid`);
  }
  return field;
}

function sourceContextBoolean(
  value: Record<string, unknown>,
  key: string,
): boolean {
  if (typeof value[key] !== "boolean") {
    throw new Error(`Archive import source context ${key} is invalid`);
  }
  return value[key] as boolean;
}

function parseSourceContext(value: unknown): ArchiveImportSourceContext {
  const root = object(value, "Archive import source context");
  const participant1 = object(root.participant1, "Archive import participant1");
  const participant2 = object(root.participant2, "Archive import participant2");
  const schedule = object(root.schedule, "Archive import schedule source");
  const kickoffAt = sourceContextString(root, "kickoffAt");
  const context = {
    fixtureGroupId: sourceContextString(root, "fixtureGroupId"),
    fixtureId: sourceContextString(root, "fixtureId"),
    gameState: sourceContextSafeInteger(root, "gameState"),
    kickoffAt,
    participant1: {
      code: sourceContextString(participant1, "code"),
      id: sourceContextString(participant1, "id"),
      name: sourceContextString(participant1, "name"),
    },
    participant1IsHome: sourceContextBoolean(root, "participant1IsHome"),
    participant2: {
      code: sourceContextString(participant2, "code"),
      id: sourceContextString(participant2, "id"),
      name: sourceContextString(participant2, "name"),
    },
    schedule: {
      competition: sourceContextString(schedule, "competition"),
      competitionId: sourceContextString(schedule, "competitionId"),
      responseHash: sourceContextString(schedule, "responseHash"),
      source: sourceContextString(schedule, "source"),
      sourcePath: sourceContextString(schedule, "sourcePath"),
      sourceTimestampMs: sourceContextSafeInteger(
        schedule,
        "sourceTimestampMs",
      ),
    },
  };
  assertTimestamp(context.kickoffAt, "Archive import source context kickoff");
  assertSha256(
    context.schedule.responseHash,
    "Archive import schedule source hash",
  );
  return context;
}

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
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return "null";
}

export function hashArchiveImportSourceContext(
  sourceContext: ArchiveImportSourceContext,
): string {
  return createHash("sha256").update(stableJson(sourceContext)).digest("hex");
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
    archiveManifestHash: nullableString(row, "archive_manifest_hash"),
    archiveManifestId: nullableString(row, "archive_manifest_id"),
    attemptCount: safeInteger(row, "attempt_count"),
    availableAt: timestamp(row, "available_at"),
    awayTeamId: requiredString(row, "away_team_id"),
    claimExpiresAt: nullableTimestamp(row, "claim_expires_at"),
    claimGeneration: safeInteger(row, "claim_generation"),
    claimStartedAt: nullableTimestamp(row, "claim_started_at"),
    claimedBy: nullableString(row, "claimed_by"),
    contextHash: requiredString(row, "context_hash"),
    createdAt: timestamp(row, "created_at"),
    fixtureId: requiredString(row, "fixture_id"),
    homeTeamId: requiredString(row, "home_team_id"),
    kickoffAt: timestamp(row, "kickoff_at"),
    lastError: nullableString(row, "last_error"),
    participant1IsHome: boolean(row, "participant1_is_home"),
    reason: importReason(requiredString(row, "reason")),
    sourceContext:
      row.source_context === null || row.source_context === undefined
        ? null
        : parseSourceContext(
            typeof row.source_context === "string"
              ? JSON.parse(row.source_context)
              : row.source_context,
          ),
    sourceTerminalRecordId: requiredString(row, "source_terminal_record_id"),
    state: importState(requiredString(row, "state")),
    updatedAt: timestamp(row, "updated_at"),
  };
}

function parseVerifiedOutput(row: QueryRow): ArchiveImportVerifiedOutput {
  return {
    archiveManifestHash: requiredString(row, "archive_manifest_hash"),
    archiveManifestId: requiredString(row, "archive_manifest_id"),
    archiveTerminalDeliveryId: requiredString(
      row,
      "archive_terminal_delivery_id",
    ),
    archiveVerifiedAt: timestamp(row, "archive_verified_at"),
    claimGeneration: safeInteger(row, "claim_generation"),
    claimStartedAt: timestamp(row, "claim_started_at"),
    fixtureId: requiredString(row, "fixture_id"),
    sourceTerminalRecordId: requiredString(row, "source_terminal_record_id"),
    workerId: requiredString(row, "worker_id"),
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
  const sourceContext = parseSourceContext(input.sourceContext);
  const expectedHome = sourceContext.participant1IsHome
    ? sourceContext.participant1.code
    : sourceContext.participant2.code;
  const expectedAway = sourceContext.participant1IsHome
    ? sourceContext.participant2.code
    : sourceContext.participant1.code;
  if (
    sourceContext.fixtureId !== input.fixtureId ||
    sourceContext.participant1IsHome !== input.participant1IsHome ||
    sourceContext.kickoffAt !== input.kickoffAt ||
    expectedHome !== input.homeTeamId ||
    expectedAway !== input.awayTeamId
  ) {
    throw new Error(
      "Archive import input does not match its frozen schedule context",
    );
  }
  if (hashArchiveImportSourceContext(sourceContext) !== input.contextHash) {
    throw new Error(
      "Frozen fixture context hash does not match source context",
    );
  }
}

function assertClaimGeneration(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Archive import claim generation is invalid");
  }
}

function assertClaimedTransition(input: ClaimedArchiveImportJob): void {
  assertNonempty(input.fixtureId, "Fixture id");
  assertNonempty(input.workerId, "Archive import worker id");
  assertClaimGeneration(input.claimGeneration);
}

function assertWorkerTransition(
  input: TerminalArchiveImportJob | RetryArchiveImportJob,
): void {
  assertClaimedTransition(input);
  assertNonempty(input.error, "Archive import error");
}

function jobSelectColumns(alias = "job"): string {
  return jobColumns
    .split(",")
    .map((column) => `${alias}.${column.trim()}`)
    .join(", ");
}

function outputSelectColumns(alias = "output"): string {
  return outputColumns
    .split(",")
    .map((column) => `${alias}.${column.trim()}`)
    .join(", ");
}

type EnqueueMode = "explicit_correction" | "live_terminal";

async function enqueueArchiveImportJobInTransaction(
  transaction: SqlExecutor,
  input: ArchiveImportJobInput,
  mode: EnqueueMode,
): Promise<ArchiveImportJob> {
  assertJobInput(input);
  const correctionReason =
    mode === "live_terminal" ? "'live_correction'" : "EXCLUDED.reason";
  const correctionPredicate =
    mode === "live_terminal"
      ? `EXCLUDED.reason = 'live_terminal'
  AND matchsense.archive_import_jobs.reason IN ('live_terminal', 'live_correction')`
      : "EXCLUDED.reason = 'live_correction'";
  const inserted = await transaction.unsafe(
    `INSERT INTO matchsense.archive_import_jobs (
  fixture_id, home_team_id, away_team_id, kickoff_at, participant1_is_home,
  context_hash, source_context, reason, source_terminal_record_id
)
VALUES ($1, $2, $3, $4::timestamptz, $5, $6, $7::jsonb, $8, $9)
ON CONFLICT (fixture_id) DO UPDATE
SET reason = ${correctionReason},
    state = 'queued',
    archive_manifest_id = NULL,
    archive_manifest_hash = NULL,
    available_at = clock_timestamp(),
    claimed_by = NULL,
    claim_expires_at = NULL,
    claim_started_at = NULL,
    last_error = NULL,
    source_terminal_record_id = EXCLUDED.source_terminal_record_id,
    updated_at = clock_timestamp()
WHERE ${correctionPredicate}
  AND matchsense.archive_import_jobs.source_terminal_record_id
      IS DISTINCT FROM EXCLUDED.source_terminal_record_id
RETURNING ${jobColumns};`,
    [
      input.fixtureId,
      input.homeTeamId,
      input.awayTeamId,
      input.kickoffAt,
      input.participant1IsHome,
      input.contextHash,
      input.sourceContext,
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
}

/**
 * Transaction-local enqueue primitive. Callers that already hold a source
 * frame transaction must use this instead of opening a second transaction.
 */
export async function enqueueArchiveImportJob(
  transaction: SqlExecutor,
  input: ArchiveImportJobInput,
): Promise<ArchiveImportJob> {
  return enqueueArchiveImportJobInTransaction(
    transaction,
    input,
    "explicit_correction",
  );
}

/**
 * A fresh terminal inserts as `live_terminal`; a distinct provider terminal
 * ID for the same frozen fixture atomically requeues it as `live_correction`.
 */
export async function enqueueLiveTerminalArchiveImportJob(
  transaction: SqlExecutor,
  input: LiveTerminalArchiveImportJobInput,
): Promise<ArchiveImportJob> {
  return enqueueArchiveImportJobInTransaction(
    transaction,
    { ...input, reason: "live_terminal" },
    "live_terminal",
  );
}

/**
 * Makes an existing terminal import unable to publish after a generic live
 * correction. A later distinct authoritative terminal can still use the
 * normal live-terminal conflict path to requeue this row as `live_correction`
 * while preserving its frozen schedule context.
 */
export async function supersedeLiveTerminalArchiveImportJobForCorrection(
  transaction: SqlExecutor,
  input: SupersedeLiveTerminalArchiveImportJobForCorrectionInput,
): Promise<void> {
  assertNonempty(input.fixtureId, "Fixture id");
  assertNonempty(input.reason, "Archive correction supersession reason");
  await transaction.unsafe(
    `UPDATE matchsense.archive_import_jobs
SET state = 'rejected',
    archive_manifest_id = NULL,
    archive_manifest_hash = NULL,
    claimed_by = NULL,
    claim_expires_at = NULL,
    claim_started_at = NULL,
    claim_generation = claim_generation + 1,
    last_error = $2,
    updated_at = clock_timestamp()
WHERE fixture_id = $1
  AND reason IN ('live_terminal', 'live_correction')
  AND state IN ('queued', 'retry_wait', 'claimed');`,
    [input.fixtureId, input.reason],
  );
}

export function createArchiveImportJobRepository(
  client: RepositoryClient,
): ArchiveImportJobRepository {
  return {
    enqueue: async (input) =>
      client.begin(async (transaction) =>
        enqueueArchiveImportJob(transaction, input),
      ),
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
    claim_expires_at = clock_timestamp() + interval '120 seconds',
    claim_generation = job.claim_generation + 1,
    claim_started_at = clock_timestamp(),
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
    renewClaim: async (input) => {
      assertClaimedTransition(input);
      assertTimestamp(input.claimExpiresAt, "Archive import claim expiry");
      const rows = await client.unsafe(
        `UPDATE matchsense.archive_import_jobs
SET claim_expires_at = $1::timestamptz,
    updated_at = clock_timestamp()
WHERE fixture_id = $2
  AND state = 'claimed'
  AND claimed_by = $3
  AND claim_generation = $4
  AND claim_expires_at > clock_timestamp()
  AND $1::timestamptz > claim_expires_at
RETURNING ${jobColumns};`,
        [
          input.claimExpiresAt,
          input.fixtureId,
          input.workerId,
          input.claimGeneration,
        ],
      );
      return rows[0] ? parseJob(rows[0]) : null;
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
      claim_started_at = NULL,
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
    claim_started_at = NULL,
    available_at = $1::timestamptz,
    last_error = $2,
    updated_at = clock_timestamp()
WHERE fixture_id = $3
  AND state = 'claimed'
  AND claimed_by = $4
  AND claim_generation = $5
  AND claim_expires_at > clock_timestamp()
RETURNING ${jobColumns};`,
        [
          input.availableAt,
          input.error,
          input.fixtureId,
          input.workerId,
          input.claimGeneration,
        ],
      );
      if (!rows[0]) {
        throw new Error("Archive import job is not claimed by this worker");
      }
      return parseJob(rows[0]);
    },
    bindVerifiedArchiveOutput: async (input) => {
      assertClaimedTransition(input);
      assertNonempty(input.archiveManifestId, "Archive manifest id");
      assertSha256(input.archiveManifestHash, "Archive manifest hash");
      const rows = await client.unsafe(
        `INSERT INTO matchsense.archive_import_job_outputs AS output (
  fixture_id, claim_generation, claim_started_at, source_terminal_record_id,
  worker_id, archive_manifest_id, archive_manifest_hash,
  archive_terminal_delivery_id, archive_verified_at
)
SELECT job.fixture_id, job.claim_generation, job.claim_started_at,
  job.source_terminal_record_id, job.claimed_by, archive.id,
  archive.delivery_manifest_hash, archive.terminal_delivery_id,
  archive.verified_at
FROM matchsense.archive_import_jobs AS job
JOIN matchsense.archive_manifests AS archive ON archive.id = $1
JOIN matchsense.rights_grants AS grant ON grant.id = archive.rights_grant_id
WHERE job.fixture_id = $3
  AND job.state = 'claimed'
  AND job.claimed_by = $4
  AND job.claim_generation = $5
  AND job.claim_started_at IS NOT NULL
  AND job.claim_expires_at > clock_timestamp()
  AND archive.delivery_manifest_hash = $2
  AND archive.fixture_id = job.fixture_id
  AND archive.mode = 'recorded'
  AND archive.status = 'REPLAY_READY'
  AND archive.verified_at IS NOT NULL
  AND archive.verified_at >= job.claim_started_at
  AND grant.active = true
  AND grant.revoked_at IS NULL
  AND (grant.expires_at IS NULL OR grant.expires_at > clock_timestamp())
  AND grant.scopes @> ARRAY['replay']::text[]
ON CONFLICT (fixture_id, claim_generation) DO UPDATE
SET archive_manifest_id = output.archive_manifest_id
WHERE output.claim_started_at = EXCLUDED.claim_started_at
  AND output.source_terminal_record_id = EXCLUDED.source_terminal_record_id
  AND output.worker_id = EXCLUDED.worker_id
  AND output.archive_manifest_id = EXCLUDED.archive_manifest_id
  AND output.archive_manifest_hash = EXCLUDED.archive_manifest_hash
  AND output.archive_terminal_delivery_id = EXCLUDED.archive_terminal_delivery_id
  AND output.archive_verified_at = EXCLUDED.archive_verified_at
RETURNING ${outputSelectColumns()};`,
        [
          input.archiveManifestId,
          input.archiveManifestHash,
          input.fixtureId,
          input.workerId,
          input.claimGeneration,
        ],
      );
      if (!rows[0]) {
        throw new Error(
          "Archive import job claim or current archive output is invalid",
        );
      }
      return parseVerifiedOutput(rows[0]);
    },
    markReplayReady: async (input) => {
      assertClaimedTransition(input);
      const rows = await client.unsafe(
        `UPDATE matchsense.archive_import_jobs AS job
SET state = 'replay_ready',
    archive_manifest_id = output.archive_manifest_id,
    archive_manifest_hash = output.archive_manifest_hash,
    claimed_by = NULL,
    claim_expires_at = NULL,
    claim_started_at = NULL,
    last_error = NULL,
    updated_at = clock_timestamp()
FROM matchsense.archive_import_job_outputs AS output
JOIN matchsense.archive_manifests AS archive
  ON archive.id = output.archive_manifest_id
JOIN matchsense.rights_grants AS grant ON grant.id = archive.rights_grant_id
WHERE job.fixture_id = $1
  AND job.state = 'claimed'
  AND job.claimed_by = $2
  AND job.claim_generation = $3
  AND job.claim_expires_at > clock_timestamp()
  AND output.fixture_id = job.fixture_id
  AND output.claim_generation = job.claim_generation
  AND output.claim_started_at = job.claim_started_at
  AND output.worker_id = job.claimed_by
  AND output.source_terminal_record_id = job.source_terminal_record_id
  AND archive.fixture_id = job.fixture_id
  AND archive.mode = 'recorded'
  AND archive.status = 'REPLAY_READY'
  AND archive.delivery_manifest_hash = output.archive_manifest_hash
  AND archive.terminal_delivery_id = output.archive_terminal_delivery_id
  AND archive.verified_at = output.archive_verified_at
  AND archive.verified_at >= job.claim_started_at
  AND grant.active = true
  AND grant.revoked_at IS NULL
  AND (grant.expires_at IS NULL OR grant.expires_at > clock_timestamp())
  AND grant.scopes @> ARRAY['replay']::text[]
RETURNING ${jobSelectColumns()};`,
        [input.fixtureId, input.workerId, input.claimGeneration],
      );
      if (!rows[0]) {
        throw new Error(
          "Archive import job claim or verified archive output is invalid",
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
    claim_started_at = NULL,
    last_error = $1,
    updated_at = clock_timestamp()
WHERE fixture_id = $2
  AND state = 'claimed'
  AND claimed_by = $3
  AND claim_generation = $4
  AND claim_expires_at > clock_timestamp()
RETURNING ${jobColumns};`,
        [input.error, input.fixtureId, input.workerId, input.claimGeneration],
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
    claim_started_at = NULL,
    last_error = $1,
    updated_at = clock_timestamp()
WHERE fixture_id = $2
  AND state = 'claimed'
  AND claimed_by = $3
  AND claim_generation = $4
  AND claim_expires_at > clock_timestamp()
RETURNING ${jobColumns};`,
        [input.error, input.fixtureId, input.workerId, input.claimGeneration],
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
    archiveManifestHash: requiredString(row, "archive_manifest_hash"),
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
      return client.begin(async (transaction) => {
        const rows = await transaction.unsafe(
          `INSERT INTO matchsense.featured_replay_configs (
  slot, fixture_id, archive_manifest_id, archive_manifest_hash, enabled
)
SELECT $1, $2, manifest.id, manifest.delivery_manifest_hash, $3
FROM matchsense.archive_manifests AS manifest
JOIN matchsense.rights_grants AS grant ON grant.id = manifest.rights_grant_id
WHERE manifest.id = $4
  AND manifest.fixture_id = $2
  AND manifest.mode = 'recorded'
  AND manifest.status = 'REPLAY_READY'
  AND EXISTS (
    SELECT 1
    FROM matchsense.archive_import_jobs AS archive_job
    JOIN matchsense.archive_import_job_outputs AS archive_output
      ON archive_output.fixture_id = archive_job.fixture_id
      AND archive_output.claim_generation = archive_job.claim_generation
      AND archive_output.archive_manifest_id = archive_job.archive_manifest_id
      AND archive_output.archive_manifest_hash = archive_job.archive_manifest_hash
    WHERE archive_job.fixture_id = manifest.fixture_id
      AND archive_job.state = 'replay_ready'
      AND archive_job.archive_manifest_id = manifest.id
      AND archive_job.archive_manifest_hash = manifest.delivery_manifest_hash
  )
  AND grant.active = true
  AND grant.revoked_at IS NULL
  AND (grant.expires_at IS NULL OR grant.expires_at > clock_timestamp())
  AND grant.scopes @> ARRAY['replay']::text[]
ON CONFLICT (slot) DO UPDATE
SET fixture_id = EXCLUDED.fixture_id,
    archive_manifest_id = EXCLUDED.archive_manifest_id,
    archive_manifest_hash = EXCLUDED.archive_manifest_hash,
    enabled = EXCLUDED.enabled,
    updated_at = clock_timestamp()
RETURNING slot, fixture_id, archive_manifest_id, archive_manifest_hash, enabled;`,
          [
            input.slot,
            input.fixtureId,
            input.enabled ?? true,
            input.archiveManifestId,
          ],
        );
        if (!rows[0]) {
          throw new Error(
            "Featured replay manifest is not current, replay-ready, and authorised",
          );
        }
        return parseFeaturedConfig(rows[0]);
      });
    },
    ready: async (slot) => {
      assertNonempty(slot, "Featured replay slot");
      const rows = await client.unsafe(
        `SELECT config.slot, config.fixture_id, config.archive_manifest_id,
  config.archive_manifest_hash
FROM matchsense.featured_replay_configs AS config
JOIN matchsense.archive_import_jobs AS job
  ON job.fixture_id = config.fixture_id
JOIN matchsense.archive_import_job_outputs AS output
  ON output.fixture_id = job.fixture_id
  AND output.claim_generation = job.claim_generation
  AND output.archive_manifest_id = job.archive_manifest_id
  AND output.archive_manifest_hash = job.archive_manifest_hash
JOIN matchsense.archive_manifests AS archive
  ON archive.id = config.archive_manifest_id
JOIN matchsense.rights_grants AS grant ON grant.id = archive.rights_grant_id
WHERE config.slot = $1
  AND config.enabled = true
  AND job.state = 'replay_ready'
  AND job.archive_manifest_id = config.archive_manifest_id
  AND job.archive_manifest_hash = config.archive_manifest_hash
  AND archive.fixture_id = config.fixture_id
  AND archive.mode = 'recorded'
  AND archive.status = 'REPLAY_READY'
  AND archive.delivery_manifest_hash = config.archive_manifest_hash
  AND grant.active = true
  AND grant.revoked_at IS NULL
  AND (grant.expires_at IS NULL OR grant.expires_at > clock_timestamp())
  AND grant.scopes @> ARRAY['replay']::text[];`,
        [slot],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        archiveManifestHash: requiredString(row, "archive_manifest_hash"),
        archiveManifestId: requiredString(row, "archive_manifest_id"),
        fixtureId: requiredString(row, "fixture_id"),
        slot: requiredString(row, "slot"),
      };
    },
  };
}
