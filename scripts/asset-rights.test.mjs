import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function loadGate() {
  try {
    return await import("./asset-rights.mjs");
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      return null;
    }
    throw error;
  }
}

async function withFixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "matchsense-assets-"));
  try {
    await writeFile(path.join(root, "ASSET-LICENSES.md"), "# Asset Licenses\n");
    await run(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("current no-product-assets repository passes the rights gate", async () => {
  const gate = await loadGate();
  assert.notEqual(gate, null, "asset rights gate must exist");
  assert.deepEqual(await gate.findAssetRightsViolations(), []);
});

test("an undeclared source product asset fails", async () => {
  const gate = await loadGate();
  assert.notEqual(gate, null, "asset rights gate must exist");

  await withFixture(async (root) => {
    const assetDirectory = path.join(root, "apps/web/public");
    await mkdir(assetDirectory, { recursive: true });
    await writeFile(path.join(assetDirectory, "goal.svg"), "<svg></svg>");

    assert.deepEqual(await gate.findAssetRightsViolations(root), [
      "apps/web/public/goal.svg",
    ]);
  });
});

test("an exact declared source product asset passes", async () => {
  const gate = await loadGate();
  assert.notEqual(gate, null, "asset rights gate must exist");

  await withFixture(async (root) => {
    const assetDirectory = path.join(root, "apps/web/src/assets");
    const assetPath = "apps/web/src/assets/goal.svg";
    await mkdir(assetDirectory, { recursive: true });
    await writeFile(path.join(root, assetPath), "<svg></svg>");
    await writeFile(
      path.join(root, "ASSET-LICENSES.md"),
      `# Asset Licenses\n\n| Asset path | Source or owner | License or permission |\n| --- | --- | --- |\n| \`${assetPath}\` | MatchSense | Original |\n`,
    );

    assert.deepEqual(await gate.findAssetRightsViolations(root), []);
  });
});

test("prose and incomplete license rows do not declare an asset", async () => {
  const gate = await loadGate();
  assert.notEqual(gate, null, "asset rights gate must exist");

  await withFixture(async (root) => {
    const assetDirectory = path.join(root, "apps/web/public");
    const assetPath = "apps/web/public/goal.svg";
    await mkdir(assetDirectory, { recursive: true });
    await writeFile(path.join(root, assetPath), "<svg></svg>");

    for (const declaration of [
      `This paragraph mentions \`${assetPath}\` without a rights declaration.`,
      `| \`${assetPath}\` | | Original |`,
      `| \`${assetPath}\` | MatchSense | |`,
    ]) {
      await writeFile(
        path.join(root, "ASSET-LICENSES.md"),
        `# Asset Licenses\n\n${declaration}\n`,
      );
      assert.deepEqual(await gate.findAssetRightsViolations(root), [assetPath]);
    }
  });
});

test("generated, dependency, and local worktree assets are outside the rights scan", async () => {
  const gate = await loadGate();
  assert.notEqual(gate, null, "asset rights gate must exist");

  await withFixture(async (root) => {
    for (const assetPath of [
      ".worktrees/feature/apps/web/public/local-preview.svg",
      "apps/web/dist/generated.svg",
      "node_modules/package/logo.svg",
      "packages/ui/dist/generated.woff2",
    ]) {
      await mkdir(path.dirname(path.join(root, assetPath)), {
        recursive: true,
      });
      await writeFile(path.join(root, assetPath), "fixture");
    }

    assert.deepEqual(await gate.findAssetRightsViolations(root), []);
  });
});
