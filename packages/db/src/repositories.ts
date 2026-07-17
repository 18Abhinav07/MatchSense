export type PersistenceMode = "live" | "demo";
export type PersistenceProvenance = "live_txline" | "synthetic_txline_shaped";

export type QueryRow = Record<string, unknown>;

export interface SqlExecutor {
  unsafe(
    query: string,
    parameters?: readonly unknown[],
  ): Promise<readonly QueryRow[]>;
}

export interface RepositoryClient extends SqlExecutor {
  begin<T>(work: (transaction: SqlExecutor) => Promise<T>): Promise<T>;
}

export interface FixtureRecord {
  awayTeamId: string;
  createdAt: string;
  homeTeamId: string;
  id: string;
  metadata: Record<string, unknown>;
  mode: PersistenceMode;
  provenance: PersistenceProvenance;
  scheduledAt: string;
  status: string;
  updatedAt: string;
}

export interface FixtureUpsert {
  awayTeamId: string;
  homeTeamId: string;
  id: string;
  metadata: Record<string, unknown>;
  mode: PersistenceMode;
  provenance: PersistenceProvenance;
  scheduledAt: string;
  status: string;
}

export interface RawSourceRecordWrite {
  dedupeKey: string;
  id: string;
  payload: unknown;
  payloadHash: string;
  provenance: PersistenceProvenance;
  receivedAt: string;
  source: string;
  sourceRecordId: string | null;
  sourceSequence: string | null;
}

export interface SourceFence {
  fencingToken: number;
  holderId: string;
  source: string;
  streamKey: string;
}

export interface CommitSourceChangeInput {
  event: { id: string; payload: unknown; type: string };
  expectedRevision: number;
  fixtureId: string;
  mode: PersistenceMode;
  moment: { id: string; kind: string; payload: unknown; revision: number };
  outbox: {
    availableAt?: string;
    id: string;
    idempotencyKey: string;
    payload: unknown;
    topic: string;
  };
  projection: { payload: unknown; revision: number };
  raw: RawSourceRecordWrite;
  sourceFence?: SourceFence;
}

export interface CommitFixtureScheduleInput {
  fixture: FixtureUpsert;
  raw: RawSourceRecordWrite;
  sourceFence?: SourceFence;
}

export interface CommitRawSourceRecordInput {
  fixtureId: string;
  mode: PersistenceMode;
  raw: RawSourceRecordWrite;
  sourceFence?: SourceFence;
}

export type CommitRawSourceRecordResult =
  { kind: "duplicate" } | { kind: "committed" } | { kind: "fenced" };

export type CommitFixtureScheduleResult =
  | { kind: "duplicate" }
  | { fixture: FixtureRecord; kind: "committed" }
  | { kind: "fenced" };

export type CommitSourceChangeResult =
  | { kind: "duplicate" }
  | { eventSequence: number; kind: "committed"; revision: number }
  | { kind: "fenced" };

export interface FixtureEventRecord {
  createdAt: string;
  eventId: string;
  eventType: string;
  fixtureId: string;
  mode: PersistenceMode;
  payload: unknown;
  sequence: number;
}

export interface FixtureProjectionRecord {
  fixtureId: string;
  mode: PersistenceMode;
  payload: unknown;
  revision: number;
  sourceSequence: string | null;
  updatedAt: string;
}

export class FixtureRevisionConflictError extends Error {
  readonly actualRevision: number;
  readonly code = "FIXTURE_REVISION_CONFLICT" as const;
  readonly expectedRevision: number;

  constructor(expectedRevision: number, actualRevision: number) {
    super("Fixture projection revision changed");
    this.name = "FixtureRevisionConflictError";
    this.actualRevision = actualRevision;
    this.expectedRevision = expectedRevision;
  }
}

export interface FixtureTruthRepository {
  commitFixtureSchedule(
    input: CommitFixtureScheduleInput,
  ): Promise<CommitFixtureScheduleResult>;
  commitRawSourceRecord(
    input: CommitRawSourceRecordInput,
  ): Promise<CommitRawSourceRecordResult>;
  commitSourceChange(
    input: CommitSourceChangeInput,
  ): Promise<CommitSourceChangeResult>;
  eventsAfter(input: {
    afterSequence: number;
    fixtureId: string;
    limit?: number;
    mode: PersistenceMode;
  }): Promise<readonly FixtureEventRecord[]>;
  get(input: {
    fixtureId: string;
    mode: PersistenceMode;
  }): Promise<FixtureRecord | null>;
  getLatestProjection(input: {
    fixtureId: string;
    mode: PersistenceMode;
  }): Promise<FixtureProjectionRecord | null>;
  list(input: {
    limit?: number;
    mode: PersistenceMode;
    scheduledFrom?: string;
    scheduledTo?: string;
  }): Promise<readonly FixtureRecord[]>;
  upsert(input: FixtureUpsert): Promise<FixtureRecord>;
}

