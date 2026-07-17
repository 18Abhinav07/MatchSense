import type {
  PersistenceMode,
  QueryRow,
  RepositoryClient,
} from "./repositories.js";

type JsonObject = Record<string, unknown>;

function encodeJson(value: unknown) {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("JSON value is invalid");
  return encoded;
}

function decodeJson(value: unknown, field: string): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Database row field ${field} is invalid`);
  }
}

function objectJson(value: unknown, field: string): JsonObject {
  const decoded = decodeJson(value, field);
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error(`Database row field ${field} is invalid`);
  }
  return decoded as JsonObject;
}

function requiredString(row: QueryRow, field: string) {
  const value = row[field];
  if (typeof value !== "string") {
    throw new Error(`Database row field ${field} is invalid`);
  }
  return value;
}

function nullableString(row: QueryRow, field: string) {
  const value = row[field];
  return value === null ? null : requiredString(row, field);
}

function timestamp(row: QueryRow, field: string) {
  const value = row[field];
  if (value instanceof Date) return value.toISOString();
  return requiredString(row, field);
}

function nullableTimestamp(row: QueryRow, field: string) {
  return row[field] === null ? null : timestamp(row, field);
}

function safeInteger(value: unknown, field: string) {
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

function bytes(row: QueryRow, field: string) {
  const value = row[field];
  if (!(value instanceof Uint8Array)) {
    throw new Error(`Database row field ${field} is invalid`);
  }
  return value;
}

function persistenceMode(row: QueryRow): PersistenceMode {
  const value = requiredString(row, "mode");
  if (value !== "live" && value !== "demo") {
    throw new Error("Database row field mode is invalid");
  }
  return value;
}

function assertHash(value: string, label: string) {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} must be lowercase SHA-256 hex`);
  }
}

export interface FanRecord {
  avatarVariant: string | null;
  createdAt: string;
  deletedAt: string | null;
  favoriteTeam: string | null;
  handle: string | null;
  handleNormalized: string | null;
  id: string;
  preferences: JsonObject;
  profile: JsonObject;
  updatedAt: string;
}

export interface FanFollowRecord {
  createdAt: string;
  eventPreferences: JsonObject;
  fanId: string;
  fixtureId: string;
  mode: PersistenceMode;
}

export interface FanSessionRecord {
  csrfHash: string;
  expiresAt: string;
  fan: FanRecord;
  lastSeenAt: string;
  revokedAt: string | null;
  sessionHash: string;
}

export interface FanRepository {
  createGuest(input: {
    csrfHash: string;
    expiresAt: string;
    fanId: string;
    sessionHash: string;
  }): Promise<FanRecord>;
  deleteFan(fanId: string): Promise<boolean>;
  getProfile(fanId: string): Promise<FanRecord | null>;
  isHandleAvailable(input: {
    excludeFanId?: string;
    handle: string;
  }): Promise<boolean>;
  listFollows(fanId: string): Promise<readonly FanFollowRecord[]>;
  listFollowers(input: {
    fixtureId: string;
    mode: PersistenceMode;
  }): Promise<readonly FanFollowRecord[]>;
  removeFollow(input: {
    fanId: string;
    fixtureId: string;
    mode: PersistenceMode;
  }): Promise<boolean>;
  resolveSession(input: {
    now?: string;
    sessionHash: string;
  }): Promise<FanSessionRecord | null>;
  touchSession(sessionHash: string): Promise<boolean>;
  updateProfile(input: {
    avatarVariant: string;
    fanId: string;
    favoriteTeam: string;
    handle: string;
    preferences: JsonObject;
    profile: JsonObject;
  }): Promise<FanRecord>;
  upsertFollow(input: {
    eventPreferences: JsonObject;
    fanId: string;
    fixtureId: string;
    mode: PersistenceMode;
  }): Promise<void>;
}

const fanColumns = `id, handle, handle_normalized, favorite_team, avatar_variant,
profile, preferences, created_at, updated_at, deleted_at`;

function parseFan(row: QueryRow): FanRecord {
  return {
    avatarVariant: nullableString(row, "avatar_variant"),
    createdAt: timestamp(row, "created_at"),
    deletedAt: nullableTimestamp(row, "deleted_at"),
    favoriteTeam: nullableString(row, "favorite_team"),
    handle: nullableString(row, "handle"),
    handleNormalized: nullableString(row, "handle_normalized"),
    id: requiredString(row, "id"),
    preferences: objectJson(row.preferences, "preferences"),
    profile: objectJson(row.profile, "profile"),
    updatedAt: timestamp(row, "updated_at"),
  };
}

function parseFollow(row: QueryRow): FanFollowRecord {
  return {
    createdAt: timestamp(row, "created_at"),
    eventPreferences: objectJson(row.event_preferences, "event_preferences"),
    fanId: requiredString(row, "fan_id"),
    fixtureId: requiredString(row, "fixture_id"),
    mode: persistenceMode(row),
  };
}

