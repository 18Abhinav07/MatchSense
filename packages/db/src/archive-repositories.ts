import { createHash } from "node:crypto";

import type {
  QueryRow,
  RepositoryClient,
  SqlExecutor,
  SourceFence,
} from "./repositories.js";

export type ArchiveMode = "live" | "recorded";
export type ArchiveProvenance = "live_txline" | "recorded_txline_authorised";
export type DurableRawRetention = "authorised_raw" | "normalised_only";
export type ArchiveManifestStatus =
  | "COLLECTING"
  | "TERMINAL_OBSERVED"
  | "REPLAY_READY"
  | "REPLAY_INVALIDATED"
  | "REPLAY_REJECTED";

export interface RightsGrant {
  active: boolean;
  createdAt: string;
  expiresAt: string | null;
  id: string;
  rawRetentionUntil: string | null;
  reference: string;
  revokedAt: string | null;
  scopes: readonly string[];
  updatedAt: string;
}

export interface RightsGrantWrite {
  active: boolean;
  expiresAt?: string | null;
  id: string;
  rawRetentionUntil?: string | null;
  reference: string;
  revokedAt?: string | null;
  scopes: readonly string[];
}

export interface DurableSourceDelivery {
  canonicalEligible: boolean;
  deliveryIntent: "realtime" | "reconcile";
  deliveryKey: string;
  fixtureId: string;
  id: string;
  mode: ArchiveMode;
  orderingKey: string;
  payload: unknown;
  payloadHash: string;
  persistedAt?: string;
  rawRetention: DurableRawRetention;
  receivedAt: string;
  responseHash: string;
  rightsGrantId: string;
  source: string;
  sourcePath: string;
  sourceRecordId: string | null;
  sourceSequence: string | null;
  streamKey: string;
}

export interface InsertDeliveryResult {
  canonicalEligible: boolean;
  duplicate?: boolean;
  inserted: boolean;
}

export interface VerifyArchiveInput {
  fixtureId: string;
  manifestId: string;
  mode: ArchiveMode;
  projectionHash: string;
  reducerVersion: string;
  rightsGrantId: string;
  sourceFence: SourceFence;
  terminalDeliveryId: string;
}

export interface ArchiveFixtureKey {
  fixtureId: string;
  mode: ArchiveMode;
}

export interface ArchiveInvalidationInput extends ArchiveFixtureKey {
  reason: string;
  sourceFence: SourceFence;
}

/**
 * A live collector correction uses its already-held live source fence. It
 * never acquires a second recorded lease, but may only invalidate a public
 * recorded replay that is currently ready.
 */
export interface RecordedReplayInvalidationInput {
  fixtureId: string;
  reason: string;
}

export interface ArchiveManifest {
  createdAt: string;
  deliveryManifestHash: string;
  fixtureId: string;
  id: string;
  invalidatedAt: string | null;
  invalidationReason: string | null;
  mode: ArchiveMode;
  projectionHash: string;
  reducerVersion: string;
  rightsGrantId: string;
  status: ArchiveManifestStatus;
  terminalDeliveryId: string;
  updatedAt: string;
  verifiedAt: string | null;
}

/**
 * Archive mutations are permitted only while the collector's exact source
 * lease is current. A stale owner must receive this explicit outcome instead
 * of treating a zero-row mutation as a successful archive transition.
 */
export type ArchiveInvalidationResult =
  { kind: "applied" } | { kind: "fenced" };

export type ArchiveVerificationResult =
  { kind: "fenced" } | { kind: "verified"; manifest: ArchiveManifest };

export interface ArchiveRepository {
  ensureRightsGrant(input: RightsGrantWrite): Promise<RightsGrant>;
  insertDelivery(input: DurableSourceDelivery): Promise<InsertDeliveryResult>;
  invalidateArchive(
    input: ArchiveInvalidationInput,
  ): Promise<ArchiveInvalidationResult>;
  orderedDeliveries(
    input: ArchiveFixtureKey,
  ): Promise<readonly DurableSourceDelivery[]>;
  replayReady(input: ArchiveFixtureKey): Promise<ArchiveManifest | null>;
  upsertRightsGrant(input: RightsGrantWrite): Promise<RightsGrant>;
  verifyArchive(input: VerifyArchiveInput): Promise<ArchiveVerificationResult>;
}

