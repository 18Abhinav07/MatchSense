import { describe, expect, it } from "vitest";

import * as databaseModule from "./index.js";

type IntegrationGuardOptions = {
  allowDestructive: string | undefined;
  databaseUrl: string | undefined;
};

type DatabaseModuleContract = {
  assertDestructiveIntegrationTarget?: (options: IntegrationGuardOptions) => {
    databaseName: string;
    databaseUrl: string;
  };
};

const db = databaseModule as DatabaseModuleContract;

function assertTarget(options: IntegrationGuardOptions) {
  expect(db.assertDestructiveIntegrationTarget).toBeTypeOf("function");
  return db.assertDestructiveIntegrationTarget!(options);
}

describe("destructive PostgreSQL integration guard", () => {
  it.each([undefined, "false", "TRUE", "1"])(
    "rejects opt-in value %j",
    (allowDestructive) => {
      expect(() =>
        assertTarget({
          allowDestructive,
          databaseUrl: "postgresql://test.example/matchsense_integration_test",
        }),
      ).toThrowError("Destructive database integration target is not allowed");
    },
  );

  it.each([
    undefined,
    "not-a-url",
    "https://test.example/matchsense_integration_test",
    "postgresql://test.example/matchsense",
    "postgresql://test.example/matchsense_test_backup",
    "postgresql://test.example/production",
  ])("rejects unsafe database URL %j", (databaseUrl) => {
    expect(() =>
      assertTarget({ allowDestructive: "true", databaseUrl }),
    ).toThrowError("Destructive database integration target is not allowed");
  });

  it.each([
    "postgresql://test.example/matchsense_test",
    "postgres://test.example/matchsense_integration_test?sslmode=disable",
  ])("accepts explicit opt-in for dedicated test URL %s", (databaseUrl) => {
    expect(assertTarget({ allowDestructive: "true", databaseUrl })).toEqual({
      databaseName: new URL(databaseUrl).pathname.slice(1),
      databaseUrl,
    });
  });
});