export function createFanRepository(client: RepositoryClient): FanRepository {
  return {
    createGuest: async (input) => {
      assertHash(input.sessionHash, "Session hash");
      assertHash(input.csrfHash, "CSRF hash");
      return client.begin(async (transaction) => {
        const rows = await transaction.unsafe(
          `INSERT INTO matchsense.fans (id)
VALUES ($1)
RETURNING ${fanColumns};`,
          [input.fanId],
        );
        const fan = rows[0];
        if (!fan) throw new Error("Fan insert returned no row");
        await transaction.unsafe(
          `INSERT INTO matchsense.fan_sessions (
  token_hash, fan_id, csrf_hash, expires_at
)
VALUES ($1, $2, $3, $4::timestamptz);`,
          [input.sessionHash, input.fanId, input.csrfHash, input.expiresAt],
        );
        return parseFan(fan);
      });
    },
    deleteFan: async (fanId) =>
      client.begin(async (transaction) => {
        await transaction.unsafe(
          `DELETE FROM matchsense.push_deliveries
WHERE device_id IN (
  SELECT id FROM matchsense.push_devices WHERE fan_id = $1
);`,
          [fanId],
        );
        await transaction.unsafe(
          "DELETE FROM matchsense.push_devices WHERE fan_id = $1;",
          [fanId],
        );
        await transaction.unsafe(
          "DELETE FROM matchsense.fan_follows WHERE fan_id = $1;",
          [fanId],
        );
        await transaction.unsafe(
          "DELETE FROM matchsense.fan_sessions WHERE fan_id = $1;",
          [fanId],
        );
        const rows = await transaction.unsafe(
          `UPDATE matchsense.fans
SET handle = NULL,
    handle_normalized = NULL,
    favorite_team = NULL,
    avatar_variant = NULL,
    profile = '{}'::jsonb,
    preferences = '{}'::jsonb,
    deleted_at = clock_timestamp(),
    updated_at = clock_timestamp()
WHERE id = $1 AND deleted_at IS NULL
RETURNING id;`,
          [fanId],
        );
        return rows[0] !== undefined;
      }),
    getProfile: async (fanId) => {
      const rows = await client.unsafe(
        `SELECT ${fanColumns}
FROM matchsense.fans
WHERE id = $1;`,
        [fanId],
      );
      return rows[0] ? parseFan(rows[0]) : null;
    },
    isHandleAvailable: async (input) => {
      const normalized = input.handle.trim().toLowerCase();
      const rows = await client.unsafe(
        `SELECT NOT EXISTS (
  SELECT 1 FROM matchsense.fans
  WHERE handle_normalized = $1
    AND deleted_at IS NULL
    AND ($2::text IS NULL OR id <> $2)
) AS available;`,
        [normalized, input.excludeFanId ?? null],
      );
      return rows[0]?.available === true;
    },
    listFollows: async (fanId) => {
      const rows = await client.unsafe(
        `SELECT fan_id, mode, fixture_id, event_preferences, created_at
FROM matchsense.fan_follows
WHERE fan_id = $1
ORDER BY created_at ASC, mode ASC, fixture_id ASC;`,
        [fanId],
      );
      return rows.map(parseFollow);
    },
    listFollowers: async (input) => {
      const rows = await client.unsafe(
        `SELECT fan_id, mode, fixture_id, event_preferences, created_at
FROM matchsense.fan_follows
WHERE mode = $1 AND fixture_id = $2
ORDER BY created_at ASC, fan_id ASC;`,
        [input.mode, input.fixtureId],
      );
      return rows.map(parseFollow);
    },
    removeFollow: async (input) => {
      const rows = await client.unsafe(
        `DELETE FROM matchsense.fan_follows
WHERE fan_id = $1 AND mode = $2 AND fixture_id = $3
RETURNING fan_id;`,
        [input.fanId, input.mode, input.fixtureId],
      );
      return rows[0] !== undefined;
    },
    resolveSession: async (input) => {
      assertHash(input.sessionHash, "Session hash");
      const rows = await client.unsafe(
        `SELECT session.token_hash, session.csrf_hash, session.expires_at,
       session.last_seen_at, session.revoked_at,
       ${fanColumns
         .split(",")
         .map((column) => `fan.${column.trim()}`)
         .join(", ")}
FROM matchsense.fan_sessions AS session
JOIN matchsense.fans AS fan ON fan.id = session.fan_id
WHERE session.token_hash = $1
  AND session.revoked_at IS NULL
  AND session.expires_at > COALESCE($2::timestamptz, clock_timestamp())
  AND fan.deleted_at IS NULL;`,
        [input.sessionHash, input.now ?? null],
      );
      const row = rows[0];
      return row
        ? {
            csrfHash: requiredString(row, "csrf_hash"),
            expiresAt: timestamp(row, "expires_at"),
            fan: parseFan(row),
            lastSeenAt: timestamp(row, "last_seen_at"),
            revokedAt: nullableTimestamp(row, "revoked_at"),
            sessionHash: requiredString(row, "token_hash"),
          }
        : null;
    },
    touchSession: async (sessionHash) => {
      assertHash(sessionHash, "Session hash");
      const rows = await client.unsafe(
        `UPDATE matchsense.fan_sessions
SET last_seen_at = clock_timestamp()
WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > clock_timestamp()
RETURNING token_hash;`,
        [sessionHash],
      );
      return rows[0] !== undefined;
    },
    updateProfile: async (input) => {
      const handle = input.handle.trim();
      if (!/^[A-Za-z0-9_]{3,24}$/u.test(handle)) {
        throw new Error("Handle is invalid");
      }
      const rows = await client.unsafe(
        `UPDATE matchsense.fans
SET handle = $2,
    handle_normalized = $3,
    favorite_team = $4,
    avatar_variant = $5,
    profile = $6::jsonb,
    preferences = $7::jsonb,
    updated_at = clock_timestamp()
WHERE id = $1 AND deleted_at IS NULL
RETURNING ${fanColumns};`,
        [
          input.fanId,
          handle,
          handle.toLowerCase(),
          input.favoriteTeam,
          input.avatarVariant,
          encodeJson(input.profile),
          encodeJson(input.preferences),
        ],
      );
      const row = rows[0];
      if (!row) throw new Error("Fan does not exist");
      return parseFan(row);
    },
    upsertFollow: async (input) => {
      await client.unsafe(
        `INSERT INTO matchsense.fan_follows (
  fan_id, mode, fixture_id, event_preferences
)
VALUES ($1, $2, $3, $4::jsonb)
ON CONFLICT (fan_id, mode, fixture_id) DO UPDATE SET
  event_preferences = EXCLUDED.event_preferences;`,
        [
          input.fanId,
          input.mode,
          input.fixtureId,
          encodeJson(input.eventPreferences),
        ],
      );
    },
  };
}

