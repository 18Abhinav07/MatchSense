import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

function assertApplicationManifest(manifest) {
  for (const libraryField of ["main", "types", "exports", "files"]) {
    assert.equal(
      Object.hasOwn(manifest, libraryField),
      false,
      `application manifest must not define ${libraryField}`,
    );
  }
  assert.equal(manifest.scripts.typecheck, "tsc --noEmit -p tsconfig.json");
  assert.equal(manifest.scripts.test, "vitest run");
}

test("web uses an application manifest instead of library exports", () => {
  const manifest = readJson("apps/web/package.json");
  assertApplicationManifest(manifest);
  assert.equal(manifest.scripts.build, "vite build");
});

test("web compiler accepts browser TypeScript and TSX", () => {
  const tsconfig = readJson("apps/web/tsconfig.json");

  assert.deepEqual(tsconfig.compilerOptions.lib, [
    "ES2023",
    "DOM",
    "DOM.Iterable",
  ]);
  assert.equal(tsconfig.compilerOptions.jsx, "react-jsx");
  assert.equal(tsconfig.compilerOptions.noEmit, true);
  assert.deepEqual(tsconfig.include, ["src/**/*.ts", "src/**/*.tsx"]);
});

test("server uses an application manifest instead of library exports", () => {
  const manifest = readJson("apps/server/package.json");
  assertApplicationManifest(manifest);
  assert.equal(manifest.scripts.build, "tsc -p tsconfig.build.json");
  assert.equal(manifest.scripts.start, "node dist/main.js");
});

test("server compiler uses Node runtime module resolution", () => {
  const tsconfig = readJson("apps/server/tsconfig.json");

  assert.equal(tsconfig.compilerOptions.module, "NodeNext");
  assert.equal(tsconfig.compilerOptions.moduleResolution, "NodeNext");
  assert.equal(tsconfig.compilerOptions.noEmit, true);
});

test("server has a production emit configuration", () => {
  const tsconfig = readJson("apps/server/tsconfig.build.json");

  assert.equal(tsconfig.extends, "./tsconfig.json");
  assert.equal(tsconfig.compilerOptions.noEmit, false);
  assert.equal(tsconfig.compilerOptions.rootDir, "src");
  assert.equal(tsconfig.compilerOptions.outDir, "dist");
  assert.deepEqual(tsconfig.exclude, ["src/**/*.test.ts"]);
});

test("runtime type definitions stay on the locked Node 24 major", () => {
  const rootManifest = readJson("package.json");
  const serverManifest = readJson("apps/server/package.json");

  assert.equal(rootManifest.devDependencies["@types/node"], "24.13.3");
  assert.equal(serverManifest.devDependencies["@types/node"], "24.13.3");
});

test("root orchestration runs the pinned package manager through Corepack", () => {
  const manifest = readJson("package.json");

  assert.equal(
    manifest.scripts.typecheck,
    "corepack pnpm --recursive --if-present run typecheck",
  );
  assert.equal(
    manifest.scripts.build,
    "corepack pnpm --recursive --if-present run build",
  );
  assert.equal(
    manifest.scripts["install:frozen"],
    "corepack pnpm install --frozen-lockfile",
  );
});
