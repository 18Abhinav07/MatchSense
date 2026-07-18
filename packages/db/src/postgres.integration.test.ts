import { createHash } from "node:crypto";

import postgres from "postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  assertDestructiveIntegrationTarget,
  createPostgresDatabase,
  migrationCatalog,
  runDatabaseCli,
  type ApplicationDatabase,
  type CommitSourceChangeInput,
} from "./index.js";

const { databaseUrl } = assertDestructiveIntegrationTarget({
  allowDestructive: process.env.MATCHSENSE_ALLOW_DESTRUCTIVE_DB_TESTS,
  databaseUrl: process.env.TEST_DATABASE_URL,
});

const admin = postgres(databaseUrl, { max: 1 });
const runtimes = new Set<ApplicationDatabase>();

function trackedDatabase(databaseTarget = databaseUrl) {
  const runtime = createPostgresDatabase(databaseTarget);
  runtimes.add(runtime);
  return runtime;
}

async function resetDatabase() {
  await admin.unsafe("DROP SCHEMA IF EXISTS matchsense CASCADE;");
  await admin.unsafe(
    "DROP TABLE IF EXISTS public.matchsense_schema_migrations;",
  );
}

async function seedV3MigrationLedger() {
  for (const migration of migrationCatalog.slice(0, 3)) {
    await admin.unsafe(migration.sql);
  }
  await admin.unsafe(`CREATE TABLE public.matchsense_schema_migrations (
  version integer PRIMARY KEY CHECK (version > 0),
  checksum text NOT NULL CHECK (length(checksum) = 64),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);`);
  for (const migration of migrationCatalog.slice(0, 3)) {
    await admin.unsafe(
      "INSERT INTO public.matchsense_schema_migrations (version, checksum) VALUES ($1, $2);",
      [migration.version, migration.checksum],
    );
  }
}

const recordedFixture = {
  awayTeamId: "ESP",
  homeTeamId: "FRA",
  id: "fx-1",
  metadata: { competition: "Integration Final" },
  mode: "recorded" as const,
  provenance: "recorded_txline_authorised" as const,
  scheduledAt: "2026-07-17T12:00:00.000Z",
  status: "scheduled",
};

function sourceChange(
  input: {
    expectedRevision?: number;
    outboxIdempotencyKey?: string;
    suffix?: string;
  } = {},
): CommitSourceChangeInput {
  const expectedRevision = input.expectedRevision ?? 0;
  const revision = expectedRevision + 1;
  const suffix = input.suffix ?? String(revision);
  return {
    event: {
      id: `event-${suffix}`,
      payload: { event: "moment.created", revision },
      type: "moment.created",
    },
    expectedRevision,
    fixtureId: recordedFixture.id,
    mode: "recorded",
    moment: {
      id: `moment-${suffix}`,
      kind: "goal",
      payload: { revision, score: { away: 0, home: revision } },
      revision,
    },
    outbox: {
      id: `outbox-${suffix}`,
      idempotencyKey:
        input.outboxIdempotencyKey ?? `moment-${suffix}:${revision}:foreground`,
      payload: { momentId: `moment-${suffix}`, revision },
      topic: "moment.created",
    },
    projection: {
      payload: { revision, score: { away: 0, home: revision } },
      revision,
    },
    raw: {
      dedupeKey: `fixture:${recordedFixture.id}:record:${suffix}`,
      id: `raw-${suffix}`,
      payload: { action: "goal", revision },
      payloadHash: createHash("sha256").update(suffix).digest("hex"),
      provenance: "recorded_txline_authorised",
      receivedAt: `2026-07-17T12:0${Math.min(revision, 9)}:00.000Z`,
      source: "replay",
      sourceRecordId: null,
      sourceSequence: String(revision),
    },
  };
}

beforeAll(async () => {
  await admin.unsafe("SELECT 1;");
});

beforeEach(async () => {
  await resetDatabase();
});

afterEach(async () => {
  const closeResults = await Promise.allSettled(
    [...runtimes].map((runtime) => runtime.close()),
  );
  runtimes.clear();

  let resetFailure: unknown;
  try {
    await resetDatabase();
  } catch (error) {
    resetFailure = error;
  }

  const failures = closeResults
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (resetFailure) {
    failures.push(resetFailure);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "PostgreSQL integration cleanup failed");
  }
});

afterAll(async () => {
  await admin.end({ timeout: 5 });
});