export interface PushDeviceRecord {
  authTag: Uint8Array;
  ciphertext: Uint8Array;
  createdAt: string;
  endpointHash: string;
  expiresAt: string | null;
  fanId: string;
  id: string;
  invalidatedAt: string | null;
  iv: Uint8Array;
  keyVersion: number;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  preferences: JsonObject;
  updatedAt: string;
}

export type PushDeliveryStatus = "pending" | "sent" | "failed" | "invalidated";

export interface PushDeviceRepository {
  getActiveForFan(input: {
    deviceId: string;
    fanId: string;
  }): Promise<PushDeviceRecord | null>;
  invalidate(input: { deviceId: string; failedAt?: string }): Promise<boolean>;
  listActiveForFan(fanId: string): Promise<readonly PushDeviceRecord[]>;
  recordDelivery(input: {
    deviceId: string;
    fixtureId: string;
    id: string;
    lastError?: string | null;
    mode: PersistenceMode;
    momentId: string;
    momentRevision: number;
    sentAt?: string | null;
    status: PushDeliveryStatus;
  }): Promise<void>;
  upsertDevice(input: {
    authTag: Uint8Array;
    ciphertext: Uint8Array;
    endpointHash: string;
    expiresAt: string | null;
    fanId: string;
    id: string;
    iv: Uint8Array;
    keyVersion: number;
    preferences: JsonObject;
  }): Promise<PushDeviceRecord>;
}

const pushDeviceColumns = `id, fan_id, endpoint_hash, subscription_ciphertext,
iv, auth_tag, key_version, preferences, expires_at, invalidated_at,
last_success_at, last_failure_at, created_at, updated_at`;

function parsePushDevice(row: QueryRow): PushDeviceRecord {
  return {
    authTag: bytes(row, "auth_tag"),
    ciphertext: bytes(row, "subscription_ciphertext"),
    createdAt: timestamp(row, "created_at"),
    endpointHash: requiredString(row, "endpoint_hash"),
    expiresAt: nullableTimestamp(row, "expires_at"),
    fanId: requiredString(row, "fan_id"),
    id: requiredString(row, "id"),
    invalidatedAt: nullableTimestamp(row, "invalidated_at"),
    iv: bytes(row, "iv"),
    keyVersion: safeInteger(row.key_version, "key_version"),
    lastFailureAt: nullableTimestamp(row, "last_failure_at"),
    lastSuccessAt: nullableTimestamp(row, "last_success_at"),
    preferences: objectJson(row.preferences, "preferences"),
    updatedAt: timestamp(row, "updated_at"),
  };
}

