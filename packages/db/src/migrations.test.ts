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
    expect(db.migrationCatalog).toHaveLength(1);

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