const sourceDeliveryColumns = `mode, id, fixture_id, source, source_record_id,
source_sequence, payload_hash, payload, received_at, persisted_at,
delivery_intent, delivery_key, ordering_key, source_path, stream_key,
response_hash, rights_grant_id, raw_retention, canonical_eligible`;

const manifestColumns = `id, mode, fixture_id, status, reducer_version,
delivery_manifest_hash, projection_hash, terminal_delivery_id, rights_grant_id,
invalidation_reason, invalidated_at, verified_at, created_at, updated_at`;
const manifestSelectColumns = manifestColumns
  .split(",")
  .map((column) => `manifest.${column.trim()}`)
  .join(", ");

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

function decodeJson(value: unknown, field: string): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Database row field ${field} is invalid`);
  }
}

function json(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("JSON payload is invalid");
  return encoded;
}

function archiveMode(value: string): ArchiveMode {
  if (value === "live" || value === "recorded") return value;
  throw new Error("Database row field mode is invalid");
}

function rawRetention(value: string): DurableRawRetention {
  if (value === "authorised_raw" || value === "normalised_only") return value;
  throw new Error("Database row field raw_retention is invalid");
}

function manifestStatus(value: string): ArchiveManifestStatus {
  if (
    value === "COLLECTING" ||
    value === "TERMINAL_OBSERVED" ||
    value === "REPLAY_READY" ||
    value === "REPLAY_INVALIDATED" ||
    value === "REPLAY_REJECTED"
  ) {
    return value;
  }
  throw new Error("Database row field status is invalid");
}

function boolean(row: QueryRow, key: string): boolean {
  if (typeof row[key] !== "boolean") {
    throw new Error(`Database row field ${key} is invalid`);
  }
  return row[key] as boolean;
}

function assertSha256(value: string, label: string) {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} must be lowercase SHA-256 hex`);
  }
}

function assertNonempty(value: string, label: string) {
  if (value.trim().length === 0) throw new Error(`${label} is required`);
}

function assertArchiveFixtureKey(input: ArchiveFixtureKey) {
  assertNonempty(input.fixtureId, "Fixture id");
}

function assertArchiveSourceFence(fence: SourceFence | undefined) {
  if (!fence) throw new Error("Archive source fence is required");
  assertNonempty(fence.source, "Archive source fence source");
  assertNonempty(fence.streamKey, "Archive source fence stream key");
  assertNonempty(fence.holderId, "Archive source fence holder id");
  if (!Number.isSafeInteger(fence.fencingToken) || fence.fencingToken <= 0) {
    throw new Error("Archive source fence token must be a positive integer");
  }
}

async function lockCurrentArchiveSourceFence(
  executor: SqlExecutor,
  input: { mode: ArchiveMode; sourceFence: SourceFence },
): Promise<boolean> {
  const rows = await executor.unsafe(
    `SELECT fencing_token
FROM matchsense.source_leases
WHERE mode = $1 AND source = $2 AND stream_key = $3
  AND holder_id = $4 AND fencing_token = $5
  AND lease_until > clock_timestamp()
FOR UPDATE;`,
    [
      input.mode,
      input.sourceFence.source,
      input.sourceFence.streamKey,
      input.sourceFence.holderId,
      input.sourceFence.fencingToken,
    ],
  );
  return rows[0] !== undefined;
}

/**
 * Transaction-local recorded replay invalidation for a caller that already
 * holds the authoritative live source-frame transaction and fence.
 */
