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
  | "MIGRATION_CHECKSUM_DRIFT"
  | "MIGRATION_HISTORY_NOT_PREFIX"
  | "UNKNOWN_APPLIED_MIGRATION";

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
  const sortedCatalog = catalog.toSorted(
    (left, right) => left.version - right.version,
  );
  const catalogByVersion = new Map(
    sortedCatalog.map((migration) => [migration.version, migration]),
  );

  if (applied.some((entry) => !catalogByVersion.has(entry.version))) {
    throw new MigrationStateError("UNKNOWN_APPLIED_MIGRATION");
  }

  if (
    applied.some(
      (entry) =>
        catalogByVersion.get(entry.version)?.checksum !== entry.checksum,
    )
  ) {
    throw new MigrationStateError("MIGRATION_CHECKSUM_DRIFT");
  }

  if (
    applied.length > sortedCatalog.length ||
    applied.some(
      (entry, index) => sortedCatalog[index]?.version !== entry.version,
    )
  ) {
    throw new MigrationStateError("MIGRATION_HISTORY_NOT_PREFIX");
  }

  const pending = sortedCatalog.slice(applied.length);

  return { current: pending.length === 0, pending };
}