export interface SourceStreamKey {
  mode: PersistenceMode;
  source: string;
  streamKey: string;
}

export interface SourceCursorRecord extends SourceStreamKey {
  cursorValue: string;
  fencingToken: number;
  updatedAt: string;
}

export interface SourceLeaseRecord extends SourceStreamKey {
  fencingToken: number;
  holderId: string;
  leaseUntil: string;
  updatedAt: string;
}

export interface FencedSourceLeaseKey extends SourceStreamKey {
  fencingToken: number;
  holderId: string;
}

export type AdvanceSourceCursorResult =
  | { cursor: SourceCursorRecord; kind: "advanced" }
  | { currentCursor: string | null; kind: "conflict" }
  | { kind: "fenced" };

export interface SourceStateRepository {
  acquireLease(
    input: SourceStreamKey & { holderId: string; leaseUntil: string },
  ): Promise<SourceLeaseRecord | null>;
  advanceCursor(
    input: FencedSourceLeaseKey & {
      cursorValue: string;
      expectedCursor: string | null;
    },
  ): Promise<AdvanceSourceCursorResult>;
  getCursor(input: SourceStreamKey): Promise<SourceCursorRecord | null>;
  releaseLease(input: FencedSourceLeaseKey): Promise<boolean>;
  renewLease(
    input: FencedSourceLeaseKey & { leaseUntil: string },
  ): Promise<SourceLeaseRecord | null>;
}

export interface CommentaryArtifactKey {
  fixtureId: string;
  language: string;
  mode: PersistenceMode;
  momentId: string;
  momentRevision: number;
  voice: string;
}

export interface CommentaryArtifactRecord extends CommentaryArtifactKey {
  bytes: Uint8Array;
  createdAt: string;
  id: string;
  mediaType: string;
  updatedAt: string;
}

export interface CommentaryArtifactRepository {
  get(input: CommentaryArtifactKey): Promise<CommentaryArtifactRecord | null>;
  upsert(
    input: CommentaryArtifactKey & {
      bytes: Uint8Array;
      id: string;
      mediaType?: string;
    },
  ): Promise<CommentaryArtifactRecord>;
}

export interface OutboxRecord {
  attemptCount: number;
  availableAt: string;
  claimToken: string | null;
  createdAt: string;
  fixtureId: string;
  id: string;
  idempotencyKey: string;
  lastError: string | null;
  lockedAt: string | null;
  lockedBy: string | null;
  mode: PersistenceMode;
  payload: unknown;
  processedAt: string | null;
  topic: string;
}

export interface OutboxWrite {
  availableAt?: string;
  fixtureId: string;
  id: string;
  idempotencyKey: string;
  mode: PersistenceMode;
  payload: unknown;
  topic: string;
}

export interface ConsumerReceiptKey {
  consumer: string;
  mode: PersistenceMode;
  outboxId: string;
}

export interface OutboxRepository {
  claim(input: {
    claimToken: string;
    limit: number;
    lockTimeoutMs: number;
    mode: PersistenceMode;
    topics: readonly string[];
    workerId: string;
  }): Promise<readonly OutboxRecord[]>;
  complete(input: {
    claimToken: string;
    id: string;
    mode: PersistenceMode;
    workerId: string;
  }): Promise<boolean>;
  enqueue(input: OutboxWrite): Promise<"duplicate" | "enqueued">;
  hasConsumerReceipt(input: ConsumerReceiptKey): Promise<boolean>;
  recordConsumerReceipt(input: ConsumerReceiptKey): Promise<boolean>;
  retryOrDeadLetter(input: {
    availableAt: string;
    claimToken: string;
    deadLetterId: string;
    error: string;
    id: string;
    maxAttempts: number;
    mode: PersistenceMode;
    workerId: string;
  }): Promise<
    { kind: "dead_letter" } | { kind: "not_claimed" } | { kind: "retry" }
  >;
}

function requiredString(row: QueryRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`Database row field ${key} is invalid`);
  }
  return value;
}

function nullableString(row: QueryRow, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  return requiredString(row, key);
}

function timestamp(row: QueryRow, key: string): string {
  const value = row[key];
  if (value instanceof Date) return value.toISOString();
  return requiredString(row, key);
}

function nullableTimestamp(row: QueryRow, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  return timestamp(row, key);
}

function safeInteger(value: unknown, field: string): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (
    typeof parsed !== "number" ||
    !Number.isSafeInteger(parsed) ||
    parsed < 0
  ) {
    throw new Error(`Database row field ${field} is invalid`);
  }
  return parsed;
}

function mode(row: QueryRow): PersistenceMode {
  const value = requiredString(row, "mode");
  if (value !== "live" && value !== "demo") {
    throw new Error("Database row field mode is invalid");
  }
  return value;
}

