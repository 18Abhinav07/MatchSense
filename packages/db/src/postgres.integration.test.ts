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
  type DatabaseRuntime,
} from "./index.js";

const { databaseUrl } = assertDestructiveIntegrationTarget({
  allowDestructive: process.env.MATCHSENSE_ALLOW_DESTRUCTIVE_DB_TESTS,
  databaseUrl: process.env.TEST_DATABASE_URL,
});

const admin = postgres(databaseUrl, { max: 1 });
const runtimes = new Set<DatabaseRuntime>();

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
