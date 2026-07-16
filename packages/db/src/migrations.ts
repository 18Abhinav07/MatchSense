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
  "MIGRATION_CHECKSUM_DRIFT" | "UNKNOWN_APPLIED_MIGRATION";

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
]);

export function planMigrations(
  catalog: readonly MigrationDefinition[],
  applied: readonly AppliedMigration[],
) {
  const catalogByVersion = new Map(
    catalog.map((migration) => [migration.version, migration]),
  );
  const appliedVersions = new Set<number>();

  for (const ledgerEntry of applied) {
    const expectedMigration = catalogByVersion.get(ledgerEntry.version);

    if (!expectedMigration) {
      throw new MigrationStateError("UNKNOWN_APPLIED_MIGRATION");
    }

    if (expectedMigration.checksum !== ledgerEntry.checksum) {
      throw new MigrationStateError("MIGRATION_CHECKSUM_DRIFT");
    }

    appliedVersions.add(ledgerEntry.version);
  }

  const pending = catalog
    .filter((migration) => !appliedVersions.has(migration.version))
    .toSorted((left, right) => left.version - right.version);

  return { current: pending.length === 0, pending };
}
