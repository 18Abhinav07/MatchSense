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
  hashArchiveImportSourceContext,
  migrationCatalog,
  runDatabaseCli,
  type ApplicationDatabase,
  type ArchiveImportJobInput,
  type CommitSourceChangeInput,
  type SourceFence,
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

async function seedV6MigrationLedger() {
  for (const migration of migrationCatalog.slice(0, 6)) {
    await admin.unsafe(migration.sql);
  }
  await admin.unsafe(`CREATE TABLE public.matchsense_schema_migrations (
  version integer PRIMARY KEY CHECK (version > 0),
  checksum text NOT NULL CHECK (length(checksum) = 64),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);`);
  for (const migration of migrationCatalog.slice(0, 6)) {
    await admin.unsafe(
      "INSERT INTO public.matchsense_schema_migrations (version, checksum) VALUES ($1, $2);",
      [migration.version, migration.checksum],
    );
  }
}

async function seedV7MigrationLedger() {
  for (const migration of migrationCatalog.slice(0, 7)) {
    await admin.unsafe(migration.sql);
  }
  await admin.unsafe(`CREATE TABLE public.matchsense_schema_migrations (
  version integer PRIMARY KEY CHECK (version > 0),
  checksum text NOT NULL CHECK (length(checksum) = 64),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);`);
  for (const migration of migrationCatalog.slice(0, 7)) {
    await admin.unsafe(
      "INSERT INTO public.matchsense_schema_migrations (version, checksum) VALUES ($1, $2);",
      [migration.version, migration.checksum],
    );
  }
}

async function seedRecordedReplayArchive(input: {
  fixtureId: string;
  manifestHash: string;
  manifestId: string;
  terminalDeliveryId: string;
}) {
  const grantId = `grant-${input.fixtureId}`;
  await admin.unsafe(
    `INSERT INTO matchsense.rights_grants (
  id, reference, scopes, active, raw_retention_until
)
VALUES ($1, $2, ARRAY['raw_retention', 'replay']::text[], true, NULL);`,
    [grantId, `integration ${input.fixtureId}`],
  );
  await admin.unsafe(
    `INSERT INTO matchsense.fixtures (
  mode, id, provenance, home_team_id, away_team_id, scheduled_at, status, metadata
)
VALUES (
  'recorded', $1, 'recorded_txline_authorised', 'FRA', 'ESP',
  '2026-07-18T12:00:00.000Z', 'final', '{}'::jsonb
);`,
    [input.fixtureId],
  );
  for (const [id, hash, sequence] of [
    ["archive-terminal-h1", "1".repeat(64), "1"],
    ["archive-terminal-h2", "2".repeat(64), "2"],
  ] as const) {
    await admin.unsafe(
      `INSERT INTO matchsense.raw_source_records (
  mode, id, fixture_id, source, source_record_id, source_sequence,
  dedupe_key, payload_hash, provenance, payload, received_at,
  delivery_intent, delivery_key, ordering_key, source_path, stream_key,
  response_hash, rights_grant_id, raw_retention, canonical_eligible
)
VALUES (
  'recorded', $1, $2, 'txline', $1, $3,
  $1, $4, 'recorded_txline_authorised',
  '{"Action":"game_finalised","StatusId":100,"Confirmed":true}'::jsonb,
  '2026-07-18T14:00:00.000Z', 'reconcile', $1, $3,
  '/historical/score', 'txline-historical', $4, $5, 'authorised_raw', true
);`,
      [id, input.fixtureId, sequence, hash, grantId],
    );
  }
  await admin.unsafe(
    `INSERT INTO matchsense.archive_manifests (
  id, mode, fixture_id, status, reducer_version, delivery_manifest_hash,
  projection_hash, terminal_delivery_id, rights_grant_id, verified_at
)
VALUES (
  $1, 'recorded', $2, 'REPLAY_READY', 'integration-v1', $3,
  repeat('a', 64), $4, $5, clock_timestamp()
);`,
    [
      input.manifestId,
      input.fixtureId,
      input.manifestHash,
      input.terminalDeliveryId,
      grantId,
    ],
  );
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

function archiveImportJobInput(
  input: Omit<
    ArchiveImportJobInput,
    "contextHash" | "participant1IsHome" | "sourceContext"
  > & {
    participant1IsHome?: boolean;
  },
): ArchiveImportJobInput {
  const participant1IsHome = input.participant1IsHome ?? true;
  const participant1Code = participant1IsHome
    ? input.homeTeamId
    : input.awayTeamId;
  const participant2Code = participant1IsHome
    ? input.awayTeamId
    : input.homeTeamId;
  const sourceContext = {
    fixtureGroupId: `schedule-group:${input.fixtureId}`,
    fixtureId: input.fixtureId,
    gameState: 2,
    kickoffAt: input.kickoffAt,
    participant1: {
      code: participant1Code,
      id: `provider:${participant1Code}`,
      name: `Provider ${participant1Code}`,
    },
    participant1IsHome,
    participant2: {
      code: participant2Code,
      id: `provider:${participant2Code}`,
      name: `Provider ${participant2Code}`,
    },
    schedule: {
      competition: "integration",
      competitionId: "72",
      responseHash: createHash("sha256")
        .update(`schedule:${input.fixtureId}:${input.kickoffAt}`)
        .digest("hex"),
      source: "txline_world_cup_schedule",
      sourcePath: "/api/fixtures/snapshot?competitionId=72",
      sourceTimestampMs: 1_784_403_000_000,
    },
  };
  return {
    ...input,
    contextHash: hashArchiveImportSourceContext(sourceContext),
    participant1IsHome,
    sourceContext,
  };
}

function sourceChange(
  input: {
    expectedRevision?: number;
    outboxIdempotencyKey?: string;
    sourceFence?: SourceFence;
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
      streamKey: "replay",
    },
    sourceFence: input.sourceFence,
  };
}

