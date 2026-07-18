import { createHash } from "node:crypto";

import type { ArchiveMode } from "./archive-repositories.js";
import type { QueryRow, RepositoryClient } from "./repositories.js";

export type CommentaryJobStatus =
  "queued" | "claimed" | "ready" | "failed" | "superseded";

export interface CommentaryJobInput {
  familyId: string;
  fixtureId: string;
  id: string;
  language: string;
  mode: ArchiveMode;
  momentRevision: number;
  templateVersion: string;
  voice: string;
}

export interface CommentaryJob extends CommentaryJobInput {
  artifactId: string | null;
  artifactSha256: string | null;
  attemptCount: number;
  claimExpiresAt: string | null;
  claimedAt: string | null;
  claimedBy: string | null;
  createdAt: string;
  lastError: string | null;
  status: CommentaryJobStatus;
  updatedAt: string;
}

export interface CompletedCommentaryJob {
  artifactId: string;
  audioBytes: Uint8Array;
  audioHash: string;
  jobId: string;
  mediaType?: string;
  workerId: string;
}

export interface FailedCommentaryJob {
  error: string;
  jobId: string;
  workerId: string;
}

export interface SupersedeCommentaryJob {
  familyId: string;
  fixtureId: string;
  mode: ArchiveMode;
  revision: number;
}

export interface CommentaryJobRepository {
  claim(workerId: string, now: Date): Promise<CommentaryJob | null>;
  complete(input: CompletedCommentaryJob): Promise<void>;
  enqueue(input: CommentaryJobInput): Promise<CommentaryJob>;
  fail(input: FailedCommentaryJob): Promise<void>;
  supersede(input: SupersedeCommentaryJob): Promise<void>;
}

const jobColumns = `id, mode, fixture_id, family_id, moment_revision, language,
voice, template_version, status, artifact_id, artifact_sha256, claimed_by,
claimed_at, claim_expires_at, attempt_count, last_error, created_at, updated_at`;

function requiredString(row: QueryRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
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

function safeInteger(value: unknown, key: string): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (
    typeof parsed !== "number" ||
    !Number.isSafeInteger(parsed) ||
    parsed < 0
  ) {
    throw new Error(`Database row field ${key} is invalid`);
  }
  return parsed;
}

function archiveMode(value: string): ArchiveMode {
  if (value === "live" || value === "recorded") return value;
  throw new Error("Database row field mode is invalid");
}

function jobStatus(value: string): CommentaryJobStatus {
  if (
    value === "queued" ||
    value === "claimed" ||
    value === "ready" ||
    value === "failed" ||
    value === "superseded"
  ) {
    return value;
  }
  throw new Error("Database row field status is invalid");
}

function parseJob(row: QueryRow): CommentaryJob {
  return {
    artifactId: nullableString(row, "artifact_id"),
    artifactSha256: nullableString(row, "artifact_sha256"),
    attemptCount: safeInteger(row.attempt_count, "attempt_count"),
    claimExpiresAt: nullableTimestamp(row, "claim_expires_at"),
    claimedAt: nullableTimestamp(row, "claimed_at"),
    claimedBy: nullableString(row, "claimed_by"),
    createdAt: timestamp(row, "created_at"),
    familyId: requiredString(row, "family_id"),
    fixtureId: requiredString(row, "fixture_id"),
    id: requiredString(row, "id"),
    language: requiredString(row, "language"),
    lastError: nullableString(row, "last_error"),
    mode: archiveMode(requiredString(row, "mode")),
    momentRevision: safeInteger(row.moment_revision, "moment_revision"),
    status: jobStatus(requiredString(row, "status")),
    templateVersion: requiredString(row, "template_version"),
    updatedAt: timestamp(row, "updated_at"),
    voice: requiredString(row, "voice"),
  };
}

function assertNonempty(value: string, label: string) {
  if (value.trim().length === 0) throw new Error(`${label} is required`);
}