describe.sequential("real PostgreSQL migration runtime", () => {
  it("reports a fresh database as reachable but pending before migration", async () => {
    const runtime = trackedDatabase();

    await expect(runtime.check()).resolves.toEqual({
      databaseReachable: true,
      migrationsCurrent: false,
    });
    await expect(runtime.checkMigrationsCurrent()).resolves.toBe(false);
  });

  it("migrates a fresh database transactionally and repeats as a no-op", async () => {
    const runtime = trackedDatabase();

    await expect(runtime.migrate()).resolves.toEqual({
      appliedVersions: [1, 2, 3, 4, 5, 6],
      currentVersion: 6,
    });
    await expect(runtime.check()).resolves.toEqual({
      databaseReachable: true,
      migrationsCurrent: true,
    });
    await expect(runtime.migrate()).resolves.toEqual({
      appliedVersions: [],
      currentVersion: 6,
    });

    const schemas = await admin.unsafe<{ schema_name: string }[]>(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'matchsense';",
    );
    const ledger = await admin.unsafe<
      { applied_at: Date; checksum: string; version: number }[]
    >(
      "SELECT version, checksum, applied_at FROM public.matchsense_schema_migrations ORDER BY version;",
    );
    expect(schemas).toHaveLength(1);
    expect(ledger).toHaveLength(6);
    expect(ledger).toEqual([
      expect.objectContaining({
        checksum: migrationCatalog[0]?.checksum,
        version: 1,
      }),
      expect.objectContaining({
        checksum: migrationCatalog[1]?.checksum,
        version: 2,
      }),
      expect.objectContaining({
        checksum: migrationCatalog[2]?.checksum,
        version: 3,
      }),
      expect.objectContaining({
        checksum: migrationCatalog[3]?.checksum,
        version: 4,
      }),
      expect.objectContaining({
        checksum: migrationCatalog[4]?.checksum,
        version: 5,
      }),
      expect.objectContaining({
        checksum: migrationCatalog[5]?.checksum,
        version: 6,
      }),
    ]);
    expect(ledger.every(({ applied_at }) => applied_at instanceof Date)).toBe(
      true,
    );
  });

  it("rejects an invalid live/recorded provenance crossover in PostgreSQL", async () => {
    const runtime = trackedDatabase();
    await runtime.migrate();

    await expect(
      admin.unsafe(
        `INSERT INTO matchsense.fixtures (
  mode, id, provenance, home_team_id, away_team_id, scheduled_at, status
)
VALUES ('live', 'fx-crossed', 'recorded_txline_authorised', 'FRA', 'ESP', clock_timestamp(), 'scheduled');`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("permits an authorised recorded fixture after the v5 provenance repair", async () => {
    const runtime = trackedDatabase();
    await runtime.migrate();

    await expect(
      admin.unsafe(
        `INSERT INTO matchsense.fixtures (
  mode, id, provenance, home_team_id, away_team_id, scheduled_at, status
)
VALUES (
  'recorded', 'recorded-v5-repair', 'recorded_txline_authorised',
  'FRA', 'ESP', clock_timestamp(), 'scheduled'
);`,
      ),
    ).resolves.toEqual([]);
  });

  it("keeps live TxLINE team identities outside fixture lifecycle state and only accepts newer observations", async () => {
    const runtime = trackedDatabase();
    await runtime.migrate();

    await runtime.teamCatalog.upsert([
      {
        code: "ESP",
        name: "Spain",
        participantId: "participant-spain",
        sourceTimestampMs: 1_784_487_500_000,
      },
      {
        code: "ARG",
        name: "Argentina",
        participantId: "participant-argentina",
        sourceTimestampMs: 1_784_487_600_000,
      },
    ]);
    await runtime.teamCatalog.upsert([
      {
        code: "ARG",
        name: "Stale Argentina",
        participantId: "participant-argentina",
        sourceTimestampMs: 1_784_487_599_999,
      },
    ]);
    await runtime.teamCatalog.upsert([
      {
        code: "ARA",
        name: "Argentina Football Association",
        participantId: "participant-argentina",
        sourceTimestampMs: 1_784_487_600_001,
      },
    ]);

    await expect(runtime.teamCatalog.list()).resolves.toEqual([
      {
        code: "ARG",
        name: "Argentina Football Association",
        participantId: "participant-argentina",
        sourceTimestampMs: 1_784_487_600_001,
      },
      {
        code: "ESP",
        name: "Spain",
        participantId: "participant-spain",
        sourceTimestampMs: 1_784_487_500_000,
      },
    ]);
    await expect(
      admin.unsafe<{ count: number }[]>(
        "SELECT count(*)::int AS count FROM matchsense.fixtures;",
      ),
    ).resolves.toEqual([{ count: 0 }]);
    await expect(
      admin.unsafe(
        `INSERT INTO matchsense.team_catalog_entries (
  participant_id, code, name, source_timestamp_ms, mode, source
)
VALUES ('invalid-team', 'INV', 'Invalid Team', 0, 'recorded', 'other');`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("preserves a frozen archive-import context while leasing, recovering, and retrying work", async () => {
    const runtime = trackedDatabase();
    await runtime.migrate();
    const queued = await runtime.archiveImportJobs.enqueue({
      awayTeamId: "ESP",
      contextHash: "a".repeat(64),
      fixtureId: "archive-job-fx-1",
      homeTeamId: "FRA",
      kickoffAt: "2026-07-18T12:00:00.000Z",
      participant1IsHome: true,
      reason: "featured_bootstrap",
      sourceTerminalRecordId: "terminal-record-1",
    });
    const duplicate = await runtime.archiveImportJobs.enqueue({
      awayTeamId: "ARG",
      contextHash: "b".repeat(64),
      fixtureId: queued.fixtureId,
      homeTeamId: "BRA",
      kickoffAt: "2030-01-01T00:00:00.000Z",
      participant1IsHome: false,
      reason: "featured_bootstrap",
      sourceTerminalRecordId: "terminal-record-1",
    });
    expect(duplicate).toMatchObject({
      awayTeamId: "ESP",
      contextHash: "a".repeat(64),
      homeTeamId: "FRA",
      kickoffAt: "2026-07-18T12:00:00.000Z",
      participant1IsHome: true,
      reason: "featured_bootstrap",
      sourceTerminalRecordId: "terminal-record-1",
      state: "queued",
    });
    const correction = await runtime.archiveImportJobs.enqueue({
      awayTeamId: "ARG",
      contextHash: "b".repeat(64),
      fixtureId: queued.fixtureId,
      homeTeamId: "BRA",
      kickoffAt: "2030-01-01T00:00:00.000Z",
      participant1IsHome: false,
      reason: "live_correction",
      sourceTerminalRecordId: "terminal-record-correction-1",
    });
    expect(correction).toMatchObject({
      awayTeamId: "ESP",
      contextHash: "a".repeat(64),
      homeTeamId: "FRA",
      kickoffAt: "2026-07-18T12:00:00.000Z",
      participant1IsHome: true,
      reason: "live_correction",
      sourceTerminalRecordId: "terminal-record-correction-1",
      state: "queued",
    });

    const claimed = await runtime.archiveImportJobs.claim(
      "archive-worker-a",
      new Date("2026-07-18T12:00:00.000Z"),
    );
    expect(claimed).toMatchObject({
      attemptCount: 1,
      claimedBy: "archive-worker-a",
      fixtureId: queued.fixtureId,
      state: "claimed",
    });
    await expect(
      runtime.archiveImportJobs.recoverExpiredClaims(
        new Date("2026-07-18T12:03:00.000Z"),
      ),
    ).resolves.toBe(1);
    const reclaimed = await runtime.archiveImportJobs.claim(
      "archive-worker-b",
      new Date("2026-07-18T12:03:00.000Z"),
    );
    expect(reclaimed).toMatchObject({
      attemptCount: 2,
      claimedBy: "archive-worker-b",
      state: "claimed",
    });
    await expect(
      runtime.archiveImportJobs.markRetry({
        availableAt: "2026-07-18T12:10:00.000Z",
        error: "temporary history timeout",
        fixtureId: queued.fixtureId,
        workerId: "archive-worker-b",
      }),
    ).resolves.toMatchObject({
      claimedBy: null,
      lastError: "temporary history timeout",
      state: "retry_wait",
    });
    await expect(
      admin.unsafe<
        {
          away_team_id: string;
          context_hash: string;
          home_team_id: string;
          participant1_is_home: boolean;
        }[]
      >(`SELECT home_team_id, away_team_id, participant1_is_home, context_hash
FROM matchsense.archive_import_jobs
WHERE fixture_id = 'archive-job-fx-1';`),
    ).resolves.toEqual([
      {
        away_team_id: "ESP",
        context_hash: "a".repeat(64),
        home_team_id: "FRA",
        participant1_is_home: true,
      },
    ]);
  });

  it("upgrades a populated v3 immutable raw row and restores its immutability in v4", async () => {
    await seedV3MigrationLedger();
    await admin.unsafe(`INSERT INTO matchsense.fixtures (
  mode, id, provenance, home_team_id, away_team_id, scheduled_at, status, metadata
)
VALUES (
  'live', 'legacy-fx-1', 'live_txline', 'FRA', 'ESP',
  '2026-07-17T12:00:00.000Z', 'final', '{}'::jsonb
);`);
    await admin.unsafe(`INSERT INTO matchsense.raw_source_records (
  mode, id, fixture_id, source, source_record_id, source_sequence,
  dedupe_key, payload_hash, provenance, payload, received_at, delivery_intent
)
VALUES (
  'live', 'legacy-raw-1', 'legacy-fx-1', 'txline', 'legacy-final', '1026',
  'legacy:final', repeat('a', 64), 'live_txline',
  '{"Action":"game_finalised","StatusId":100}'::jsonb,
  '2026-07-17T14:00:00.000Z', 'realtime'
);`);

    const runtime = trackedDatabase();
    await expect(runtime.migrate()).resolves.toEqual({
      appliedVersions: [4, 5, 6],
      currentVersion: 6,
    });

    const rows = await admin.unsafe<
      {
        canonical_eligible: boolean;
        delivery_key: string;
        ordering_key: string;
        raw_retention: string;
        response_hash: string;
        rights_grant_id: string;
        source_path: string;
        stream_key: string;
      }[]
    >(`SELECT delivery_key, ordering_key, source_path, stream_key,
  response_hash, rights_grant_id, raw_retention, canonical_eligible
FROM matchsense.raw_source_records
WHERE mode = 'live' AND id = 'legacy-raw-1';`);
    expect(rows).toEqual([
      {
        canonical_eligible: true,
        delivery_key: "a".repeat(64),
        ordering_key: "1026",
        raw_retention: "normalised_only",
        response_hash: "a".repeat(64),
        rights_grant_id: "legacy-unverified",
        source_path: "legacy-unverified",
        stream_key: "txline",
      },
    ]);
    await expect(
      admin.unsafe(
        "UPDATE matchsense.raw_source_records SET payload = '{}'::jsonb WHERE mode = 'live' AND id = 'legacy-raw-1';",
      ),
    ).rejects.toMatchObject({ code: "P0001" });
    await expect(
      admin.unsafe(
        "DELETE FROM matchsense.raw_source_records WHERE mode = 'live' AND id = 'legacy-raw-1';",
      ),
    ).rejects.toMatchObject({ code: "P0001" });
  });

  it("commits schedule raw-first, keeps duplicates inert, and accepts raw-only updates", async () => {
    const runtime = trackedDatabase();
    await runtime.migrate();
    const scheduleRaw = {
      ...sourceChange({ suffix: "schedule-1" }).raw,
      dedupeKey: "schedule:fx-1:v1",
      id: "raw-schedule-1",
    };

    await expect(
      runtime.fixtureTruth.commitFixtureSchedule({
        fixture: recordedFixture,
        raw: scheduleRaw,
      }),
    ).resolves.toEqual({
      fixture: expect.objectContaining({
        id: recordedFixture.id,
        metadata: { competition: "Integration Final" },
      }),
      kind: "committed",
    });
    await expect(
      runtime.fixtureTruth.commitFixtureSchedule({
        fixture: {
          ...recordedFixture,
          metadata: { competition: "duplicate must not mutate" },
        },
        raw: scheduleRaw,
      }),
    ).resolves.toEqual({ kind: "duplicate" });
    await expect(
      runtime.fixtureTruth.get({
        fixtureId: recordedFixture.id,
        mode: "recorded",
      }),
    ).resolves.toMatchObject({
      metadata: { competition: "Integration Final" },
      status: "scheduled",
    });

    await expect(
      runtime.fixtureTruth.commitFixtureSchedule({
        fixture: {
          ...recordedFixture,
          metadata: { competition: "Integration Final", note: "postponed" },
          scheduledAt: "2026-07-18T12:00:00.000Z",
          status: "postponed",
        },
        raw: {
          ...scheduleRaw,
          dedupeKey: "schedule:fx-1:v2",
          id: "raw-schedule-2",
          payloadHash: createHash("sha256").update("schedule-2").digest("hex"),
        },
      }),
    ).resolves.toMatchObject({ kind: "committed" });
    await expect(
      runtime.fixtureTruth.commitRawSourceRecord({
        fixtureId: recordedFixture.id,
        mode: "recorded",
        raw: {
          ...scheduleRaw,
          dedupeKey: "neutral-update:fx-1:1",
          id: "raw-neutral-1",
          payloadHash: createHash("sha256").update("neutral-1").digest("hex"),
        },
      }),
    ).resolves.toEqual({ kind: "committed" });

    const counts = await admin.unsafe<
      { moments: number; outbox: number; raw: number }[]
    >(`SELECT
  (SELECT count(*)::integer FROM matchsense.raw_source_records) AS raw,
  (SELECT count(*)::integer FROM matchsense.canonical_moments) AS moments,
  (SELECT count(*)::integer FROM matchsense.outbox) AS outbox;`);
    expect(counts[0]).toEqual({ moments: 0, outbox: 0, raw: 3 });
    await expect(
      runtime.fixtureTruth.get({
        fixtureId: recordedFixture.id,
        mode: "recorded",
      }),
    ).resolves.toMatchObject({
      metadata: { competition: "Integration Final", note: "postponed" },
      scheduledAt: "2026-07-18T12:00:00.000Z",
      status: "postponed",
    });
  });

  it("fences stream ownership and compare-and-sets opaque cursors without regression", async () => {
    const runtime = trackedDatabase();
    await runtime.migrate();
    const firstGeneration = 1;
    const secondGeneration = 2;
    const stream = {
      mode: "live" as const,
      source: "txline",
      streamKey: "scores:mainnet",
    };
    const firstLease = await runtime.sourceState.acquireLease({
      ...stream,
      holderId: "worker-old",
      leaseUntil: "2099-01-01T00:01:00.000Z",
    });
    expect(firstLease).toMatchObject({ fencingToken: firstGeneration });
    await expect(
      runtime.sourceState.advanceCursor({
        ...stream,
        cursorValue: "opaque:z",
        expectedCursor: null,
        fencingToken: firstGeneration,
        holderId: "worker-old",
      }),
    ).resolves.toMatchObject({
      cursor: { cursorValue: "opaque:z", fencingToken: firstGeneration },
      kind: "advanced",
    });
    await expect(
      runtime.sourceState.advanceCursor({
        ...stream,
        cursorValue: "opaque:stale",
        expectedCursor: null,
        fencingToken: firstGeneration,
        holderId: "worker-old",
      }),
    ).resolves.toEqual({
      currentCursor: "opaque:z",
      kind: "conflict",
    });
    await expect(
      runtime.sourceState.releaseLease({
        ...stream,
        fencingToken: firstGeneration,
        holderId: "worker-old",
      }),
    ).resolves.toBe(true);

    const secondLease = await runtime.sourceState.acquireLease({
      ...stream,
      holderId: "worker-new",
      leaseUntil: "2099-01-01T00:02:00.000Z",
    });
    expect(secondLease).toMatchObject({ fencingToken: secondGeneration });
    await expect(
      runtime.sourceState.advanceCursor({
        ...stream,
        cursorValue: "opaque:stale-owner",
        expectedCursor: "opaque:z",
        fencingToken: firstGeneration,
        holderId: "worker-old",
      }),
    ).resolves.toEqual({ kind: "fenced" });
    await expect(
      runtime.sourceState.advanceCursor({
        ...stream,
        cursorValue: "opaque:a",
        expectedCursor: "opaque:z",
        fencingToken: secondGeneration,
        holderId: "worker-new",
      }),
    ).resolves.toMatchObject({
      cursor: { cursorValue: "opaque:a", fencingToken: secondGeneration },
      kind: "advanced",
    });
    await expect(runtime.sourceState.getCursor(stream)).resolves.toMatchObject({
      cursorValue: "opaque:a",
      fencingToken: secondGeneration,
    });
    await expect(
      runtime.sourceState.renewLease({
        ...stream,
        fencingToken: firstGeneration,
        holderId: "worker-old",
        leaseUntil: "2099-01-01T00:03:00.000Z",
      }),
    ).resolves.toBeNull();
  });

  it("rejects every stale live source write before any raw or derived mutation", async () => {
    const runtime = trackedDatabase();
    await runtime.migrate();
    const oldGeneration = 1;
    const newGeneration = 2;
    const stream = {
      mode: "live" as const,
      source: "txline",
      streamKey: "scores:mainnet",
    };
    await expect(
      runtime.sourceState.acquireLease({
        ...stream,
        holderId: "worker-old",
        leaseUntil: "2099-01-01T00:01:00.000Z",
      }),
    ).resolves.toMatchObject({ fencingToken: oldGeneration });
    await runtime.sourceState.releaseLease({
      ...stream,
      fencingToken: oldGeneration,
      holderId: "worker-old",
    });
    await expect(
      runtime.sourceState.acquireLease({
        ...stream,
        holderId: "worker-new",
        leaseUntil: "2099-01-01T00:02:00.000Z",
      }),
    ).resolves.toMatchObject({ fencingToken: newGeneration });

    const fixture = {
      ...recordedFixture,
      id: "live-fx-fenced",
      mode: "live" as const,
      provenance: "live_txline" as const,
    };
    const raw = {
      ...sourceChange({ suffix: "stale-live" }).raw,
      id: "raw-stale-live",
      provenance: "live_txline" as const,
      source: "txline",
    };
    const staleFence = {
      fencingToken: oldGeneration,
      holderId: "worker-old",
      source: stream.source,
      streamKey: stream.streamKey,
    };
    await expect(
      runtime.fixtureTruth.commitFixtureSchedule({
        fixture,
        raw,
        sourceFence: staleFence,
      }),
    ).resolves.toEqual({ kind: "fenced" });
    await expect(
      runtime.fixtureTruth.commitRawSourceRecord({
        fixtureId: fixture.id,
        mode: "live",
        raw,
        sourceFence: staleFence,
      }),
    ).resolves.toEqual({ kind: "fenced" });
    await expect(
      runtime.fixtureTruth.commitSourceChange({
        ...sourceChange({ suffix: "stale-derived" }),
        fixtureId: fixture.id,
        mode: "live",
        raw: { ...raw, id: "raw-stale-derived" },
        sourceFence: staleFence,
      }),
    ).resolves.toEqual({ kind: "fenced" });

    const counts = await admin.unsafe<
      {
        events: number;
        fixtures: number;
        moments: number;
        outbox: number;
        projections: number;
        raw: number;
      }[]
    >(`SELECT
  (SELECT count(*)::integer FROM matchsense.fixtures) AS fixtures,
  (SELECT count(*)::integer FROM matchsense.raw_source_records) AS raw,
  (SELECT count(*)::integer FROM matchsense.fixture_projections) AS projections,
  (SELECT count(*)::integer FROM matchsense.canonical_moments) AS moments,
  (SELECT count(*)::integer FROM matchsense.fixture_events) AS events,
  (SELECT count(*)::integer FROM matchsense.outbox) AS outbox;`);
    expect(counts[0]).toEqual({
      events: 0,
      fixtures: 0,
      moments: 0,
      outbox: 0,
      projections: 0,
      raw: 0,
    });

    await expect(
      runtime.fixtureTruth.commitFixtureSchedule({
        fixture,
        raw,
        sourceFence: {
          ...staleFence,
          fencingToken: newGeneration,
          holderId: "worker-new",
        },
      }),
    ).resolves.toMatchObject({ kind: "committed" });
  });

  it("commits one revision, event, and outbox row for concurrent duplicate source records", async () => {
    const runtime = trackedDatabase();
    await runtime.migrate();
    await runtime.fixtureTruth.upsert(recordedFixture);
    const change = sourceChange();

    const results = await Promise.all([
      runtime.fixtureTruth.commitSourceChange(change),
      runtime.fixtureTruth.commitSourceChange(change),
    ]);
    expect(results).toEqual(
      expect.arrayContaining([
        { eventSequence: 1, kind: "committed", revision: 1 },
        { kind: "duplicate" },
      ]),
    );

    const counts = await admin.unsafe<
      {
        events: number;
        moments: number;
        outbox: number;
        raw: number;
        revisions: number;
      }[]
    >(`SELECT
  (SELECT count(*)::integer FROM matchsense.raw_source_records) AS raw,
  (SELECT count(*)::integer FROM matchsense.canonical_moments) AS moments,
  (SELECT count(*)::integer FROM matchsense.moment_revisions) AS revisions,
  (SELECT count(*)::integer FROM matchsense.fixture_events) AS events,
  (SELECT count(*)::integer FROM matchsense.outbox) AS outbox;`);
    expect(counts[0]).toEqual({
      events: 1,
      moments: 1,
      outbox: 1,
      raw: 1,
      revisions: 1,
    });
  });

  it("atomically processes and deduplicates a source envelope through the v3 repository path", async () => {
    const runtime = trackedDatabase();
    await runtime.migrate();
    await runtime.fixtureTruth.upsert(recordedFixture);
    const raw = sourceChange({ suffix: "process-envelope" }).raw;
    const derive = vi.fn((current: { revision: number } | null) => {
      const revision = (current?.revision ?? 0) + 1;
      return {
        event: {
          id: `processed-event-${revision}`,
          payload: { revision },
          type: "moment.created",
        },
        moment: {
          id: "processed-goal",
          kind: "goal",
          payload: { score: { away: 0, home: 1 } },
          revision,
        },
        outbox: [
          {
            id: `processed-outbox-${revision}`,
            idempotencyKey: `processed-goal:${revision}:broadcast`,
            payload: { momentId: "processed-goal", revision },
            topic: "fixture.broadcast",
          },
        ],
        projection: {
          payload: { revision, score: { away: 0, home: 1 } },
          revision,
        },
      };
    });
    const input = {
      derive,
      fixtureId: recordedFixture.id,
      mode: "recorded" as const,
      raw,
    };

    await expect(
      runtime.fixtureTruth.processSourceEnvelope(input),
    ).resolves.toEqual({ eventSequence: 1, kind: "committed", revision: 1 });
    await expect(
      runtime.fixtureTruth.processSourceEnvelope(input),
    ).resolves.toEqual({ kind: "duplicate" });
    expect(derive).toHaveBeenCalledTimes(1);

    const [counts] = await admin.unsafe<
      {
        events: number;
        moments: number;
        outbox: number;
        projections: number;
        raw: number;
      }[]
    >(`SELECT
  (SELECT count(*)::integer FROM matchsense.raw_source_records) AS raw,
  (SELECT count(*)::integer FROM matchsense.fixture_projections) AS projections,
  (SELECT count(*)::integer FROM matchsense.canonical_moments) AS moments,
  (SELECT count(*)::integer FROM matchsense.fixture_events) AS events,
  (SELECT count(*)::integer FROM matchsense.outbox) AS outbox;`);
    expect(counts).toEqual({
      events: 1,
      moments: 1,
      outbox: 1,
      projections: 1,
      raw: 1,
    });
  });

  it("allows reconciliation truth history but rejects reconciliation Moment and push writes", async () => {
    const runtime = trackedDatabase();
    await runtime.migrate();
    await runtime.fixtureTruth.upsert(recordedFixture);
    const reconciliationRaw = {
      ...sourceChange({ suffix: "reconcile-history" }).raw,
      canonicalEligible: true,
      deliveryIntent: "reconcile" as const,
      id: "raw-reconcile-history",
    };

    await expect(
      runtime.fixtureTruth.processSourceEnvelope({
        derive: () => ({
          event: {
            id: "event-reconciled-1",
            payload: { correction: true },
            type: "fixture.reconciled",
          },
          outbox: [],
          projection: { payload: { correction: true }, revision: 1 },
        }),
        fixtureId: recordedFixture.id,
        mode: "recorded",
        raw: reconciliationRaw,
      }),
    ).resolves.toEqual({ eventSequence: 1, kind: "committed", revision: 1 });

    const [historyCounts] = await admin.unsafe<
      { events: number; moments: number; outbox: number; projections: number }[]
    >(`SELECT
  (SELECT count(*)::integer FROM matchsense.fixture_projections) AS projections,
  (SELECT count(*)::integer FROM matchsense.fixture_events) AS events,
  (SELECT count(*)::integer FROM matchsense.canonical_moments) AS moments,
  (SELECT count(*)::integer FROM matchsense.outbox) AS outbox;`);
    expect(historyCounts).toEqual({
      events: 1,
      moments: 0,
      outbox: 0,
      projections: 1,
    });

    await admin.unsafe(`INSERT INTO matchsense.canonical_moments (
  mode, fixture_id, id, kind, current_revision
)
VALUES ('recorded', 'fx-1', 'direct-reconcile-moment', 'goal', 1);`);
    await expect(
      admin.unsafe(`INSERT INTO matchsense.moment_revisions (
  mode, fixture_id, moment_id, revision, source_record_id, payload
)
VALUES (
  'recorded', 'fx-1', 'direct-reconcile-moment', 1,
  'raw-reconcile-history', '{"blocked":true}'::jsonb
);`),
    ).rejects.toMatchObject({ code: "P0001" });
    await expect(
      admin.unsafe(`INSERT INTO matchsense.outbox (
  mode, id, fixture_id, topic, idempotency_key, payload, source_record_id
)
VALUES (
  'recorded', 'outbox-direct-reconcile', 'fx-1', 'push.candidate',
  'direct-reconcile:push', '{"blocked":true}'::jsonb,
  'raw-reconcile-history'
);`),
    ).rejects.toMatchObject({ code: "P0001" });
  });

  it("rolls back raw and all derived writes when the atomic commit fails", async () => {
    const runtime = trackedDatabase();
    await runtime.migrate();
    await runtime.fixtureTruth.upsert(recordedFixture);
    const first = sourceChange();
    await runtime.fixtureTruth.commitSourceChange(first);
    const conflicting = sourceChange({
      expectedRevision: 1,
      outboxIdempotencyKey: first.outbox.idempotencyKey,
      suffix: "rollback",
    });

    await expect(
      runtime.fixtureTruth.commitSourceChange(conflicting),
    ).rejects.toMatchObject({ code: "23505" });
    const rows = await admin.unsafe<
      { events: number; outbox: number; raw: number; revision: string }[]
    >(`SELECT
  (SELECT count(*)::integer FROM matchsense.raw_source_records) AS raw,
  (SELECT count(*)::integer FROM matchsense.fixture_events) AS events,
  (SELECT count(*)::integer FROM matchsense.outbox) AS outbox,
  (SELECT revision::text FROM matchsense.fixture_projections WHERE mode = 'recorded' AND fixture_id = 'fx-1') AS revision;`);
    expect(rows[0]).toEqual({ events: 1, outbox: 1, raw: 1, revision: "1" });
    await expect(
      admin.unsafe(
        "UPDATE matchsense.raw_source_records SET payload = '{}'::jsonb WHERE mode = 'recorded' AND id = 'raw-1';",
      ),
    ).rejects.toMatchObject({ code: "P0001" });
  });

  it("replays durable fixture events after a repository restart", async () => {
    const firstRuntime = trackedDatabase();
    await firstRuntime.migrate();
    await firstRuntime.fixtureTruth.upsert(recordedFixture);
    await firstRuntime.fixtureTruth.commitSourceChange(sourceChange());
    await expect(
      firstRuntime.fixtureTruth.getLatestProjection({
        fixtureId: recordedFixture.id,
        mode: "recorded",
      }),
    ).resolves.toMatchObject({
      fixtureId: recordedFixture.id,
      revision: 1,
      sourceSequence: "1",
    });
    await firstRuntime.close();

    const restarted = trackedDatabase();
    await expect(
      restarted.fixtureTruth.eventsAfter({
        afterSequence: 0,
        fixtureId: recordedFixture.id,
        mode: "recorded",
      }),
    ).resolves.toEqual([
      expect.objectContaining({ eventId: "event-1", sequence: 1 }),
    ]);
  });

  it("prevents an expired same-id worker claim from completing or retrying its replacement", async () => {
    const firstWorker = trackedDatabase();
    const secondWorker = trackedDatabase();
    await firstWorker.migrate();
    await firstWorker.fixtureTruth.upsert(recordedFixture);
    await firstWorker.fixtureTruth.commitSourceChange(sourceChange());

    const [expiredClaim] = await firstWorker.outbox.claim({
      claimToken: "fixture-claim-expired",
      limit: 1,
      lockTimeoutMs: 30_000,
      mode: "recorded",
      topics: ["moment.created"],
      workerId: "replica-shared-id",
    });
    expect(expiredClaim).toMatchObject({
      claimToken: "fixture-claim-expired",
      id: "outbox-1",
    });
    await admin.unsafe(
      "UPDATE matchsense.outbox SET locked_at = clock_timestamp() - interval '1 minute' WHERE mode = 'recorded' AND id = 'outbox-1';",
    );

    const [replacementClaim] = await secondWorker.outbox.claim({
      claimToken: "fixture-claim-replacement",
      limit: 1,
      lockTimeoutMs: 30_000,
      mode: "recorded",
      topics: ["moment.created"],
      workerId: "replica-shared-id",
    });
    expect(replacementClaim).toMatchObject({
      attemptCount: 2,
      claimToken: "fixture-claim-replacement",
      id: "outbox-1",
    });

    await expect(
      firstWorker.outbox.complete({
        claimToken: "fixture-claim-expired",
        id: "outbox-1",
        mode: "recorded",
        workerId: "replica-shared-id",
      }),
    ).resolves.toBe(false);
    await expect(
      firstWorker.outbox.retryOrDeadLetter({
        availableAt: "2000-01-01T00:00:00.000Z",
        claimToken: "fixture-claim-expired",
        deadLetterId: "dead:stale-claim",
        error: "stale worker",
        id: "outbox-1",
        maxAttempts: 3,
        mode: "recorded",
        workerId: "replica-shared-id",
      }),
    ).resolves.toEqual({ kind: "not_claimed" });
    await expect(
      secondWorker.outbox.complete({
        claimToken: "fixture-claim-replacement",
        id: "outbox-1",
        mode: "recorded",
        workerId: "replica-shared-id",
      }),
    ).resolves.toBe(true);

    const [state] = await admin.unsafe<
      {
        claim_token: string | null;
        locked_by: string | null;
        processed: boolean;
      }[]
    >(`SELECT claim_token, locked_by, processed_at IS NOT NULL AS processed
FROM matchsense.outbox
WHERE mode = 'recorded' AND id = 'outbox-1';`);
    expect(state).toEqual({
      claim_token: null,
      locked_by: null,
      processed: true,
    });
  });

  it("persists commentary bytes and drives receipt, retry, and dead-letter state", async () => {
    const runtime = trackedDatabase();
    await runtime.migrate();
    await runtime.fixtureTruth.upsert(recordedFixture);
    await runtime.fixtureTruth.commitSourceChange(sourceChange());

    const artifact = await runtime.commentaryArtifacts.upsert({
      bytes: new Uint8Array([1, 2, 3, 4]),
      fixtureId: recordedFixture.id,
      id: "commentary-1",
      language: "en-IN",
      mode: "recorded",
      momentId: "moment-1",
      momentRevision: 1,
      voice: "kore",
    });
    expect([...artifact.bytes]).toEqual([1, 2, 3, 4]);
    await expect(
      runtime.commentaryArtifacts.get({
        fixtureId: recordedFixture.id,
        language: "en-IN",
        mode: "recorded",
        momentId: "moment-1",
        momentRevision: 1,
        voice: "kore",
      }),
    ).resolves.toMatchObject({ id: "commentary-1" });

    const [firstClaim] = await runtime.outbox.claim({
      claimToken: "fixture-claim-first",
      limit: 1,
      lockTimeoutMs: 30_000,
      mode: "recorded",
      topics: ["moment.created"],
      workerId: "worker-1",
    });
    expect(firstClaim).toMatchObject({
      claimToken: "fixture-claim-first",
      id: "outbox-1",
    });
    const receipt = {
      consumer: "foreground",
      mode: "recorded" as const,
      outboxId: "outbox-1",
    };
    await expect(runtime.outbox.recordConsumerReceipt(receipt)).resolves.toBe(
      true,
    );
    await expect(runtime.outbox.recordConsumerReceipt(receipt)).resolves.toBe(
      false,
    );
    await expect(
      runtime.outbox.complete({
        claimToken: "fixture-claim-first",
        id: "outbox-1",
        mode: "recorded",
        workerId: "worker-1",
      }),
    ).resolves.toBe(true);

    await expect(
      runtime.outbox.enqueue({
        availableAt: "2000-01-01T00:00:00.000Z",
        fixtureId: recordedFixture.id,
        id: "outbox-retry",
        idempotencyKey: "retry-once-then-dead",
        mode: "recorded",
        payload: { poison: true },
        topic: "moment.created",
      }),
    ).resolves.toBe("enqueued");
    const [retryClaim] = await runtime.outbox.claim({
      claimToken: "fixture-claim-retry-first",
      limit: 1,
      lockTimeoutMs: 30_000,
      mode: "recorded",
      topics: ["moment.created"],
      workerId: "worker-1",
    });
    expect(retryClaim?.attemptCount).toBe(1);
    await expect(
      runtime.outbox.retryOrDeadLetter({
        availableAt: "2000-01-01T00:00:00.000Z",
        claimToken: "fixture-claim-retry-first",
        deadLetterId: "dead:recorded:outbox-retry",
        error: "first failure",
        id: "outbox-retry",
        maxAttempts: 2,
        mode: "recorded",
        workerId: "worker-1",
      }),
    ).resolves.toEqual({ kind: "retry" });
    const [deadClaim] = await runtime.outbox.claim({
      claimToken: "fixture-claim-retry-second",
      limit: 1,
      lockTimeoutMs: 30_000,
      mode: "recorded",
      topics: ["moment.created"],
      workerId: "worker-1",
    });
    expect(deadClaim?.attemptCount).toBe(2);
    await expect(
      runtime.outbox.retryOrDeadLetter({
        availableAt: "2000-01-01T00:00:00.000Z",
        claimToken: "fixture-claim-retry-second",
        deadLetterId: "dead:recorded:outbox-retry",
        error: "second failure",
        id: "outbox-retry",
        maxAttempts: 2,
        mode: "recorded",
        workerId: "worker-1",
      }),
    ).resolves.toEqual({ kind: "dead_letter" });
    const deadLetters = await admin.unsafe<{ count: number }[]>(
      "SELECT count(*)::integer AS count FROM matchsense.outbox_dead_letters;",
    );
    expect(deadLetters[0]?.count).toBe(1);
  });

  it("rejects checksum drift instead of accepting a changed migration", async () => {
    const runtime = trackedDatabase();
    await runtime.migrate();
    await admin.unsafe(
      "UPDATE public.matchsense_schema_migrations SET checksum = repeat('0', 64) WHERE version = 1;",
    );

    await expect(runtime.migrate()).rejects.toMatchObject({
      code: "MIGRATION_CHECKSUM_DRIFT",
    });
    await expect(runtime.check()).resolves.toEqual({
      databaseReachable: true,
      migrationsCurrent: false,
    });
  });

  it("rejects a ledger version absent from the catalog", async () => {
    const runtime = trackedDatabase();
    await runtime.migrate();
    await admin.unsafe(
      "INSERT INTO public.matchsense_schema_migrations (version, checksum) VALUES (99, repeat('f', 64));",
    );

    await expect(runtime.migrate()).rejects.toMatchObject({
      code: "UNKNOWN_APPLIED_MIGRATION",
    });
    await expect(runtime.check()).resolves.toEqual({
      databaseReachable: true,
      migrationsCurrent: false,
    });
  });

  it("returns a generic nonzero CLI result for an unreachable database", async () => {
    const writeError = vi.fn();
    const writeOutput = vi.fn();

    await expect(
      runDatabaseCli({
        args: ["check"],
        createRuntime: trackedDatabase,
        environment: {
          DATABASE_URL: "postgresql://127.0.0.1:1/matchsense",
        },
        writeError,
        writeOutput,
      }),
    ).resolves.toBe(1);
    expect(writeError).toHaveBeenCalledExactlyOnceWith(
      "Database is not ready\n",
    );
    expect(writeOutput).not.toHaveBeenCalled();
  });
});
