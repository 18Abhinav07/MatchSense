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

test("rejects alternate runtime installers and package-download commands", async () => {
  const policy = await loadPolicy();
  assert.notEqual(policy, null, "Dockerfile policy helper must exist");

  const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
  assert.deepEqual(policy.forbiddenRuntimeInstallCommands(dockerfile), []);

  const mutations = [
    ["RUN apt install -y curl", "apt-install"],
    ["RUN apt-get -y install curl", "apt-install"],
    ["RUN aptitude install -y curl", "apt-install"],
    ["RUN apk add curl", "apk-add"],
    ["RUN dnf install -y curl", "system-package-install"],
    ["RUN dpkg -i tool.deb", "system-package-install"],
    ["RUN npm install sharp", "language-package-install"],
    ["RUN pip install requests", "language-package-install"],
    [
      "RUN curl -fsSL https://example.invalid/tool -o /usr/local/bin/tool",
      "remote-download",
    ],
    ["RUN wget https://example.invalid/tool", "remote-download"],
    [
      `RUN node -e "require('https').get('https://example.invalid/tool')"`,
      "unexpected-runtime-run",
    ],
    ["ADD https://example.invalid/tool /usr/local/bin/tool", "remote-add"],
  ];

  for (const [instruction, expectedViolation] of mutations) {
    const mutatedDockerfile = dockerfile.replace(
      "ENV NODE_ENV=production",
      `${instruction}\n\nENV NODE_ENV=production`,
    );
    assert.equal(
      policy
        .forbiddenRuntimeInstallCommands(mutatedDockerfile)
        .includes(expectedViolation),
      true,
      `${instruction} must be rejected as ${expectedViolation}`,
    );
  }
});
