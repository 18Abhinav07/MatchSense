import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadPolicy() {
  try {
    return await import("./dockerfile-policy.mjs");
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      return null;
    }

    throw error;
  }
}

test("parses the runtime apt package list without hiding extra packages", async () => {
  const policy = await loadPolicy();
  assert.notEqual(policy, null, "Dockerfile policy helper must exist");

  const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
  assert.deepEqual(policy.runtimeAptPackages(dockerfile), ["ffmpeg"]);

  const bloatedDockerfile = dockerfile.replace(
    "--no-install-recommends ffmpeg",
    "--no-install-recommends ffmpeg curl",
  );
  assert.deepEqual(policy.runtimeAptPackages(bloatedDockerfile), [
    "ffmpeg",
    "curl",
  ]);
});

test("isolates runtime-stage instructions from builder tooling", async () => {
  const policy = await loadPolicy();
  assert.notEqual(policy, null, "Dockerfile policy helper must exist");

  const dockerfile = [
    "FROM pinned AS builder",
    "RUN apt-get install -y build-essential",
    "FROM pinned AS runtime",
    "RUN apt-get update \\",
    "  && apt-get install -y --no-install-recommends ffmpeg \\",
    "  && rm -rf /var/lib/apt/lists/*",
  ].join("\n");

  assert.deepEqual(policy.runtimeAptPackages(dockerfile), ["ffmpeg"]);
});