function provenance(row: QueryRow): PersistenceProvenance {
  const value = requiredString(row, "provenance");
  if (value !== "live_txline" && value !== "synthetic_txline_shaped") {
    throw new Error("Database row field provenance is invalid");
  }
  return value;
}

function json(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("JSON payload is invalid");
  return encoded;
}

function decodedJson(value: unknown, field: string): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Database row field ${field} is invalid`);
  }
}

function assertSafeNonNegativeInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
}

function assertModeProvenance(
  value: PersistenceMode,
  dataProvenance: PersistenceProvenance,
) {
  if (
    (value === "live" && dataProvenance !== "live_txline") ||
    (value === "demo" && dataProvenance !== "synthetic_txline_shaped")
  ) {
    throw new Error("Persistence mode and provenance do not match");
  }
}

function parseFixture(row: QueryRow): FixtureRecord {
  const metadata = decodedJson(row.metadata, "metadata");
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    Array.isArray(metadata)
  ) {
    throw new Error("Database row field metadata is invalid");
  }
  return {
    awayTeamId: requiredString(row, "away_team_id"),
    createdAt: timestamp(row, "created_at"),
    homeTeamId: requiredString(row, "home_team_id"),
    id: requiredString(row, "id"),
    metadata: metadata as Record<string, unknown>,
    mode: mode(row),
    provenance: provenance(row),
    scheduledAt: timestamp(row, "scheduled_at"),
    status: requiredString(row, "status"),
    updatedAt: timestamp(row, "updated_at"),
  };
}

function parseEvent(row: QueryRow): FixtureEventRecord {
  return {
    createdAt: timestamp(row, "created_at"),
    eventId: requiredString(row, "event_id"),
    eventType: requiredString(row, "event_type"),
    fixtureId: requiredString(row, "fixture_id"),
    mode: mode(row),
    payload: decodedJson(row.payload, "payload"),
    sequence: safeInteger(row.sequence, "sequence"),
  };
}

function parseProjection(row: QueryRow): FixtureProjectionRecord {
  return {
    fixtureId: requiredString(row, "fixture_id"),
    mode: mode(row),
    payload: decodedJson(row.payload, "payload"),
    revision: safeInteger(row.revision, "revision"),
    sourceSequence: nullableString(row, "source_sequence"),
    updatedAt: timestamp(row, "updated_at"),
  };
}

function parseSourceCursor(row: QueryRow): SourceCursorRecord {
  return {
    cursorValue: requiredString(row, "cursor_value"),
    fencingToken: safeInteger(row.fencing_token, "fencing_token"),
    mode: mode(row),
    source: requiredString(row, "source"),
    streamKey: requiredString(row, "stream_key"),
    updatedAt: timestamp(row, "updated_at"),
  };
}

function parseSourceLease(row: QueryRow): SourceLeaseRecord {
  return {
    fencingToken: safeInteger(row.fencing_token, "fencing_token"),
    holderId: requiredString(row, "holder_id"),
    leaseUntil: timestamp(row, "lease_until"),
    mode: mode(row),
    source: requiredString(row, "source"),
    streamKey: requiredString(row, "stream_key"),
    updatedAt: timestamp(row, "updated_at"),
  };
}

function parseCommentary(row: QueryRow): CommentaryArtifactRecord {
  const bytes = row.bytes;
  if (!(bytes instanceof Uint8Array)) {
    throw new Error("Database row field bytes is invalid");
  }
  return {
    bytes,
    createdAt: timestamp(row, "created_at"),
    fixtureId: requiredString(row, "fixture_id"),
    id: requiredString(row, "id"),
    language: requiredString(row, "language"),
    mediaType: requiredString(row, "media_type"),
    mode: mode(row),
    momentId: requiredString(row, "moment_id"),
    momentRevision: safeInteger(row.moment_revision, "moment_revision"),
    updatedAt: timestamp(row, "updated_at"),
    voice: requiredString(row, "voice"),
  };
}

function parseOutbox(row: QueryRow): OutboxRecord {
  return {
    attemptCount: safeInteger(row.attempt_count, "attempt_count"),
    availableAt: timestamp(row, "available_at"),
    claimToken: nullableString(row, "claim_token"),
    createdAt: timestamp(row, "created_at"),
    fixtureId: requiredString(row, "fixture_id"),
    id: requiredString(row, "id"),
    idempotencyKey: requiredString(row, "idempotency_key"),
    lastError: nullableString(row, "last_error"),
    lockedAt: nullableTimestamp(row, "locked_at"),
    lockedBy: nullableString(row, "locked_by"),
    mode: mode(row),
    payload: decodedJson(row.payload, "payload"),
    processedAt: nullableTimestamp(row, "processed_at"),
    topic: requiredString(row, "topic"),
  };
}

const fixtureColumns = `mode, id, provenance, home_team_id, away_team_id,
scheduled_at, status, metadata, created_at, updated_at`;

const projectionColumns = `mode, fixture_id, revision, source_sequence, payload, updated_at`;

function assertRawSourceRecord(
  fixtureMode: PersistenceMode,
  raw: RawSourceRecordWrite,
) {
  assertModeProvenance(fixtureMode, raw.provenance);
  if (!/^[a-f0-9]{64}$/u.test(raw.payloadHash)) {
    throw new Error("Raw payload hash must be lowercase SHA-256 hex");
  }
}

async function lockCurrentSourceFence(
  executor: SqlExecutor,
  input: {
    mode: PersistenceMode;
    rawSource: string;
    sourceFence: SourceFence | undefined;
  },
): Promise<boolean> {
  if (input.mode === "demo") return true;
  const fence = input.sourceFence;
  if (!fence || fence.source !== input.rawSource) return false;
  assertFencingToken(fence.fencingToken);

  const rows = await executor.unsafe(
    `SELECT fencing_token