export async function invalidateRecordedReplayReadyArchiveInTransaction(
  transaction: SqlExecutor,
  input: RecordedReplayInvalidationInput,
): Promise<void> {
  assertNonempty(input.fixtureId, "Fixture id");
  assertNonempty(input.reason, "Archive invalidation reason");
  await transaction.unsafe(
    `UPDATE matchsense.archive_manifests
SET status = 'REPLAY_INVALIDATED',
    invalidation_reason = $2,
    invalidated_at = clock_timestamp(),
    updated_at = clock_timestamp()
WHERE mode = 'recorded' AND fixture_id = $1 AND status = 'REPLAY_READY';`,
    [input.fixtureId, input.reason],
  );
}

function provenanceFor(mode: ArchiveMode): ArchiveProvenance {
  return mode === "live" ? "live_txline" : "recorded_txline_authorised";
}

function parseDelivery(row: QueryRow): DurableSourceDelivery {
  const intent = requiredString(row, "delivery_intent");
  if (intent !== "realtime" && intent !== "reconcile") {
    throw new Error("Database row field delivery_intent is invalid");
  }
  return {
    canonicalEligible: boolean(row, "canonical_eligible"),
    deliveryIntent: intent,
    deliveryKey: requiredString(row, "delivery_key"),
    fixtureId: requiredString(row, "fixture_id"),
    id: requiredString(row, "id"),
    mode: archiveMode(requiredString(row, "mode")),
    orderingKey: requiredString(row, "ordering_key"),
    payload: decodeJson(row.payload, "payload"),
    payloadHash: requiredString(row, "payload_hash"),
    persistedAt: timestamp(row, "persisted_at"),
    rawRetention: rawRetention(requiredString(row, "raw_retention")),
    receivedAt: timestamp(row, "received_at"),
    responseHash: requiredString(row, "response_hash"),
    rightsGrantId: requiredString(row, "rights_grant_id"),
    source: requiredString(row, "source"),
    sourcePath: requiredString(row, "source_path"),
    sourceRecordId: nullableString(row, "source_record_id"),
    sourceSequence: nullableString(row, "source_sequence"),
    streamKey: requiredString(row, "stream_key"),
  };
}

function parseManifest(row: QueryRow): ArchiveManifest {
  return {
    createdAt: timestamp(row, "created_at"),
    deliveryManifestHash: requiredString(row, "delivery_manifest_hash"),
    fixtureId: requiredString(row, "fixture_id"),
    id: requiredString(row, "id"),
    invalidatedAt: nullableTimestamp(row, "invalidated_at"),
    invalidationReason: nullableString(row, "invalidation_reason"),
    mode: archiveMode(requiredString(row, "mode")),
    projectionHash: requiredString(row, "projection_hash"),
    reducerVersion: requiredString(row, "reducer_version"),
    rightsGrantId: requiredString(row, "rights_grant_id"),
    status: manifestStatus(requiredString(row, "status")),
    terminalDeliveryId: requiredString(row, "terminal_delivery_id"),
    updatedAt: timestamp(row, "updated_at"),
    verifiedAt: nullableTimestamp(row, "verified_at"),
  };
}

function parseRightsGrant(row: QueryRow): RightsGrant {
  const scopes = row.scopes;
  if (
    !Array.isArray(scopes) ||
    !scopes.every((scope) => typeof scope === "string")
  ) {
    throw new Error("Database row field scopes is invalid");
  }
  return {
    active: boolean(row, "active"),
    createdAt: timestamp(row, "created_at"),
    expiresAt: nullableTimestamp(row, "expires_at"),
    id: requiredString(row, "id"),
    rawRetentionUntil: nullableTimestamp(row, "raw_retention_until"),
    reference: requiredString(row, "reference"),
    revokedAt: nullableTimestamp(row, "revoked_at"),
    scopes,
    updatedAt: timestamp(row, "updated_at"),
  };
}

