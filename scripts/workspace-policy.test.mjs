import assert from "node:assert/strict";
import test from "node:test";

async function loadPolicy() {
  try {
    return await import("./workspace-policy.mjs");
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      return null;
    }

    throw error;
  }
}

test("rejects dependencies that add Redis, BullMQ, or object storage", async () => {
  const policy = await loadPolicy();
  assert.notEqual(policy, null, "workspace policy helper must exist");

  const forbiddenDependencies = [
    ["redis", "redis"],
    ["ioredis", "redis"],
    ["@redis/client", "redis"],
    ["@upstash/redis", "redis"],
    ["bullmq", "bullmq"],
    ["aws-sdk", "object-store"],
    ["@aws-sdk/client-s3", "object-store"],
    ["@aws-sdk/lib-storage", "object-store"],
    ["minio", "object-store"],
    ["@google-cloud/storage", "object-store"],
    ["@azure/storage-blob", "object-store"],
    ["multer-s3", "object-store"],
    ["s3rver", "object-store"],
  ];

  for (const [dependency, expectedCategory] of forbiddenDependencies) {
    assert.equal(
      policy.forbiddenInfrastructureCategory(dependency),
      expectedCategory,
      `${dependency} must be rejected as ${expectedCategory}`,
    );
  }
});

test("allows dependency names outside the exact infrastructure policy", async () => {
  const policy = await loadPolicy();
  assert.notEqual(policy, null, "workspace policy helper must exist");

  const allowedDependencies = [
    "redistribution-tools",
    "@aws-sdk/client-sqs",
    "@google-cloud/pubsub",
    "@azure/service-bus",
    "@upstash/vector",
    "multer",
    "@matchsense/storage-types",
  ];

  for (const dependency of allowedDependencies) {
    assert.equal(
      policy.forbiddenInfrastructureCategory(dependency),
      null,
      `${dependency} must not be rejected by a broad substring match`,
    );
  }
});

test("accepts only canonical full-workspace or own-workspace Vitest runs", async () => {
  const policy = await loadPolicy();
  assert.notEqual(policy, null, "workspace policy helper must exist");

  assert.equal(
    policy.isCanonicalVitestTestScript("vitest run", "apps/web/src"),
    true,
  );
  assert.equal(
    policy.isCanonicalVitestTestScript(
      "vitest run --root ../.. apps/server/src",
      "apps/server/src",
    ),
    true,
  );
  assert.equal(
    policy.isCanonicalVitestTestScript(
      "vitest run --root ../.. apps/web/src",
      "apps/server/src",
    ),
    false,
    "a scoped script must not silently test another workspace",
  );
});

test("rejects missing, non-run, and pass-with-no-tests scripts", async () => {
  const policy = await loadPolicy();
  assert.notEqual(policy, null, "workspace policy helper must exist");

  for (const script of [
    undefined,
    "",
    "vitest",
    "vitest run --passWithNoTests",
    "node --test",
  ]) {
    assert.equal(
      policy.isCanonicalVitestTestScript(script, "apps/server/src"),
      false,
      `${String(script)} must not satisfy the Vitest run contract`,
    );
  }
});
