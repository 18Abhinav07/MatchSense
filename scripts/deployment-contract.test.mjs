import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  forbiddenRuntimeInstallCommands,
  runtimeAptPackages,
  runtimeStageContents,
} from "./dockerfile-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function workflowJob(workflow, jobName) {
  const marker = `  ${jobName}:\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `CI job is missing: ${jobName}`);

  const remainder = workflow.slice(start + marker.length);
  const nextJob = remainder.search(/^  [A-Za-z0-9_-]+:\n/mu);
  return nextJob === -1 ? remainder : remainder.slice(0, nextJob);
}

test("production Dockerfile is immutable, portable, and least privileged", () => {
  assert.equal(existsSync(path.join(root, "Dockerfile")), true);
  const dockerfile = read("Dockerfile");
  const runtimeStage = runtimeStageContents(dockerfile);

  assert.deepEqual(
    [...dockerfile.matchAll(/^FROM .*$/gmu)].map((match) => match[0]),
    [
      "FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS builder",
      "FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime",
    ],
    "both stages must use the exact immutable Node base",
  );
  assert.match(dockerfile, /corepack prepare pnpm@11\.13\.0 --activate/u);
  assert.match(dockerfile, /pnpm install --frozen-lockfile/u);
  assert.match(dockerfile, /pnpm run build/u);
  assert.match(
    dockerfile,
    /pnpm --filter @matchsense\/server deploy --prod --legacy \/opt\/deploy\/server/u,
  );
  assert.match(
    dockerfile,
    /COPY --from=builder \/opt\/deploy\/server \/app\/server/u,
  );
  assert.match(
    dockerfile,
    /COPY --from=builder \/workspace\/apps\/web\/dist \/app\/web\/dist/u,
  );
  assert.match(dockerfile, /^ENV NODE_ENV=production$/mu);
  assert.match(dockerfile, /^ENV PORT=8080$/mu);
  assert.deepEqual(
    [...runtimeStage.matchAll(/^USER\s+(.+)$/gmu)].map((match) => match[1]),
    ["node"],
    "the runtime must drop privileges once and never switch back to root",
  );
  assert.match(dockerfile, /^EXPOSE 8080$/mu);
  assert.doesNotMatch(
    dockerfile,
    /^HEALTHCHECK /mu,
    "the shared image must not force an HTTP healthcheck on worker roles",
  );
  assert.match(dockerfile, /^ENV ROLE=api$/mu);
  assert.match(dockerfile, /^CMD \["node", "dist\/entry\.js"\]$/mu);
  assert.deepEqual(
    runtimeAptPackages(dockerfile),
    ["ffmpeg"],
    "ffmpeg is required for transcoding; no unrelated runtime package is allowed",
  );
  assert.deepEqual(
    forbiddenRuntimeInstallCommands(dockerfile),
    [],
    "the runtime must not use alternate installers or package-download commands",
  );
  assert.match(
    runtimeStage,
    /RUN apt-get update \\\r?\n\s+&& apt-get install -y --no-install-recommends ffmpeg \\\r?\n\s+&& rm -rf \/var\/lib\/apt\/lists\/\*/u,
    "runtime apt metadata must be removed in the same layer as the ffmpeg install",
  );
  assert.equal(
    [...runtimeStage.matchAll(/\bapt-get install\b/gu)].length,
    1,
    "the runtime stage must not hide a second package install",
  );
});

test("Docker context excludes local, generated, and secret-bearing files", () => {
  const dockerignore = read(".dockerignore");
  const ignored = new Set(
    dockerignore
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#")),
  );

  for (const expected of [
    ".git",
    ".env*",
    "**/node_modules",
    "**/dist",
    "coverage",
  ]) {
    assert.equal(ignored.has(expected), true, `${expected} must be ignored`);
  }
  assert.doesNotMatch(dockerignore, /^!.*\.env/mu);

  const npmignore = read("apps/server/.npmignore");
  for (const forbidden of ["src", "*.test.*", "tsconfig*.json"]) {
    assert.match(
      npmignore,
      new RegExp(`^${forbidden.replaceAll("*", "\\*")}$`, "mu"),
    );
  }
});

test("root exposes real deployment verification commands", () => {
  const manifest = readJson("package.json");

  assert.equal(
    manifest.scripts?.["test:container"],
    "node scripts/container-smoke.mjs",
  );
  assert.equal(
    manifest.scripts?.["asset:check"],
    "node scripts/asset-rights.mjs",
  );
});

test("Railway config keeps role-specific process settings out of a shared repository config", () => {
  assert.equal(existsSync(path.join(root, "railway.json")), true);
  const railway = readJson("railway.json");

  assert.equal(railway.$schema, "https://railway.com/railway.schema.json");
  assert.deepEqual(railway.build, {
    builder: "DOCKERFILE",
    dockerfilePath: "Dockerfile",
  });
  assert.equal(Object.hasOwn(railway.deploy ?? {}, "startCommand"), false);
  assert.equal(railway.deploy?.numReplicas, 1);
  assert.equal(railway.deploy?.multiRegionConfig, null);
  assert.equal(railway.deploy?.sleepApplication, false);
  assert.equal(Object.hasOwn(railway.deploy ?? {}, "healthcheckPath"), false);
  assert.equal(
    Object.hasOwn(railway.deploy ?? {}, "healthcheckTimeout"),
    false,
  );
  assert.equal(railway.deploy?.overlapSeconds, 0);
  assert.equal(railway.deploy?.drainingSeconds, 15);
  assert.equal(railway.deploy?.restartPolicyType, "ON_FAILURE");
  assert.equal(railway.deploy?.restartPolicyMaxRetries, 10);
  assert.equal(existsSync(path.join(root, "railway.worker.json")), false);

  const readme = read("README.md");
  assert.match(readme, /one API replica/iu);
  assert.match(readme, /collector worker\s+service/iu);
  for (const variable of [
    "DATABASE_URL",
    "TXLINE_API_TOKEN",
    "VAPID_SUBJECT",
    "VAPID_PUBLIC_KEY",
    "VAPID_PRIVATE_KEY",
    "PUSH_SUBSCRIPTION_ENCRYPTION_SECRET",
    "GROQ_API_KEY",
    "GEMINI_API_KEY",
  ]) {
    assert.match(readme, new RegExp(`\\b${variable}\\b`, "u"));
  }
});

test("container smoke uses isolated pinned infrastructure and validates the runtime contract", () => {
  const smoke = read("scripts/container-smoke.mjs");

  assert.match(
    smoke,
    /postgres:17\.5-alpine@sha256:6567bca8d7bc8c82c5922425a0baee57be8402df92bae5eacad5f01ae9544daa/u,
  );
  assert.match(smoke, /matchsense_container_test/u);
  assert.match(smoke, /assertDestructiveIntegrationTarget/u);
  assert.match(smoke, /runLabeledCommand/u);
  assert.doesNotMatch(smoke, /node:child_process/u);
  for (const stage of [
    "build production image",
    "create smoke network",
    "start PostgreSQL",
    "wait for PostgreSQL",
    "apply database migrations",
    "verify database migrations",
    "start application",
    "inspect application user",
    "inspect runtime user",
    "probe production image",
    "inspect published port",
    "stop application gracefully",
    "inspect application exit",
    "cleanup: stop application",
    "cleanup: remove application",
    "cleanup: remove PostgreSQL",
    "cleanup: remove network",
    "cleanup: remove image",
  ]) {
    assert.equal(
      smoke.includes(`"${stage}"`),
      true,
      `${stage} must be labeled`,
    );
  }
  assert.doesNotMatch(
    smoke,
    /\bdocker\(\s*"(?:network|run|exec|inspect|port|stop|rm|image)"/u,
  );
  assert.match(smoke, /sensitiveValues/u);
  assert.match(smoke, /127\.0\.0\.1::8080/u);
  assert.match(smoke, /health\/live/u);
  assert.match(smoke, /health\/ready/u);
  assert.match(
    smoke,
    /"start application"[\s\S]+?ROLE=api[\s\S]+?"--publish"/u,
  );
  assert.match(smoke, /node_modules\/@matchsense\/db\/dist\/cli\.js/u);
  assert.match(
    smoke,
    /Database migrations applied: \\d\+; current version: \\d\+/u,
  );
  assert.match(smoke, /Database migrations are current/u);
  assert.match(smoke, /\/app\/web\/dist\/index\.html/u);
  assert.match(smoke, /require\.resolve\(['"]vitest['"]\)/u);
  assert.match(smoke, /\/app\/server\/src/u);
  assert.match(smoke, /matches\/fixture-1\/moments\/moment-1/u);
  assert.match(smoke, /api\/not-a-route/u);
  assert.match(smoke, /cache-control/iu);
  assert.match(smoke, /"--timeout"/u);
  assert.doesNotMatch(smoke, /"--time"/u);
  assert.match(smoke, /finally/u);
  assert.doesNotMatch(smoke, /console\.(?:log|error).*password/iu);
});

test("CI pins supply-chain actions and proves quality before container runtime", () => {
  const workflow = read(".github/workflows/ci.yml");
  const secretScanJob = workflowJob(workflow, "secret-scan");
  const qualityJob = workflowJob(workflow, "quality");
  const dockerJob = workflowJob(workflow, "docker");

  assert.match(workflow, /^permissions:\n  contents: read$/mu);
  assert.match(
    workflow,
    /actions\/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0/u,
  );
  assert.match(workflow, /fetch-depth: 0/u);
  assert.match(
    workflow,
    /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/u,
  );
  assert.match(workflow, /node-version: 24\.18\.0/u);
  assert.match(
    secretScanJob,
    /gitleaks\/gitleaks-action@e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e/u,
  );
  assert.match(
    secretScanJob,
    /actions\/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0/u,
  );
  assert.match(secretScanJob, /fetch-depth: 0/u);
  assert.equal(
    secretScanJob.indexOf("actions/checkout@") <
      secretScanJob.indexOf("gitleaks/gitleaks-action@"),
    true,
    "the isolated secret scan must check out full history before gitleaks",
  );
  assert.doesNotMatch(
    secretScanJob,
    /setup-node|corepack|\b(?:npm|pnpm|yarn)\b/iu,
    "the secret-scan job must not install dependencies or execute project code",
  );
  assert.match(
    qualityJob,
    /^\s+needs: secret-scan$/mu,
    "quality must wait for the isolated secret scan",
  );
  assert.doesNotMatch(qualityJob, /gitleaks/iu);
  assert.match(workflow, /corepack prepare pnpm@11\.13\.0 --activate/u);
  assert.match(workflow, /pnpm install --frozen-lockfile/u);
  for (const command of [
    "pnpm format:check",
    "pnpm test",
    "pnpm typecheck",
    "pnpm build",
    "pnpm asset:check",
    "pnpm test:integration",
  ]) {
    assert.equal(workflow.includes(command), true, `${command} must run in CI`);
  }
  const installIndex = qualityJob.indexOf(
    "run: pnpm install --frozen-lockfile",
  );
  const formatIndex = qualityJob.indexOf("run: pnpm format:check");
  assert.equal(
    installIndex < formatIndex,
    true,
    "quality must install before running the repository format check",
  );
  assert.match(
    workflow,
    /postgres:17\.5-alpine@sha256:6567bca8d7bc8c82c5922425a0baee57be8402df92bae5eacad5f01ae9544daa/u,
  );
  assert.match(workflow, /POSTGRES_DB: matchsense_integration_test/u);
  assert.match(workflow, /MATCHSENSE_ALLOW_DESTRUCTIVE_DB_TESTS: "true"/u);
  assert.match(workflow, /TEST_DATABASE_URL:/u);
  assert.match(
    dockerJob,
    /^\s+needs: \[secret-scan, quality\]$/mu,
    "container verification must require both independent CI gates",
  );
  assert.match(workflow, /pnpm test:container/u);
  assert.doesNotMatch(workflow, /redis|bullmq|minio|s3/iu);
});
