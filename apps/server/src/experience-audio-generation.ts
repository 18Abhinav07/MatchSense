import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type { CanonicalEventKind } from "@matchsense/contracts";

import {
  runByteCommand,
  transcodeWavToStreamMp3,
  type ByteCommandRunner,
} from "./audio-transcoder.js";
import {
  EXPERIENCE_AUDIO_SCRIPT,
  EXPERIENCE_MEMORY_INTRO,
} from "./experience-audio-script.js";
import {
  EXPERIENCE_AWAY_TEAM,
  EXPERIENCE_HOME_TEAM,
} from "./experience-fixture-contract.js";
import {
  EXPERIENCE_TEMPLATE_ID,
  EXPERIENCE_TEMPLATE_VERSION,
  type ExperienceBeatKey,
} from "./experience-runtime.js";
import { inspectMp3 } from "./mp3.js";

const GROQ_SPEECH_URL = "https://api.groq.com/openai/v1/audio/speech";
const GROQ_SPEECH_MODEL = "canopylabs/orpheus-v1-english";
const GROQ_SPEECH_VOICE = "troy";

type ExperienceAudioKind = CanonicalEventKind | "memory.intro";

export interface ExperienceAudioGenerationTarget {
  beatKey: ExperienceBeatKey | "memory-intro";
  file: string;
  kind: ExperienceAudioKind;
  minute: string;
  transcript: string;
}

export interface ExperienceAudioManifestEntry {
  beatKey: string;
  durationMs: number;
  kind: ExperienceAudioKind;
  minute: string;
  mp3Path: string;
  sha256: string;
  transcript: string;
}

export interface ExperienceAudioManifest {
  awayTeam: "FRA";
  entries: readonly ExperienceAudioManifestEntry[];
  homeTeam: "ARG";
  locale: "en";
  stream: {
    bitrateKbps: 64;
    channels: 1;
    codec: "mp3";
    sampleRateHz: 44_100;
  };
  templateId: "five-minute-match";
  templateVersion: 3;
}

type TtsFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface GenerateExperienceAudioPackOptions {
  apiKey?: string;
  expectedMp3Bytes: Buffer;
  fetchTts?: TtsFetch;
  outputDirectory: string;
  requestWav?: ExperienceWavRequester;
  run?: ByteCommandRunner;
}

export type ExperienceWavRequester = (
  target: ExperienceAudioGenerationTarget,
) => Promise<Buffer>;

interface ExperienceSpeechSynthesizer {
  synthesize(
    transcript: string,
    voiceName: string,
  ): Promise<{
    bytes: Buffer;
    fallbackReason: string | null;
    provider: "gemini" | "deterministic-cue";
  }>;
}

export interface ExperienceAudioGeneratorOptions {
  decoder: "docker" | "local";
  provider: "gemini" | "groq";
}

const BEAT_METADATA = [
  ["kickoff", "phase.kickoff", "0'"],
  ["opening-goal", "goal", "12'"],
  ["opening-goal-var-review", "var.started", "13'"],
  ["opening-goal-var-stands", "var.stands", "13'"],
  ["home-yellow", "card.yellow", "24'"],
  ["away-yellow-first-half", "card.yellow", "31'"],
  ["away-penalty-awarded", "penalty.awarded", "40'"],
  ["away-penalty-scored", "penalty.scored", "41'"],
  ["half-time", "phase.half_time", "HT"],
  ["second-half", "phase.second_half_start", "46'"],
  ["away-red", "card.red", "58'"],
  ["home-yellow-second-half", "card.yellow", "67'"],
  ["away-yellow-second-half", "card.yellow", "67'"],
  ["winning-goal", "goal", "78'"],
  ["apparent-equalizer", "goal", "88'"],
  ["equalizer-var-review", "var.started", "89'"],
  ["equalizer-var-overturned", "var.overturned", "89'"],
  ["late-corner", "corner", "90+2'"],
  ["regulation-end", "phase.regulation_end", "90+4'"],
  ["full-time", "phase.full_time", "FT"],
] as const satisfies readonly (readonly [
  ExperienceBeatKey,
  CanonicalEventKind,
  string,
])[];

export const EXPERIENCE_AUDIO_GENERATION_TARGETS: readonly ExperienceAudioGenerationTarget[] =
  Object.freeze([
    ...BEAT_METADATA.map(([beatKey, kind, minute]) =>
      Object.freeze({
        beatKey,
        file: `${beatKey}.mp3`,
        kind,
        minute,
        transcript: EXPERIENCE_AUDIO_SCRIPT[beatKey],
      }),
    ),
    Object.freeze({
      beatKey: "memory-intro" as const,
      file: "memory-intro.mp3",
      kind: "memory.intro" as const,
      minute: "MEMORY",
      transcript: EXPERIENCE_MEMORY_INTRO,
    }),
  ]);