async function acquireRecordedReplayFence(
  runtime: Pick<ApplicationDatabase, "sourceState">,
): Promise<SourceFence> {
  const lease = await runtime.sourceState.acquireLease({
    holderId: "recorded-replay-test-worker",
    leaseUntil: "2099-01-01T00:10:00.000Z",
    mode: "recorded",
    source: "replay",
    streamKey: "replay",
  });
  if (!lease) throw new Error("Expected recorded replay source lease");
  return {
    fencingToken: lease.fencingToken,
    holderId: lease.holderId,
    source: lease.source,
    streamKey: lease.streamKey,
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
      appliedVersions: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      currentVersion: 9,
    });
    await expect(runtime.check()).resolves.toEqual({
      databaseReachable: true,
      migrationsCurrent: true,
    });
    await expect(runtime.migrate()).resolves.toEqual({
      appliedVersions: [],
      currentVersion: 9,
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
    expect(ledger).toHaveLength(9);
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
      expect.objectContaining({
        checksum: migrationCatalog[6]?.checksum,
        version: 7,
      }),
      expect.objectContaining({
        checksum: migrationCatalog[7]?.checksum,
        version: 8,
      }),
      expect.objectContaining({
        checksum: migrationCatalog[8]?.checksum,
        version: 9,
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
    const queued = await runtime.archiveImportJobs.enqueue(
      archiveImportJobInput({
        awayTeamId: "ESP",
        fixtureId: "archive-job-fx-1",
        homeTeamId: "FRA",
        kickoffAt: "2026-07-18T12:00:00.000Z",
        participant1IsHome: true,
        reason: "featured_bootstrap",
        sourceTerminalRecordId: "terminal-record-1",
      }),
    );
    const duplicate = await runtime.archiveImportJobs.enqueue(
      archiveImportJobInput({
        awayTeamId: "ARG",
        fixtureId: queued.fixtureId,
        homeTeamId: "BRA",
        kickoffAt: "2030-01-01T00:00:00.000Z",
        participant1IsHome: false,
        reason: "featured_bootstrap",
        sourceTerminalRecordId: "terminal-record-1",
      }),
    );
    expect(duplicate).toMatchObject({
      awayTeamId: "ESP",
      contextHash: queued.contextHash,
      homeTeamId: "FRA",
      kickoffAt: "2026-07-18T12:00:00.000Z",
      participant1IsHome: true,
      reason: "featured_bootstrap",
      sourceTerminalRecordId: "terminal-record-1",
      state: "queued",
    });
    const correction = await runtime.archiveImportJobs.enqueue(
      archiveImportJobInput({
        awayTeamId: "ARG",
        fixtureId: queued.fixtureId,
        homeTeamId: "BRA",
        kickoffAt: "2030-01-01T00:00:00.000Z",
        participant1IsHome: false,
        reason: "live_correction",
        sourceTerminalRecordId: "terminal-record-correction-1",
      }),
    );
    expect(correction).toMatchObject({
      awayTeamId: "ESP",
      contextHash: queued.contextHash,
      homeTeamId: "FRA",
      kickoffAt: "2026-07-18T12:00:00.000Z",
      participant1IsHome: true,
      reason: "live_correction",
      sourceTerminalRecordId: "terminal-record-correction-1",
      state: "queued",
    });

    const claimed = await runtime.archiveImportJobs.claim(
      "archive-worker-a",
      new Date("2100-01-01T00:00:00.000Z"),
    );
    expect(claimed).toMatchObject({
      attemptCount: 1,
      claimGeneration: 1,
      claimedBy: "archive-worker-a",
      fixtureId: queued.fixtureId,
      state: "claimed",
    });
    await expect(
      runtime.archiveImportJobs.recoverExpiredClaims(
        new Date("2100-01-01T00:03:00.000Z"),
      ),
    ).resolves.toBe(1);
    const reclaimed = await runtime.archiveImportJobs.claim(
      "archive-worker-b",
      new Date("2100-01-01T00:03:00.000Z"),
    );
    expect(reclaimed).toMatchObject({
      attemptCount: 2,
      claimGeneration: 2,
      claimedBy: "archive-worker-b",
      state: "claimed",
    });
    await expect(
      runtime.archiveImportJobs.markRetry({
        availableAt: "2100-01-01T00:10:00.000Z",
        claimGeneration: reclaimed?.claimGeneration ?? 0,
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

  it("backfills populated v6 replay-ready jobs and featured slots with their archive hash", async () => {
    await seedV6MigrationLedger();
    const fixtureId = "v6-replay-backfill-fx";
    const manifestId = "v6-replay-backfill-manifest";
    const manifestHash = "b".repeat(64);
    await seedRecordedReplayArchive({
      fixtureId,
      manifestHash,
      manifestId,
      terminalDeliveryId: "archive-terminal-h1",
    });
    await admin.unsafe(
      `INSERT INTO matchsense.archive_import_jobs (
  fixture_id, home_team_id, away_team_id, kickoff_at, participant1_is_home,
  context_hash, reason, state, archive_manifest_id, source_terminal_record_id
)
VALUES (
  $1, 'FRA', 'ESP', '2026-07-18T12:00:00.000Z', true,
  repeat('c', 64), 'featured_bootstrap', 'replay_ready', $2, 'source-terminal-h1'
);`,
      [fixtureId, manifestId],
    );
    await admin.unsafe(
      `INSERT INTO matchsense.featured_replay_configs (
  slot, fixture_id, archive_manifest_id, enabled
)
VALUES ('v6-backfill', $1, $2, true);`,
      [fixtureId, manifestId],
    );
    const runtime = trackedDatabase();
    await expect(runtime.migrate()).resolves.toEqual({
      appliedVersions: [7, 8, 9],
      currentVersion: 9,
    });
    await expect(
      admin.unsafe<
        {
          config_hash: string;
          job_hash: string;
          manifest_hash: string;
        }[]
      >(`SELECT job.archive_manifest_hash AS job_hash,
  config.archive_manifest_hash AS config_hash,
  archive.delivery_manifest_hash AS manifest_hash
FROM matchsense.archive_import_jobs AS job
JOIN matchsense.featured_replay_configs AS config
  ON config.fixture_id = job.fixture_id
JOIN matchsense.archive_manifests AS archive
  ON archive.id = job.archive_manifest_id
WHERE job.fixture_id = 'v6-replay-backfill-fx';`),
    ).resolves.toEqual([
      {
        config_hash: manifestHash,
        job_hash: manifestHash,
        manifest_hash: manifestHash,
      },
    ]);
  });

  it("requires a post-claim output binding and keeps a corrected archive from re-exposing h1", async () => {
    const runtime = trackedDatabase();
    await runtime.migrate();
    const fixtureId = "archive-generation-fence-fx";
    const manifestId = "archive-generation-fence-manifest";
    const h1 = "1".repeat(64);
    const h2 = "2".repeat(64);
    const queued = await runtime.archiveImportJobs.enqueue(
      archiveImportJobInput({
        awayTeamId: "ESP",
        fixtureId,
        homeTeamId: "FRA",
        kickoffAt: "2026-07-18T12:00:00.000Z",
        participant1IsHome: true,
        reason: "featured_bootstrap",
        sourceTerminalRecordId: "source-terminal-h1",
      }),
    );
    const first = await runtime.archiveImportJobs.claim(
      "archive-worker-a",
      new Date("2100-01-01T00:00:00.000Z"),
    );
    if (!first) throw new Error("Expected first archive import claim");
    expect(first).toMatchObject({ claimGeneration: 1, state: "claimed" });
    await seedRecordedReplayArchive({
      fixtureId,
      manifestHash: h1,
      manifestId,
      terminalDeliveryId: "archive-terminal-h1",
    });
    await runtime.archiveImportJobs.bindVerifiedArchiveOutput({
      archiveManifestHash: h1,
      archiveManifestId: manifestId,
      claimGeneration: first.claimGeneration,
      fixtureId,
      workerId: "archive-worker-a",
    });
    await runtime.archiveImportJobs.markReplayReady({
      claimGeneration: first.claimGeneration,
      fixtureId,
      workerId: "archive-worker-a",
    });
    await runtime.featuredReplays.configure({
      archiveManifestId: manifestId,
      fixtureId,
      slot: "archive-generation-fence",
    });
    await expect(
      runtime.featuredReplays.ready("archive-generation-fence"),
    ).resolves.toMatchObject({ archiveManifestHash: h1 });

    const correction = await runtime.archiveImportJobs.enqueue(
      archiveImportJobInput({
        awayTeamId: "ARG",
        fixtureId: queued.fixtureId,
        homeTeamId: "BRA",
        kickoffAt: "2030-01-01T00:00:00.000Z",
        participant1IsHome: false,
        reason: "live_correction",
        sourceTerminalRecordId: "source-terminal-h2",
      }),
    );
    expect(correction).toMatchObject({
      claimGeneration: 1,
      sourceTerminalRecordId: "source-terminal-h2",
      state: "queued",
    });
    await expect(
      runtime.featuredReplays.ready("archive-generation-fence"),
    ).resolves.toBeNull();
    const second = await runtime.archiveImportJobs.claim(
      "archive-worker-a",
      new Date("2100-01-01T00:00:00.000Z"),
    );
    if (!second) throw new Error("Expected corrected archive import claim");
    expect(second).toMatchObject({ claimGeneration: 2, state: "claimed" });

    await expect(
      runtime.archiveImportJobs.bindVerifiedArchiveOutput({
        archiveManifestHash: h1,
        archiveManifestId: manifestId,
        claimGeneration: second.claimGeneration,
        fixtureId,
        workerId: "archive-worker-a",
      }),
    ).rejects.toThrow(
      "Archive import job claim or current archive output is invalid",
    );
    await expect(
      runtime.archiveImportJobs.markReplayReady({
        claimGeneration: first.claimGeneration,
        fixtureId,
        workerId: "archive-worker-a",
      }),
    ).rejects.toThrow(
      "Archive import job claim or verified archive output is invalid",
    );
    await expect(
      runtime.archiveImportJobs.markRetry({
        availableAt: "2100-01-01T00:10:00.000Z",
        claimGeneration: first.claimGeneration,
        error: "stale retry",
        fixtureId,
        workerId: "archive-worker-a",
      }),
    ).rejects.toThrow("Archive import job is not claimed by this worker");
    await expect(
      runtime.archiveImportJobs.markBlockedRights({
        claimGeneration: first.claimGeneration,
        error: "stale rights",
        fixtureId,
        workerId: "archive-worker-a",
      }),
    ).rejects.toThrow("Archive import job is not claimed by this worker");
    await expect(
      runtime.archiveImportJobs.markRejected({
        claimGeneration: first.claimGeneration,
        error: "stale rejection",
        fixtureId,
        workerId: "archive-worker-a",
      }),
    ).rejects.toThrow("Archive import job is not claimed by this worker");
    await admin.unsafe(
      `UPDATE matchsense.archive_manifests
SET delivery_manifest_hash = $2,
    terminal_delivery_id = 'archive-terminal-h2',
    verified_at = clock_timestamp(),
    updated_at = clock_timestamp()
WHERE id = $1;`,
      [manifestId, h2],
    );
    await expect(
      runtime.archiveImportJobs.bindVerifiedArchiveOutput({
        archiveManifestHash: h2,
        archiveManifestId: manifestId,
        claimGeneration: second.claimGeneration,
        fixtureId,
        workerId: "archive-worker-a",
      }),
    ).resolves.toMatchObject({
      archiveManifestHash: h2,
      claimGeneration: 2,
      sourceTerminalRecordId: "source-terminal-h2",
    });
    await expect(
      runtime.archiveImportJobs.markReplayReady({
        claimGeneration: second.claimGeneration,
        fixtureId,
        workerId: "archive-worker-a",
      }),
    ).resolves.toMatchObject({
      archiveManifestHash: h2,
      claimGeneration: 2,
      state: "replay_ready",
    });
    await expect(
      runtime.featuredReplays.ready("archive-generation-fence"),
    ).resolves.toBeNull();
  });

  it("rechecks every replay right when finalising a bound output and serving a featured replay", async () => {
    const runtime = trackedDatabase();
    await runtime.migrate();
    const fixtureId = "archive-rights-recheck-fx";
    const manifestId = "archive-rights-recheck-manifest";
    const manifestHash = "3".repeat(64);
    const grantId = `grant-${fixtureId}`;
    const workerId = "archive-worker-rights";
    await runtime.archiveImportJobs.enqueue(
      archiveImportJobInput({
        awayTeamId: "ESP",
        fixtureId,
        homeTeamId: "FRA",
        kickoffAt: "2026-07-18T12:00:00.000Z",
        participant1IsHome: true,
        reason: "featured_bootstrap",
        sourceTerminalRecordId: "rights-source-terminal",
      }),
    );
    const first = await runtime.archiveImportJobs.claim(
      workerId,
      new Date("2100-01-01T00:00:00.000Z"),
    );
    if (!first) throw new Error("Expected first rights recheck claim");
    await seedRecordedReplayArchive({
      fixtureId,
      manifestHash,
      manifestId,
      terminalDeliveryId: "archive-terminal-h1",
    });

    const restoreReplayRight = async () => {
      await admin.unsafe(
        `UPDATE matchsense.rights_grants
SET active = true,
    revoked_at = NULL,
    expires_at = NULL,
    scopes = ARRAY['raw_retention', 'replay']::text[]
WHERE id = $1;`,
        [grantId],
      );
    };
    const refreshArchiveVerification = async () => {
      await admin.unsafe(
        `UPDATE matchsense.archive_manifests
SET verified_at = clock_timestamp(),
    updated_at = clock_timestamp()
WHERE id = $1;`,
        [manifestId],
      );
    };
    const mutations = [
      {
        apply: () =>
          admin.unsafe(
            `UPDATE matchsense.rights_grants
SET active = false,
    revoked_at = clock_timestamp(),
    expires_at = NULL
WHERE id = $1;`,
            [grantId],
          ),
        name: "revoked",
      },
      {
        apply: () =>
          admin.unsafe(
            `UPDATE matchsense.rights_grants
SET active = false,
    revoked_at = NULL,
    expires_at = NULL
WHERE id = $1;`,
            [grantId],
          ),
        name: "inactive",
      },
      {
        apply: () =>
          admin.unsafe(
            `UPDATE matchsense.rights_grants
SET active = true,
    revoked_at = NULL,
    expires_at = clock_timestamp() - interval '1 second'
WHERE id = $1;`,
            [grantId],
          ),
        name: "expired",
      },
      {
        apply: () =>
          admin.unsafe(
            `UPDATE matchsense.rights_grants
SET active = true,
    revoked_at = NULL,
    expires_at = NULL,
    scopes = ARRAY['raw_retention']::text[]
WHERE id = $1;`,
            [grantId],
          ),
        name: "missing replay scope",
      },
    ];

    let claim = first;
    await runtime.archiveImportJobs.bindVerifiedArchiveOutput({
      archiveManifestHash: manifestHash,
      archiveManifestId: manifestId,
      claimGeneration: claim.claimGeneration,
      fixtureId,
      workerId,
    });
    for (const mutation of mutations) {
      await mutation.apply();
      await expect(
        runtime.archiveImportJobs.markReplayReady({
          claimGeneration: claim.claimGeneration,
          fixtureId,
          workerId,
        }),
      ).rejects.toThrow(
        "Archive import job claim or verified archive output is invalid",
      );
      await runtime.archiveImportJobs.markRetry({
        availableAt: "2000-01-01T00:00:00.000Z",
        claimGeneration: claim.claimGeneration,
        error: `rights ${mutation.name}`,
        fixtureId,
        workerId,
      });
      await restoreReplayRight();
      const next = await runtime.archiveImportJobs.claim(
        workerId,
        new Date("2100-01-01T00:00:00.000Z"),
      );
      if (!next) throw new Error("Expected next rights recheck claim");
      claim = next;
      await refreshArchiveVerification();
      await runtime.archiveImportJobs.bindVerifiedArchiveOutput({
        archiveManifestHash: manifestHash,
        archiveManifestId: manifestId,
        claimGeneration: claim.claimGeneration,
        fixtureId,
        workerId,
      });
    }
    await runtime.archiveImportJobs.markReplayReady({
      claimGeneration: claim.claimGeneration,
      fixtureId,
      workerId,
    });
    await runtime.featuredReplays.configure({
      archiveManifestId: manifestId,
      fixtureId,
      slot: "archive-rights-recheck",
    });
    await expect(
      runtime.featuredReplays.ready("archive-rights-recheck"),
    ).resolves.toMatchObject({ archiveManifestHash: manifestHash });
    for (const mutation of mutations) {
      await mutation.apply();
      await expect(
        runtime.featuredReplays.ready("archive-rights-recheck"),
      ).resolves.toBeNull();
      await restoreReplayRight();
      await expect(
        runtime.featuredReplays.ready("archive-rights-recheck"),
      ).resolves.toMatchObject({ archiveManifestHash: manifestHash });
    }
  });

  it("serves recorded history only from a current bound replay-ready import job with active rights", async () => {
    const runtime = trackedDatabase();
    await runtime.migrate();
    const fixtureId = "archive-public-binding-fx";
    const manifestId = "archive-public-binding-manifest";
    const manifestHash = "6".repeat(64);
    const workerId = "archive-public-binding-worker";
    await seedRecordedReplayArchive({
      fixtureId,
      manifestHash,
      manifestId,
      terminalDeliveryId: "archive-public-terminal",
    });

    await admin.unsafe(
      `INSERT INTO matchsense.archive_import_jobs (
  fixture_id, home_team_id, away_team_id, kickoff_at, participant1_is_home,
  context_hash, reason, state, archive_manifest_id, archive_manifest_hash,
  claim_generation, source_terminal_record_id
)
VALUES (
  $1, 'FRA', 'ESP', '2026-07-18T12:00:00.000Z', true,
  repeat('7', 64), 'featured_bootstrap', 'replay_ready', $2, $3,
  1, 'archive-public-source-h1'
);`,
      [fixtureId, manifestId, manifestHash],
    );
    await expect(
      runtime.fixtureReads.getReplayReady({ fixtureId, mode: "recorded" }),
    ).resolves.toBeNull();
    await expect(runtime.fixtureReads.readHistory()).resolves.toEqual([]);
    await expect(
      runtime.featuredReplays.configure({
        archiveManifestId: manifestId,
        fixtureId,
        slot: "archive-public-binding",
      }),
    ).rejects.toThrow(
      "Featured replay manifest is not current, replay-ready, and authorised",
    );

    await admin.unsafe(
      "DELETE FROM matchsense.archive_import_jobs WHERE fixture_id = $1;",
      [fixtureId],
    );
    await runtime.archiveImportJobs.enqueue(
      archiveImportJobInput({
        awayTeamId: "ESP",
        fixtureId,
        homeTeamId: "FRA",
        kickoffAt: "2026-07-18T12:00:00.000Z",
        participant1IsHome: true,
        reason: "featured_bootstrap",
        sourceTerminalRecordId: "archive-public-source-h1",
      }),
    );
    const claimed = await runtime.archiveImportJobs.claim(
      workerId,
      new Date("2100-01-01T00:00:00.000Z"),
    );
    if (!claimed) throw new Error("Expected public archive claim");
    await admin.unsafe(
      `UPDATE matchsense.archive_manifests
SET verified_at = clock_timestamp(), updated_at = clock_timestamp()
WHERE id = $1;`,
      [manifestId],
    );
    await runtime.archiveImportJobs.bindVerifiedArchiveOutput({
      archiveManifestHash: manifestHash,
      archiveManifestId: manifestId,
      claimGeneration: claimed.claimGeneration,
      fixtureId,
      workerId,
    });
    await runtime.archiveImportJobs.markReplayReady({
      claimGeneration: claimed.claimGeneration,
      fixtureId,
      workerId,
    });
    await expect(
      runtime.fixtureReads.getReplayReady({ fixtureId, mode: "recorded" }),
    ).resolves.toMatchObject({
      archiveManifestId: manifestId,
      fixture: expect.objectContaining({ fixtureId, replayReady: true }),
    });
    await expect(runtime.fixtureReads.readHistory()).resolves.toEqual([
      expect.objectContaining({ fixtureId, replayReady: true }),
    ]);
    await runtime.featuredReplays.configure({
      archiveManifestId: manifestId,
      fixtureId,
      slot: "archive-public-binding",
    });
    await expect(
      runtime.featuredReplays.ready("archive-public-binding"),
    ).resolves.toMatchObject({ archiveManifestId: manifestId, fixtureId });

    const grantId = `grant-${fixtureId}`;
    await admin.unsafe(
      `UPDATE matchsense.rights_grants
SET active = false, revoked_at = clock_timestamp()
WHERE id = $1;`,
      [grantId],
    );
    await expect(
      runtime.fixtureReads.getReplayReady({ fixtureId, mode: "recorded" }),
    ).resolves.toBeNull();
    await expect(runtime.fixtureReads.readHistory()).resolves.toEqual([]);
    await expect(
      runtime.featuredReplays.ready("archive-public-binding"),
    ).resolves.toBeNull();
    await admin.unsafe(
      `UPDATE matchsense.rights_grants
SET active = true, revoked_at = NULL
WHERE id = $1;`,
      [grantId],
    );

    await runtime.archiveImportJobs.enqueue(
      archiveImportJobInput({
        awayTeamId: "ARG",
        fixtureId,
        homeTeamId: "BRA",
        kickoffAt: "2030-01-01T00:00:00.000Z",
        participant1IsHome: false,
        reason: "live_correction",
        sourceTerminalRecordId: "archive-public-source-h2",
      }),
    );
    await expect(
      runtime.fixtureReads.getReplayReady({ fixtureId, mode: "recorded" }),
    ).resolves.toBeNull();
    await expect(runtime.fixtureReads.readHistory()).resolves.toEqual([]);
    await expect(
      runtime.featuredReplays.ready("archive-public-binding"),
    ).resolves.toBeNull();
  });

  it("rejects a bound output when the archive changes before finalisation", async () => {
    const runtime = trackedDatabase();
    await runtime.migrate();
    const fixtureId = "archive-post-bind-stale-fx";
    const manifestId = "archive-post-bind-stale-manifest";
    const h1 = "4".repeat(64);
    const h2 = "5".repeat(64);
    const workerId = "archive-worker-post-bind";
    await runtime.archiveImportJobs.enqueue(
      archiveImportJobInput({
        awayTeamId: "ESP",
        fixtureId,
        homeTeamId: "FRA",
        kickoffAt: "2026-07-18T12:00:00.000Z",
        participant1IsHome: true,
        reason: "featured_bootstrap",
        sourceTerminalRecordId: "post-bind-source-terminal",
      }),
    );
    const first = await runtime.archiveImportJobs.claim(
      workerId,
      new Date("2100-01-01T00:00:00.000Z"),
    );
    if (!first) throw new Error("Expected first stale archive claim");
    await seedRecordedReplayArchive({
      fixtureId,
      manifestHash: h1,
      manifestId,
      terminalDeliveryId: "archive-terminal-h1",
    });
    const restoreCurrentArchive = async () => {
      await admin.unsafe(
        `UPDATE matchsense.archive_manifests
SET status = 'REPLAY_READY',
    delivery_manifest_hash = $2,
    terminal_delivery_id = 'archive-terminal-h1',
    invalidation_reason = NULL,
    invalidated_at = NULL,
    verified_at = clock_timestamp(),
    updated_at = clock_timestamp()
WHERE id = $1;`,
        [manifestId, h1],
      );
    };
    const mutations = [
      {
        apply: () =>
          admin.unsafe(
            `UPDATE matchsense.archive_manifests
SET delivery_manifest_hash = $2,
    updated_at = clock_timestamp()
WHERE id = $1;`,
            [manifestId, h2],
          ),
        name: "hash",
      },
      {
        apply: () =>
          admin.unsafe(
            `UPDATE matchsense.archive_manifests
SET status = 'REPLAY_INVALIDATED',
    invalidation_reason = 'integration stale status',
    invalidated_at = clock_timestamp(),
    updated_at = clock_timestamp()
WHERE id = $1;`,
            [manifestId],
          ),
        name: "status",
      },
      {
        apply: () =>
          admin.unsafe(
            `UPDATE matchsense.archive_manifests
SET verified_at = clock_timestamp() + interval '1 second',
    updated_at = clock_timestamp()
WHERE id = $1;`,
            [manifestId],
          ),
        name: "verified timestamp",
      },
    ];

    let claim = first;
    await runtime.archiveImportJobs.bindVerifiedArchiveOutput({
      archiveManifestHash: h1,
      archiveManifestId: manifestId,
      claimGeneration: claim.claimGeneration,
      fixtureId,
      workerId,
    });
    for (const mutation of mutations) {
      await mutation.apply();
      await expect(
        runtime.archiveImportJobs.markReplayReady({
          claimGeneration: claim.claimGeneration,
          fixtureId,
          workerId,
        }),
      ).rejects.toThrow(
        "Archive import job claim or verified archive output is invalid",
      );
      await runtime.archiveImportJobs.markRetry({
        availableAt: "2000-01-01T00:00:00.000Z",
        claimGeneration: claim.claimGeneration,
        error: `stale archive ${mutation.name}`,
        fixtureId,
        workerId,
      });
      const next = await runtime.archiveImportJobs.claim(
        workerId,
        new Date("2100-01-01T00:00:00.000Z"),
      );
      if (!next) throw new Error("Expected next stale archive claim");
      claim = next;
      await restoreCurrentArchive();
      await runtime.archiveImportJobs.bindVerifiedArchiveOutput({
        archiveManifestHash: h1,
        archiveManifestId: manifestId,
        claimGeneration: claim.claimGeneration,
        fixtureId,
        workerId,
      });
    }
  });

  it("resets a populated v7 claimed job, preserves its nullable v9 source context, and issues its first fenced claim", async () => {
    await seedV7MigrationLedger();
    await admin.unsafe(
      `INSERT INTO matchsense.archive_import_jobs (
  fixture_id, home_team_id, away_team_id, kickoff_at, participant1_is_home,
  context_hash, reason, state, claimed_by, claim_expires_at,
  source_terminal_record_id
)
VALUES (
  'v7-claimed-job-fx', 'FRA', 'ESP', '2026-07-18T12:00:00.000Z', true,
  repeat('9', 64), 'featured_bootstrap', 'claimed', 'legacy-worker',
  '2100-01-01T00:00:00.000Z', 'legacy-source-terminal'
);`,
    );
    const runtime = trackedDatabase();
    await expect(runtime.migrate()).resolves.toEqual({
      appliedVersions: [8, 9],
      currentVersion: 9,
    });
    await expect(
      admin.unsafe<
        {
          claim_expires_at: Date | null;
          claim_generation: string;
          claim_started_at: Date | null;
          claimed_by: string | null;
          state: string;
          source_context: unknown;
        }[]
      >(`SELECT state, claimed_by, claim_expires_at, claim_started_at,
  source_context,
  claim_generation::text AS claim_generation
FROM matchsense.archive_import_jobs
WHERE fixture_id = 'v7-claimed-job-fx';`),
    ).resolves.toEqual([
      {
        claim_expires_at: null,
        claim_generation: "0",
        claim_started_at: null,
        claimed_by: null,
        state: "retry_wait",
        source_context: null,
      },
    ]);
    await expect(
      runtime.archiveImportJobs.claim(
        "v8-worker",
        new Date("2100-01-01T00:00:00.000Z"),
      ),
    ).resolves.toMatchObject({
      claimGeneration: 1,
      claimedBy: "v8-worker",
      fixtureId: "v7-claimed-job-fx",
      state: "claimed",
    });
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
      appliedVersions: [4, 5, 6, 7, 8, 9],
      currentVersion: 9,
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
    const sourceFence = await acquireRecordedReplayFence(runtime);
    const scheduleRaw = {
      ...sourceChange({ sourceFence, suffix: "schedule-1" }).raw,
      dedupeKey: "schedule:fx-1:v1",
      id: "raw-schedule-1",
    };

    await expect(
      runtime.fixtureTruth.commitFixtureSchedule({
        fixture: recordedFixture,
        raw: scheduleRaw,
        sourceFence,
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
        sourceFence,
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
        sourceFence,
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
        sourceFence,
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

  it("fences lost recorded source ownership before raw or projection writes and accepts the replacement lease", async () => {
    const runtime = trackedDatabase();
    await runtime.migrate();
    const fixture = {
      ...recordedFixture,
      id: "recorded-fenced-frame-fx",
    };
    await runtime.fixtureTruth.upsert(fixture);
    const stream = {
      mode: "recorded" as const,
      source: "txline_historical",
      streamKey: "archive-imports",
    };
    const oldLease = await runtime.sourceState.acquireLease({
      ...stream,
      holderId: "recorded-worker-old",
      leaseUntil: "2099-01-01T00:01:00.000Z",
    });
    if (!oldLease) throw new Error("Expected old recorded source lease");
    await runtime.sourceState.releaseLease({
      ...stream,
      fencingToken: oldLease.fencingToken,
      holderId: oldLease.holderId,
    });
    const currentLease = await runtime.sourceState.acquireLease({
      ...stream,
      holderId: "recorded-worker-new",
      leaseUntil: "2099-01-01T00:02:00.000Z",
    });
    if (!currentLease)
      throw new Error("Expected current recorded source lease");

    const frame = (
      suffix: string,
      sourceFence: SourceFence,
      revision: number,
    ) => ({
      deliveries: [
        {
          derive: () => [
            {
              event: {
                id: `recorded-fenced-event-${suffix}`,
                payload: { revision },
                type: "fixture.reconciled",
              },
              outbox: [],
              projection: { payload: { revision }, revision },
            },
          ],
          fixtureId: fixture.id,
          raw: {
            canonicalEligible: true,
            dedupeKey: `recorded-fenced:${suffix}`,
            deliveryIntent: "reconcile" as const,
            id: `recorded-fenced-raw-${suffix}`,
            orderingKey: String(revision).padStart(20, "0"),
            payload: { Action: "game_finalised", FixtureId: fixture.id },
            payloadHash: createHash("sha256").update(suffix).digest("hex"),
            provenance: "recorded_txline_authorised" as const,
            rawRetention: "normalised_only" as const,
            receivedAt: `2026-07-18T12:0${revision}:00.000Z`,
            source: stream.source,
            sourcePath: "/historical/score",
            sourceRecordId: `recorded-source-${suffix}`,
            sourceSequence: String(revision),
            streamKey: stream.streamKey,
          },
        },
      ],
      mode: "recorded" as const,
      sourceFence,
    });
    const staleFence = {
      fencingToken: oldLease.fencingToken,
      holderId: oldLease.holderId,
      source: oldLease.source,
      streamKey: oldLease.streamKey,
    };

    await expect(
      runtime.fixtureTruth.commitCollectorFrame(frame("stale", staleFence, 1)),
    ).resolves.toEqual({ kind: "fenced" });
    await expect(
      admin.unsafe<{ projections: number; raw: number }[]>(`SELECT
  (SELECT count(*)::integer FROM matchsense.raw_source_records) AS raw,
  (SELECT count(*)::integer FROM matchsense.fixture_projections) AS projections;`),
    ).resolves.toEqual([{ projections: 0, raw: 0 }]);

    await expect(
      runtime.fixtureTruth.commitCollectorFrame(
        frame(
          "current",
          {
            fencingToken: currentLease.fencingToken,
            holderId: currentLease.holderId,
            source: currentLease.source,
            streamKey: currentLease.streamKey,
          },
          1,
        ),
      ),
    ).resolves.toEqual({
      deliveries: [{ eventSequences: [1], kind: "committed", revisions: [1] }],
      kind: "committed",
    });
    await expect(
      admin.unsafe<{ projections: number; raw: number }[]>(`SELECT
  (SELECT count(*)::integer FROM matchsense.raw_source_records) AS raw,
  (SELECT count(*)::integer FROM matchsense.fixture_projections) AS projections;`),
    ).resolves.toEqual([{ projections: 1, raw: 1 }]);
  });

  it("commits one revision, event, and outbox row for concurrent duplicate source records", async () => {
    const runtime = trackedDatabase();
    await runtime.migrate();
    await runtime.fixtureTruth.upsert(recordedFixture);
    const sourceFence = await acquireRecordedReplayFence(runtime);
    const change = sourceChange({ sourceFence });

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
    const sourceFence = await acquireRecordedReplayFence(runtime);
    const raw = sourceChange({
      sourceFence,
      suffix: "process-envelope",
    }).raw;
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
      sourceFence,
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
    const sourceFence = await acquireRecordedReplayFence(runtime);
    const reconciliationRaw = {
      ...sourceChange({ sourceFence, suffix: "reconcile-history" }).raw,
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
        sourceFence,
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
    const sourceFence = await acquireRecordedReplayFence(runtime);
    const first = sourceChange({ sourceFence });
    await runtime.fixtureTruth.commitSourceChange(first);
    const conflicting = sourceChange({
      expectedRevision: 1,
      outboxIdempotencyKey: first.outbox.idempotencyKey,
      sourceFence,
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
    const sourceFence = await acquireRecordedReplayFence(firstRuntime);
    await firstRuntime.fixtureTruth.commitSourceChange(
      sourceChange({ sourceFence }),
    );
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
    const sourceFence = await acquireRecordedReplayFence(firstWorker);
    await firstWorker.fixtureTruth.commitSourceChange(
      sourceChange({ sourceFence }),
    );

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
    const sourceFence = await acquireRecordedReplayFence(runtime);
    await runtime.fixtureTruth.commitSourceChange(
      sourceChange({ sourceFence }),
    );

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