export function createPushDeviceRepository(
  client: RepositoryClient,
): PushDeviceRepository {
  return {
    getActiveForFan: async (input) => {
      const rows = await client.unsafe(
        `SELECT ${pushDeviceColumns}
FROM matchsense.push_devices
WHERE id = $1 AND fan_id = $2
  AND invalidated_at IS NULL
  AND (expires_at IS NULL OR expires_at > clock_timestamp());`,
        [input.deviceId, input.fanId],
      );
      return rows[0] ? parsePushDevice(rows[0]) : null;
    },
    invalidate: async (input) => {
      const rows = await client.unsafe(
        `UPDATE matchsense.push_devices
SET invalidated_at = COALESCE($2::timestamptz, clock_timestamp()),
    last_failure_at = COALESCE($2::timestamptz, clock_timestamp()),
    updated_at = clock_timestamp()
WHERE id = $1 AND invalidated_at IS NULL
RETURNING id;`,
        [input.deviceId, input.failedAt ?? null],
      );
      return rows[0] !== undefined;
    },
    listActiveForFan: async (fanId) => {
      const rows = await client.unsafe(
        `SELECT ${pushDeviceColumns}
FROM matchsense.push_devices
WHERE fan_id = $1
  AND invalidated_at IS NULL
  AND (expires_at IS NULL OR expires_at > clock_timestamp())
ORDER BY created_at ASC, id ASC;`,
        [fanId],
      );
      return rows.map(parsePushDevice);
    },
    recordDelivery: async (input) => {
      await client.unsafe(
        `INSERT INTO matchsense.push_deliveries (
  id, device_id, mode, fixture_id, moment_id, moment_revision,
  status, attempt_count, last_error, sent_at
)
VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9::timestamptz)
ON CONFLICT (device_id, mode, fixture_id, moment_id, moment_revision)
DO UPDATE SET
  status = EXCLUDED.status,
  attempt_count = matchsense.push_deliveries.attempt_count + 1,
  last_error = EXCLUDED.last_error,
  sent_at = COALESCE(EXCLUDED.sent_at, matchsense.push_deliveries.sent_at);`,
        [
          input.id,
          input.deviceId,
          input.mode,
          input.fixtureId,
          input.momentId,
          input.momentRevision,
          input.status,
          input.lastError ?? null,
          input.sentAt ?? null,
        ],
      );
    },
    upsertDevice: async (input) => {
      assertHash(input.endpointHash, "Endpoint hash");
      if (input.keyVersion < 1 || !Number.isSafeInteger(input.keyVersion)) {
        throw new Error("Push key version is invalid");
      }
      const rows = await client.unsafe(
        `INSERT INTO matchsense.push_devices (
  id, fan_id, endpoint_hash, subscription_ciphertext, iv, auth_tag,
  key_version, preferences, expires_at
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz)
ON CONFLICT (endpoint_hash) DO UPDATE SET
  fan_id = EXCLUDED.fan_id,
  subscription_ciphertext = EXCLUDED.subscription_ciphertext,
  iv = EXCLUDED.iv,
  auth_tag = EXCLUDED.auth_tag,
  key_version = EXCLUDED.key_version,
  preferences = EXCLUDED.preferences,
  expires_at = EXCLUDED.expires_at,
  invalidated_at = NULL,
  updated_at = clock_timestamp()
RETURNING ${pushDeviceColumns};`,
        [
          input.id,
          input.fanId,
          input.endpointHash,
          input.ciphertext,
          input.iv,
          input.authTag,
          input.keyVersion,
          encodeJson(input.preferences),
          input.expiresAt,
        ],
      );
      const row = rows[0];
      if (!row) throw new Error("Push device upsert returned no row");
      return parsePushDevice(row);
    },
  };
}

export type ExperienceJourney = "guided_demo" | "experience_match";
export type ExperienceRunStatus =
  "ready" | "countdown" | "live" | "final" | "cancelled";

export interface ExperienceRunRecord {
  completedAt: string | null;
  createdAt: string;
  fixtureId: string;
  fixtureMode: "demo";
  id: string;
  journey: ExperienceJourney;
  kickoffAt: string;
  nextBeatIndex: number;
  ownerFanId: string | null;
  status: ExperienceRunStatus;
  templateId: string;
  templateVersion: number;
  updatedAt: string;
  version: number;
}

export interface ExperienceBeatRecord {
  attemptCount: number;
  beatIndex: number;
  beatKey: string;
  claimedAt: string | null;
  claimToken: string | null;
  deliveredAt: string | null;
  dueAt: string;
  envelope: unknown;
  lastError: string | null;
  runId: string;
  state: "pending" | "claimed" | "delivered";
}

