import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

import type { CanonicalMoment } from "@matchsense/contracts";

import {
  EXPERIENCE_AUDIO_BEAT_METADATA,
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
import { assertCompatibleMp3Streams, inspectMp3 } from "./mp3.js";

const EXPERIENCE_BEAT_DELIMITER = ":beat:";
const MAX_MANIFEST_BYTES = 256 * 1_024;
const MAX_MP3_BYTES = 2 * 1_024 * 1_024;
const EXPECTED_STREAM = Object.freeze({
  bitrateKbps: 64,
  channels: 1,
  codec: "mp3",
  sampleRateHz: 44_100,
} as const);
const EXPECTED_BEAT_KEYS = Object.freeze(
  Object.keys(EXPERIENCE_AUDIO_SCRIPT) as ExperienceBeatKey[],
);
const EXPECTED_BEAT_KEY_SET = new Set<string>(EXPECTED_BEAT_KEYS);
const EXPECTED_BEAT_METADATA = new Map(
  EXPERIENCE_AUDIO_BEAT_METADATA.map((metadata) => [
    metadata.beatKey,
    metadata,
  ]),
);
const SAFE_MP3_BASENAME = /^[A-Za-z0-9][A-Za-z0-9-]*\.mp3$/u;
const SHA_256 = /^[a-f0-9]{64}$/u;

export interface ExperienceAudioAsset {
  readonly beatKey: string;
  readonly bytes: Buffer;
  readonly durationMs: number;
  readonly kind: string;
  readonly minute: string;
  readonly sha256: string;
  readonly transcript: string;
}

export interface ExperienceAudioPack {
  readonly awayTeam: "FRA";
  readonly homeTeam: "ARG";
  readonly locale: "en";
  readonly memoryIntro: ExperienceAudioAsset;
  readonly templateId: "five-minute-match";
  readonly templateVersion: 3;
  forMoment(moment: CanonicalMoment): ExperienceAudioAsset | null;
}

export interface LoadExperienceAudioPackOptions {
  readonly referenceSilenceBytes: Buffer;
}

interface StoredExperienceAudioAsset extends ExperienceAudioAsset {
  readonly bytes: Buffer;
}

interface ManifestEntry {
  beatKey: string;
  durationMs: number;
  kind: string;
  minute: string;
  mp3Path: string;
  sha256: string;
  transcript: string;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function parseManifestEntry(value: unknown, index: number): ManifestEntry {
  const entry = requireRecord(value, `Experience audio entry ${index}`);
  const durationMs = entry.durationMs;
  if (!Number.isSafeInteger(durationMs) || Number(durationMs) <= 0) {
    throw new Error(`Experience audio entry ${index} has invalid duration`);
  }
  return {
    beatKey: requireString(entry.beatKey, `Entry ${index} beatKey`),
    durationMs: Number(durationMs),
    kind: requireString(entry.kind, `Entry ${index} kind`),
    minute: requireString(entry.minute, `Entry ${index} minute`),
    mp3Path: requireString(entry.mp3Path, `Entry ${index} MP3 path`),
    sha256: requireString(entry.sha256, `Entry ${index} SHA-256`),
    transcript: requireString(entry.transcript, `Entry ${index} transcript`),
  };
}

function assertFixedManifestContract(manifest: Record<string, unknown>) {
  if (
    manifest.homeTeam !== EXPERIENCE_HOME_TEAM ||
    manifest.awayTeam !== EXPERIENCE_AWAY_TEAM
  ) {
    throw new Error(
      "Experience audio manifest must target ARG at home and FRA away",
    );
  }
  if (
    manifest.templateId !== EXPERIENCE_TEMPLATE_ID ||
    manifest.templateVersion !== EXPERIENCE_TEMPLATE_VERSION
  ) {
    throw new Error(
      "Experience audio manifest template contract does not match v3",
    );
  }
  if (manifest.locale !== "en") {
    throw new Error("Experience audio manifest locale must be English");
  }
  const stream = requireRecord(manifest.stream, "Experience audio stream");
  for (const [key, expected] of Object.entries(EXPECTED_STREAM)) {
    if (stream[key] !== expected) {
      throw new Error(`Experience audio stream ${key} does not match`);
    }
  }
}

function cloneAsset(asset: StoredExperienceAudioAsset): ExperienceAudioAsset {
  return Object.freeze({
    beatKey: asset.beatKey,
    bytes: Buffer.from(asset.bytes),
    durationMs: asset.durationMs,
    kind: asset.kind,
    minute: asset.minute,
    sha256: asset.sha256,
    transcript: asset.transcript,
  });
}

function expectedTranscript(beatKey: string) {
  if (beatKey === "memory-intro") return EXPERIENCE_MEMORY_INTRO;
  if (!EXPECTED_BEAT_KEY_SET.has(beatKey)) return null;
  return EXPERIENCE_AUDIO_SCRIPT[beatKey as ExperienceBeatKey];
}

function assertSafeMp3Basename(mp3Path: string) {
  if (
    path.basename(mp3Path) !== mp3Path ||
    path.win32.basename(mp3Path) !== mp3Path ||
    !SAFE_MP3_BASENAME.test(mp3Path)
  ) {
    throw new Error(
      `Experience audio MP3 path is not a safe basename: ${mp3Path}`,
    );
  }
}

function readBoundedRegularFile(input: {
  filePath: string;
  label: string;
  maxBytes: number;
}) {
  const { filePath, label, maxBytes } = input;
  const stat = lstatSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`${label} must be a regular file, not a symlink or device`);
  }
  if (stat.size <= 0) {
    throw new Error(`${label} must not be empty`);
  }
  if (stat.size > maxBytes) {
    throw new Error(`${label} is too large (maximum ${maxBytes} bytes)`);
  }
  return readFileSync(filePath);
}