function assertRightsGrantWrite(input: RightsGrantWrite) {
  assertNonempty(input.id, "Rights grant id");
  assertNonempty(input.reference, "Rights grant reference");
  if (
    input.scopes.length === 0 ||
    input.scopes.some((scope) => scope.trim().length === 0)
  ) {
    throw new Error("Rights grant scopes are required");
  }
}

function assertDelivery(input: DurableSourceDelivery) {
  assertSha256(input.deliveryKey, "Delivery key");
  assertSha256(input.payloadHash, "Raw payload hash");
  assertSha256(input.responseHash, "Response hash");
  for (const [value, label] of [
    [input.id, "Delivery id"],
    [input.fixtureId, "Fixture id"],
    [input.orderingKey, "Ordering key"],
    [input.rightsGrantId, "Rights grant id"],
    [input.source, "Source"],
    [input.sourcePath, "Source path"],
    [input.streamKey, "Stream key"],
  ] as const) {
    assertNonempty(value, label);
  }
  if (input.rawRetention !== "authorised_raw") {
    throw new Error("Archive delivery requires authorised raw retention");
  }
  json(input.payload);
}

function deliveryManifestHash(
  deliveries: readonly DurableSourceDelivery[],
): string {
  const manifest = deliveries
    .map(
      (delivery, index) =>
        `${index + 1}:${delivery.orderingKey}:${delivery.deliveryKey}:${delivery.responseHash}`,
    )
    .join("\n");
  return createHash("sha256").update(manifest).digest("hex");
}

