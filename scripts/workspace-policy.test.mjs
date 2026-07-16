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
    ["bullmq", "bullmq"],
    ["@aws-sdk/client-s3", "object-store"],
    ["minio", "object-store"],
    ["@google-cloud/storage", "object-store"],
    ["@azure/storage-blob", "object-store"],
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
