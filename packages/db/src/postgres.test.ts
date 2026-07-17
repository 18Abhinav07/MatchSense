import { describe, expect, it, vi } from "vitest";

import * as databaseModule from "./index.js";

type UnsafeQuery = (
  query: string,
  parameters?: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>;

interface TestPostgresClient {
  begin<T>(
    work: (transaction: { unsafe: UnsafeQuery }) => Promise<T>,
  ): Promise<T>;
  end(options: { timeout: number }): Promise<void>;
  unsafe: UnsafeQuery;
}

type DatabaseModuleContract = {
  createApplicationDatabase?: (client: TestPostgresClient) => {
    check(): Promise<{
      databaseReachable: boolean;
      migrationsCurrent: boolean;
    }>;
    close(): Promise<void>;
    commentaryArtifacts: { get(input: unknown): Promise<unknown> };
    fixtureTruth: { get(input: unknown): Promise<unknown> };
    outbox: { hasConsumerReceipt(input: unknown): Promise<boolean> };
    sourceState: { getCursor(input: unknown): Promise<unknown> };
  };
  createPostgresDatabase?: (databaseUrl: string) => {
    check(): Promise<{
      databaseReachable: boolean;
      migrationsCurrent: boolean;
    }>;
    close(): Promise<void>;
    migrate(): Promise<unknown>;
  };
  createPostgresMigrationStore?: (client: TestPostgresClient) => {
    close(): Promise<void>;
    inspectAppliedMigrations(): Promise<unknown>;
    ping(): Promise<void>;
    withMigrationLock<T>(
      work: (transaction: {
        ensureLedger(): Promise<void>;
        executeMigration(migration: {
          checksum: string;
          description: string;
          sql: string;
          version: number;
        }): Promise<void>;
        readAppliedMigrations(): Promise<unknown>;
        recordMigration(migration: {
          checksum: string;
          description: string;
          sql: string;
          version: number;
        }): Promise<void>;
      }) => Promise<T>,
    ): Promise<T>;
  };
};

const db = databaseModule as DatabaseModuleContract;

function fakeClient(options: { ledgerExists?: boolean } = {}) {
  const queries: { parameters: readonly unknown[]; query: string }[] = [];
  const unsafe = vi.fn<UnsafeQuery>(async (query, parameters = []) => {
    queries.push({ parameters, query });

    if (query.includes("to_regclass")) {
      return [{ ledger_exists: options.ledgerExists ?? false }];
    }

    if (query.includes("SELECT version, checksum")) {
      return [{ checksum: "checksum-one", version: 1 }];
    }

    return [];
  });
  const transaction = { unsafe };
  const begin = vi.fn(async <T>(work: (tx: typeof transaction) => Promise<T>) =>
    work(transaction),
  );
  const end = vi.fn(async () => undefined);

  return {
    client: { begin, end, unsafe } satisfies TestPostgresClient,
    end,
    queries,
  };
}

describe("PostgreSQL migration store", () => {
  it("exports the production database factory", () => {
    expect(db.createPostgresDatabase).toBeTypeOf("function");
  });

  it("builds migrations and all repositories over one shared application client", async () => {
    expect(db.createApplicationDatabase).toBeTypeOf("function");
    const fake = fakeClient({ ledgerExists: false });
    const database = db.createApplicationDatabase?.(fake.client);

    expect(database?.fixtureTruth).toBeDefined();
    expect(database?.commentaryArtifacts).toBeDefined();
    expect(database?.outbox).toBeDefined();
    expect(database?.sourceState).toBeDefined();
    await expect(database?.check()).resolves.toEqual({
      databaseReachable: true,
      migrationsCurrent: false,
    });
    await expect(
      database?.fixtureTruth.get({ fixtureId: "fx-1", mode: "demo" }),
    ).resolves.toBeNull();
    await expect(
      database?.sourceState.getCursor({
        mode: "live",
        source: "txline",
        streamKey: "scores:mainnet",
      }),
    ).resolves.toBeNull();
    await database?.close();
    await database?.close();

    expect(fake.queries.map(({ query }) => query)).toEqual([
      "SELECT 1;",
      expect.stringContaining("to_regclass"),
      expect.stringContaining("FROM matchsense.fixtures"),
      expect.stringContaining("FROM matchsense.source_cursors"),
    ]);
    expect(fake.end).toHaveBeenCalledTimes(1);
  });

  it("runs ledger and migration writes inside the advisory-locked transaction", async () => {
    expect(db.createPostgresMigrationStore).toBeTypeOf("function");
    const fake = fakeClient();
    const store = db.createPostgresMigrationStore?.(fake.client);
    const migration = {
      checksum: "checksum-two",
      description: "two",
      sql: "SELECT 2;",
      version: 2,
    };

    await store?.withMigrationLock(async (transaction) => {
      await transaction.ensureLedger();
      await transaction.readAppliedMigrations();
      await transaction.executeMigration(migration);
      await transaction.recordMigration(migration);
    });

    expect(fake.queries.map(({ query }) => query)).toEqual([
      expect.stringContaining("pg_advisory_xact_lock"),
      expect.stringContaining("CREATE TABLE IF NOT EXISTS"),
      expect.stringContaining("SELECT version, checksum"),
      "SELECT 2;",
      expect.stringContaining("INSERT INTO"),
    ]);
    expect(fake.queries.at(-1)?.parameters).toEqual([2, "checksum-two"]);
  });

  it("reports a missing ledger as pending without creating it", async () => {
    expect(db.createPostgresMigrationStore).toBeTypeOf("function");
    const fake = fakeClient({ ledgerExists: false });
    const store = db.createPostgresMigrationStore?.(fake.client);

    await expect(store?.inspectAppliedMigrations()).resolves.toEqual({
      ledgerExists: false,
    });
    expect(fake.queries).toHaveLength(1);
    expect(fake.queries[0]?.query).toContain("to_regclass");
  });

  it("closes postgres with a bounded drain timeout", async () => {
    expect(db.createPostgresMigrationStore).toBeTypeOf("function");
    const fake = fakeClient();
    const store = db.createPostgresMigrationStore?.(fake.client);

    await store?.close();

    expect(fake.end).toHaveBeenCalledExactlyOnceWith({ timeout: 5 });
  });
});