const GENERATOR_USAGE =
  "Usage: generate-experience-audio.mts [--provider=groq|--provider=gemini] [--decoder=local|--decoder=docker]";

export function parseExperienceAudioGeneratorArgs(
  args: readonly string[],
): ExperienceAudioGeneratorOptions {
  let decoder: ExperienceAudioGeneratorOptions["decoder"] = "local";
  let provider: ExperienceAudioGeneratorOptions["provider"] = "groq";
  let decoderWasSet = false;
  let providerWasSet = false;

  for (const argument of args) {
    if (argument === "--decoder=local" || argument === "--decoder=docker") {
      if (decoderWasSet) throw new Error(GENERATOR_USAGE);
      decoder = argument === "--decoder=docker" ? "docker" : "local";
      decoderWasSet = true;
      continue;
    }
    if (argument === "--provider=groq" || argument === "--provider=gemini") {
      if (providerWasSet) throw new Error(GENERATOR_USAGE);
      provider = argument === "--provider=gemini" ? "gemini" : "groq";
      providerWasSet = true;
      continue;
    }
    throw new Error(GENERATOR_USAGE);
  }

  return { decoder, provider };
}

function unicodeLength(value: string) {
  return Array.from(value).length;
}

export function validateExperienceAudioGenerationTargets(
  targets: readonly ExperienceAudioGenerationTarget[],
) {
  const beatKeys = new Set<string>();
  const files = new Set<string>();
  for (const target of targets) {
    if (beatKeys.has(target.beatKey)) {
      throw new Error(`Duplicate beat key: ${target.beatKey}`);
    }
    beatKeys.add(target.beatKey);
    if (files.has(target.file)) {
      throw new Error(`Duplicate output file: ${target.file}`);
    }
    files.add(target.file);
  }

  const expectedBeatKeys = Object.keys(EXPERIENCE_AUDIO_SCRIPT).sort();
  const actualBeatKeys = targets
    .filter((target) => target.kind !== "memory.intro")
    .map((target) => target.beatKey)
    .sort();
  const memoryTargets = targets.filter(
    (target) => target.kind === "memory.intro",
  );

  if (
    targets.length !== expectedBeatKeys.length + 1 ||
    actualBeatKeys.join("\u0000") !== expectedBeatKeys.join("\u0000") ||
    memoryTargets.length !== 1
  ) {
    throw new Error("Experience audio generation plan is partial");
  }

  for (const target of targets) {
    if (
      path.basename(target.file) !== target.file ||
      !target.file.endsWith(".mp3")
    ) {
      throw new Error(`Invalid deterministic MP3 filename: ${target.file}`);
    }
    if (
      target.transcript.trim().length === 0 ||
      unicodeLength(target.transcript) > 200
    ) {
      throw new Error(`Invalid transcript for ${target.beatKey}`);
    }
    if (
      target.kind === "memory.intro" &&
      (target.beatKey !== "memory-intro" ||
        target.transcript !== EXPERIENCE_MEMORY_INTRO)
    ) {
      throw new Error(
        "Experience Memory introduction does not match its script",
      );
    }
    if (target.kind !== "memory.intro") {
      const transcript =
        EXPERIENCE_AUDIO_SCRIPT[target.beatKey as ExperienceBeatKey];
      if (transcript !== target.transcript) {
        throw new Error(`Transcript does not match script: ${target.beatKey}`);
      }
    }
  }
}

function requireStreamContract(bytes: Buffer) {
  const contract = inspectMp3(bytes);
  if (
    contract.bitrateKbps !== 64 ||
    contract.channels !== 1 ||
    contract.sampleRateHz !== 44_100
  ) {
    throw new Error(
      "Experience audio reference must be mono 44.1 kHz 64 kbps MP3",
    );
  }
  return contract;
}

function isFileSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function requireOutputDoesNotExist(outputDirectory: string) {
  try {
    await access(outputDirectory);
  } catch (error) {
    if (isFileSystemError(error) && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Experience audio output already exists: ${outputDirectory}`);
}

function assertWav(bytes: Buffer) {
  if (bytes.length === 0) {
    throw new Error("Groq returned an empty WAV");
  }
  if (
    bytes.length < 12 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("Groq returned invalid WAV audio");
  }
}

export function createGeminiExperienceWavRequester(
  pipeline: ExperienceSpeechSynthesizer,
): ExperienceWavRequester {
  return async (target) => {
    const speech = await pipeline.synthesize(target.transcript, "Kore");
    if (speech.provider !== "gemini") {
      throw new Error(speech.fallbackReason ?? "gemini_deterministic_fallback");
    }
    assertWav(speech.bytes);
    return speech.bytes;
  };
}

async function requestGroqWav(
  target: ExperienceAudioGenerationTarget,
  apiKey: string,
  fetchTts: TtsFetch,
) {
  const response = await fetchTts(GROQ_SPEECH_URL, {
    body: JSON.stringify({
      input: target.transcript,
      model: GROQ_SPEECH_MODEL,
      response_format: "wav",
      voice: GROQ_SPEECH_VOICE,
    }),
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
  if (!response.ok) {
    const body = (await response.text().catch(() => "")).slice(0, 4_096);
    if (body.toLowerCase().includes("model_terms_required")) {
      throw new Error(
        "Groq Orpheus model terms must be accepted before generation",
      );
    }
    if (response.status === 429) {
      throw new Error("Groq TTS rate limit exceeded");
    }
    throw new Error(`Groq TTS request failed with HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  assertWav(bytes);
  return bytes;
}

function createManifestEntry(
  target: ExperienceAudioGenerationTarget,
  mp3Bytes: Buffer,
): ExperienceAudioManifestEntry {
  const contract = requireStreamContract(mp3Bytes);
  return {
    beatKey: target.beatKey,
    durationMs: Math.round(contract.durationMs),
    kind: target.kind,
    minute: target.minute,
    mp3Path: target.file,
    sha256: createHash("sha256").update(mp3Bytes).digest("hex"),
    transcript: target.transcript,
  };
}

export function createDockerFfmpegRunner(
  delegate: ByteCommandRunner = runByteCommand,
  image = "matchsense-debug:latest",
): ByteCommandRunner {
  return (command) =>
    delegate({
      args: ["run", "--rm", "-i", image, "ffmpeg", ...command.args],
      command: "docker",
      input: command.input,
      timeoutMs: command.timeoutMs,
    });
}

export async function generateExperienceAudioPack(
  options: GenerateExperienceAudioPackOptions,
) {
  const apiKey = options.apiKey?.trim() ?? "";
  if (!options.requestWav && apiKey.length === 0) {
    throw new Error("GROQ_API_KEY is required");
  }
  validateExperienceAudioGenerationTargets(EXPERIENCE_AUDIO_GENERATION_TARGETS);
  const expected = requireStreamContract(options.expectedMp3Bytes);
  const requestWav =
    options.requestWav ??
    ((target: ExperienceAudioGenerationTarget) =>
      requestGroqWav(target, apiKey, options.fetchTts ?? fetch));
  await requireOutputDoesNotExist(options.outputDirectory);

  const parentDirectory = path.dirname(options.outputDirectory);
  await mkdir(parentDirectory, { recursive: true });
  const stagingDirectory = await mkdtemp(
    path.join(parentDirectory, ".experience-audio-"),
  );

  try {
    const entries: ExperienceAudioManifestEntry[] = [];
    for (const target of EXPERIENCE_AUDIO_GENERATION_TARGETS) {
      const wavBytes = await requestWav(target);
      assertWav(wavBytes);
      const mp3Bytes = await transcodeWavToStreamMp3(wavBytes, {
        expected,
        ...(options.run ? { run: options.run } : {}),
      });
      const entry = createManifestEntry(target, mp3Bytes);
      await writeFile(path.join(stagingDirectory, target.file), mp3Bytes, {
        flag: "wx",
      });
      entries.push(entry);
    }
    if (entries.length !== EXPERIENCE_AUDIO_GENERATION_TARGETS.length) {
      throw new Error("Experience audio manifest is partial");
    }

    const manifest: ExperienceAudioManifest = {
      awayTeam: EXPERIENCE_AWAY_TEAM as "FRA",
      entries,
      homeTeam: EXPERIENCE_HOME_TEAM as "ARG",
      locale: "en",
      stream: {
        bitrateKbps: 64,
        channels: 1,
        codec: "mp3",
        sampleRateHz: 44_100,
      },
      templateId: EXPERIENCE_TEMPLATE_ID,
      templateVersion: EXPERIENCE_TEMPLATE_VERSION,
    };
    const manifestBytes = Buffer.from(
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(stagingDirectory, "manifest.json"),
      manifestBytes,
      { flag: "wx" },
    );
    await rename(stagingDirectory, options.outputDirectory);
    return {
      manifest,
      manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    };
  } catch (error) {
    await rm(stagingDirectory, { force: true, recursive: true });
    throw error;
  }
}
