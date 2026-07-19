import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { runLabeledCommand } from "./safe-command-runner.mjs";

const postgresImage =
  "postgres:17.5-alpine@sha256:6567bca8d7bc8c82c5922425a0baee57be8402df92bae5eacad5f01ae9544daa";
const databaseName =
  process.env.MATCHSENSE_CONTAINER_TEST_DATABASE ?? "matchsense_container_test";
const runSuffix = randomUUID().replaceAll("-", "").slice(0, 12);
const networkName = `matchsense-smoke-${runSuffix}`;
const postgresName = `matchsense-postgres-${runSuffix}`;
const appName = `matchsense-app-${runSuffix}`;
const generatedImage = `matchsense-container-smoke:${runSuffix}`;
const imageName = process.env.MATCHSENSE_CONTAINER_IMAGE ?? generatedImage;
const ownsImage = process.env.MATCHSENSE_CONTAINER_IMAGE === undefined;
const databaseUser = "matchsense";
const databasePassword = randomUUID();
const sensitiveValues = new Set([databasePassword]);
const runtimeImageProbe = String.raw`
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  assert.equal(fs.existsSync('/app/web/dist/index.html'), true);
  assert.equal(fs.existsSync('/app/server/node_modules/@matchsense/db/dist/cli.js'), true);
  assert.equal(fs.existsSync('/app/server/assets/silence.mp3'), true);
  assert.equal(fs.existsSync('/app/server/assets/goal-cue.mp3'), true);
  assert.equal(fs.existsSync('/app/server/assets/experience/v3/en/manifest.json'), true);
  assert.equal(fs.existsSync('/app/server/assets/experience/v3/en/winning-goal.mp3'), true);
  for (const forbiddenPath of ['/app/server/src', '/app/server/test', '/app/server/tests', '/app/web/src']) {
    assert.equal(fs.existsSync(forbiddenPath), false);
  }
  assert.equal(fs.readdirSync('/app/server').some((entry) => entry.includes('.test.')), false);
  try {
    require.resolve('vitest');
    process.exit(12);
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
  }
`;

function assertDestructiveIntegrationTarget(target) {
  if (target !== "matchsense_container_test" || !target.endsWith("_test")) {
    throw new Error("Container smoke database target is not allowed");
  }
}

function docker(stage, ...args) {
  return runLabeledCommand(stage, "docker", args, {
    sensitiveValues: [...sensitiveValues],
  });
}

async function eventually(operation, description, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`${description} did not become ready`, { cause: lastError });
}

async function fetchOk(url) {
  const response = await fetch(url);
  assert.equal(response.ok, true, `${url} returned ${response.status}`);
  return response;
}

async function cleanupDocker(stage, ...args) {
  try {
    await docker(stage, ...args);
  } catch {
    // Cleanup must be exhaustive and idempotent.
  }
}