FROM matchsense.source_leases
WHERE mode = $1 AND source = $2 AND stream_key = $3
  AND holder_id = $4 AND fencing_token = $5
  AND lease_until > clock_timestamp()
FOR UPDATE;`,
    [
      input.mode,
      fence.source,
      fence.streamKey,
      fence.holderId,
      fence.fencingToken,
    ],
  );
  return rows[0] !== undefined;
}

async function insertRawSourceRecord(
  executor: SqlExecutor,
  input: CommitRawSourceRecordInput,
): Promise<boolean> {
  const rows = await executor.unsafe(
    `INSERT INTO matchsense.raw_source_records (
  mode, id, fixture_id, source, source_record_id, source_sequence,
  dedupe_key, payload_hash, provenance, payload, received_at
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::timestamptz)
ON CONFLICT (mode, source, fixture_id, dedupe_key) DO NOTHING
RETURNING id;`,
    [
      input.mode,
      input.raw.id,
      input.fixtureId,
      input.raw.source,
      input.raw.sourceRecordId,
      input.raw.sourceSequence,
      input.raw.dedupeKey,
      input.raw.payloadHash,
      input.raw.provenance,
      json(input.raw.payload),
      input.raw.receivedAt,
    ],
  );
  return rows[0] !== undefined;
}

async function upsertFixture(
  executor: SqlExecutor,
  input: FixtureUpsert,
): Promise<FixtureRecord> {
  assertModeProvenance(input.mode, input.provenance);
  const rows = await executor.unsafe(
    `INSERT INTO matchsense.fixtures (
  mode, id, provenance, home_team_id, away_team_id, scheduled_at, status, metadata
)
VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8::jsonb)
ON CONFLICT (mode, id) DO UPDATE SET
  scheduled_at = EXCLUDED.scheduled_at,
  status = EXCLUDED.status,
  metadata = EXCLUDED.metadata,
  updated_at = clock_timestamp()
RETURNING ${fixtureColumns};`,
    [
      input.mode,
      input.id,
      input.provenance,
      input.homeTeamId,
      input.awayTeamId,
      input.scheduledAt,
      input.status,
      json(input.metadata),
    ],
  );
  const row = rows[0];
  if (!row) throw new Error("Fixture upsert returned no row");
  return parseFixture(row);
}

export function createFixtureTruthRepository(
  client: RepositoryClient,
): FixtureTruthRepository {
  return {
    commitFixtureSchedule: async (input) => {
      assertModeProvenance(input.fixture.mode, input.fixture.provenance);
      assertRawSourceRecord(input.fixture.mode, input.raw);
      return client.begin(async (transaction) => {
        if (
          !(await lockCurrentSourceFence(transaction, {
            mode: input.fixture.mode,
            rawSource: input.raw.source,
            sourceFence: input.sourceFence,
          }))
        ) {
          return { kind: "fenced" };
        }
        const inserted = await insertRawSourceRecord(transaction, {
          fixtureId: input.fixture.id,
          mode: input.fixture.mode,
          raw: input.raw,
        });
        if (!inserted) return { kind: "duplicate" };

        return {
          fixture: await upsertFixture(transaction, input.fixture),
          kind: "committed",
        };
      });
    },
    commitRawSourceRecord: async (input) => {
      assertRawSourceRecord(input.mode, input.raw);
      return client.begin(async (transaction) => {
        if (
          !(await lockCurrentSourceFence(transaction, {
            mode: input.mode,
            rawSource: input.raw.source,
            sourceFence: input.sourceFence,
          }))
        ) {
          return { kind: "fenced" };
        }
        return {
          kind: (await insertRawSourceRecord(transaction, input))
            ? "committed"
            : "duplicate",
        };
      });
    },
    upsert: async (input) => upsertFixture(client, input),
    get: async ({ fixtureId, mode: fixtureMode }) => {
      const rows = await client.unsafe(
        `SELECT ${fixtureColumns}
