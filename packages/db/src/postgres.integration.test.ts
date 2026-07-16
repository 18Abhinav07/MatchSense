import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  createPostgresDatabase,
  migrationCatalog,
  runDatabaseCli,
} from "./index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL is required for PostgreSQL integration tests",
  );
}

const admin = postgres(databaseUrl, { max: 1 });

beforeAll(async () => {
  await admin.unsafe("SELECT 1;");
});

beforeEach(async () => {
  await admin.unsafe("DROP SCHEMA IF EXISTS matchsense CASCADE;");
  await admin.unsafe(
    "DROP TABLE IF EXISTS public.matchsense_schema_migrations;",
  );
});

afterAll(async () => {
  await admin.end({ timeout: 5 });
});

describe.sequential("real PostgreSQL migration runtime", () => {
  it("reports a fresh database as reachable but pending before migration", async () => {
    const runtime = createPostgresDatabase(databaseUrl);

    await expect(runtime.check()).resolves.toEqual({
      databaseReachable: true,
      migrationsCurrent: false,
    });
    await expect(runtime.checkMigrationsCurrent()).resolves.toBe(false);
    await runtime.close();
  });

  it("migrates a fresh database transactionally and repeats as a no-op", async () => {
    const runtime = createPostgresDatabase(databaseUrl);

    await expect(runtime.migrate()).resolves.toEqual({
      appliedVersions: [1],
      currentVersion: 1,
    });
    await expect(runtime.check()).resolves.toEqual({
      databaseReachable: true,
      migrationsCurrent: true,
    });
    await expect(runtime.migrate()).resolves.toEqual({
      appliedVersions: [],
      currentVersion: 1,
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
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      checksum: migrationCatalog[0]?.checksum,
      version: 1,
    });
    expect(ledger[0]?.applied_at).toBeInstanceOf(Date);
    await runtime.close();
  });

  it("rejects checksum drift instead of accepting a changed migration", async () => {
    const runtime = createPostgresDatabase(databaseUrl);
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
    await runtime.close();
  });

  it("rejects a ledger version absent from the catalog", async () => {
    const runtime = createPostgresDatabase(databaseUrl);
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
    await runtime.close();
  });

  it("returns a generic nonzero CLI result for an unreachable database", async () => {
    const writeError = vi.fn();
    const writeOutput = vi.fn();

    await expect(
      runDatabaseCli({
        args: ["check"],
        createRuntime: createPostgresDatabase,
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