export interface ExperienceRepository {
  claimDueBeats(input: {
    claimToken: string;
    limit: number;
    lockTimeoutMs: number;
    now: string;
  }): Promise<readonly ExperienceBeatRecord[]>;
  completeBeat(input: {
    beatIndex: number;
    claimToken: string;
    deliveredAt: string;
    runId: string;
  }): Promise<boolean>;
  createRun(input: {
    beats: readonly {
      beatIndex: number;
      beatKey: string;
      dueAt: string;
      envelope: unknown;
    }[];
    run: {
      fixtureId: string;
      id: string;
      journey: ExperienceJourney;
      kickoffAt: string;
      ownerFanId: string | null;
      status: ExperienceRunStatus;
      templateId: string;
      templateVersion: number;
    };
    template: {
      active: boolean;
      definition: unknown;
      id: string;
      version: number;
    };
  }): Promise<ExperienceRunRecord>;
  failBeat(input: {
    beatIndex: number;
    claimToken: string;
    error: string;
    retryAt: string;
    runId: string;
  }): Promise<boolean>;
  getRun(runId: string): Promise<ExperienceRunRecord | null>;
  listForOwner(fanId: string): Promise<readonly ExperienceRunRecord[]>;
  listRecoverableRuns(): Promise<readonly ExperienceRunRecord[]>;
}

const experienceRunColumns = `id, template_id, template_version, fixture_mode,
fixture_id, owner_fan_id, journey, status, kickoff_at, next_beat_index,
version, created_at, updated_at, completed_at`;
const experienceBeatColumns = `run_id, beat_index, beat_key, due_at, envelope,
state, claim_token, claimed_at, delivered_at, attempt_count, last_error`;

function parseExperienceRun(row: QueryRow): ExperienceRunRecord {
  const fixtureMode = requiredString(row, "fixture_mode");
  if (fixtureMode !== "demo") {
    throw new Error("Database row field fixture_mode is invalid");
  }
  return {
    completedAt: nullableTimestamp(row, "completed_at"),
    createdAt: timestamp(row, "created_at"),
    fixtureId: requiredString(row, "fixture_id"),
    fixtureMode,
    id: requiredString(row, "id"),
    journey: requiredString(row, "journey") as ExperienceJourney,
    kickoffAt: timestamp(row, "kickoff_at"),
    nextBeatIndex: safeInteger(row.next_beat_index, "next_beat_index"),
    ownerFanId: nullableString(row, "owner_fan_id"),
    status: requiredString(row, "status") as ExperienceRunStatus,
    templateId: requiredString(row, "template_id"),
    templateVersion: safeInteger(row.template_version, "template_version"),
    updatedAt: timestamp(row, "updated_at"),
    version: safeInteger(row.version, "version"),
  };
}

function parseExperienceBeat(row: QueryRow): ExperienceBeatRecord {
  return {
    attemptCount: safeInteger(row.attempt_count, "attempt_count"),
    beatIndex: safeInteger(row.beat_index, "beat_index"),
    beatKey: requiredString(row, "beat_key"),
    claimedAt: nullableTimestamp(row, "claimed_at"),
    claimToken: nullableString(row, "claim_token"),
    deliveredAt: nullableTimestamp(row, "delivered_at"),
    dueAt: timestamp(row, "due_at"),
    envelope: decodeJson(row.envelope, "envelope"),
    lastError: nullableString(row, "last_error"),
    runId: requiredString(row, "run_id"),
    state: requiredString(row, "state") as ExperienceBeatRecord["state"],
  };
}