FROM matchsense.fixtures
WHERE mode = $1 AND id = $2;`,
        [fixtureMode, fixtureId],
      );
      return rows[0] ? parseFixture(rows[0]) : null;
    },
    getLatestProjection: async ({ fixtureId, mode: fixtureMode }) => {
      const rows = await client.unsafe(
        `SELECT ${projectionColumns}
FROM matchsense.fixture_projections
WHERE mode = $1 AND fixture_id = $2;`,
        [fixtureMode, fixtureId],
      );
      return rows[0] ? parseProjection(rows[0]) : null;
    },
    list: async (input) => {
      const limit = input.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
        throw new Error("Fixture list limit is invalid");
      }
      const rows = await client.unsafe(
        `SELECT ${fixtureColumns}
FROM matchsense.fixtures
WHERE mode = $1
  AND ($2::timestamptz IS NULL OR scheduled_at >= $2::timestamptz)
  AND ($3::timestamptz IS NULL OR scheduled_at <= $3::timestamptz)
ORDER BY scheduled_at ASC, id ASC
LIMIT $4;`,
        [
          input.mode,
          input.scheduledFrom ?? null,
          input.scheduledTo ?? null,
          limit,
        ],
      );
      return rows.map(parseFixture);
    },
    commitSourceChange: async (input) => {
      assertRawSourceRecord(input.mode, input.raw);
      assertSafeNonNegativeInteger(input.expectedRevision, "expectedRevision");
      const nextRevision = input.expectedRevision + 1;
      if (
        input.projection.revision !== nextRevision ||
        input.moment.revision !== nextRevision
      ) {
        throw new Error("Derived revisions must advance exactly once");
      }
      return client.begin(async (transaction) => {
        if (
          !(await lockCurrentSourceFence(transaction, {
            mode: input.mode,
            rawSource: input.raw.source,
            sourceFence: input.sourceFence,
          }))
        ) {
          return { kind: "fenced" };
        }
        if (
          !(await insertRawSourceRecord(transaction, {
            fixtureId: input.fixtureId,
            mode: input.mode,
            raw: input.raw,
          }))
        ) {
          return { kind: "duplicate" };
        }

        const fixtureRows = await transaction.unsafe(
          `SELECT id
FROM matchsense.fixtures
WHERE mode = $1 AND id = $2
FOR UPDATE;`,
          [input.mode, input.fixtureId],
        );
        if (!fixtureRows[0]) throw new Error("Fixture does not exist");

        const projectionRows = await transaction.unsafe(
          `SELECT revision
FROM matchsense.fixture_projections
WHERE mode = $1 AND fixture_id = $2;`,
          [input.mode, input.fixtureId],
        );
        const actualRevision = projectionRows[0]
          ? safeInteger(projectionRows[0].revision, "revision")
          : 0;
        if (actualRevision !== input.expectedRevision) {
          throw new FixtureRevisionConflictError(
            input.expectedRevision,
            actualRevision,
          );
        }

        await transaction.unsafe(
          `INSERT INTO matchsense.fixture_projections (
  mode, fixture_id, revision, source_sequence, payload
)
VALUES ($1, $2, $3, $4, $5::jsonb)
ON CONFLICT (mode, fixture_id) DO UPDATE SET
  revision = EXCLUDED.revision,
  source_sequence = EXCLUDED.source_sequence,
  payload = EXCLUDED.payload,
  updated_at = clock_timestamp();`,
          [
            input.mode,
            input.fixtureId,
            input.projection.revision,
            input.raw.sourceSequence,
            json(input.projection.payload),
          ],
        );
        await transaction.unsafe(
          `INSERT INTO matchsense.canonical_moments (mode, fixture_id, id, kind)