function assertSha256(value: string, label: string) {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} must be lowercase SHA-256 hex`);
  }
}

function assertJobInput(input: CommentaryJobInput) {
  for (const [value, label] of [
    [input.id, "Commentary job id"],
    [input.fixtureId, "Fixture id"],
    [input.familyId, "Moment family id"],
    [input.language, "Language"],
    [input.voice, "Voice"],
    [input.templateVersion, "Template version"],
  ] as const) {
    assertNonempty(value, label);
  }
  if (!Number.isSafeInteger(input.momentRevision) || input.momentRevision < 1) {
    throw new Error("Moment revision must be a positive safe integer");
  }
}

export function createCommentaryJobRepository(
  client: RepositoryClient,
): CommentaryJobRepository {
  return {
    enqueue: async (input) => {
      assertJobInput(input);
      const rows = await client.unsafe(
        `INSERT INTO matchsense.commentary_jobs (
  id, mode, fixture_id, family_id, moment_revision, language, voice,
  template_version, status
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued')
ON CONFLICT (mode, fixture_id, family_id, moment_revision, language, voice, template_version)
DO UPDATE SET updated_at = clock_timestamp()
RETURNING ${jobColumns};`,
        [
          input.id,
          input.mode,
          input.fixtureId,
          input.familyId,
          input.momentRevision,
          input.language,
          input.voice,
          input.templateVersion,
        ],
      );
      const row = rows[0];
      if (!row) throw new Error("Commentary job enqueue returned no row");
      return parseJob(row);
    },
    claim: async (workerId, now) => {
      assertNonempty(workerId, "Commentary worker id");
      if (Number.isNaN(now.valueOf())) throw new Error("Claim time is invalid");
      return client.begin(async (transaction) => {
        const rows = await transaction.unsafe(
          `WITH candidate AS (
  SELECT id
  FROM matchsense.commentary_jobs
  WHERE status = 'queued'
    OR (status = 'claimed' AND claim_expires_at <= $2::timestamptz)
  ORDER BY created_at ASC, id ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE matchsense.commentary_jobs AS job
SET status = 'claimed',
    claimed_by = $1,
    claimed_at = $2::timestamptz,
    claim_expires_at = $2::timestamptz + interval '60 seconds',
    attempt_count = job.attempt_count + 1,
    last_error = NULL,
    updated_at = clock_timestamp()
FROM candidate
WHERE job.id = candidate.id
RETURNING ${jobColumns
            .split(",")
            .map((column) => `job.${column.trim()}`)
            .join(", ")};`,
          [workerId, now.toISOString()],
        );
        return rows[0] ? parseJob(rows[0]) : null;
      });
    },
    complete: async (input) => {
      assertNonempty(input.jobId, "Commentary job id");
      assertNonempty(input.workerId, "Commentary worker id");
      assertNonempty(input.artifactId, "Commentary artifact id");
      if (
        !(input.audioBytes instanceof Uint8Array) ||
        input.audioBytes.byteLength === 0
      ) {
        throw new Error("Commentary audio bytes must not be empty");
      }
      assertSha256(input.audioHash, "Commentary audio hash");
      const computedHash = createHash("sha256")
        .update(input.audioBytes)
        .digest("hex");
      if (computedHash !== input.audioHash) {
        throw new Error("Commentary audio hash does not match bytes");
      }

      await client.begin(async (transaction) => {
        const jobRows = await transaction.unsafe(
          `SELECT ${jobColumns}
FROM matchsense.commentary_jobs
WHERE id = $1
FOR UPDATE;`,
          [input.jobId],
        );
        const jobRow = jobRows[0];
        if (!jobRow) throw new Error("Commentary job does not exist");
        const job = parseJob(jobRow);
        if (job.status !== "claimed" || job.claimedBy !== input.workerId) {
          throw new Error("Commentary job is not claimed by this worker");
        }
        const artifactRows = await transaction.unsafe(
          `INSERT INTO matchsense.commentary_artifacts (
  mode, id, fixture_id, moment_id, moment_revision, language, voice,
  template_version, media_type, bytes
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
ON CONFLICT (mode, fixture_id, moment_id, moment_revision, language, voice, template_version)
DO UPDATE SET
  media_type = EXCLUDED.media_type,
  bytes = EXCLUDED.bytes,
  updated_at = clock_timestamp()
RETURNING id;`,
          [
            job.mode,
            input.artifactId,
            job.fixtureId,
            job.familyId,
            job.momentRevision,
            job.language,
            job.voice,
            job.templateVersion,
            input.mediaType ?? "audio/mpeg",
            input.audioBytes,
          ],
        );
        const artifactRow = artifactRows[0];
        if (!artifactRow) {
          throw new Error("Commentary artifact upsert returned no row");
        }
        const persistedArtifactId = requiredString(artifactRow, "id");
        const completedRows = await transaction.unsafe(
          `UPDATE matchsense.commentary_jobs
SET status = 'ready',
    artifact_id = $1,
    artifact_sha256 = $2,
    claimed_by = NULL,
    claimed_at = NULL,
    claim_expires_at = NULL,
    last_error = NULL,
    updated_at = clock_timestamp()
WHERE id = $3 AND status = 'claimed' AND claimed_by = $4
  AND claim_expires_at > clock_timestamp()
RETURNING ${jobColumns};`,
          [persistedArtifactId, input.audioHash, input.jobId, input.workerId],
        );
        if (!completedRows[0]) {
          throw new Error("Commentary job claim was lost before completion");
        }
      });
    },
    fail: async (input) => {
      assertNonempty(input.jobId, "Commentary job id");
      assertNonempty(input.workerId, "Commentary worker id");
      assertNonempty(input.error, "Commentary failure reason");
      const rows = await client.unsafe(
        `UPDATE matchsense.commentary_jobs
SET status = 'failed',
    claimed_by = NULL,
    claimed_at = NULL,
    claim_expires_at = NULL,
    last_error = $1,
    updated_at = clock_timestamp()
WHERE id = $2 AND status = 'claimed' AND claimed_by = $3
RETURNING id;`,
        [input.error, input.jobId, input.workerId],
      );
      if (!rows[0])
        throw new Error("Commentary job is not claimed by this worker");
    },
    supersede: async (input) => {
      assertNonempty(input.fixtureId, "Fixture id");
      assertNonempty(input.familyId, "Moment family id");
      if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
        throw new Error("Moment revision must be a positive safe integer");
      }
      await client.unsafe(
        `UPDATE matchsense.commentary_jobs
SET status = 'superseded',
    claimed_by = NULL,
    claimed_at = NULL,
    claim_expires_at = NULL,
    updated_at = clock_timestamp()
WHERE mode = $1 AND fixture_id = $2 AND family_id = $3 AND moment_revision = $4
  AND status <> 'superseded';`,
        [input.mode, input.fixtureId, input.familyId, input.revision],
      );
    },
  };
}
