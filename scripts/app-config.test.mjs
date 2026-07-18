import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { isCanonicalVitestTestScript } from "./workspace-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
}

function assertApplicationManifest(manifest, workspaceTestTarget) {
  for (const libraryField of ["main", "types", "exports", "files"]) {
    assert.equal(
      Object.hasOwn(manifest, libraryField),
      false,
      `application manifest must not define ${libraryField}`,
    );
  }
  assert.equal(manifest.scripts.typecheck, "tsc --noEmit -p tsconfig.json");
  assert.equal(
    isCanonicalVitestTestScript(manifest.scripts.test, workspaceTestTarget),
    true,
    "application tests must run Vitest against the full repository or their own workspace",
  );
}

test("web uses an application manifest instead of library exports", () => {
  const manifest = readJson("apps/web/package.json");
  assertApplicationManifest(manifest, "apps/web/src");
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
  assertApplicationManifest(manifest, "apps/server/src");
  assert.equal(manifest.scripts.build, "tsc -p tsconfig.build.json");
  assert.equal(manifest.scripts.start, "node dist/entry.js");
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
    manifest.scripts["preflight:typecheck"],
    "corepack pnpm --recursive --filter './packages/**' --if-present run build",
  );
  assert.equal(
    manifest.scripts.typecheck,
    "corepack pnpm run preflight:typecheck && corepack pnpm --recursive --if-present run typecheck",
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

test("Corepack-only shells skip pnpm's implicit bare-pnpm install check", () => {
  const workspace = readFileSync(
    path.join(root, "pnpm-workspace.yaml"),
    "utf8",
  );

  assert.match(
    workspace,
    /^verifyDepsBeforeRun: false$/mu,
    "frozen installation is an explicit gate, so lifecycle scripts must not spawn an unavailable bare pnpm binary",
  );
});

test("root Vitest resolves unbuilt server dependencies from workspace source", () => {
  const config = readFileSync(path.join(root, "vitest.config.ts"), "utf8");

  for (const [packageName, sourcePath] of [
    ["@matchsense/commentary", "packages/commentary/src/index.ts"],
    ["@matchsense/rooms", "packages/rooms/src/index.ts"],
  ]) {
    assert.match(
      config,
      new RegExp(
        `"${packageName}"\\s*:\\s*path\\.join\\(\\s*root\\s*,\\s*"${sourcePath}"\\s*,?\\s*\\)`,
        "u",
      ),
      `${packageName} must resolve without relying on prebuilt dist artifacts`,
    );
  }
});
