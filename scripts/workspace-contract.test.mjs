import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  isAllowedEnvironmentExampleValue,
  isForbiddenCommittedEnvironmentFile,
  scanCommittedSecrets,
} from "./secret-scan.mjs";
import {
  forbiddenInfrastructureCategory,
  isCanonicalVitestTestScript,
} from "./workspace-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const workspaces = [
  ["apps/web", "@matchsense/web"],
  ["apps/server", "@matchsense/server"],
  ["packages/contracts", "@matchsense/contracts"],
  ["packages/db", "@matchsense/db"],
  ["packages/txline-adapter", "@matchsense/txline-adapter"],
  ["packages/event-engine", "@matchsense/event-engine"],
  ["packages/moment-engine", "@matchsense/moment-engine"],
  ["packages/commentary", "@matchsense/commentary"],
  ["packages/replay", "@matchsense/replay"],
  ["packages/rooms", "@matchsense/rooms"],
  ["packages/ui", "@matchsense/ui"],
];

const requiredRootFiles = [
  ".env.example",
  ".gitignore",
  ".node-version",
  "ASSET-LICENSES.md",
  "README.md",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
];

function readText(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function childDirectories(relativePath) {
  const absolutePath = path.join(root, relativePath);

  if (!existsSync(absolutePath)) {
    return [];
  }

  return readdirSync(absolutePath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function projectFiles(relativePath = "") {
  const absolutePath = path.join(root, relativePath);

  if (!existsSync(absolutePath)) {
    return [];
  }

  return readdirSync(absolutePath, { withFileTypes: true }).flatMap((entry) => {
    if ([".git", ".worktrees", "dist", "node_modules"].includes(entry.name)) {
      return [];
    }

    const childPath = path.join(relativePath, entry.name);
    return entry.isDirectory() ? projectFiles(childPath) : [childPath];
  });
}

function dependencyEntries(manifest) {
  return [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ].flatMap((dependencies) => Object.entries(dependencies ?? {}));
}

test("the production workspace keeps its locked lean-monorepo contract", () => {
  const violations = [];
  const check = (condition, message) => {
    if (!condition) {
      violations.push(message);
    }
  };

  for (const relativePath of requiredRootFiles) {
    check(
      existsSync(path.join(root, relativePath)),
      `missing root file: ${relativePath}`,
    );
  }

  const expectedAppDirectories = workspaces
    .filter(([directory]) => directory.startsWith("apps/"))
    .map(([directory]) => path.basename(directory))
    .sort();
  const expectedPackageDirectories = workspaces
    .filter(([directory]) => directory.startsWith("packages/"))
    .map(([directory]) => path.basename(directory))
    .sort();

  assert.deepEqual(
    childDirectories("apps"),
    expectedAppDirectories,
    "apps/ must contain exactly the locked application workspaces",
  );
  assert.deepEqual(
    childDirectories("packages"),
    expectedPackageDirectories,
    "packages/ must contain exactly the locked library workspaces",
  );

  check(
    !existsSync(path.join(root, "apps/api")),
    "forbidden workspace exists: apps/api",
  );
  check(
    !existsSync(path.join(root, "apps/worker")),
    "forbidden workspace exists: apps/worker",
  );

  const manifests = [];
  for (const [directory, expectedName] of workspaces) {
    const isApplication = directory.startsWith("apps/");
    const manifestPath = path.join(directory, "package.json");
    const tsconfigPath = path.join(directory, "tsconfig.json");
    const entryPath = path.join(directory, "src/index.ts");

    check(
      existsSync(path.join(root, manifestPath)),
      `missing workspace manifest: ${manifestPath}`,
    );
    check(
      existsSync(path.join(root, tsconfigPath)),
      `missing workspace config: ${tsconfigPath}`,
    );
    check(
      existsSync(path.join(root, entryPath)),
      `missing workspace entry: ${entryPath}`,
    );

    if (existsSync(path.join(root, manifestPath))) {
      const manifest = readJson(manifestPath);
      manifests.push([manifestPath, manifest]);
      check(
        manifest.name === expectedName,
        `${manifestPath} must be named ${expectedName}`,
      );
      check(manifest.private === true, `${manifestPath} must remain private`);
      check(manifest.type === "module", `${manifestPath} must use ESM`);
      const expectedBuildScript =
        directory === "apps/web"
          ? "vite build"
          : directory === "apps/server"
            ? "tsc -p tsconfig.build.json"
            : "tsc -p tsconfig.json";
      check(
        manifest.scripts?.build === expectedBuildScript,
        `${manifestPath} needs the standard build script`,
      );
      check(
        manifest.scripts?.typecheck === "tsc --noEmit -p tsconfig.json",
        `${manifestPath} needs the standard typecheck script`,
      );
      if (isApplication) {
        check(
          isCanonicalVitestTestScript(
            manifest.scripts?.test,
            `${directory}/src`,
          ),
          `${manifestPath} needs a canonical Vitest test script scoped to its own workspace`,
        );
      }
      if (directory === "packages/rooms") {
        check(
          isCanonicalVitestTestScript(
            manifest.scripts?.test,
            "packages/rooms/test",
          ),
          `${manifestPath} must run its Rooms suite through Vitest`,
        );
      }
      if (isApplication) {
        for (const libraryField of ["main", "types", "exports", "files"]) {
          check(
            !Object.hasOwn(manifest, libraryField),
            `${manifestPath} application must not publish ${libraryField}`,
          );
        }
      } else {
        check(
          manifest.exports?.["."]?.types === "./dist/index.d.ts" &&
            manifest.exports?.["."]?.import === "./dist/index.js",
          `${manifestPath} must export its ESM entry and declarations coherently`,
        );
      }
    }

    if (existsSync(path.join(root, tsconfigPath))) {
      const tsconfig = readJson(tsconfigPath);
      check(
        tsconfig.extends === "../../tsconfig.base.json",
        `${tsconfigPath} must extend the root compiler config`,
      );
      if (isApplication) {
        check(
          tsconfig.compilerOptions?.noEmit === true,
          `${tsconfigPath} application must not emit without its app bundler`,
        );
        check(
          tsconfig.compilerOptions?.outDir === undefined,
          `${tsconfigPath} application must not target a library dist directory`,
        );
      } else {
        check(
          tsconfig.compilerOptions?.rootDir === "src",
          `${tsconfigPath} must compile from src`,
        );
        check(
          tsconfig.compilerOptions?.outDir === "dist",
          `${tsconfigPath} must emit to dist`,
        );
      }
      check(
        Array.isArray(tsconfig.include) &&
          tsconfig.include.includes("src/**/*.ts"),
        `${tsconfigPath} must include TypeScript source files`,
      );
    }
  }

  if (existsSync(path.join(root, "package.json"))) {
    const manifest = readJson("package.json");
    manifests.push(["package.json", manifest]);
    check(manifest.private === true, "root package must remain private");
    check(manifest.type === "module", "root package must use ESM");
    check(
      manifest.packageManager === "pnpm@11.13.0",
      "root package manager must be pnpm@11.13.0",
    );
    check(
      manifest.engines?.node === ">=24",
      "root Node engine must target >=24",
    );
    for (const script of [
      "test",
      "typecheck",
      "build",
      "format:check",
      "install:frozen",
    ]) {
      check(
        typeof manifest.scripts?.[script] === "string",
        `root script is missing: ${script}`,
      );
    }
    check(
      manifest.scripts?.test ===
        "corepack pnpm run preflight:db && node --test scripts/*.test.mjs && vitest run",
      "root test script must run every workspace policy test",
    );
    check(
      manifest.scripts?.["install:frozen"] ===
        "corepack pnpm install --frozen-lockfile",
      "root install:frozen script must enforce the committed lockfile",
    );
  }

  for (const [manifestPath, manifest] of manifests) {
    for (const [dependency] of dependencyEntries(manifest)) {
      const forbiddenCategory = forbiddenInfrastructureCategory(dependency);
      check(
        forbiddenCategory === null,
        `${manifestPath} contains a forbidden ${forbiddenCategory} dependency: ${dependency}`,
      );
    }
  }

  if (existsSync(path.join(root, "pnpm-workspace.yaml"))) {
    const workspaceConfig = readText("pnpm-workspace.yaml");
    const workspaceGlobs = [
      ...workspaceConfig.matchAll(/^\s*-\s*["']?([^"'\s]+)["']?\s*$/gm),
    ]
      .map((match) => match[1])
      .sort();
    assert.deepEqual(
      workspaceGlobs,
      ["apps/*", "packages/*"],
      "pnpm workspace globs must stay minimal and exact",
    );
  }

  if (existsSync(path.join(root, "tsconfig.base.json"))) {
    const compilerOptions =
      readJson("tsconfig.base.json").compilerOptions ?? {};
    check(
      compilerOptions.strict === true,
      "TypeScript strict mode must be enabled",
    );
    check(
      compilerOptions.noUncheckedIndexedAccess === true,
      "noUncheckedIndexedAccess must be enabled",
    );
    check(
      compilerOptions.exactOptionalPropertyTypes === true,
      "exactOptionalPropertyTypes must be enabled",
    );
    check(
      compilerOptions.module === "ESNext",
      "TypeScript module output must be ESM",
    );
    check(
      compilerOptions.moduleResolution === "Bundler",
      "TypeScript module resolution must be bundler-compatible",
    );
    check(
      compilerOptions.verbatimModuleSyntax === true,
      "verbatimModuleSyntax must be enabled",
    );
  }

  if (existsSync(path.join(root, ".node-version"))) {
    check(
      readText(".node-version").trim() === "24",
      ".node-version must target Node 24",
    );
  }

  if (existsSync(path.join(root, ".env.example"))) {
    const envLines = readText(".env.example")
      .split(/\r?\n/u)
      .filter(
        (line) => line.trim() !== "" && !line.trimStart().startsWith("#"),
      );
    check(
      envLines.length > 0,
      ".env.example must document the required variable names",
    );
    for (const line of envLines) {
      const separator = line.indexOf("=");
      const key = line.slice(0, separator);
      const value = line.slice(separator + 1);
      check(
        separator > 0 && /^[A-Z][A-Z0-9_]*$/u.test(key),
        `.env.example contains an invalid assignment: ${line}`,
      );
      check(
        value === "" || isAllowedEnvironmentExampleValue(key, value),
        `.env.example contains an unapproved nonempty default: ${key}`,
      );
    }
  }

  const files = projectFiles();
  const unexpectedEnvFiles = files.filter(isForbiddenCommittedEnvironmentFile);
  check(
    unexpectedEnvFiles.length === 0,
    `unexpected environment files: ${unexpectedEnvFiles.join(", ")}`,
  );

  for (const file of files) {
    for (const finding of scanCommittedSecrets(file, readText(file))) {
      check(
        false,
        `${file}:${finding.line} contains ${finding.kind}${finding.key ? ` for ${finding.key}` : ""}`,
      );
    }
  }

  assert.deepEqual(
    violations,
    [],
    `workspace contract violations:\n- ${violations.join("\n- ")}`,
  );
});