VALUES ($1, $2, $3, $4)
ON CONFLICT (mode, fixture_id, id) DO NOTHING;`,
          [input.mode, input.fixtureId, input.moment.id, input.moment.kind],
        );
        await transaction.unsafe(
          `INSERT INTO matchsense.moment_revisions (
  mode, fixture_id, moment_id, revision, source_record_id, payload
)
VALUES ($1, $2, $3, $4, $5, $6::jsonb);`,
          [
            input.mode,
            input.fixtureId,
            input.moment.id,
            input.moment.revision,
            input.raw.id,
            json(input.moment.payload),
          ],
        );
        const eventRows = await transaction.unsafe(
          `INSERT INTO matchsense.fixture_events (
  mode, fixture_id, sequence, event_id, event_type, payload
)
SELECT $1, $2, COALESCE(MAX(sequence), 0) + 1, $3, $4, $5::jsonb
FROM matchsense.fixture_events
WHERE mode = $1 AND fixture_id = $2
RETURNING sequence;`,
          [
            input.mode,
            input.fixtureId,
            input.event.id,
            input.event.type,
            json(input.event.payload),
          ],
        );
        const eventRow = eventRows[0];
        if (!eventRow) throw new Error("Fixture event insert returned no row");
        const eventSequence = safeInteger(eventRow.sequence, "sequence");
        await transaction.unsafe(
          `INSERT INTO matchsense.outbox (
  mode, id, fixture_id, topic, idempotency_key, payload, available_at
)
VALUES ($1, $2, $3, $4, $5, $6::jsonb, COALESCE($7::timestamptz, clock_timestamp()));`,
          [
            input.mode,
            input.outbox.id,
            input.fixtureId,
            input.outbox.topic,
            input.outbox.idempotencyKey,
            json(input.outbox.payload),
            input.outbox.availableAt ?? null,
          ],
        );

        return {
          eventSequence,
          kind: "committed",
          revision: input.projection.revision,
        };
      });
    },
    eventsAfter: async (input) => {
      assertSafeNonNegativeInteger(input.afterSequence, "afterSequence");
      const limit = input.limit ?? 100;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw new Error("Fixture event limit is invalid");
      }
      const rows = await client.unsafe(
        `SELECT mode, fixture_id, sequence, event_id, event_type, payload, created_at
FROM matchsense.fixture_events
WHERE mode = $1 AND fixture_id = $2 AND sequence > $3
ORDER BY sequence ASC
LIMIT $4;`,
        [input.mode, input.fixtureId, input.afterSequence, limit],
      );
      return rows.map(parseEvent);
    },
  };
}

const sourceCursorColumns = `mode, source, stream_key, cursor_value,
fencing_token, updated_at`;
const sourceLeaseColumns = `mode, source, stream_key, holder_id,
fencing_token, lease_until, updated_at`;

function assertFencingToken(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Fencing token must be a positive safe integer");
  }
}

export function createSourceStateRepository(
  client: RepositoryClient,
): SourceStateRepository {
  return {
    acquireLease: async (input) => {
      const rows = await client.unsafe(
        `INSERT INTO matchsense.source_leases AS source_leases (
  mode, source, stream_key, holder_id, fencing_token, lease_until
)
SELECT $1, $2, $3, $4, 1, $5::timestamptz
WHERE $5::timestamptz > clock_timestamp()
ON CONFLICT (mode, source, stream_key) DO UPDATE SET
  holder_id = EXCLUDED.holder_id,
  fencing_token = source_leases.fencing_token + 1,
  lease_until = EXCLUDED.lease_until,
  updated_at = clock_timestamp()
WHERE source_leases.lease_until <= clock_timestamp()
RETURNING ${sourceLeaseColumns};`,
        [
          input.mode,
          input.source,
          input.streamKey,
          input.holderId,
          input.leaseUntil,
        ],
      );
      return rows[0] ? parseSourceLease(rows[0]) : null;
    },
    advanceCursor: async (input) => {
      assertFencingToken(input.fencingToken);
      return client.begin(async (transaction) => {
        const leaseRows = await transaction.unsafe(
          `SELECT ${sourceLeaseColumns}
FROM matchsense.source_leases
WHERE mode = $1 AND source = $2 AND stream_key = $3
  AND holder_id = $4 AND fencing_token = $5
  AND lease_until > clock_timestamp()
FOR UPDATE;`,
          [
            input.mode,
            input.source,
            input.streamKey,
            input.holderId,
            input.fencingToken,
          ],
        );
        if (!leaseRows[0]) return { kind: "fenced" };

        const cursorRows = await transaction.unsafe(
          `SELECT ${sourceCursorColumns}
FROM matchsense.source_cursors
WHERE mode = $1 AND source = $2 AND stream_key = $3
FOR UPDATE;`,
          [input.mode, input.source, input.streamKey],
        );
        const currentCursor = cursorRows[0]
          ? requiredString(cursorRows[0], "cursor_value")
          : null;
        if (currentCursor !== input.expectedCursor) {
          return { currentCursor, kind: "conflict" };
        }

        const advancedRows = await transaction.unsafe(
          `INSERT INTO matchsense.source_cursors AS source_cursors (
  mode, source, stream_key, cursor_value, fencing_token
)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (mode, source, stream_key) DO UPDATE SET
  cursor_value = EXCLUDED.cursor_value,
  fencing_token = EXCLUDED.fencing_token,
  updated_at = clock_timestamp()
WHERE source_cursors.cursor_value IS NOT DISTINCT FROM $6
RETURNING ${sourceCursorColumns};`,
          [
            input.mode,
            input.source,
            input.streamKey,
            input.cursorValue,
            input.fencingToken,
            input.expectedCursor,
          ],
        );
        if (advancedRows[0]) {
          return {
            cursor: parseSourceCursor(advancedRows[0]),
            kind: "advanced",
          };
        }

        const racedRows = await transaction.unsafe(
          `SELECT ${sourceCursorColumns}