async function main() {
  assertDestructiveIntegrationTarget(databaseName);
  let appStarted = false;
  let appStoppedGracefully = false;
  let networkCreated = false;
  let postgresStarted = false;

  try {
    if (ownsImage) {
      await runLabeledCommand(
        "build production image",
        "docker",
        ["build", "--tag", imageName, "."],
        { inherit: true },
      );
    }

    await docker("create smoke network", "network", "create", networkName);
    networkCreated = true;

    await docker(
      "start PostgreSQL",
      "run",
      "--detach",
      "--name",
      postgresName,
      "--network",
      networkName,
      "--env",
      `POSTGRES_DB=${databaseName}`,
      "--env",
      `POSTGRES_USER=${databaseUser}`,
      "--env",
      `POSTGRES_PASSWORD=${databasePassword}`,
      postgresImage,
    );
    postgresStarted = true;

    await eventually(
      () =>
        docker(
          "wait for PostgreSQL",
          "exec",
          postgresName,
          "pg_isready",
          "--username",
          databaseUser,
          "--dbname",
          databaseName,
        ),
      "PostgreSQL",
    );

    const databaseUrl = `postgresql://${databaseUser}:${encodeURIComponent(databasePassword)}@${postgresName}:5432/${databaseName}`;
    sensitiveValues.add(databaseUrl);
    const migrationOutput = await docker(
      "apply database migrations",
      "run",
      "--rm",
      "--network",
      networkName,
      "--env",
      `DATABASE_URL=${databaseUrl}`,
      "--entrypoint",
      "node",
      imageName,
      "node_modules/@matchsense/db/dist/cli.js",
      "migrate",
    );
    assert.match(
      migrationOutput,
      /(?:^|\n)Database migrations applied: \d+; current version: \d+$/u,
      "deployed migration CLI must execute and report the applied state",
    );
    const checkOutput = await docker(
      "verify database migrations",
      "run",
      "--rm",
      "--network",
      networkName,
      "--env",
      `DATABASE_URL=${databaseUrl}`,
      "--entrypoint",
      "node",
      imageName,
      "node_modules/@matchsense/db/dist/cli.js",
      "check",
    );
    assert.equal(
      checkOutput,
      "Database migrations are current",
      "deployed database check CLI must execute against the migrated target",
    );

    await docker(
      "start application",
      "run",
      "--detach",
      "--name",
      appName,
      "--network",
      networkName,
      "--env",
      "ROLE=api",
      "--env",
      `DATABASE_URL=${databaseUrl}`,
      "--publish",
      "127.0.0.1::8080",
      imageName,
    );
    appStarted = true;

    const configuredUser = await docker(
      "inspect application user",
      "inspect",
      "--format",
      "{{.Config.User}}",
      appName,
    );
    assert.equal(configuredUser, "node");
    const runtimeUserId = await docker(
      "inspect runtime user",
      "exec",
      appName,
      "node",
      "-e",
      "process.stdout.write(String(process.getuid?.() ?? 0))",
    );
    assert.notEqual(runtimeUserId, "0");
    await docker(
      "probe production image",
      "exec",
      appName,
      "node",
      "-e",
      runtimeImageProbe,
    );

    const publishedAddress = await docker(
      "inspect published port",
      "port",
      appName,
      "8080/tcp",
    );
    const portMatch = publishedAddress.match(/^127\.0\.0\.1:(\d+)$/u);
    assert.notEqual(portMatch, null, "container must publish only to loopback");
    const baseUrl = `http://127.0.0.1:${portMatch[1]}`;

    await eventually(() => fetchOk(`${baseUrl}/health/live`), "application");
    const readyResponse = await fetchOk(`${baseUrl}/health/ready`);
    assert.deepEqual(await readyResponse.json(), {
      checks: { database: "reachable", migrations: "current" },
      status: "ready",
    });

    const rootResponse = await fetchOk(`${baseUrl}/`);
    const rootBody = await rootResponse.text();
    assert.equal(rootResponse.headers.get("cache-control"), "no-cache");
    assert.match(rootBody, /MatchSense/u);

    const indexResponse = await fetchOk(`${baseUrl}/index.html`);
    assert.equal(indexResponse.headers.get("cache-control"), "no-cache");

    const nestedResponse = await fetchOk(
      `${baseUrl}/matches/fixture-1/moments/moment-1`,
    );
    assert.equal(nestedResponse.headers.get("cache-control"), "no-cache");
    assert.equal(await nestedResponse.text(), rootBody);

    const unknownApiResponse = await fetch(`${baseUrl}/api/not-a-route`);
    assert.equal(unknownApiResponse.status, 404);
    assert.match(
      unknownApiResponse.headers.get("content-type") ?? "",
      /application\/json/u,
    );
    assert.deepEqual(await unknownApiResponse.json(), {
      error: { code: "NOT_FOUND", message: "Route not found" },
    });

    const assetPath = rootBody.match(/(?:src|href)="(\/assets\/[^"]+)"/u)?.[1];
    assert.notEqual(
      assetPath,
      undefined,
      "built shell must reference an asset",
    );
    const assetResponse = await fetchOk(`${baseUrl}${assetPath}`);
    assert.equal(
      assetResponse.headers.get("cache-control"),
      "public, max-age=31536000, immutable",
    );

    await docker(
      "stop application gracefully",
      "stop",
      "--timeout",
      "10",
      appName,
    );
    appStoppedGracefully = true;
    const exitCode = await docker(
      "inspect application exit",
      "inspect",
      "--format",
      "{{.State.ExitCode}}",
      appName,
    );
    assert.equal(exitCode, "0", "SIGTERM shutdown must exit cleanly");

    process.stdout.write("Container smoke passed\n");
  } finally {
    if (appStarted && !appStoppedGracefully) {
      await cleanupDocker(
        "cleanup: stop application",
        "stop",
        "--timeout",
        "10",
        appName,
      );
    }
    if (appStarted) {
      await cleanupDocker(
        "cleanup: remove application",
        "rm",
        "--force",
        appName,
      );
    }
    if (postgresStarted) {
      await cleanupDocker(
        "cleanup: remove PostgreSQL",
        "rm",
        "--force",
        postgresName,
      );
    }
    if (networkCreated) {
      await cleanupDocker(
        "cleanup: remove network",
        "network",
        "rm",
        networkName,
      );
    }
    if (ownsImage) {
      await cleanupDocker(
        "cleanup: remove image",
        "image",
        "rm",
        "--force",
        imageName,
      );
    }
  }
}

await main();
