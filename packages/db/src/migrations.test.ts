import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import * as databaseModule from "./index.js";

type DatabaseModuleContract = {
  migrationCatalog?: readonly {
    checksum: string;
    description: string;
    sql: string;
    version: number;
  }[];
  planMigrations?: (
    catalog: readonly {
      checksum: string;
      description: string;
      sql: string;
      version: number;
    }[],
    applied: readonly { checksum: string; version: number }[],
  ) => {
    current: boolean;
    pending: readonly { checksum: string; version: number }[];
  };
};

const db = databaseModule as DatabaseModuleContract;

const prefixCatalog = [
  {
    checksum: "checksum-one",
    description: "one",
    sql: "SELECT 1;",
    version: 1,
  },
  {
    checksum: "checksum-two",
    description: "two",
    sql: "SELECT 2;",
    version: 2,
  },
  {
    checksum: "checksum-three",
    description: "three",
    sql: "SELECT 3;",
    version: 3,
  },
] as const;

describe("migration catalog and planning", () => {
  it("publishes a deterministic schema-only baseline migration", () => {
    expect(db.migrationCatalog).toHaveLength(8);

    const migration = db.migrationCatalog?.[0];
    expect(migration).toMatchObject({
      description: "create matchsense schema",
      version: 1,
    });
    expect(migration?.sql).toMatch(
      /^CREATE SCHEMA IF NOT EXISTS matchsense;$/u,
    );
    expect(migration?.sql).not.toMatch(/CREATE\s+TABLE/iu);
    expect(migration?.checksum).toBe(
      createHash("sha256")
        .update(migration?.sql ?? "")
        .digest("hex"),
    );
  });

  it("publishes the deterministic v2 truth and delivery foundation", () => {
    const migration = db.migrationCatalog?.[1];

    expect(migration).toMatchObject({
      description: "create durable product truth and delivery foundation",
      version: 2,
    });
    expect(migration?.checksum).toBe(
      createHash("sha256")
        .update(migration?.sql ?? "")
        .digest("hex"),
    );

    for (const table of [
      "fixtures",
      "raw_source_records",
      "source_cursors",
      "source_leases",
      "fixture_projections",
      "canonical_moments",
      "moment_revisions",
      "fixture_events",
      "outbox",
      "consumer_receipts",
      "outbox_dead_letters",
      "commentary_artifacts",
    ]) {
      expect(migration?.sql).toMatch(
        new RegExp(`CREATE TABLE matchsense\\.${table} \\(`, "u"),
      );
    }

    expect(migration?.sql).toContain("CHECK (mode IN ('live', 'demo'))");
    expect(migration?.sql).toContain(
      "CHECK ((mode = 'live' AND provenance = 'live_txline') OR (mode = 'demo' AND provenance = 'synthetic_txline_shaped'))",
    );
    expect(migration?.sql).toMatch(
      /PRIMARY KEY \(mode, fixture_id, sequence\)/u,
    );
    expect(migration?.sql).toMatch(
      /FOREIGN KEY \(mode, fixture_id\) REFERENCES matchsense\.fixtures \(mode, id\)/u,
    );
    expect(migration?.sql).toMatch(
      /CREATE INDEX fixtures_schedule_idx[\s\S]*scheduled_at/u,
    );
    expect(migration?.sql).toMatch(
      /CREATE UNIQUE INDEX raw_source_records_dedupe_idx/u,
    );
    expect(migration?.sql).toMatch(
      /FOREIGN KEY \(mode, fixture_id\) REFERENCES matchsense\.fixtures \(mode, id\) DEFERRABLE INITIALLY DEFERRED/u,
    );
    expect(migration?.sql).toMatch(
      /CREATE TABLE matchsense\.source_cursors \([\s\S]*stream_key text NOT NULL[\s\S]*fencing_token bigint NOT NULL[\s\S]*PRIMARY KEY \(mode, source, stream_key\)/u,
    );
    expect(migration?.sql).toMatch(
      /CREATE TABLE matchsense\.source_leases \([\s\S]*stream_key text NOT NULL[\s\S]*fencing_token bigint NOT NULL[\s\S]*PRIMARY KEY \(mode, source, stream_key\)/u,
    );
    expect(migration?.sql).not.toMatch(
      /CREATE TABLE matchsense\.source_(?:cursors|leases) \([^;]*fixture_id/u,
    );
    expect(migration?.sql).toMatch(
      /CREATE TABLE matchsense\.fixture_projections \([\s\S]*source_sequence text/u,
    );
    expect(migration?.sql).toMatch(/dedupe_key text NOT NULL/u);
    expect(migration?.sql).toMatch(
      /payload_hash text NOT NULL CHECK \(length\(payload_hash\) = 64\)/u,
    );
    expect(migration?.sql).toMatch(
      /raw_source_records \(mode, source, fixture_id, dedupe_key\)/u,
    );
    expect(migration?.sql).toMatch(/revision bigint NOT NULL/u);
    expect(migration?.sql).toMatch(/idempotency_key text NOT NULL/u);
    expect(migration?.sql).toMatch(/UNIQUE \(mode, idempotency_key\)/u);
    expect(migration?.sql).toMatch(/claim_token text/u);
    expect(migration?.sql).toMatch(
      /\(locked_by IS NULL\) = \(claim_token IS NULL\)/u,
    );
    expect(migration?.sql).toMatch(
      /FOREIGN KEY \(mode, fixture_id, moment_id\) REFERENCES matchsense\.canonical_moments \(mode, fixture_id, id\)/u,
    );
    expect(migration?.sql).toMatch(
      /FOREIGN KEY \(mode, fixture_id, source_record_id\) REFERENCES matchsense\.raw_source_records \(mode, fixture_id, id\)/u,
    );
    expect(migration?.sql).toMatch(
      /UNIQUE \(mode, fixture_id, moment_id, moment_revision, language, voice\)/u,
    );
    expect(migration?.sql).toMatch(
      /FOREIGN KEY \(mode, fixture_id, moment_id, moment_revision\) REFERENCES matchsense\.moment_revisions \(mode, fixture_id, moment_id, revision\)/u,
    );
    expect(migration?.sql).toMatch(/CREATE INDEX fixture_events_catchup_idx/u);
    expect(migration?.sql).toMatch(
      /CREATE INDEX outbox_unprocessed_idx[\s\S]*WHERE processed_at IS NULL/u,
    );
    expect(migration?.sql).not.toMatch(/call_three|leaderboard|room_invites/iu);
  });

  it("appends the v3 fan, delivery, experience, room, and memory product records", () => {
    const migration = db.migrationCatalog?.[2];

    expect(migration).toMatchObject({
      description: "create unified fan experience product records",
      version: 3,
    });
    expect(migration?.checksum).toBe(
      createHash("sha256")
        .update(migration?.sql ?? "")
        .digest("hex"),
    );

    for (const table of [
      "fans",
      "fan_sessions",
      "fan_follows",
      "push_devices",
      "push_deliveries",
      "experience_templates",
      "experience_runs",
      "experience_run_beats",
      "rooms",
      "room_memberships",
      "match_memories",
    ]) {
      expect(migration?.sql).toMatch(
        new RegExp(`CREATE TABLE matchsense\\.${table} \\(`, "u"),
      );
    }

    expect(migration?.sql).toMatch(
      /ALTER TABLE matchsense\.raw_source_records[\s\S]*ALTER COLUMN payload DROP NOT NULL/u,
    );
    expect(migration?.sql).toMatch(
      /delivery_intent text NOT NULL DEFAULT 'realtime'[\s\S]*CHECK \(delivery_intent IN \('realtime', 'reconcile'\)\)/u,
    );
    expect(migration?.sql).toMatch(/handle_normalized text UNIQUE/u);
    expect(migration?.sql).toMatch(
      /UNIQUE \(device_id, mode, fixture_id, moment_id, moment_revision\)/u,
    );
    expect(migration?.sql).toMatch(/PRIMARY KEY \(run_id, beat_index\)/u);
    expect(migration?.sql).toMatch(
      /PRIMARY KEY \(fan_id, mode, fixture_id, revision\)/u,
    );
  });

  it("retires synthetic public modes and adds the authorised archive/job foundation in v4", () => {
    const migration = db.migrationCatalog?.[3];

    expect(db.migrationCatalog).toHaveLength(8);
    expect(migration).toMatchObject({
      description:
        "retire synthetic public modes and add authorised archive jobs",
      version: 4,
    });
    expect(migration?.checksum).toBe(
      createHash("sha256")
        .update(migration?.sql ?? "")
        .digest("hex"),
    );
    expect(migration?.sql).toContain(
      "DELETE FROM matchsense.fixtures WHERE mode = 'demo'",
    );
    expect(migration?.sql).toContain("CHECK (mode IN ('live', 'recorded'))");
    expect(migration?.sql).toContain("CREATE TABLE matchsense.rights_grants");
    expect(migration?.sql).toContain(
      "CREATE TABLE matchsense.archive_manifests",
    );
    expect(migration?.sql).toContain(
      "CREATE TABLE matchsense.archive_manifest_entries",
    );
    expect(migration?.sql).toContain("CREATE TABLE matchsense.commentary_jobs");
    expect(migration?.sql).toContain(
      "raw_source_records_delivery_intent_check",
    );
    expect(migration?.sql).toContain("ordering_key text NOT NULL");
    expect(migration?.sql).toContain("source_path text NOT NULL");
    expect(migration?.sql).toContain("response_hash text NOT NULL");
    expect(migration?.sql).toContain("rights_grant_id text NOT NULL");
    expect(migration?.sql).toContain("canonical_eligible boolean;");
    expect(migration?.sql).toContain(
      "ALTER COLUMN canonical_eligible SET NOT NULL",
    );
    expect(migration?.sql).toContain(
      "source-only delivery cannot create canonical truth",
    );
    expect(migration?.sql).toContain(
      "reconciliation delivery cannot create Moment or outbox effects",
    );
    expect(migration?.sql).toContain(
      "TG_TABLE_NAME IN ('moment_revisions', 'outbox')",
    );
  });

  it("temporarily suspends immutable raw rows only while backfilling a populated v3 database", () => {
    const migration = db.migrationCatalog?.[3];
    const sql = migration?.sql ?? "";
    const suspend = sql.indexOf(
      "DROP TRIGGER IF EXISTS raw_source_records_immutable",
    );
    const demoRawDelete = sql.indexOf(
      "DELETE FROM matchsense.raw_source_records WHERE mode = 'demo'",
    );
    const legacyBackfill = sql.indexOf(
      "UPDATE matchsense.raw_source_records\nSET delivery_key = payload_hash",
    );
    const restore = sql.lastIndexOf(
      "CREATE TRIGGER raw_source_records_immutable",
    );

    expect(suspend).toBeGreaterThanOrEqual(0);
    expect(suspend).toBeLessThan(demoRawDelete);
    expect(suspend).toBeLessThan(legacyBackfill);
    expect(restore).toBeGreaterThan(legacyBackfill);
    expect(sql).toContain(
      "BEFORE UPDATE OR DELETE ON matchsense.raw_source_records",
    );
  });

  it("adds a live TxLINE team catalogue separate from fixture lifecycle state in v5", () => {
    const migration = db.migrationCatalog?.[4];

    expect(migration).toMatchObject({
      description: "create durable live TxLINE team catalogue",
      version: 5,
    });
    expect(migration?.checksum).toBe(
      createHash("sha256")
        .update(migration?.sql ?? "")
        .digest("hex"),
    );
    expect(migration?.sql).toMatch(
      /CREATE TABLE matchsense\.team_catalog_entries \(/u,
    );
    expect(migration?.sql).toMatch(/participant_id text NOT NULL/u);
    expect(migration?.sql).toMatch(/UNIQUE \(code\)/u);
    expect(migration?.sql).toMatch(/source_timestamp_ms bigint NOT NULL/u);
    expect(migration?.sql).toContain("CHECK (mode = 'live')");
    expect(migration?.sql).toContain("CHECK (source = 'txline')");
    expect(migration?.sql).toContain("PRIMARY KEY (participant_id)");
    expect(migration?.sql).toContain(
      "CREATE INDEX team_catalog_entries_code_idx",
    );
    expect(migration?.sql).toContain(
      "DROP CONSTRAINT IF EXISTS fixtures_check1",
    );
    expect(migration?.sql).not.toContain("fixture_id");
    expect(migration?.sql).not.toContain("payload jsonb");
  });

  it("adds durable archive-import leases and manifest-pinned featured replay readiness in v6", () => {
    const migration = db.migrationCatalog?.[5];

    expect(db.migrationCatalog).toHaveLength(8);
    expect(migration).toMatchObject({
      description:
        "create durable archive import jobs and featured replay readiness",
      version: 6,
    });
    expect(migration?.checksum).toBe(
      createHash("sha256")
        .update(migration?.sql ?? "")
        .digest("hex"),
    );
    expect(migration?.sql).toMatch(
      /CREATE TABLE matchsense\.archive_import_jobs \(/u,
    );
    expect(migration?.sql).toMatch(/fixture_id text PRIMARY KEY/u);
    expect(migration?.sql).toMatch(/participant1_is_home boolean NOT NULL/u);
    expect(migration?.sql).toMatch(
      /context_hash text NOT NULL CHECK \(length\(context_hash\) = 64\)/u,
    );
    expect(migration?.sql).toContain(
      "'featured_bootstrap', 'live_terminal', 'live_correction'",
    );
    expect(migration?.sql).toContain(
      "'queued', 'claimed', 'retry_wait', 'replay_ready', 'blocked_rights', 'rejected'",
    );
    expect(migration?.sql).toContain(
      "CREATE INDEX archive_import_jobs_claim_idx",
    );
    expect(migration?.sql).toContain(
      "CREATE TABLE matchsense.featured_replay_configs",
    );
    expect(migration?.sql).toContain("archive_manifest_id text NOT NULL");
    expect(migration?.sql).toContain("featured_replay_configs_manifest_fk");
  });

  it("pins replay jobs and featured slots to the verified archive content hash in v7", () => {
    const migration = db.migrationCatalog?.[6];

    expect(migration).toMatchObject({
      description: "pin replay readiness to verified archive manifest content",
      version: 7,
    });
    expect(migration?.checksum).toBe(
      createHash("sha256")
        .update(migration?.sql ?? "")
        .digest("hex"),
    );
    expect(migration?.sql).toContain("ADD COLUMN archive_manifest_hash text");
    expect(migration?.sql).toContain("delivery_manifest_hash");
    expect(migration?.sql).toContain(
      "DROP CONSTRAINT IF EXISTS archive_import_jobs_replay_ready_manifest",
    );
    expect(migration?.sql).toContain("archive_manifest_hash IS NOT NULL");
    expect(migration?.sql).toContain(
      "ALTER COLUMN archive_manifest_hash SET NOT NULL",
    );
  });

  it("fences archive claims and records only post-claim verified outputs in v8", () => {
    const migration = db.migrationCatalog?.[7];

    expect(migration).toMatchObject({
      description: "fence archive import claims with verified output bindings",
      version: 8,
    });
    expect(migration?.checksum).toBe(
      createHash("sha256")
        .update(migration?.sql ?? "")
        .digest("hex"),
    );
    expect(migration?.sql).toContain(
      "ADD COLUMN claim_generation bigint NOT NULL DEFAULT 0",
    );
    expect(migration?.sql).toContain("ADD COLUMN claim_started_at timestamptz");
    expect(migration?.sql).toContain(
      "CREATE TABLE matchsense.archive_import_job_outputs",
    );
    expect(migration?.sql).toContain(
      "PRIMARY KEY (fixture_id, claim_generation)",
    );
    expect(migration?.sql).toContain(
      "archive_verified_at timestamptz NOT NULL",
    );
    expect(migration?.sql).toContain(
      "archive_terminal_delivery_id text NOT NULL",
    );
    expect(migration?.sql).toContain("archive_import_jobs_claim_pair");
  });

  it("orders pending migrations and reports a repeat run as current", () => {
    expect(db.planMigrations).toBeTypeOf("function");

    const catalog = [
      {
        checksum: "checksum-one",
        description: "one",
        sql: "SELECT 1;",
        version: 1,
      },
      {
        checksum: "checksum-two",
        description: "two",
        sql: "SELECT 2;",
        version: 2,
      },
    ] as const;

    expect(db.planMigrations?.(catalog, [])).toEqual({
      current: false,
      pending: catalog,
    });
    expect(
      db.planMigrations?.(catalog, [{ checksum: "checksum-one", version: 1 }]),
    ).toEqual({ current: false, pending: [catalog[1]] });
    expect(
      db.planMigrations?.(catalog, [
        { checksum: "checksum-one", version: 1 },
        { checksum: "checksum-two", version: 2 },
      ]),
    ).toEqual({ current: true, pending: [] });
  });

  it("rejects checksum drift in an applied migration", () => {
    expect(db.planMigrations).toBeTypeOf("function");

    expect(() =>
      db.planMigrations?.(
        [
          {
            checksum: "expected-checksum",
            description: "one",
            sql: "SELECT 1;",
            version: 1,
          },
        ],
        [{ checksum: "tampered-checksum", version: 1 }],
      ),
    ).toThrowError(
      expect.objectContaining({ code: "MIGRATION_CHECKSUM_DRIFT" }),
    );
  });

  it("rejects an applied version absent from the catalog", () => {
    expect(db.planMigrations).toBeTypeOf("function");

    expect(() =>
      db.planMigrations?.(
        [
          {
            checksum: "checksum-one",
            description: "one",
            sql: "SELECT 1;",
            version: 1,
          },
        ],
        [{ checksum: "unknown-checksum", version: 99 }],
      ),
    ).toThrowError(
      expect.objectContaining({ code: "UNKNOWN_APPLIED_MIGRATION" }),
    );
  });

  it("accepts only a valid prefix of the catalog sorted by version", () => {
    expect(db.planMigrations).toBeTypeOf("function");
    const unsortedCatalog = [
      prefixCatalog[2],
      prefixCatalog[0],
      prefixCatalog[1],
    ];

    expect(
      db.planMigrations?.(unsortedCatalog, [
        { checksum: "checksum-one", version: 1 },
        { checksum: "checksum-two", version: 2 },
      ]),
    ).toEqual({ current: false, pending: [prefixCatalog[2]] });
  });

  it.each([
    {
      applied: [{ checksum: "checksum-two", version: 2 }],
      state: "only a later version",
    },
    {
      applied: [
        { checksum: "checksum-one", version: 1 },
        { checksum: "checksum-three", version: 3 },
      ],
      state: "a gap between applied versions",
    },
    {
      applied: [
        { checksum: "checksum-one", version: 1 },
        { checksum: "checksum-one", version: 1 },
      ],
      state: "a duplicate applied version",
    },
  ])("rejects migration history containing $state", ({ applied }) => {
    expect(db.planMigrations).toBeTypeOf("function");

    expect(() => db.planMigrations?.(prefixCatalog, applied)).toThrowError(
      expect.objectContaining({ code: "MIGRATION_HISTORY_NOT_PREFIX" }),
    );
  });

  it("reports unknown versions before checksum or prefix errors", () => {
    expect(db.planMigrations).toBeTypeOf("function");

    for (const applied of [
      [
        { checksum: "tampered-checksum", version: 1 },
        { checksum: "unknown-checksum", version: 99 },
      ],
      [
        { checksum: "unknown-checksum", version: 99 },
        { checksum: "tampered-checksum", version: 1 },
      ],
    ]) {
      expect(() => db.planMigrations?.(prefixCatalog, applied)).toThrowError(
        expect.objectContaining({ code: "UNKNOWN_APPLIED_MIGRATION" }),
      );
    }
  });
});