FROM matchsense.source_cursors
WHERE mode = $1 AND source = $2 AND stream_key = $3;`,
          [input.mode, input.source, input.streamKey],
        );
        return {
          currentCursor: racedRows[0]
            ? requiredString(racedRows[0], "cursor_value")
            : null,
          kind: "conflict",
        };
      });
    },
    getCursor: async (input) => {
      const rows = await client.unsafe(
        `SELECT ${sourceCursorColumns}
FROM matchsense.source_cursors
WHERE mode = $1 AND source = $2 AND stream_key = $3;`,
        [input.mode, input.source, input.streamKey],
      );
      return rows[0] ? parseSourceCursor(rows[0]) : null;
    },
    releaseLease: async (input) => {
      assertFencingToken(input.fencingToken);
      const rows = await client.unsafe(
        `UPDATE matchsense.source_leases
SET lease_until = clock_timestamp(), updated_at = clock_timestamp()
WHERE mode = $1 AND source = $2 AND stream_key = $3
  AND holder_id = $4 AND fencing_token = $5
  AND lease_until > clock_timestamp()
RETURNING fencing_token;`,
        [
          input.mode,
          input.source,
          input.streamKey,
          input.holderId,
          input.fencingToken,
        ],
      );
      return rows[0] !== undefined;
    },
    renewLease: async (input) => {
      assertFencingToken(input.fencingToken);
      const rows = await client.unsafe(
        `UPDATE matchsense.source_leases
SET lease_until = $6::timestamptz, updated_at = clock_timestamp()
WHERE mode = $1 AND source = $2 AND stream_key = $3
  AND holder_id = $4 AND fencing_token = $5
  AND lease_until > clock_timestamp()
  AND $6::timestamptz > lease_until
RETURNING ${sourceLeaseColumns};`,
        [
          input.mode,
          input.source,
          input.streamKey,
          input.holderId,
          input.fencingToken,
          input.leaseUntil,
        ],
      );
      return rows[0] ? parseSourceLease(rows[0]) : null;
    },
  };
}

export function createCommentaryArtifactRepository(
  client: RepositoryClient,
): CommentaryArtifactRepository {
  const columns = `mode, id, fixture_id, moment_id, moment_revision, language,
voice, media_type, bytes, created_at, updated_at`;
  return {
    get: async (input) => {
      const rows = await client.unsafe(
        `SELECT ${columns}