export function createExperienceRepository(
  client: RepositoryClient,
): ExperienceRepository {
  return {
    claimDueBeats: async (input) => {
      if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
        throw new Error("Experience claim limit is invalid");
      }
      const rows = await client.unsafe(
        `WITH due AS (
  SELECT run_id, beat_index
  FROM matchsense.experience_run_beats
  WHERE due_at <= $1::timestamptz
    AND (
      state = 'pending'
      OR (state = 'claimed' AND claimed_at < $1::timestamptz - ($4::integer * interval '1 millisecond'))
    )
  ORDER BY due_at ASC, run_id ASC, beat_index ASC
  FOR UPDATE SKIP LOCKED
  LIMIT $2
)
UPDATE matchsense.experience_run_beats AS beat
SET state = 'claimed', claim_token = $3, claimed_at = $1::timestamptz,
    attempt_count = beat.attempt_count + 1
FROM due
WHERE beat.run_id = due.run_id AND beat.beat_index = due.beat_index
RETURNING ${experienceBeatColumns
          .split(",")
          .map((column) => `beat.${column.trim()}`)
          .join(", ")};`,
        [input.now, input.limit, input.claimToken, input.lockTimeoutMs],
      );
      return rows.map(parseExperienceBeat);
    },
    completeBeat: async (input) =>
      client.begin(async (transaction) => {
        const rows = await transaction.unsafe(
          `UPDATE matchsense.experience_run_beats
SET state = 'delivered', delivered_at = $4::timestamptz,
    claim_token = NULL, claimed_at = NULL, last_error = NULL
WHERE run_id = $1 AND beat_index = $2 AND state = 'claimed' AND claim_token = $3
RETURNING run_id;`,
          [input.runId, input.beatIndex, input.claimToken, input.deliveredAt],
        );
        if (!rows[0]) return false;
        await transaction.unsafe(
          `UPDATE matchsense.experience_runs
SET next_beat_index = GREATEST(next_beat_index, $2 + 1),
    version = version + 1,
    status = CASE
      WHEN NOT EXISTS (
        SELECT 1 FROM matchsense.experience_run_beats
        WHERE run_id = $1 AND state <> 'delivered'
      ) THEN 'final'
      WHEN status IN ('ready', 'countdown') THEN 'live'
      ELSE status
    END,
    completed_at = CASE
      WHEN NOT EXISTS (
        SELECT 1 FROM matchsense.experience_run_beats
        WHERE run_id = $1 AND state <> 'delivered'
      ) THEN $3::timestamptz
      ELSE completed_at
    END,
    updated_at = $3::timestamptz
WHERE id = $1;`,
          [input.runId, input.beatIndex, input.deliveredAt],
        );
        return true;
      }),
    createRun: async (input) =>
      client.begin(async (transaction) => {
        await transaction.unsafe(
          `INSERT INTO matchsense.experience_templates (
  id, version, definition, active
)
VALUES ($1, $2, $3::jsonb, $4)
ON CONFLICT (id, version) DO NOTHING;`,
          [
            input.template.id,
            input.template.version,
            encodeJson(input.template.definition),
            input.template.active,
          ],
        );
        const rows = await transaction.unsafe(
          `INSERT INTO matchsense.experience_runs (
  id, template_id, template_version, fixture_mode, fixture_id,
  owner_fan_id, journey, status, kickoff_at
)
VALUES ($1, $2, $3, 'demo', $4, $5, $6, $7, $8::timestamptz)
RETURNING ${experienceRunColumns};`,
          [
            input.run.id,
            input.run.templateId,
            input.run.templateVersion,
            input.run.fixtureId,
            input.run.ownerFanId,
            input.run.journey,
            input.run.status,
            input.run.kickoffAt,
          ],
        );
        const run = rows[0];
        if (!run) throw new Error("Experience run insert returned no row");
        for (const beat of input.beats) {
          await transaction.unsafe(
            `INSERT INTO matchsense.experience_run_beats (
  run_id, beat_index, beat_key, due_at, envelope
)
VALUES ($1, $2, $3, $4::timestamptz, $5::jsonb);`,
            [
              input.run.id,
              beat.beatIndex,
              beat.beatKey,
              beat.dueAt,
              encodeJson(beat.envelope),
            ],
          );
        }
        return parseExperienceRun(run);
      }),
    failBeat: async (input) => {
      const rows = await client.unsafe(
        `UPDATE matchsense.experience_run_beats
SET state = 'pending', due_at = $5::timestamptz,
    claim_token = NULL, claimed_at = NULL, last_error = $4
WHERE run_id = $1 AND beat_index = $2 AND state = 'claimed' AND claim_token = $3
RETURNING run_id;`,
        [
          input.runId,
          input.beatIndex,
          input.claimToken,
          input.error.slice(0, 4_000),
          input.retryAt,
        ],
      );
      return rows[0] !== undefined;
    },
    getRun: async (runId) => {
      const rows = await client.unsafe(
        `SELECT ${experienceRunColumns}
FROM matchsense.experience_runs
WHERE id = $1;`,
        [runId],
      );
      return rows[0] ? parseExperienceRun(rows[0]) : null;
    },
    listForOwner: async (fanId) => {
      const rows = await client.unsafe(
        `SELECT ${experienceRunColumns}
FROM matchsense.experience_runs
WHERE owner_fan_id = $1
ORDER BY created_at DESC, id ASC;`,
        [fanId],
      );
      return rows.map(parseExperienceRun);
    },
    listRecoverableRuns: async () => {
      const rows = await client.unsafe(
        `SELECT ${experienceRunColumns}
FROM matchsense.experience_runs
WHERE status IN ('ready', 'countdown', 'live', 'final')
ORDER BY created_at DESC, id ASC
LIMIT 50;`,
      );
      return rows.map(parseExperienceRun);
    },
  };
}

export type RoomStatus = "lobby" | "locked" | "live" | "final" | "cancelled";

export interface RoomAggregateRecord<T = unknown> {
  aggregate: T;
  createdAt: string;
  finalizedAt: string | null;
  fixtureId: string;
  id: string;
  inviteExpiresAt: string;
  inviteHash: string;
  mode: PersistenceMode;
  ownerFanId: string;
  status: RoomStatus;
  updatedAt: string;
  version: number;
}

