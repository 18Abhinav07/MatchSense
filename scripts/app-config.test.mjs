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

  assert.equal(manifest.scripts.build, "tsc --noEmit -p tsconfig.json");
  assert.equal(manifest.scripts.typecheck, "tsc --noEmit -p tsconfig.json");
}

test("web uses an application manifest instead of library exports", () => {
  assertApplicationManifest(readJson("apps/web/package.json"));
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
  assertApplicationManifest(readJson("apps/server/package.json"));
});

test("server compiler uses Node runtime module resolution", () => {
  const tsconfig = readJson("apps/server/tsconfig.json");

  assert.equal(tsconfig.compilerOptions.module, "NodeNext");
  assert.equal(tsconfig.compilerOptions.moduleResolution, "NodeNext");
  assert.equal(tsconfig.compilerOptions.noEmit, true);
});