FROM matchsense.commentary_artifacts
WHERE mode = $1 AND fixture_id = $2 AND moment_id = $3
  AND moment_revision = $4 AND language = $5 AND voice = $6;`,
        [
          input.mode,
          input.fixtureId,
          input.momentId,
          input.momentRevision,
          input.language,
          input.voice,
        ],
      );
      return rows[0] ? parseCommentary(rows[0]) : null;
    },
    upsert: async (input) => {
      if (input.bytes.byteLength === 0) {
        throw new Error("Commentary artifact bytes cannot be empty");
      }
      const rows = await client.unsafe(
        `INSERT INTO matchsense.commentary_artifacts (
  mode, id, fixture_id, moment_id, moment_revision, language, voice, media_type, bytes
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (mode, fixture_id, moment_id, moment_revision, language, voice) DO UPDATE SET
  media_type = EXCLUDED.media_type,
  bytes = EXCLUDED.bytes,
  updated_at = clock_timestamp()
RETURNING ${columns};`,
        [
          input.mode,
          input.id,
          input.fixtureId,
          input.momentId,
          input.momentRevision,
          input.language,
          input.voice,
          input.mediaType ?? "audio/mpeg",
          input.bytes,
        ],
      );
      const row = rows[0];
      if (!row) throw new Error("Commentary upsert returned no row");
      return parseCommentary(row);
    },
  };
}

export function createOutboxRepository(
  client: RepositoryClient,
): OutboxRepository {
  const columns = `mode, id, fixture_id, topic, idempotency_key, payload,
available_at, attempt_count, locked_by, locked_at, claim_token, processed_at, last_error, created_at`;
  return {
    enqueue: async (input) => {
      const rows = await client.unsafe(
        `INSERT INTO matchsense.outbox (
  mode, id, fixture_id, topic, idempotency_key, payload, available_at
)
VALUES ($1, $2, $3, $4, $5, $6::jsonb, COALESCE($7::timestamptz, clock_timestamp()))
ON CONFLICT (mode, idempotency_key) DO NOTHING
RETURNING id;`,
        [
          input.mode,
          input.id,
          input.fixtureId,
          input.topic,
          input.idempotencyKey,
          json(input.payload),
          input.availableAt ?? null,
        ],
      );
      return rows[0] ? "enqueued" : "duplicate";
    },
    claim: async (input) => {
      if (input.topics.length === 0) return [];
      if (input.claimToken.trim().length === 0) {
        throw new Error("Outbox claim token is invalid");
      }
      if (
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 100
      ) {
        throw new Error("Outbox claim limit is invalid");
      }
      if (
        !Number.isSafeInteger(input.lockTimeoutMs) ||
        input.lockTimeoutMs < 1
      ) {
        throw new Error("Outbox lock timeout is invalid");
      }
      return client.begin(async (transaction) => {
        const rows = await transaction.unsafe(
          `WITH candidates AS (
  SELECT mode, id
  FROM matchsense.outbox
  WHERE mode = $1
    AND topic = ANY($2::text[])
    AND processed_at IS NULL
    AND available_at <= clock_timestamp()
    AND (locked_at IS NULL OR locked_at < clock_timestamp() - ($5::integer * interval '1 millisecond'))
  ORDER BY available_at ASC, created_at ASC, id ASC
  FOR UPDATE SKIP LOCKED
  LIMIT $4
)
UPDATE matchsense.outbox AS message
SET locked_by = $3,
    locked_at = clock_timestamp(),
    claim_token = $6,
    attempt_count = message.attempt_count + 1
FROM candidates
WHERE message.mode = candidates.mode AND message.id = candidates.id
RETURNING ${columns
            .split(",")
            .map((column) => `message.${column.trim()}`)
            .join(", ")};`,
          [
            input.mode,
            input.topics,
            input.workerId,
            input.limit,
            input.lockTimeoutMs,
            input.claimToken,
          ],
        );
        return rows.map(parseOutbox);
      });
    },
    complete: async (input) => {
      const rows = await client.unsafe(
        `UPDATE matchsense.outbox
SET processed_at = clock_timestamp(), locked_by = NULL, locked_at = NULL, claim_token = NULL
WHERE mode = $1 AND id = $2 AND locked_by = $3 AND claim_token = $4 AND processed_at IS NULL
RETURNING id;`,
        [input.mode, input.id, input.workerId, input.claimToken],
      );
      return Boolean(rows[0]);
    },
    hasConsumerReceipt: async (input) => {
      const rows = await client.unsafe(
        `SELECT EXISTS (
  SELECT 1 FROM matchsense.consumer_receipts
  WHERE mode = $1 AND consumer = $2 AND outbox_id = $3
) AS exists;`,
        [input.mode, input.consumer, input.outboxId],
      );
      return rows[0]?.exists === true;
    },
    recordConsumerReceipt: async (input) => {
      const rows = await client.unsafe(
        `INSERT INTO matchsense.consumer_receipts (mode, consumer, outbox_id)
VALUES ($1, $2, $3)
ON CONFLICT DO NOTHING
RETURNING outbox_id;`,
        [input.mode, input.consumer, input.outboxId],
      );
      return Boolean(rows[0]);
    },
    retryOrDeadLetter: async (input) => {
      if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1) {
        throw new Error("Outbox max attempts is invalid");
      }
      return client.begin(async (transaction) => {
        const rows = await transaction.unsafe(
          `SELECT ${columns}
FROM matchsense.outbox
WHERE mode = $1 AND id = $2 AND locked_by = $3 AND claim_token = $4 AND processed_at IS NULL
FOR UPDATE;`,
          [input.mode, input.id, input.workerId, input.claimToken],
        );
        const row = rows[0];
        if (!row) return { kind: "not_claimed" };
        const message = parseOutbox(row);
        if (message.attemptCount >= input.maxAttempts) {
          await transaction.unsafe(
            `INSERT INTO matchsense.outbox_dead_letters (
  mode, id, outbox_id, fixture_id, topic, payload, attempt_count, error
)
VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
ON CONFLICT (mode, outbox_id) DO NOTHING;`,
            [
              message.mode,
              input.deadLetterId,
              message.id,
              message.fixtureId,
              message.topic,
              json(message.payload),
              message.attemptCount,
              input.error,
            ],
          );
          await transaction.unsafe(
            `UPDATE matchsense.outbox
SET processed_at = clock_timestamp(), locked_by = NULL, locked_at = NULL,
    claim_token = NULL, last_error = $5
WHERE mode = $1 AND id = $2 AND locked_by = $3 AND claim_token = $4;`,
            [
              input.mode,
              input.id,
              input.workerId,
              input.claimToken,
              input.error,
            ],
          );
          return { kind: "dead_letter" };
        }
        await transaction.unsafe(
          `UPDATE matchsense.outbox
SET available_at = $5::timestamptz,
    locked_by = NULL,
    locked_at = NULL,
    claim_token = NULL,
    last_error = $6
WHERE mode = $1 AND id = $2 AND locked_by = $3 AND claim_token = $4;`,
          [
            input.mode,
            input.id,
            input.workerId,
            input.claimToken,
            input.availableAt,
            input.error,
          ],
        );
        return { kind: "retry" };
      });
    },
  };
}
