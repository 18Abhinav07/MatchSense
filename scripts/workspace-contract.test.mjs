import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

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
  ["packages/ui", "@matchsense/ui"],
];

const requiredRootFiles = [
  ".env.example",
  ".gitignore",
  ".node-version",
  "ASSET-LICENSES.md",
  "README.md",
  "package.json",
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
    if ([".git", "dist", "node_modules"].includes(entry.name)) {
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
      check(
        manifest.scripts?.build === "tsc -p tsconfig.json",
        `${manifestPath} needs the standard build script`,
      );
      check(
        manifest.scripts?.typecheck === "tsc --noEmit -p tsconfig.json",
        `${manifestPath} needs the standard typecheck script`,
      );
      check(
        manifest.exports?.["."]?.types === "./dist/index.d.ts" &&
          manifest.exports?.["."]?.import === "./dist/index.js",
        `${manifestPath} must export its ESM entry and declarations coherently`,
      );
    }

    if (existsSync(path.join(root, tsconfigPath))) {
      const tsconfig = readJson(tsconfigPath);
      check(
        tsconfig.extends === "../../tsconfig.base.json",
        `${tsconfigPath} must extend the root compiler config`,
      );
      check(
        tsconfig.compilerOptions?.rootDir === "src",
        `${tsconfigPath} must compile from src`,
      );
      check(
        tsconfig.compilerOptions?.outDir === "dist",
        `${tsconfigPath} must emit to dist`,
      );
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
    for (const script of ["test", "typecheck", "build", "format:check"]) {
      check(
        typeof manifest.scripts?.[script] === "string",
        `root script is missing: ${script}`,
      );
    }
  }

  for (const [manifestPath, manifest] of manifests) {
    for (const [dependency, version] of dependencyEntries(manifest)) {
      const dependencyString = `${dependency}@${version}`.toLowerCase();
      check(
        !dependencyString.includes("redis"),
        `${manifestPath} contains a Redis dependency: ${dependency}`,
      );
      check(
        !dependencyString.includes("bullmq"),
        `${manifestPath} contains a BullMQ dependency: ${dependency}`,
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
      check(
        /^[A-Z][A-Z0-9_]*=$/u.test(line),
        `.env.example values must be empty: ${line.split("=", 1)[0]}`,
      );
    }
  }

  const files = projectFiles();
  const unexpectedEnvFiles = files.filter(
    (file) =>
      path.basename(file).startsWith(".env") &&
      path.basename(file) !== ".env.example",
  );
  check(
    unexpectedEnvFiles.length === 0,
    `unexpected environment files: ${unexpectedEnvFiles.join(", ")}`,
  );

  const privateKeyMarker = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
  const secretAssignment =
    /^\s*(?:export\s+)?[A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*(\S.*)$/gmu;
  for (const file of files) {
    const contents = readText(file);
    check(
      !contents.includes(privateKeyMarker),
      `${file} contains private key material`,
    );
    check(
      !secretAssignment.test(contents),
      `${file} contains a non-empty secret assignment`,
    );
    secretAssignment.lastIndex = 0;
  }

  assert.deepEqual(
    violations,
    [],
    `workspace contract violations:\n- ${violations.join("\n- ")}`,
  );
});
