import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createCommentaryPipeline } from "../packages/commentary/src/index.js";

import {
  createDockerFfmpegRunner,
  createGeminiExperienceWavRequester,
  generateExperienceAudioPack,
  parseExperienceAudioGeneratorArgs,
} from "../apps/server/src/experience-audio-generation.js";

async function main() {
  const { decoder, provider } = parseExperienceAudioGeneratorArgs(
    process.argv.slice(2),
  );
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
  const groqApiKey = process.env.GROQ_API_KEY?.trim();
  const geminiApiKey =
    process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim();
  if (provider === "groq" && !groqApiKey) {
    throw new Error("GROQ_API_KEY is required");
  }
  if (provider === "gemini" && !geminiApiKey) {
    throw new Error("GEMINI_API_KEY or GOOGLE_API_KEY is required");
  }
  const requestWav =
    provider === "gemini"
      ? createGeminiExperienceWavRequester(
          createCommentaryPipeline({
            env: { GEMINI_API_KEY: geminiApiKey },
            ttsTimeoutMs: 60_000,
          }),
        )
      : undefined;
  const result = await generateExperienceAudioPack({
    expectedMp3Bytes,
    outputDirectory,
    ...(groqApiKey ? { apiKey: groqApiKey } : {}),
    ...(decoder === "docker" ? { run: createDockerFfmpegRunner() } : {}),
    ...(requestWav ? { requestWav } : {}),
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
