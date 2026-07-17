import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const productAssetExtensions = new Set([
  ".avif",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".m4a",
  ".mp3",
  ".mp4",
  ".ogg",
  ".otf",
  ".png",
  ".svg",
  ".ttf",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
]);

const excludedDirectories = new Set([
  ".git",
  ".worktrees",
  "dist",
  "node_modules",
]);

function normalizedRelativePath(root, absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

function isProductAssetPath(relativePath) {
  const segments = relativePath.split("/");
  const belongsToProductAssetDirectory = segments.some((segment) =>
    ["assets", "public"].includes(segment),
  );

  return (
    belongsToProductAssetDirectory &&
    productAssetExtensions.has(path.extname(relativePath).toLowerCase())
  );
}

async function collectProductAssets(root, relativeDirectory = "") {
  const absoluteDirectory = path.join(root, relativeDirectory);
  let entries;
  try {
    entries = await readdir(absoluteDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const assets = [];
  for (const entry of entries) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) {
      continue;
    }

    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      assets.push(...(await collectProductAssets(root, relativePath)));
    } else if (
      entry.isFile() &&
      isProductAssetPath(
        normalizedRelativePath(root, path.join(root, relativePath)),
      )
    ) {
      assets.push(normalizedRelativePath(root, path.join(root, relativePath)));
    }
  }

  return assets.sort();
}

function declaredAssetPaths(document) {
  const declarations = new Set();
  for (const line of document.split(/\r?\n/u)) {
    const row = line.match(
      /^\|\s*`((?:apps|packages|assets)\/[^`]+)`\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*$/u,
    );
    const sourceOrOwner = row?.[2]?.trim();
    const licenseOrPermission = row?.[3]?.trim();

    if (
      row?.[1] &&
      sourceOrOwner &&
      licenseOrPermission &&
      sourceOrOwner !== "---" &&
      licenseOrPermission !== "---"
    ) {
      declarations.add(row[1]);
    }
  }
  return declarations;
}

export async function findAssetRightsViolations(root = projectRoot) {
  const document = await readFile(path.join(root, "ASSET-LICENSES.md"), "utf8");
  const declared = declaredAssetPaths(document);
  const assets = await collectProductAssets(root);

  return assets.filter((assetPath) => !declared.has(assetPath));
}

const entryPath = process.argv[1];
const isDirectExecution =
  entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href;

if (isDirectExecution) {
  const violations = await findAssetRightsViolations();
  if (violations.length > 0) {
    process.stderr.write(
      `Undeclared product assets:\n${violations.map((asset) => `- ${asset}`).join("\n")}\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write("Asset rights declarations are current\n");
  }
}