function readValidatedAsset(input: {
  entry: ManifestEntry;
  referenceContract: ReturnType<typeof inspectMp3>;
  rootDirectory: string;
}): StoredExperienceAudioAsset {
  const { entry, referenceContract, rootDirectory } = input;
  assertSafeMp3Basename(entry.mp3Path);
  if (!SHA_256.test(entry.sha256)) {
    throw new Error(`Experience audio SHA-256 is malformed: ${entry.beatKey}`);
  }
  const transcript = expectedTranscript(entry.beatKey);
  if (transcript === null) {
    throw new Error(`Unknown Experience audio beat key: ${entry.beatKey}`);
  }
  if (entry.transcript !== transcript) {
    throw new Error(`Experience audio transcript mismatch: ${entry.beatKey}`);
  }
  if (
    entry.beatKey === "memory-intro" &&
    (entry.kind !== "memory.intro" || entry.minute !== "MEMORY")
  ) {
    throw new Error("Experience Memory introduction metadata does not match");
  }
  if (entry.beatKey !== "memory-intro") {
    const metadata = EXPECTED_BEAT_METADATA.get(
      entry.beatKey as ExperienceBeatKey,
    );
    if (
      !metadata ||
      metadata.kind !== entry.kind ||
      metadata.minute !== entry.minute
    ) {
      throw new Error(
        `Experience audio metadata kind or minute mismatch: ${entry.beatKey}`,
      );
    }
  }

  const bytes = readBoundedRegularFile({
    filePath: path.join(rootDirectory, entry.mp3Path),
    label: `Experience audio ${entry.beatKey} MP3`,
    maxBytes: MAX_MP3_BYTES,
  });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== entry.sha256) {
    throw new Error(`Experience audio SHA-256 mismatch: ${entry.beatKey}`);
  }
  const contract = inspectMp3(bytes);
  if (
    contract.bitrateKbps !== EXPECTED_STREAM.bitrateKbps ||
    contract.channels !== EXPECTED_STREAM.channels ||
    contract.sampleRateHz !== EXPECTED_STREAM.sampleRateHz
  ) {
    throw new Error(`Experience audio MP3 stream mismatch: ${entry.beatKey}`);
  }
  assertCompatibleMp3Streams(referenceContract, contract);
  if (Math.round(contract.durationMs) !== entry.durationMs) {
    throw new Error(`Experience audio duration mismatch: ${entry.beatKey}`);
  }

  return Object.freeze({
    beatKey: entry.beatKey,
    bytes: Buffer.from(bytes),
    durationMs: entry.durationMs,
    kind: entry.kind,
    minute: entry.minute,
    sha256: entry.sha256,
    transcript: entry.transcript,
  });
}

