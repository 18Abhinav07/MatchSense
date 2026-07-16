import { describe, expect, it, vi } from "vitest";

import * as databaseModule from "./index.js";

interface TestMigration {
  checksum: string;
  description: string;
  sql: string;
  version: number;
}

interface TestTransaction {
  ensureLedger(): Promise<void>;
  executeMigration(migration: TestMigration): Promise<void>;
  readAppliedMigrations(): Promise<readonly TestLedgerEntry[]>;
  recordMigration(migration: TestMigration): Promise<void>;
}

interface TestLedgerEntry {
  checksum: string;
  version: number;
}

interface TestStore {
  close(): Promise<void>;
  inspectAppliedMigrations(): Promise<
    | { ledgerExists: false }
    | { applied: readonly TestLedgerEntry[]; ledgerExists: true }
  >;
  ping(): Promise<void>;
  withMigrationLock<T>(
    work: (transaction: TestTransaction) => Promise<T>,
  ): Promise<T>;
}

type DatabaseRuntimeContract = {
  check(): Promise<{
    databaseReachable: boolean;
    migrationsCurrent: boolean;
  }>;
  checkMigrationsCurrent(): Promise<boolean>;
  close(): Promise<void>;
  migrate(): Promise<{
    appliedVersions: readonly number[];
    currentVersion: number;
  }>;
};

type DatabaseModuleContract = {
  createDatabaseRuntime?: (options: {
    catalog?: readonly TestMigration[];
    store: TestStore;
  }) => DatabaseRuntimeContract;
};

const db = databaseModule as DatabaseModuleContract;

function createTestStore(initialApplied: readonly TestLedgerEntry[] = []) {
  let applied = [...initialApplied];
  let ledgerExists = initialApplied.length > 0;
  const executed: number[] = [];
  const lockEntries: string[] = [];
  const close = vi.fn(async () => undefined);
  const ping = vi.fn(async () => undefined);

  const transaction: TestTransaction = {
    ensureLedger: async () => {
      ledgerExists = true;
    },
    executeMigration: async (migration) => {
      executed.push(migration.version);
    },
    readAppliedMigrations: async () => applied,
    recordMigration: async (migration) => {
      applied.push({
        checksum: migration.checksum,
        version: migration.version,
      });
    },
  };

  const store: TestStore = {
    close,
    inspectAppliedMigrations: async () =>
      ledgerExists ? { applied, ledgerExists: true } : { ledgerExists: false },
    ping,
    withMigrationLock: async (work) => {
      lockEntries.push("entered");
      return work(transaction);
    },
  };

  return { close, executed, lockEntries, ping, store };
}

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

describe("database runtime", () => {
  it("applies pending migrations in one locked run and repeats as a no-op", async () => {
    expect(db.createDatabaseRuntime).toBeTypeOf("function");
    const testStore = createTestStore();
    const runtime = db.createDatabaseRuntime?.({
      catalog,
      store: testStore.store,
    });

    await expect(runtime?.migrate()).resolves.toEqual({
      appliedVersions: [1, 2],
      currentVersion: 2,
    });
    await expect(runtime?.migrate()).resolves.toEqual({
      appliedVersions: [],
      currentVersion: 2,
    });
    expect(testStore.executed).toEqual([1, 2]);
    expect(testStore.lockEntries).toEqual(["entered", "entered"]);
  });

  it("reports pending before migration and current after migration", async () => {
    expect(db.createDatabaseRuntime).toBeTypeOf("function");
    const testStore = createTestStore();
    const runtime = db.createDatabaseRuntime?.({
      catalog,
      store: testStore.store,
    });

    await expect(runtime?.checkMigrationsCurrent()).resolves.toBe(false);
    await expect(runtime?.check()).resolves.toEqual({
      databaseReachable: true,
      migrationsCurrent: false,
    });
    await runtime?.migrate();
    await expect(runtime?.checkMigrationsCurrent()).resolves.toBe(true);
    await expect(runtime?.check()).resolves.toEqual({
      databaseReachable: true,
      migrationsCurrent: true,
    });
    expect(testStore.ping).toHaveBeenCalledTimes(4);
  });

  it("keeps a reachable database not ready when migration state is invalid", async () => {
    expect(db.createDatabaseRuntime).toBeTypeOf("function");
    const testStore = createTestStore([{ checksum: "unknown", version: 99 }]);
    const runtime = db.createDatabaseRuntime?.({
      catalog,
      store: testStore.store,
    });

    await expect(runtime?.check()).resolves.toEqual({
      databaseReachable: true,
      migrationsCurrent: false,
    });
  });

  it("reports an unreachable database without exposing the connection failure", async () => {
    expect(db.createDatabaseRuntime).toBeTypeOf("function");
    const testStore = createTestStore();
    testStore.ping.mockRejectedValueOnce(
      new Error("postgresql://user:secret@private.example/matchsense"),
    );
    const runtime = db.createDatabaseRuntime?.({
      catalog,
      store: testStore.store,
    });

    await expect(runtime?.check()).resolves.toEqual({
      databaseReachable: false,
      migrationsCurrent: false,
    });
  });

  it("closes the store exactly once", async () => {
    expect(db.createDatabaseRuntime).toBeTypeOf("function");
    const testStore = createTestStore();
    const runtime = db.createDatabaseRuntime?.({
      catalog,
      store: testStore.store,
    });

    await runtime?.close();
    await runtime?.close();

    expect(testStore.close).toHaveBeenCalledTimes(1);
  });
});