export interface RoomAggregateRepository<T = unknown> {
  compareAndSwap(input: {
    aggregate: T;
    expectedVersion: number;
    finalizedAt: string | null;
    roomId: string;
    status: RoomStatus;
  }): Promise<RoomAggregateRecord<T> | null>;
  create(input: {
    aggregate: T;
    fixtureId: string;
    host: {
      fanId: string;
      nickname: string;
      teamCode: string | null;
    };
    id: string;
    inviteExpiresAt: string;
    inviteHash: string;
    mode: PersistenceMode;
    status: RoomStatus;
  }): Promise<RoomAggregateRecord<T>>;
  get(roomId: string): Promise<RoomAggregateRecord<T> | null>;
  join(input: {
    fanId: string;
    nickname: string;
    role: "member" | "spectator";
    roomId: string;
    teamCode: string | null;
  }): Promise<void>;
  joinAndCompareAndSwap(input: {
    aggregate: T;
    expectedVersion: number;
    finalizedAt: string | null;
    member: {
      fanId: string;
      nickname: string;
      role: "member" | "spectator";
      teamCode: string | null;
    };
    roomId: string;
    status: RoomStatus;
  }): Promise<RoomAggregateRecord<T> | null>;
  listByFixture(input: {
    fixtureId: string;
    mode: PersistenceMode;
  }): Promise<readonly RoomAggregateRecord<T>[]>;
  listForFan(fanId: string): Promise<readonly RoomAggregateRecord<T>[]>;
  previewByInviteHash(
    inviteHash: string,
  ): Promise<RoomAggregateRecord<T> | null>;
}

const roomColumns = `id, mode, fixture_id, owner_fan_id, invite_hash,
invite_expires_at, status, version, aggregate, created_at, updated_at, finalized_at`;

function parseRoom<T>(row: QueryRow): RoomAggregateRecord<T> {
  return {
    aggregate: decodeJson(row.aggregate, "aggregate") as T,
    createdAt: timestamp(row, "created_at"),
    finalizedAt: nullableTimestamp(row, "finalized_at"),
    fixtureId: requiredString(row, "fixture_id"),
    id: requiredString(row, "id"),
    inviteExpiresAt: timestamp(row, "invite_expires_at"),
    inviteHash: requiredString(row, "invite_hash"),
    mode: persistenceMode(row),
    ownerFanId: requiredString(row, "owner_fan_id"),
    status: requiredString(row, "status") as RoomStatus,
    updatedAt: timestamp(row, "updated_at"),
    version: safeInteger(row.version, "version"),
  };
}

export function createRoomAggregateRepository<T = unknown>(
  client: RepositoryClient,
): RoomAggregateRepository<T> {
  return {
    compareAndSwap: async (input) => {
      const rows = await client.unsafe(
        `UPDATE matchsense.rooms
SET version = version + 1,
    aggregate = $3::jsonb,
    status = $4,
    finalized_at = $5::timestamptz,
    updated_at = clock_timestamp()
WHERE id = $1 AND version = $2
RETURNING ${roomColumns};`,
        [
          input.roomId,
          input.expectedVersion,
          encodeJson(input.aggregate),
          input.status,
          input.finalizedAt,
        ],
      );
      return rows[0] ? parseRoom<T>(rows[0]) : null;
    },
    create: async (input) => {
      assertHash(input.inviteHash, "Invite hash");
      return client.begin(async (transaction) => {
        const rows = await transaction.unsafe(
          `INSERT INTO matchsense.rooms (
  id, mode, fixture_id, owner_fan_id, invite_hash,
  invite_expires_at, status, aggregate
)
VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8::jsonb)
RETURNING ${roomColumns};`,
          [
            input.id,
            input.mode,
            input.fixtureId,
            input.host.fanId,
            input.inviteHash,
            input.inviteExpiresAt,
            input.status,
            encodeJson(input.aggregate),
          ],
        );
        const room = rows[0];
        if (!room) throw new Error("Room insert returned no row");
        await transaction.unsafe(
          `INSERT INTO matchsense.room_memberships (
  room_id, fan_id, role, nickname_snapshot, team_code_snapshot
)
VALUES ($1, $2, 'host', $3, $4);`,
          [
            input.id,
            input.host.fanId,
            input.host.nickname,
            input.host.teamCode,
          ],
        );
        return parseRoom<T>(room);
      });
    },
    get: async (roomId) => {
      const rows = await client.unsafe(
        `SELECT ${roomColumns}
FROM matchsense.rooms
WHERE id = $1;`,
        [roomId],
      );
      return rows[0] ? parseRoom<T>(rows[0]) : null;
    },
    join: async (input) => {
      await client.unsafe(
        `INSERT INTO matchsense.room_memberships (
  room_id, fan_id, role, nickname_snapshot, team_code_snapshot
)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (room_id, fan_id) DO UPDATE SET
  role = EXCLUDED.role,
  nickname_snapshot = EXCLUDED.nickname_snapshot,
  team_code_snapshot = EXCLUDED.team_code_snapshot,
  left_at = NULL;`,
        [input.roomId, input.fanId, input.role, input.nickname, input.teamCode],
      );
    },
    joinAndCompareAndSwap: async (input) =>
      client.begin(async (transaction) => {
        const rows = await transaction.unsafe(
          `UPDATE matchsense.rooms
SET version = version + 1,
    aggregate = $3::jsonb,
    status = $4,
    finalized_at = $5::timestamptz,
    updated_at = clock_timestamp()
WHERE id = $1 AND version = $2
RETURNING ${roomColumns};`,
          [
            input.roomId,
            input.expectedVersion,
            encodeJson(input.aggregate),
            input.status,
            input.finalizedAt,
          ],
        );
        const room = rows[0];
        if (!room) return null;
        await transaction.unsafe(
          `INSERT INTO matchsense.room_memberships (
  room_id, fan_id, role, nickname_snapshot, team_code_snapshot
)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (room_id, fan_id) DO UPDATE SET
  role = EXCLUDED.role,
  nickname_snapshot = EXCLUDED.nickname_snapshot,
  team_code_snapshot = EXCLUDED.team_code_snapshot,
  left_at = NULL;`,
          [
            input.roomId,
            input.member.fanId,
            input.member.role,
            input.member.nickname,
            input.member.teamCode,
          ],
        );
        return parseRoom<T>(room);
      }),
    listByFixture: async (input) => {
      const rows = await client.unsafe(
        `SELECT ${roomColumns}
FROM matchsense.rooms
WHERE mode = $1 AND fixture_id = $2
ORDER BY created_at ASC, id ASC;`,
        [input.mode, input.fixtureId],
      );
      return rows.map(parseRoom<T>);
    },
    listForFan: async (fanId) => {
      const rows = await client.unsafe(
        `SELECT ${roomColumns
          .split(",")
          .map((column) => `room.${column.trim()}`)
          .join(", ")}
FROM matchsense.rooms AS room
JOIN matchsense.room_memberships AS membership ON membership.room_id = room.id
WHERE membership.fan_id = $1 AND membership.left_at IS NULL
ORDER BY room.updated_at DESC, room.id ASC;`,
        [fanId],
      );
      return rows.map(parseRoom<T>);
    },
    previewByInviteHash: async (inviteHash) => {
      assertHash(inviteHash, "Invite hash");
      const rows = await client.unsafe(
        `SELECT ${roomColumns}
FROM matchsense.rooms
WHERE invite_hash = $1
  AND invite_expires_at > clock_timestamp()
  AND status <> 'cancelled';`,
        [inviteHash],
      );
      return rows[0] ? parseRoom<T>(rows[0]) : null;
    },
  };
}

