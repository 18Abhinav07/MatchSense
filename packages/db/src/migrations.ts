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
  defineMigration(
    4,
    "retire synthetic public modes and add authorised archive jobs",
    `-- Migration 2 intentionally makes raw source rows immutable. Version 4
-- needs a one-transaction maintenance window to remove synthetic rows and
-- annotate legacy rows; the trigger is restored before this migration commits.
DROP TRIGGER IF EXISTS raw_source_records_immutable
  ON matchsense.raw_source_records;

-- The synthetic Experience/Demo records are not a public product data source.
-- They are removed before the product mode constraints are tightened.
DELETE FROM matchsense.push_deliveries WHERE mode = 'demo';
DELETE FROM matchsense.commentary_artifacts WHERE mode = 'demo';
DELETE FROM matchsense.moment_revisions WHERE mode = 'demo';
DELETE FROM matchsense.canonical_moments WHERE mode = 'demo';
DELETE FROM matchsense.fixture_events WHERE mode = 'demo';
DELETE FROM matchsense.consumer_receipts WHERE mode = 'demo';
DELETE FROM matchsense.outbox_dead_letters WHERE mode = 'demo';
DELETE FROM matchsense.outbox WHERE mode = 'demo';
DELETE FROM matchsense.fixture_projections WHERE mode = 'demo';
DELETE FROM matchsense.raw_source_records WHERE mode = 'demo';
DELETE FROM matchsense.source_cursors WHERE mode = 'demo';
DELETE FROM matchsense.source_leases WHERE mode = 'demo';
DELETE FROM matchsense.fan_follows WHERE mode = 'demo';
DELETE FROM matchsense.room_memberships
WHERE room_id IN (SELECT id FROM matchsense.rooms WHERE mode = 'demo');
DELETE FROM matchsense.rooms WHERE mode = 'demo';
DELETE FROM matchsense.match_memories WHERE mode = 'demo';
DELETE FROM matchsense.experience_run_beats;
DELETE FROM matchsense.experience_runs;
DELETE FROM matchsense.experience_templates;
DELETE FROM matchsense.fixtures WHERE mode = 'demo';

CREATE TABLE matchsense.rights_grants (
  id text PRIMARY KEY,
  reference text NOT NULL,
  scopes text[] NOT NULL,
  active boolean NOT NULL DEFAULT true,
  raw_retention_until timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (cardinality(scopes) > 0),
  CHECK (revoked_at IS NULL OR active = false)
);

-- Legacy pre-archive records remain explicitly non-replayable. We preserve
-- their normalised history without inventing a raw-data right or response.
INSERT INTO matchsense.rights_grants (
  id, reference, scopes, active, revoked_at
)
VALUES (
  'legacy-unverified',
  'pre-v4 source records without authorised raw-retention metadata',
  ARRAY['normalised_retention'],
  false,
  clock_timestamp()
)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE matchsense.raw_source_records
  ADD COLUMN delivery_key text,
  ADD COLUMN ordering_key text,
  ADD COLUMN source_path text,
  ADD COLUMN stream_key text,
  ADD COLUMN response_hash text,
  ADD COLUMN rights_grant_id text,
  ADD COLUMN raw_retention text,
  ADD COLUMN canonical_eligible boolean;

UPDATE matchsense.raw_source_records
SET delivery_key = payload_hash,
    ordering_key = COALESCE(source_sequence, id),
    source_path = 'legacy-unverified',
    stream_key = source,
    response_hash = payload_hash,
    rights_grant_id = 'legacy-unverified',
    raw_retention = 'normalised_only',
    canonical_eligible = true
WHERE delivery_key IS NULL;

CREATE TRIGGER raw_source_records_immutable
BEFORE UPDATE OR DELETE ON matchsense.raw_source_records
FOR EACH ROW EXECUTE FUNCTION matchsense.reject_raw_source_record_mutation();

ALTER TABLE matchsense.raw_source_records
  ALTER COLUMN delivery_key SET NOT NULL,
  ALTER COLUMN ordering_key SET NOT NULL,
  ALTER COLUMN source_path SET NOT NULL,
  ALTER COLUMN stream_key SET NOT NULL,
  ALTER COLUMN response_hash SET NOT NULL,
  ALTER COLUMN rights_grant_id SET NOT NULL,
  ALTER COLUMN raw_retention SET NOT NULL,
  ALTER COLUMN canonical_eligible SET NOT NULL;

ALTER TABLE matchsense.fixtures
  DROP CONSTRAINT IF EXISTS fixtures_mode_check,
  DROP CONSTRAINT IF EXISTS fixtures_check;
ALTER TABLE matchsense.fixtures
  ADD CONSTRAINT fixtures_mode_check CHECK (mode IN ('live', 'recorded')),
  ADD CONSTRAINT fixtures_provenance_check CHECK (
    (mode = 'live' AND provenance = 'live_txline')
    OR (mode = 'recorded' AND provenance = 'recorded_txline_authorised')
  );

ALTER TABLE matchsense.raw_source_records
  DROP CONSTRAINT IF EXISTS raw_source_records_mode_check,
  DROP CONSTRAINT IF EXISTS raw_source_records_check,
  DROP CONSTRAINT IF EXISTS raw_source_records_payload_hash_check,
  DROP CONSTRAINT IF EXISTS raw_source_records_delivery_intent_check;
ALTER TABLE matchsense.raw_source_records
  ADD CONSTRAINT raw_source_records_mode_check CHECK (mode IN ('live', 'recorded')),
  ADD CONSTRAINT raw_source_records_payload_hash_check
    CHECK (length(payload_hash) = 64),
  ADD CONSTRAINT raw_source_records_response_hash_check
    CHECK (length(response_hash) = 64),
  ADD CONSTRAINT raw_source_records_provenance_check CHECK (
    (mode = 'live' AND provenance = 'live_txline')
    OR (mode = 'recorded' AND provenance = 'recorded_txline_authorised')
  ),
  ADD CONSTRAINT raw_source_records_delivery_intent_check
    CHECK (delivery_intent IN ('realtime', 'reconcile')),
  ADD CONSTRAINT raw_source_records_retention_check CHECK (
    (raw_retention = 'authorised_raw' AND payload IS NOT NULL)
    OR raw_retention = 'normalised_only'
  ),
  ADD CONSTRAINT raw_source_records_rights_grant_fk
    FOREIGN KEY (rights_grant_id) REFERENCES matchsense.rights_grants (id);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'source_cursors',
    'source_leases',
    'fixture_projections',
    'canonical_moments',
    'moment_revisions',
    'fixture_events',
    'outbox',
    'consumer_receipts',
    'outbox_dead_letters',
    'commentary_artifacts',
    'fan_follows',
    'push_deliveries',
    'rooms',
    'match_memories'
  ]
  LOOP
    EXECUTE format(
      'ALTER TABLE matchsense.%I DROP CONSTRAINT IF EXISTS %I',
      table_name,
      table_name || '_mode_check'
    );
    EXECUTE format(
      'ALTER TABLE matchsense.%I ADD CONSTRAINT %I CHECK (mode IN (''live'', ''recorded''))',
      table_name,
      table_name || '_mode_check'
    );
  END LOOP;
END;
$$;

ALTER TABLE matchsense.experience_runs
  DROP CONSTRAINT IF EXISTS experience_runs_fixture_mode_check,
  ALTER COLUMN fixture_mode SET DEFAULT 'recorded';
ALTER TABLE matchsense.experience_runs
  ADD CONSTRAINT experience_runs_fixture_mode_check
    CHECK (fixture_mode IN ('live', 'recorded'));

ALTER TABLE matchsense.fixture_events
  ADD COLUMN source_record_id text;
ALTER TABLE matchsense.fixture_events
  ADD CONSTRAINT fixture_events_source_record_fk
    FOREIGN KEY (mode, fixture_id, source_record_id)
    REFERENCES matchsense.raw_source_records (mode, fixture_id, id);

ALTER TABLE matchsense.outbox
  ADD COLUMN source_record_id text;
ALTER TABLE matchsense.outbox
  ADD CONSTRAINT outbox_source_record_fk
    FOREIGN KEY (mode, fixture_id, source_record_id)
    REFERENCES matchsense.raw_source_records (mode, fixture_id, id);

CREATE OR REPLACE FUNCTION matchsense.reject_source_only_canonical_write()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.source_record_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM matchsense.raw_source_records AS source_record
    WHERE source_record.mode = NEW.mode
      AND source_record.fixture_id = NEW.fixture_id
      AND source_record.id = NEW.source_record_id
      AND source_record.canonical_eligible = false
  ) THEN
    RAISE EXCEPTION 'source-only delivery cannot create canonical truth';
  END IF;
  IF TG_TABLE_NAME IN ('moment_revisions', 'outbox')
    AND NEW.source_record_id IS NOT NULL AND EXISTS (
      SELECT 1
      FROM matchsense.raw_source_records AS source_record
      WHERE source_record.mode = NEW.mode
        AND source_record.fixture_id = NEW.fixture_id
        AND source_record.id = NEW.source_record_id
        AND source_record.delivery_intent = 'reconcile'
    ) THEN
    RAISE EXCEPTION 'reconciliation delivery cannot create Moment or outbox effects';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS moment_revisions_source_only_guard
  ON matchsense.moment_revisions;
CREATE TRIGGER moment_revisions_source_only_guard
BEFORE INSERT ON matchsense.moment_revisions
FOR EACH ROW EXECUTE FUNCTION matchsense.reject_source_only_canonical_write();

DROP TRIGGER IF EXISTS fixture_events_source_only_guard
  ON matchsense.fixture_events;
CREATE TRIGGER fixture_events_source_only_guard
BEFORE INSERT ON matchsense.fixture_events
FOR EACH ROW EXECUTE FUNCTION matchsense.reject_source_only_canonical_write();

DROP TRIGGER IF EXISTS outbox_source_only_guard
  ON matchsense.outbox;
CREATE TRIGGER outbox_source_only_guard
BEFORE INSERT ON matchsense.outbox
FOR EACH ROW EXECUTE FUNCTION matchsense.reject_source_only_canonical_write();

ALTER TABLE matchsense.commentary_artifacts
  ADD COLUMN template_version text NOT NULL DEFAULT 'legacy-v1';
ALTER TABLE matchsense.commentary_artifacts
  DROP CONSTRAINT IF EXISTS commentary_artifacts_mode_fixture_id_moment_id_moment_revision_language_voice_key;
ALTER TABLE matchsense.commentary_artifacts
  ADD CONSTRAINT commentary_artifacts_identity_key
    UNIQUE (mode, fixture_id, moment_id, moment_revision, language, voice, template_version);

CREATE TABLE matchsense.fixture_schedule_observations (
  mode text NOT NULL CHECK (mode IN ('live', 'recorded')),
  fixture_id text NOT NULL,
  source text NOT NULL,
  source_path text NOT NULL,
  observed_at timestamptz NOT NULL,
  response_hash text NOT NULL CHECK (length(response_hash) = 64),
  rights_grant_id text NOT NULL REFERENCES matchsense.rights_grants (id),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (mode, fixture_id, source, observed_at, response_hash),
  FOREIGN KEY (mode, fixture_id) REFERENCES matchsense.fixtures (mode, id)
);

CREATE INDEX raw_source_records_archive_order_idx
  ON matchsense.raw_source_records (mode, fixture_id, ordering_key, delivery_key);
CREATE INDEX raw_source_records_rights_idx
  ON matchsense.raw_source_records (rights_grant_id, raw_retention);

CREATE TABLE matchsense.archive_manifests (
  id text PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('live', 'recorded')),
  fixture_id text NOT NULL,
  status text NOT NULL CHECK (status IN (
    'COLLECTING',
    'TERMINAL_OBSERVED',
    'REPLAY_READY',
    'REPLAY_INVALIDATED',
    'REPLAY_REJECTED'
  )),
  reducer_version text NOT NULL,
  delivery_manifest_hash text NOT NULL CHECK (length(delivery_manifest_hash) = 64),
  projection_hash text NOT NULL CHECK (length(projection_hash) = 64),
  terminal_delivery_id text NOT NULL,
  rights_grant_id text NOT NULL REFERENCES matchsense.rights_grants (id),
  invalidation_reason text,
  invalidated_at timestamptz,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (mode, fixture_id),
  FOREIGN KEY (mode, fixture_id) REFERENCES matchsense.fixtures (mode, id),
  FOREIGN KEY (mode, fixture_id, terminal_delivery_id)
    REFERENCES matchsense.raw_source_records (mode, fixture_id, id),
  CHECK ((status = 'REPLAY_INVALIDATED') = (invalidated_at IS NOT NULL)),
  CHECK ((status = 'REPLAY_INVALIDATED') = (invalidation_reason IS NOT NULL))
);

CREATE TABLE matchsense.archive_manifest_entries (
  manifest_id text NOT NULL REFERENCES matchsense.archive_manifests (id),
  mode text NOT NULL,
  fixture_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  delivery_id text NOT NULL,
  delivery_key text NOT NULL,
  ordering_key text NOT NULL,
  response_hash text NOT NULL CHECK (length(response_hash) = 64),
  PRIMARY KEY (manifest_id, ordinal),
  UNIQUE (manifest_id, delivery_id),
  FOREIGN KEY (mode, fixture_id, delivery_id)
    REFERENCES matchsense.raw_source_records (mode, fixture_id, id)
);

CREATE INDEX archive_manifests_replay_ready_idx
  ON matchsense.archive_manifests (fixture_id, mode, verified_at DESC)
  WHERE status = 'REPLAY_READY';

CREATE TABLE matchsense.commentary_jobs (
  id text PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('live', 'recorded')),
  fixture_id text NOT NULL,
  family_id text NOT NULL,
  moment_revision bigint NOT NULL CHECK (moment_revision > 0),
  language text NOT NULL,
  voice text NOT NULL,
  template_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'claimed', 'ready', 'failed', 'superseded')),
  artifact_id text,
  artifact_sha256 text CHECK (artifact_sha256 IS NULL OR length(artifact_sha256) = 64),
  claimed_by text,
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (mode, fixture_id, family_id, moment_revision, language, voice, template_version),
  FOREIGN KEY (mode, fixture_id, family_id, moment_revision)
    REFERENCES matchsense.moment_revisions (mode, fixture_id, moment_id, revision),
  FOREIGN KEY (mode, artifact_id)
    REFERENCES matchsense.commentary_artifacts (mode, id),
  CHECK ((status = 'claimed') = (claimed_by IS NOT NULL)),
  CHECK ((status = 'claimed') = (claimed_at IS NOT NULL)),
  CHECK ((status = 'claimed') = (claim_expires_at IS NOT NULL)),
  CHECK ((status = 'ready') = (artifact_id IS NOT NULL)),
  CHECK ((status = 'ready') = (artifact_sha256 IS NOT NULL))
);

CREATE INDEX commentary_jobs_claim_idx
  ON matchsense.commentary_jobs (status, claim_expires_at, created_at, id)
  WHERE status IN ('queued', 'claimed');

CREATE OR REPLACE FUNCTION matchsense.commentary_ready_requires_bytes()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'ready' AND NOT EXISTS (
    SELECT 1
    FROM matchsense.commentary_artifacts AS artifact
    WHERE artifact.mode = NEW.mode
      AND artifact.id = NEW.artifact_id
      AND octet_length(artifact.bytes) > 0
  ) THEN
    RAISE EXCEPTION 'ready commentary job requires nonempty artifact bytes';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER commentary_jobs_ready_requires_bytes
BEFORE INSERT OR UPDATE OF status, artifact_id ON matchsense.commentary_jobs
FOR EACH ROW EXECUTE FUNCTION matchsense.commentary_ready_requires_bytes();`.trim(),
  ),
  defineMigration(
    5,
    "create durable live TxLINE team catalogue",
    `ALTER TABLE matchsense.fixtures
  DROP CONSTRAINT IF EXISTS fixtures_check1;

CREATE TABLE matchsense.team_catalog_entries (
  participant_id text NOT NULL CHECK (length(btrim(participant_id)) > 0),
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{1,19}$'),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  source_timestamp_ms bigint NOT NULL CHECK (source_timestamp_ms >= 0),
  mode text NOT NULL DEFAULT 'live' CHECK (mode = 'live'),
  source text NOT NULL DEFAULT 'txline' CHECK (source = 'txline'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (participant_id),
  UNIQUE (code)
);

CREATE INDEX team_catalog_entries_code_idx
  ON matchsense.team_catalog_entries (code ASC, participant_id ASC);`.trim(),
  ),
  defineMigration(
    6,
    "create durable archive import jobs and featured replay readiness",
    `CREATE TABLE matchsense.archive_import_jobs (
  fixture_id text PRIMARY KEY CHECK (length(btrim(fixture_id)) > 0),
  home_team_id text NOT NULL CHECK (length(btrim(home_team_id)) > 0),
  away_team_id text NOT NULL CHECK (length(btrim(away_team_id)) > 0),
  kickoff_at timestamptz NOT NULL,
  participant1_is_home boolean NOT NULL,
  context_hash text NOT NULL CHECK (length(context_hash) = 64),
  reason text NOT NULL CHECK (reason IN (
    'featured_bootstrap', 'live_terminal', 'live_correction'
  )),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN (
    'queued', 'claimed', 'retry_wait', 'replay_ready', 'blocked_rights', 'rejected'
  )),
  archive_manifest_id text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claimed_by text,
  claim_expires_at timestamptz,
  source_terminal_record_id text NOT NULL
    CHECK (length(btrim(source_terminal_record_id)) > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT archive_import_jobs_distinct_teams
    CHECK (home_team_id <> away_team_id),
  CONSTRAINT archive_import_jobs_claim_pair
    CHECK ((claimed_by IS NULL) = (claim_expires_at IS NULL)),
  CONSTRAINT archive_import_jobs_claimed_state
    CHECK ((state = 'claimed') = (claimed_by IS NOT NULL)),
  CONSTRAINT archive_import_jobs_replay_ready_manifest
    CHECK ((state = 'replay_ready') = (archive_manifest_id IS NOT NULL)),
  CONSTRAINT archive_import_jobs_manifest_fk
    FOREIGN KEY (archive_manifest_id) REFERENCES matchsense.archive_manifests (id)
);

CREATE INDEX archive_import_jobs_claim_idx
  ON matchsense.archive_import_jobs (available_at ASC, created_at ASC, fixture_id ASC)
  WHERE state IN ('queued', 'retry_wait');
CREATE INDEX archive_import_jobs_expired_claim_idx
  ON matchsense.archive_import_jobs (claim_expires_at ASC, fixture_id ASC)
  WHERE state = 'claimed';

CREATE TABLE matchsense.featured_replay_configs (
  slot text PRIMARY KEY CHECK (length(btrim(slot)) > 0),
  fixture_id text NOT NULL CHECK (length(btrim(fixture_id)) > 0),
  archive_manifest_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT featured_replay_configs_manifest_fk
    FOREIGN KEY (archive_manifest_id) REFERENCES matchsense.archive_manifests (id)
);

CREATE INDEX featured_replay_configs_enabled_idx
  ON matchsense.featured_replay_configs (slot ASC)
  WHERE enabled;`.trim(),
  ),
  defineMigration(
    7,
    "pin replay readiness to verified archive manifest content",
    `ALTER TABLE matchsense.archive_import_jobs
  ADD COLUMN archive_manifest_hash text
    CHECK (archive_manifest_hash IS NULL OR length(archive_manifest_hash) = 64);

UPDATE matchsense.archive_import_jobs AS job
SET archive_manifest_hash = archive.delivery_manifest_hash,
    updated_at = clock_timestamp()
FROM matchsense.archive_manifests AS archive
WHERE job.state = 'replay_ready'
  AND job.archive_manifest_id = archive.id;

ALTER TABLE matchsense.archive_import_jobs
  DROP CONSTRAINT IF EXISTS archive_import_jobs_replay_ready_manifest;
ALTER TABLE matchsense.archive_import_jobs
  ADD CONSTRAINT archive_import_jobs_replay_ready_manifest
    CHECK (
      (state = 'replay_ready') = (
        archive_manifest_id IS NOT NULL AND archive_manifest_hash IS NOT NULL
      )
    );

ALTER TABLE matchsense.featured_replay_configs
  ADD COLUMN archive_manifest_hash text;

UPDATE matchsense.featured_replay_configs AS config
SET archive_manifest_hash = archive.delivery_manifest_hash,
    updated_at = clock_timestamp()
FROM matchsense.archive_manifests AS archive
WHERE config.archive_manifest_id = archive.id;

ALTER TABLE matchsense.featured_replay_configs
  ALTER COLUMN archive_manifest_hash SET NOT NULL;
ALTER TABLE matchsense.featured_replay_configs
  ADD CONSTRAINT featured_replay_configs_manifest_hash_check
    CHECK (length(archive_manifest_hash) = 64);`.trim(),
  ),
  defineMigration(
    8,
    "fence archive import claims with verified output bindings",
    `ALTER TABLE matchsense.archive_import_jobs
  ADD COLUMN claim_generation bigint NOT NULL DEFAULT 0
    CHECK (claim_generation >= 0),
  ADD COLUMN claim_started_at timestamptz;

-- A claim that began before this migration cannot produce the generation-bound
-- evidence required below. Requeue it rather than letting an old worker finalise.
UPDATE matchsense.archive_import_jobs
SET state = 'retry_wait',
    claimed_by = NULL,
    claim_expires_at = NULL,
    claim_started_at = NULL,
    available_at = clock_timestamp(),
    last_error = COALESCE(
      last_error,
      'archive import claim reset for generation fencing migration'
    ),
    updated_at = clock_timestamp()
WHERE state = 'claimed';

ALTER TABLE matchsense.archive_import_jobs
  DROP CONSTRAINT IF EXISTS archive_import_jobs_claim_pair;
ALTER TABLE matchsense.archive_import_jobs
  ADD CONSTRAINT archive_import_jobs_claim_pair
    CHECK (
      (claimed_by IS NULL AND claim_expires_at IS NULL AND claim_started_at IS NULL)
      OR
      (claimed_by IS NOT NULL AND claim_expires_at IS NOT NULL AND claim_started_at IS NOT NULL)
    );
ALTER TABLE matchsense.archive_import_jobs
  ADD CONSTRAINT archive_import_jobs_claim_generation_when_claimed
    CHECK (state <> 'claimed' OR claim_generation > 0);

CREATE TABLE matchsense.archive_import_job_outputs (
  fixture_id text NOT NULL
    REFERENCES matchsense.archive_import_jobs (fixture_id) ON DELETE CASCADE,
  claim_generation bigint NOT NULL CHECK (claim_generation > 0),
  claim_started_at timestamptz NOT NULL,
  source_terminal_record_id text NOT NULL
    CHECK (length(btrim(source_terminal_record_id)) > 0),
  worker_id text NOT NULL CHECK (length(btrim(worker_id)) > 0),
  archive_manifest_id text NOT NULL
    REFERENCES matchsense.archive_manifests (id),
  archive_manifest_hash text NOT NULL
    CHECK (length(archive_manifest_hash) = 64),
  archive_terminal_delivery_id text NOT NULL
    CHECK (length(btrim(archive_terminal_delivery_id)) > 0),
  archive_verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (fixture_id, claim_generation)
);

CREATE INDEX archive_import_job_outputs_manifest_idx
  ON matchsense.archive_import_job_outputs (
    archive_manifest_id ASC, archive_manifest_hash ASC
  );`.trim(),
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
