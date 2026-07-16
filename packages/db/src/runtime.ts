import {
  migrationCatalog,
  MigrationStateError,
  planMigrations,
  type AppliedMigration,
  type MigrationDefinition,
} from "./migrations.js";

export interface MigrationTransaction {
  ensureLedger(): Promise<void>;
  executeMigration(migration: MigrationDefinition): Promise<void>;
  readAppliedMigrations(): Promise<readonly AppliedMigration[]>;
  recordMigration(migration: MigrationDefinition): Promise<void>;
}

export type AppliedMigrationInspection =
  | { ledgerExists: false }
  | { applied: readonly AppliedMigration[]; ledgerExists: true };

export interface MigrationStore {
  close(): Promise<void>;
  inspectAppliedMigrations(): Promise<AppliedMigrationInspection>;
  ping(): Promise<void>;
  withMigrationLock<T>(
    work: (transaction: MigrationTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface DatabaseReadiness {
  databaseReachable: boolean;
  migrationsCurrent: boolean;
}

export interface DatabaseRuntime {
  check(): Promise<DatabaseReadiness>;
  checkMigrationsCurrent(): Promise<boolean>;
  close(): Promise<void>;
  migrate(): Promise<{
    appliedVersions: readonly number[];
    currentVersion: number;
  }>;
}

function latestCatalogVersion(catalog: readonly MigrationDefinition[]) {
  return catalog.reduce(
    (latest, migration) => Math.max(latest, migration.version),
    0,
  );
}

export function createDatabaseRuntime(options: {
  catalog?: readonly MigrationDefinition[];
  store: MigrationStore;
}): DatabaseRuntime {
  const catalog = options.catalog ?? migrationCatalog;
  let closePromise: Promise<void> | undefined;

  const inspectCurrent = async () => {
    const inspection = await options.store.inspectAppliedMigrations();

    if (!inspection.ledgerExists) {
      return false;
    }

    return planMigrations(catalog, inspection.applied).current;
  };

  return {
    check: async () => {
      try {
        await options.store.ping();
      } catch {
        return {
          databaseReachable: false,
          migrationsCurrent: false,
        };
      }

      try {
        return {
          databaseReachable: true,
          migrationsCurrent: await inspectCurrent(),
        };
      } catch (error) {
        if (error instanceof MigrationStateError) {
          return {
            databaseReachable: true,
            migrationsCurrent: false,
          };
        }

        return {
          databaseReachable: false,
          migrationsCurrent: false,
        };
      }
    },
    checkMigrationsCurrent: async () => {
      await options.store.ping();
      return inspectCurrent();
    },
    close: async () => {
      closePromise ??= options.store.close();
      await closePromise;
    },
    migrate: async () =>
      options.store.withMigrationLock(async (transaction) => {
        await transaction.ensureLedger();
        const applied = await transaction.readAppliedMigrations();
        const plan = planMigrations(catalog, applied);
        const appliedVersions: number[] = [];

        for (const migration of plan.pending) {
          await transaction.executeMigration(migration);
          await transaction.recordMigration(migration);
          appliedVersions.push(migration.version);
        }

        return {
          appliedVersions,
          currentVersion: latestCatalogVersion(catalog),
        };
      }),
  };
}