export interface MemoryRecord<T = unknown> {
  createdAt: string;
  fanId: string;
  fixtureId: string;
  mode: PersistenceMode;
  payload: T;
  revision: number;
}

export interface MemoryRepository<T = unknown> {
  append(input: {
    fanId: string;
    fixtureId: string;
    mode: PersistenceMode;
    payload: T;
    revision: number;
  }): Promise<MemoryRecord<T> | null>;
  latestForFanFixture(input: {
    fanId: string;
    fixtureId: string;
    mode: PersistenceMode;
  }): Promise<MemoryRecord<T> | null>;
  listLatestForFan(fanId: string): Promise<readonly MemoryRecord<T>[]>;
}

const memoryColumns = `fan_id, mode, fixture_id, revision, payload, created_at`;

function parseMemory<T>(row: QueryRow): MemoryRecord<T> {
  return {
    createdAt: timestamp(row, "created_at"),
    fanId: requiredString(row, "fan_id"),
    fixtureId: requiredString(row, "fixture_id"),
    mode: persistenceMode(row),
    payload: decodeJson(row.payload, "payload") as T,
    revision: safeInteger(row.revision, "revision"),
  };
}

export function createMemoryRepository<T = unknown>(
  client: RepositoryClient,
): MemoryRepository<T> {
  return {
    append: async (input) => {
      const rows = await client.unsafe(
        `INSERT INTO matchsense.match_memories (
  fan_id, mode, fixture_id, revision, payload
)
VALUES ($1, $2, $3, $4, $5::jsonb)
ON CONFLICT DO NOTHING
RETURNING ${memoryColumns};`,
        [
          input.fanId,
          input.mode,
          input.fixtureId,
          input.revision,
          encodeJson(input.payload),
        ],
      );
      return rows[0] ? parseMemory<T>(rows[0]) : null;
    },
    latestForFanFixture: async (input) => {
      const rows = await client.unsafe(
        `SELECT ${memoryColumns}
FROM matchsense.match_memories
WHERE fan_id = $1 AND mode = $2 AND fixture_id = $3
ORDER BY revision DESC
LIMIT 1;`,
        [input.fanId, input.mode, input.fixtureId],
      );
      return rows[0] ? parseMemory<T>(rows[0]) : null;
    },
    listLatestForFan: async (fanId) => {
      const rows = await client.unsafe(
        `SELECT ${memoryColumns}
FROM (
  SELECT DISTINCT ON (mode, fixture_id) ${memoryColumns}
  FROM matchsense.match_memories
  WHERE fan_id = $1
  ORDER BY mode, fixture_id, revision DESC
) AS latest
ORDER BY created_at DESC, mode ASC, fixture_id ASC;`,
        [fanId],
      );
      return rows.map(parseMemory<T>);
    },
  };
}