/**
 * A replay-ready manifest alone is insufficient: its exact content must be
 * bound to the generation that actually transitioned the import job to ready.
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
    WHERE archive_job.fixture_id = manifest.fixture_id
      AND archive_job.state = 'replay_ready'
      AND archive_job.archive_manifest_id = manifest.id
      AND archive_job.archive_manifest_hash = manifest.delivery_manifest_hash
  )`;
}

function txlinePayloadRecord(payload: unknown): Record<string, unknown> | null {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const update = Object.hasOwn(record, "Update")
    ? record.Update
    : Object.hasOwn(record, "update")
      ? record.update
      : undefined;
  const unwrapped = update ?? record;
  return typeof unwrapped === "object" &&
    unwrapped !== null &&
    !Array.isArray(unwrapped)
    ? (unwrapped as Record<string, unknown>)
    : null;
}

function txlinePayloadField(
  payload: Record<string, unknown>,
  ...keys: readonly string[]
): unknown {
  for (const key of keys) {
    if (Object.hasOwn(payload, key)) return payload[key];
  }
  return undefined;
}

function txlineAction(payload: Record<string, unknown>): string | null {
  const action = txlinePayloadField(payload, "Action", "action");
  return typeof action === "string" ? action.toLowerCase() : null;
}

function txlineStatusId(payload: Record<string, unknown>): number | null {
  const statusId = txlinePayloadField(payload, "StatusId", "statusId");
  return typeof statusId === "number" && Number.isFinite(statusId)
    ? statusId
    : null;
}

function isAuthoritativeTerminalDelivery(
  delivery: DurableSourceDelivery,
): boolean {
  if (!delivery.canonicalEligible) return false;
  const payload = txlinePayloadRecord(delivery.payload);
  if (!payload) return false;
  return (
    txlineAction(payload) === "game_finalised" &&
    txlineStatusId(payload) === 100 &&
    txlinePayloadField(payload, "Confirmed", "confirmed") !== false
  );
}

async function orderedFixtureDeliveries(
  executor: SqlExecutor,
  mode: ArchiveMode,
  fixtureId: string,
): Promise<readonly DurableSourceDelivery[]> {
  const rows = await executor.unsafe(
    `SELECT ${sourceDeliveryColumns}
FROM matchsense.raw_source_records
WHERE mode = $1 AND fixture_id = $2
ORDER BY ordering_key ASC, delivery_key ASC, id ASC;`,
    [mode, fixtureId],
  );
  return rows.map(parseDelivery);
}

export function createArchiveRepository(
  client: RepositoryClient,
): ArchiveRepository {
  return {
    ensureRightsGrant: async (input) => {
      assertRightsGrantWrite(input);
      const parameters = [
        input.id,
        input.reference,
        input.scopes,
        input.active,
        input.rawRetentionUntil ?? null,
        input.expiresAt ?? null,
        input.revokedAt ?? null,
      ];
      const inserted = await client.unsafe(
        `INSERT INTO matchsense.rights_grants (
  id, reference, scopes, active, raw_retention_until, expires_at, revoked_at
)
VALUES ($1, $2, $3::text[], $4, $5::timestamptz, $6::timestamptz, $7::timestamptz)
ON CONFLICT (id) DO NOTHING
RETURNING id, reference, scopes, active, raw_retention_until, expires_at,
  revoked_at, created_at, updated_at;`,
        parameters,
      );
      const row =
        inserted[0] ??
        (
          await client.unsafe(
            `SELECT id, reference, scopes, active, raw_retention_until, expires_at,
  revoked_at, created_at, updated_at
FROM matchsense.rights_grants
WHERE id = $1;`,
            [input.id],
          )
        )[0];
      if (!row) throw new Error("Rights grant ensure returned no row");
      return parseRightsGrant(row);
    },
    upsertRightsGrant: async (input) => {
      assertRightsGrantWrite(input);
      const rows = await client.unsafe(
        `INSERT INTO matchsense.rights_grants (
  id, reference, scopes, active, raw_retention_until, expires_at, revoked_at
)
VALUES ($1, $2, $3::text[], $4, $5::timestamptz, $6::timestamptz, $7::timestamptz)
ON CONFLICT (id) DO UPDATE SET
  reference = EXCLUDED.reference,
  scopes = EXCLUDED.scopes,
  active = EXCLUDED.active,
  raw_retention_until = EXCLUDED.raw_retention_until,
  expires_at = EXCLUDED.expires_at,
  revoked_at = EXCLUDED.revoked_at,
  updated_at = clock_timestamp()
RETURNING id, reference, scopes, active, raw_retention_until, expires_at,
  revoked_at, created_at, updated_at;`,
        [
          input.id,
          input.reference,
          input.scopes,
          input.active,
          input.rawRetentionUntil ?? null,
          input.expiresAt ?? null,
          input.revokedAt ?? null,
        ],
      );
      const row = rows[0];
      if (!row) throw new Error("Rights grant upsert returned no row");
      return parseRightsGrant(row);
    },
    insertDelivery: async (input) => {
      assertDelivery(input);
      return client.begin(async (transaction) => {
        const grantRows = await transaction.unsafe(
          `SELECT id
FROM matchsense.rights_grants
WHERE id = $1
  AND active = true
  AND revoked_at IS NULL
  AND (expires_at IS NULL OR expires_at > clock_timestamp())
  AND (raw_retention_until IS NULL OR raw_retention_until > clock_timestamp())
  AND scopes @> ARRAY['raw_retention']::text[]
FOR KEY SHARE;`,
          [input.rightsGrantId],
        );
        if (!grantRows[0]) {
          throw new Error(
            "Authorised raw retention grant is inactive, expired, revoked, or missing raw-retention scope",
          );
        }

        const rows = await transaction.unsafe(
          `INSERT INTO matchsense.raw_source_records (
  mode, id, fixture_id, source, source_record_id, source_sequence,
  dedupe_key, payload_hash, provenance, payload, received_at,
  delivery_intent, delivery_key, ordering_key, source_path, stream_key,
  response_hash, rights_grant_id, raw_retention, canonical_eligible
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::timestamptz,
  $12, $13, $14, $15, $16, $17, $18, $19, $20)
ON CONFLICT (mode, source, fixture_id, dedupe_key) DO NOTHING
RETURNING ${sourceDeliveryColumns};`,
          [
            input.mode,
            input.id,
            input.fixtureId,
            input.source,
            input.sourceRecordId,
            input.sourceSequence,
            input.deliveryKey,
            input.payloadHash,
            provenanceFor(input.mode),
            json(input.payload),
            input.receivedAt,
            input.deliveryIntent,
            input.deliveryKey,
            input.orderingKey,
            input.sourcePath,
            input.streamKey,
            input.responseHash,
            input.rightsGrantId,
            input.rawRetention,
            input.canonicalEligible,
          ],
        );
        return rows[0]
          ? {
              canonicalEligible: parseDelivery(rows[0]).canonicalEligible,
              inserted: true,
            }
          : {
              canonicalEligible: input.canonicalEligible,
              duplicate: true,
              inserted: false,
            };
      });
    },
    orderedDeliveries: async (input) => {
      assertArchiveFixtureKey(input);
      const rows = await client.unsafe(
        `SELECT ${sourceDeliveryColumns}
FROM matchsense.raw_source_records
WHERE mode = $1 AND fixture_id = $2
ORDER BY ordering_key ASC, delivery_key ASC, id ASC;`,
        [input.mode, input.fixtureId],
      );
      return rows.map(parseDelivery);
    },
    verifyArchive: async (input) => {
      assertNonempty(input.fixtureId, "Fixture id");
      assertNonempty(input.manifestId, "Manifest id");
      assertNonempty(input.reducerVersion, "Reducer version");
      assertNonempty(input.rightsGrantId, "Rights grant id");
      assertNonempty(input.terminalDeliveryId, "Terminal delivery id");
      assertSha256(input.projectionHash, "Projection hash");
      assertArchiveSourceFence(input.sourceFence);

      return client.begin(async (transaction) => {
        if (
          !(await lockCurrentArchiveSourceFence(transaction, {
            mode: input.mode,
            sourceFence: input.sourceFence,
          }))
        ) {
          return { kind: "fenced" };
        }
        const grantRows = await transaction.unsafe(
          `SELECT id
FROM matchsense.rights_grants
WHERE id = $1
  AND active = true
  AND revoked_at IS NULL
  AND (expires_at IS NULL OR expires_at > clock_timestamp())
  AND scopes @> ARRAY['replay']::text[]
FOR KEY SHARE;`,
          [input.rightsGrantId],
        );
        if (!grantRows[0]) {
          throw new Error(
            "Archive replay grant is inactive, expired, revoked, or missing replay scope",
          );
        }
        const deliveries = await orderedFixtureDeliveries(
          transaction,
          input.mode,
          input.fixtureId,
        );
        if (deliveries.length === 0) {
          throw new Error("Archive cannot verify without source deliveries");
        }
        if (
          deliveries.some(
            (delivery) =>
              delivery.rawRetention !== "authorised_raw" ||
              delivery.rightsGrantId !== input.rightsGrantId,
          )
        ) {
          throw new Error(
            "Archive contains delivery without one authorised raw grant",
          );
        }
        const terminal = [...deliveries]
          .reverse()
          .find((delivery) => delivery.canonicalEligible);
        if (!terminal || terminal.id !== input.terminalDeliveryId) {
          throw new Error(
            "Archive terminal delivery must be the final canonical delivery",
          );
        }
        if (!isAuthoritativeTerminalDelivery(terminal)) {
          throw new Error(
            "Archive terminal delivery must be confirmed game_finalised with StatusId 100",
          );
        }

        const deliveryHash = deliveryManifestHash(deliveries);
        const manifestRows = await transaction.unsafe(
          `INSERT INTO matchsense.archive_manifests AS manifest (
  id, mode, fixture_id, status, reducer_version, delivery_manifest_hash,
  projection_hash, terminal_delivery_id, rights_grant_id, verified_at
)
VALUES ($1, $2, $3, 'REPLAY_READY', $4, $5, $6, $7, $8, clock_timestamp())
ON CONFLICT (mode, fixture_id) DO UPDATE SET
  status = 'REPLAY_READY',
  reducer_version = EXCLUDED.reducer_version,
  delivery_manifest_hash = EXCLUDED.delivery_manifest_hash,
  projection_hash = EXCLUDED.projection_hash,
  terminal_delivery_id = EXCLUDED.terminal_delivery_id,
  rights_grant_id = EXCLUDED.rights_grant_id,
  invalidation_reason = NULL,
  invalidated_at = NULL,
  verified_at = clock_timestamp(),
  updated_at = clock_timestamp()
RETURNING ${manifestColumns};`,
          [
            input.manifestId,
            input.mode,
            input.fixtureId,
            input.reducerVersion,
            deliveryHash,
            input.projectionHash,
            input.terminalDeliveryId,
            input.rightsGrantId,
          ],
        );
        const manifestRow = manifestRows[0];
        if (!manifestRow)
          throw new Error("Archive manifest upsert returned no row");
        const manifest = parseManifest(manifestRow);
        await transaction.unsafe(
          `DELETE FROM matchsense.archive_manifest_entries
WHERE manifest_id = $1;`,
          [manifest.id],
        );
        await transaction.unsafe(
          `INSERT INTO matchsense.archive_manifest_entries (
  manifest_id, mode, fixture_id, ordinal, delivery_id, delivery_key,
  ordering_key, response_hash
)
SELECT $1, $2, $3, entry.ordinal, entry.delivery_id, entry.delivery_key,
  entry.ordering_key, entry.response_hash
FROM unnest(
  $4::integer[], $5::text[], $6::text[], $7::text[], $8::text[]
) AS entry(ordinal, delivery_id, delivery_key, ordering_key, response_hash);`,
          [
            manifest.id,
            input.mode,
            input.fixtureId,
            deliveries.map((_, index) => index + 1),
            deliveries.map((delivery) => delivery.id),
            deliveries.map((delivery) => delivery.deliveryKey),
            deliveries.map((delivery) => delivery.orderingKey),
            deliveries.map((delivery) => delivery.responseHash),
          ],
        );
        return { kind: "verified", manifest };
      });
    },
    invalidateArchive: async (input) => {
      assertArchiveFixtureKey(input);
      assertNonempty(input.reason, "Archive invalidation reason");
      assertArchiveSourceFence(input.sourceFence);
      return client.begin(async (transaction) => {
        if (
          !(await lockCurrentArchiveSourceFence(transaction, {
            mode: input.mode,
            sourceFence: input.sourceFence,
          }))
        ) {
          return { kind: "fenced" };
        }
        await transaction.unsafe(
          `UPDATE matchsense.archive_manifests
SET status = 'REPLAY_INVALIDATED',
    invalidation_reason = $3,
    invalidated_at = clock_timestamp(),
    updated_at = clock_timestamp()
WHERE mode = $1 AND fixture_id = $2 AND status = 'REPLAY_READY';`,
          [input.mode, input.fixtureId, input.reason],
        );
        return { kind: "applied" };
      });
    },
    replayReady: async (input) => {
      assertArchiveFixtureKey(input);
      if (input.mode !== "recorded") return null;
      const rows = await client.unsafe(
        `SELECT ${manifestSelectColumns}
FROM matchsense.archive_manifests AS manifest
JOIN matchsense.rights_grants AS rights_grant ON rights_grant.id = manifest.rights_grant_id
WHERE manifest.mode = $1
  AND manifest.fixture_id = $2
  AND manifest.status = 'REPLAY_READY'
  AND (${currentRecordedArchiveImportBinding()})
  AND rights_grant.active = true
  AND rights_grant.revoked_at IS NULL
  AND (rights_grant.expires_at IS NULL OR rights_grant.expires_at > clock_timestamp())
  AND rights_grant.scopes @> ARRAY['replay']::text[]
ORDER BY manifest.verified_at DESC, manifest.id ASC
LIMIT 1;`,
        [input.mode, input.fixtureId],
      );
      return rows[0] ? parseManifest(rows[0]) : null;
    },
  };
}
