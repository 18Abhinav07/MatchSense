import { createHash } from "node:crypto";

export interface MigrationDefinition {
  checksum: string;
  description: string;
  sql: string;
  version: number;
}

export interface AppliedMigration {
  checksum: string;
  version: number;
}

export type MigrationStateErrorCode =
  | "MIGRATION_CHECKSUM_DRIFT"
  | "MIGRATION_HISTORY_NOT_PREFIX"
  | "UNKNOWN_APPLIED_MIGRATION";

export class MigrationStateError extends Error {
  readonly code: MigrationStateErrorCode;

  constructor(code: MigrationStateErrorCode) {
    super("Database migration state is invalid");
    this.name = "MigrationStateError";
    this.code = code;
  }
}

function defineMigration(
  version: number,
  description: string,
  sql: string,
): MigrationDefinition {
  return Object.freeze({
    checksum: createHash("sha256").update(sql).digest("hex"),
    description,
    sql,
    version,
  });
}

export const migrationCatalog = Object.freeze([
  defineMigration(
    1,
    "create matchsense schema",
    "CREATE SCHEMA IF NOT EXISTS matchsense;",
  ),
  defineMigration(
    2,
    "create durable product truth and delivery foundation",
    `CREATE TABLE matchsense.fixtures (
  mode text NOT NULL CHECK (mode IN ('live', 'demo')),
  id text NOT NULL,
  provenance text NOT NULL,
  home_team_id text NOT NULL,
  away_team_id text NOT NULL,
  scheduled_at timestamptz NOT NULL,
  status text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (mode, id),
  CHECK (home_team_id <> away_team_id),
  CHECK ((mode = 'live' AND provenance = 'live_txline') OR (mode = 'demo' AND provenance = 'synthetic_txline_shaped'))
);

CREATE INDEX fixtures_schedule_idx
  ON matchsense.fixtures (mode, scheduled_at, id);

CREATE TABLE matchsense.raw_source_records (
  mode text NOT NULL CHECK (mode IN ('live', 'demo')),
  id text NOT NULL,
  fixture_id text NOT NULL,
  source text NOT NULL,
  source_record_id text,
  source_sequence text,
  dedupe_key text NOT NULL,
  payload_hash text NOT NULL CHECK (length(payload_hash) = 64),
  provenance text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL,
  persisted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (mode, id),
  UNIQUE (mode, fixture_id, id),
  FOREIGN KEY (mode, fixture_id) REFERENCES matchsense.fixtures (mode, id) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((mode = 'live' AND provenance = 'live_txline') OR (mode = 'demo' AND provenance = 'synthetic_txline_shaped'))
);

CREATE UNIQUE INDEX raw_source_records_dedupe_idx
  ON matchsense.raw_source_records (mode, source, fixture_id, dedupe_key);
CREATE INDEX raw_source_records_fixture_idx
  ON matchsense.raw_source_records (mode, fixture_id, persisted_at, id);

CREATE FUNCTION matchsense.reject_raw_source_record_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'raw source records are immutable';
END;
$$;

CREATE TRIGGER raw_source_records_immutable
BEFORE UPDATE OR DELETE ON matchsense.raw_source_records
FOR EACH ROW EXECUTE FUNCTION matchsense.reject_raw_source_record_mutation();

CREATE TABLE matchsense.source_cursors (
  mode text NOT NULL CHECK (mode IN ('live', 'demo')),
  source text NOT NULL,
  stream_key text NOT NULL,
  cursor_value text NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (mode, source, stream_key)
);

CREATE TABLE matchsense.source_leases (
  mode text NOT NULL CHECK (mode IN ('live', 'demo')),
  source text NOT NULL,
  stream_key text NOT NULL,
  holder_id text NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  lease_until timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (mode, source, stream_key)
);

CREATE INDEX source_leases_expiry_idx
  ON matchsense.source_leases (mode, source, stream_key, lease_until);

CREATE TABLE matchsense.fixture_projections (
  mode text NOT NULL CHECK (mode IN ('live', 'demo')),
  fixture_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 0),
  source_sequence text,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (mode, fixture_id),
  FOREIGN KEY (mode, fixture_id) REFERENCES matchsense.fixtures (mode, id)
);

CREATE TABLE matchsense.canonical_moments (
  mode text NOT NULL CHECK (mode IN ('live', 'demo')),
  id text NOT NULL,
  fixture_id text NOT NULL,
  kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (mode, fixture_id, id),
  FOREIGN KEY (mode, fixture_id) REFERENCES matchsense.fixtures (mode, id)
);

CREATE INDEX canonical_moments_fixture_idx
  ON matchsense.canonical_moments (mode, fixture_id, created_at, id);

CREATE TABLE matchsense.moment_revisions (
  mode text NOT NULL CHECK (mode IN ('live', 'demo')),
  moment_id text NOT NULL,
  fixture_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  source_record_id text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (mode, fixture_id, moment_id, revision),
  FOREIGN KEY (mode, fixture_id, moment_id) REFERENCES matchsense.canonical_moments (mode, fixture_id, id),
  FOREIGN KEY (mode, fixture_id) REFERENCES matchsense.fixtures (mode, id),
  FOREIGN KEY (mode, fixture_id, source_record_id) REFERENCES matchsense.raw_source_records (mode, fixture_id, id)
);

CREATE INDEX moment_revisions_fixture_idx
  ON matchsense.moment_revisions (mode, fixture_id, revision, moment_id);

CREATE TABLE matchsense.fixture_events (
  mode text NOT NULL CHECK (mode IN ('live', 'demo')),
  fixture_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (mode, fixture_id, sequence),
  UNIQUE (mode, fixture_id, event_id),
  FOREIGN KEY (mode, fixture_id) REFERENCES matchsense.fixtures (mode, id)
);

CREATE INDEX fixture_events_catchup_idx
  ON matchsense.fixture_events (mode, fixture_id, sequence);

CREATE TABLE matchsense.outbox (
  mode text NOT NULL CHECK (mode IN ('live', 'demo')),
  id text NOT NULL,
  fixture_id text NOT NULL,
  topic text NOT NULL,
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  locked_by text,
  locked_at timestamptz,
  claim_token text,
  processed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (mode, id),
  UNIQUE (mode, idempotency_key),
  FOREIGN KEY (mode, fixture_id) REFERENCES matchsense.fixtures (mode, id),
  CHECK ((locked_by IS NULL) = (locked_at IS NULL)),
  CHECK ((locked_by IS NULL) = (claim_token IS NULL))
);

CREATE INDEX outbox_unprocessed_idx
  ON matchsense.outbox (mode, available_at, created_at, id)
  WHERE processed_at IS NULL;

CREATE TABLE matchsense.consumer_receipts (
  mode text NOT NULL CHECK (mode IN ('live', 'demo')),
  consumer text NOT NULL,
  outbox_id text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (mode, consumer, outbox_id),
  FOREIGN KEY (mode, outbox_id) REFERENCES matchsense.outbox (mode, id)
);

CREATE TABLE matchsense.outbox_dead_letters (
  mode text NOT NULL CHECK (mode IN ('live', 'demo')),
  id text NOT NULL,
  outbox_id text NOT NULL,
  fixture_id text NOT NULL,
  topic text NOT NULL,
  payload jsonb NOT NULL,
  attempt_count integer NOT NULL CHECK (attempt_count > 0),
  error text NOT NULL,
  failed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (mode, id),
  UNIQUE (mode, outbox_id),
  FOREIGN KEY (mode, outbox_id) REFERENCES matchsense.outbox (mode, id),
  FOREIGN KEY (mode, fixture_id) REFERENCES matchsense.fixtures (mode, id)
);

CREATE TABLE matchsense.commentary_artifacts (
  mode text NOT NULL CHECK (mode IN ('live', 'demo')),
  id text NOT NULL,
  fixture_id text NOT NULL,
  moment_id text NOT NULL,
  moment_revision bigint NOT NULL CHECK (moment_revision > 0),
  language text NOT NULL,
  voice text NOT NULL,
  media_type text NOT NULL DEFAULT 'audio/mpeg',
  bytes bytea NOT NULL CHECK (octet_length(bytes) > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (mode, id),
  UNIQUE (mode, fixture_id, moment_id, moment_revision, language, voice),
  FOREIGN KEY (mode, fixture_id) REFERENCES matchsense.fixtures (mode, id),
  FOREIGN KEY (mode, fixture_id, moment_id, moment_revision) REFERENCES matchsense.moment_revisions (mode, fixture_id, moment_id, revision)
);

CREATE INDEX commentary_artifacts_fixture_idx
  ON matchsense.commentary_artifacts (mode, fixture_id, created_at, id);`.trim(),
  ),
  defineMigration(
    3,
    "create unified fan experience product records",
    `ALTER TABLE matchsense.raw_source_records
  ALTER COLUMN payload DROP NOT NULL,
  ADD COLUMN delivery_intent text NOT NULL DEFAULT 'realtime'
    CHECK (delivery_intent IN ('realtime', 'reconcile')),
  ADD COLUMN occurred_at timestamptz;

ALTER TABLE matchsense.canonical_moments
  ADD COLUMN current_revision bigint NOT NULL DEFAULT 0
    CHECK (current_revision >= 0);

UPDATE matchsense.canonical_moments AS moment
SET current_revision = latest.revision
FROM (
  SELECT mode, fixture_id, moment_id, MAX(revision) AS revision
  FROM matchsense.moment_revisions
  GROUP BY mode, fixture_id, moment_id
) AS latest
WHERE moment.mode = latest.mode
  AND moment.fixture_id = latest.fixture_id
  AND moment.id = latest.moment_id;

CREATE TABLE matchsense.fans (
  id text PRIMARY KEY,
  handle text,
  handle_normalized text UNIQUE,
  favorite_team text,
  avatar_variant text,
  profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  CHECK (handle IS NULL OR length(handle) BETWEEN 3 AND 24),
  CHECK (handle_normalized IS NULL OR handle_normalized = lower(handle_normalized))
);

CREATE TABLE matchsense.fan_sessions (
  token_hash text PRIMARY KEY CHECK (length(token_hash) = 64),
  fan_id text NOT NULL REFERENCES matchsense.fans (id),
  csrf_hash text NOT NULL CHECK (length(csrf_hash) = 64),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX fan_sessions_fan_idx
  ON matchsense.fan_sessions (fan_id, expires_at);

CREATE TABLE matchsense.fan_follows (
  fan_id text NOT NULL REFERENCES matchsense.fans (id),
  mode text NOT NULL CHECK (mode IN ('live', 'demo')),
  fixture_id text NOT NULL,
  event_preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (fan_id, mode, fixture_id),
  FOREIGN KEY (mode, fixture_id) REFERENCES matchsense.fixtures (mode, id)
);

CREATE TABLE matchsense.push_devices (
  id text PRIMARY KEY,
  fan_id text NOT NULL REFERENCES matchsense.fans (id),
  endpoint_hash text NOT NULL UNIQUE CHECK (length(endpoint_hash) = 64),
  subscription_ciphertext bytea NOT NULL,
  iv bytea NOT NULL,
  auth_tag bytea NOT NULL,
  key_version integer NOT NULL DEFAULT 1 CHECK (key_version > 0),
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz,
  invalidated_at timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX push_devices_fan_idx
  ON matchsense.push_devices (fan_id, invalidated_at);

CREATE TABLE matchsense.push_deliveries (
  id text PRIMARY KEY,
  device_id text NOT NULL REFERENCES matchsense.push_devices (id),
  mode text NOT NULL CHECK (mode IN ('live', 'demo')),
  fixture_id text NOT NULL,
  moment_id text NOT NULL,
  moment_revision bigint NOT NULL CHECK (moment_revision > 0),
  status text NOT NULL CHECK (status IN ('pending', 'sent', 'failed', 'invalidated')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (device_id, mode, fixture_id, moment_id, moment_revision),
  FOREIGN KEY (mode, fixture_id, moment_id, moment_revision)
    REFERENCES matchsense.moment_revisions (mode, fixture_id, moment_id, revision)
);

CREATE TABLE matchsense.experience_templates (
  id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  definition jsonb NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (id, version)
);

CREATE TABLE matchsense.experience_runs (
  id text PRIMARY KEY,
  template_id text NOT NULL,
  template_version integer NOT NULL,
  fixture_mode text NOT NULL DEFAULT 'demo' CHECK (fixture_mode = 'demo'),
  fixture_id text NOT NULL,
  owner_fan_id text REFERENCES matchsense.fans (id),
  journey text NOT NULL CHECK (journey IN ('guided_demo', 'experience_match')),
  status text NOT NULL CHECK (status IN ('ready', 'countdown', 'live', 'final', 'cancelled')),
  kickoff_at timestamptz NOT NULL,
  next_beat_index integer NOT NULL DEFAULT 0 CHECK (next_beat_index >= 0),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE (fixture_mode, fixture_id),
  FOREIGN KEY (template_id, template_version)
    REFERENCES matchsense.experience_templates (id, version),
  FOREIGN KEY (fixture_mode, fixture_id)
    REFERENCES matchsense.fixtures (mode, id)
);

CREATE TABLE matchsense.experience_run_beats (
  run_id text NOT NULL REFERENCES matchsense.experience_runs (id),
  beat_index integer NOT NULL CHECK (beat_index >= 0),
  beat_key text NOT NULL,
  due_at timestamptz NOT NULL,
  envelope jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'claimed', 'delivered')),
  claim_token text,
  claimed_at timestamptz,
  delivered_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text,
  PRIMARY KEY (run_id, beat_index),
  UNIQUE (run_id, beat_key),
  CHECK ((state = 'claimed') = (claim_token IS NOT NULL))
);

CREATE INDEX experience_run_beats_due_idx
  ON matchsense.experience_run_beats (state, due_at, run_id, beat_index);

CREATE TABLE matchsense.rooms (
  id text PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('live', 'demo')),
  fixture_id text NOT NULL,
  owner_fan_id text NOT NULL REFERENCES matchsense.fans (id),
  invite_hash text NOT NULL UNIQUE CHECK (length(invite_hash) = 64),
  invite_expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('lobby', 'locked', 'live', 'final', 'cancelled')),
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  aggregate jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finalized_at timestamptz,
  FOREIGN KEY (mode, fixture_id) REFERENCES matchsense.fixtures (mode, id)
);

CREATE INDEX rooms_fixture_idx
  ON matchsense.rooms (mode, fixture_id, status);

CREATE TABLE matchsense.room_memberships (
  room_id text NOT NULL REFERENCES matchsense.rooms (id),
  fan_id text NOT NULL REFERENCES matchsense.fans (id),
  role text NOT NULL CHECK (role IN ('host', 'member', 'spectator')),
  nickname_snapshot text NOT NULL,
  team_code_snapshot text,
  joined_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  left_at timestamptz,
  PRIMARY KEY (room_id, fan_id)
);

CREATE INDEX room_memberships_fan_idx
  ON matchsense.room_memberships (fan_id, joined_at DESC);

CREATE TABLE matchsense.match_memories (
  fan_id text NOT NULL REFERENCES matchsense.fans (id),
  mode text NOT NULL CHECK (mode IN ('live', 'demo')),
  fixture_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (fan_id, mode, fixture_id, revision),
  FOREIGN KEY (mode, fixture_id) REFERENCES matchsense.fixtures (mode, id)
);

CREATE INDEX match_memories_fan_latest_idx
  ON matchsense.match_memories (fan_id, created_at DESC);`.trim(),
  ),
]);

export function planMigrations(
  catalog: readonly MigrationDefinition[],
  applied: readonly AppliedMigration[],
) {
  const sortedCatalog = catalog.toSorted(
    (left, right) => left.version - right.version,
  );
  const catalogByVersion = new Map(
    sortedCatalog.map((migration) => [migration.version, migration]),
  );

  if (applied.some((entry) => !catalogByVersion.has(entry.version))) {
    throw new MigrationStateError("UNKNOWN_APPLIED_MIGRATION");
  }

  if (
    applied.some(
      (entry) =>
        catalogByVersion.get(entry.version)?.checksum !== entry.checksum,
    )
  ) {
    throw new MigrationStateError("MIGRATION_CHECKSUM_DRIFT");
  }

  if (
    applied.length > sortedCatalog.length ||
    applied.some(
      (entry, index) => sortedCatalog[index]?.version !== entry.version,
    )
  ) {
    throw new MigrationStateError("MIGRATION_HISTORY_NOT_PREFIX");
  }

  const pending = sortedCatalog.slice(applied.length);

  return { current: pending.length === 0, pending };
}
