import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readManifest(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

test("the database package pins the approved PostgreSQL runtime", () => {
  const databaseManifest = readManifest("packages/db/package.json");
  const serverManifest = readManifest("apps/server/package.json");

  assert.equal(databaseManifest.dependencies?.postgres, "3.4.9");
  assert.equal(serverManifest.dependencies?.["@matchsense/db"], "workspace:*");
});

test("database commands are real explicit package entrypoints", () => {
  const rootManifest = readManifest("package.json");
  const databaseManifest = readManifest("packages/db/package.json");

  assert.equal(
    rootManifest.scripts?.["db:migrate"],
    "corepack pnpm --filter @matchsense/db build && node packages/db/dist/cli.js migrate",
  );
  assert.equal(
    rootManifest.scripts?.["db:check"],
    "corepack pnpm --filter @matchsense/db build && node packages/db/dist/cli.js check",
  );
  assert.equal(
    rootManifest.scripts?.["test:integration"],
    "corepack pnpm --filter @matchsense/db run test:integration",
  );
  assert.equal(
    databaseManifest.scripts?.["db:migrate"],
    "node dist/cli.js migrate",
  );
  assert.equal(
    databaseManifest.scripts?.["db:check"],
    "node dist/cli.js check",
  );
  assert.equal(
    databaseManifest.scripts?.["test:integration"],
    "vitest run --config vitest.integration.config.ts",
  );
});

test("root verification prebuilds the internal DB package from a fresh clone", () => {
  const rootManifest = readManifest("package.json");

  assert.equal(
    rootManifest.scripts?.["preflight:db"],
    "corepack pnpm --filter @matchsense/db build",
  );
  assert.equal(
    rootManifest.scripts?.test,
    "corepack pnpm run preflight:db && node --test scripts/*.test.mjs && vitest run",
  );
  assert.equal(
    rootManifest.scripts?.typecheck,
    "corepack pnpm run preflight:db && corepack pnpm --recursive --if-present run typecheck",
  );
});

test("the postgres-js boundary uses an explicit adapter instead of a double cast", () => {
  const source = readFileSync(
    path.join(root, "packages/db/src/postgres.ts"),
    "utf8",
  );

  assert.match(source, /function adaptPostgresClient/u);
  assert.doesNotMatch(source, /as\s+unknown\s+as\s+PostgresClient/u);
});