export function loadExperienceAudioPack(
  rootDirectory: string,
  options: LoadExperienceAudioPackOptions,
): ExperienceAudioPack {
  if (typeof rootDirectory !== "string" || rootDirectory.trim().length === 0) {
    throw new Error("Experience audio pack root directory is required");
  }
  if (!Buffer.isBuffer(options.referenceSilenceBytes)) {
    throw new Error("Experience audio reference silence bytes are required");
  }
  const referenceContract = inspectMp3(
    Buffer.from(options.referenceSilenceBytes),
  );
  if (
    referenceContract.bitrateKbps !== EXPECTED_STREAM.bitrateKbps ||
    referenceContract.channels !== EXPECTED_STREAM.channels ||
    referenceContract.sampleRateHz !== EXPECTED_STREAM.sampleRateHz
  ) {
    throw new Error("Experience audio reference silence stream does not match");
  }

  const manifestBytes = readBoundedRegularFile({
    filePath: path.join(rootDirectory, "manifest.json"),
    label: "Experience audio manifest",
    maxBytes: MAX_MANIFEST_BYTES,
  });
  const manifest = requireRecord(
    JSON.parse(manifestBytes.toString("utf8")) as unknown,
    "Experience audio manifest",
  );
  assertFixedManifestContract(manifest);
  if (!Array.isArray(manifest.entries)) {
    throw new Error("Experience audio manifest entries must be an array");
  }
  const entries = manifest.entries.map(parseManifestEntry);
  const beatKeys = new Set<string>();
  const files = new Set<string>();
  for (const entry of entries) {
    if (beatKeys.has(entry.beatKey)) {
      throw new Error(`Duplicate Experience audio beat key: ${entry.beatKey}`);
    }
    beatKeys.add(entry.beatKey);
    if (files.has(entry.mp3Path)) {
      throw new Error(`Duplicate Experience audio MP3 path: ${entry.mp3Path}`);
    }
    files.add(entry.mp3Path);
  }
  if (
    entries.length !== EXPECTED_BEAT_KEYS.length + 1 ||
    !beatKeys.has("memory-intro") ||
    EXPECTED_BEAT_KEYS.some((beatKey) => !beatKeys.has(beatKey))
  ) {
    throw new Error("Experience audio manifest coverage is partial");
  }

  const assets = new Map<string, StoredExperienceAudioAsset>();
  for (const entry of entries) {
    assets.set(
      entry.beatKey,
      readValidatedAsset({ entry, referenceContract, rootDirectory }),
    );
  }
  const memoryIntro = assets.get("memory-intro");
  if (!memoryIntro) {
    throw new Error("Experience audio Memory introduction is missing");
  }

  const pack: ExperienceAudioPack = {
    awayTeam: "FRA",
    forMoment(moment) {
      if (moment.provenance !== "synthetic_txline_shaped") return null;
      const delimiterIndex = moment.sourceEnvelopeId.lastIndexOf(
        EXPERIENCE_BEAT_DELIMITER,
      );
      if (delimiterIndex < 0) return null;
      const beatKey = moment.sourceEnvelopeId.slice(
        delimiterIndex + EXPERIENCE_BEAT_DELIMITER.length,
      );
      const asset = assets.get(beatKey);
      return asset && beatKey !== "memory-intro" ? cloneAsset(asset) : null;
    },
    homeTeam: "ARG",
    locale: "en",
    get memoryIntro() {
      return cloneAsset(memoryIntro);
    },
    templateId: "five-minute-match",
    templateVersion: 3,
  };
  return Object.freeze(pack);
}
