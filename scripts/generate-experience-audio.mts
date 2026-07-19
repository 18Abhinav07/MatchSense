import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createDockerFfmpegRunner,
  generateExperienceAudioPack,
} from "../apps/server/src/experience-audio-generation.js";

function selectedDecoder(args: readonly string[]) {
  if (
    args.length === 0 ||
    (args.length === 1 && args[0] === "--decoder=local")
  ) {
    return "local" as const;
  }
  if (args.length === 1 && args[0] === "--decoder=docker") {
    return "docker" as const;
  }
  throw new Error(
    "Usage: generate-experience-audio.mts [--decoder=local|--decoder=docker]",
  );
}

async function main() {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) throw new Error("GROQ_API_KEY is required");

  const decoder = selectedDecoder(process.argv.slice(2));
  const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const expectedMp3Bytes = await readFile(
    path.join(projectRoot, "apps/server/assets/silence.mp3"),
  );
  const outputDirectory = path.join(
    projectRoot,
    "apps/server/assets/experience/v3/en",
  );
  const result = await generateExperienceAudioPack({
    apiKey,
    expectedMp3Bytes,
    outputDirectory,
    ...(decoder === "docker" ? { run: createDockerFfmpegRunner() } : {}),
  });

  process.stdout.write(
    `Generated ${result.manifest.entries.length} Experience audio assets; manifest sha256 ${result.manifestSha256}\n`,
  );
}

try {
  await main();
} catch (error) {
  const message =
    error instanceof Error
      ? error.message
      : "Experience audio generation failed";
  process.stderr.write(`Experience audio generation failed: ${message}\n`);
  process.exitCode = 1;
}
