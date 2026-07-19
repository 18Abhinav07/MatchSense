import { createHash } from "node:crypto";
import {
  cp,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CanonicalMoment, DataProvenance } from "@matchsense/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadExperienceAudioPack,
  type ExperienceAudioPack,
} from "./experience-audio-pack.js";
import { inspectMp3 } from "./mp3.js";

const COMMITTED_PACK = fileURLToPath(
  new URL("../assets/experience/v3/en", import.meta.url),
);
const SILENCE = new URL("../assets/silence.mp3", import.meta.url);
const createdDirectories: string[] = [];

interface MutableManifestEntry {
  beatKey: string;
  durationMs: number;
  kind: string;
  minute: string;
  mp3Path: string;
  sha256: string;
  transcript: string;
}

interface MutableManifest {
  entries: MutableManifestEntry[];
  [key: string]: unknown;
}

let packRoot = "";
let silenceBytes: Buffer;

beforeEach(async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "matchsense-pack-loader-"),
  );
  createdDirectories.push(directory);
  packRoot = path.join(directory, "pack");
  await cp(COMMITTED_PACK, packRoot, { recursive: true });
  silenceBytes = await readFile(SILENCE);
});

afterEach(async () => {
  await Promise.all(
    createdDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

function moment(
  sourceEnvelopeId: string,
  provenance: DataProvenance = "synthetic_txline_shaped",
): CanonicalMoment {
  return {
    celebratesGoal: true,
    eventTeam: "ARG",
    familyId: "family-1",
    fixtureId: "experience-fixture",
    id: "moment-1",
    identity: "moment-1:1",
    kind: "goal",
    minute: "78'",
    occurredAt: null,
    provenance,
    revision: 1,
    score: { away: 1, home: 2 },
    sourceEnvelopeId,
    status: "confirmed",
  };
}

async function mutateManifest(change: (manifest: MutableManifest) => void) {
  const manifestPath = path.join(packRoot, "manifest.json");
  const manifest = JSON.parse(
    await readFile(manifestPath, "utf8"),
  ) as MutableManifest;
  change(manifest);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function syntheticMp3(input: {
  bitrateKbps: 32 | 64;
  channels: 1 | 2;
  sampleRateHz: 44_100 | 48_000;
}) {
  const bitrateIndex = input.bitrateKbps === 64 ? 5 : 1;
  const sampleRateIndex = input.sampleRateHz === 44_100 ? 0 : 1;
  const frameLength = Math.floor(
    (144 * input.bitrateKbps * 1_000) / input.sampleRateHz,
  );
  const frames = Array.from({ length: 4 }, () => {
    const frame = Buffer.alloc(frameLength);
    frame[0] = 0xff;
    frame[1] = 0xfb;
    frame[2] = (bitrateIndex << 4) | (sampleRateIndex << 2);
    frame[3] = input.channels === 1 ? 0xc0 : 0;
    return frame;
  });
  return Buffer.concat(frames);
}

async function replaceWinningGoal(bytes: Buffer) {
  const file = path.join(packRoot, "winning-goal.mp3");
  await writeFile(file, bytes);
  await mutateManifest((manifest) => {
    const entry = manifest.entries.find(
      ({ beatKey }) => beatKey === "winning-goal",
    );
    if (!entry) throw new Error("test manifest lost winning-goal");
    entry.durationMs = Math.round(inspectMp3(bytes).durationMs);
    entry.sha256 = createHash("sha256").update(bytes).digest("hex");
  });
}

function load(): ExperienceAudioPack {
  return loadExperienceAudioPack(packRoot, {
    referenceSilenceBytes: silenceBytes,
  });
}

describe("loadExperienceAudioPack", () => {
  it("loads and validates the real committed ARG-FRA v3 English pack", () => {
    const pack = load();

    expect(pack).toMatchObject({
      awayTeam: "FRA",
      homeTeam: "ARG",
      locale: "en",
      templateId: "five-minute-match",
      templateVersion: 3,
    });
    expect(pack.forMoment(moment("run-1:beat:winning-goal"))).toMatchObject({
      beatKey: "winning-goal",
      transcript:
        "Goal for Argentina! They strike late and lead France two goals to one.",
    });
    expect(pack.memoryIntro.transcript).toMatch(/match summary/i);
  });

  it("fails closed when a referenced MP3 is missing", async () => {
    await unlink(path.join(packRoot, "winning-goal.mp3"));
    expect(load).toThrow(/winning-goal\.mp3|missing|ENOENT/i);
  });

  it("rejects symlinked manifest and MP3 files before reading them", async () => {
    const manifestPath = path.join(packRoot, "manifest.json");
    const manifestTarget = path.join(packRoot, "manifest-target.json");
    await rename(manifestPath, manifestTarget);
    await symlink("manifest-target.json", manifestPath);
    expect(load).toThrow(/manifest.*regular|symlink/i);

    await unlink(manifestPath);
    await rename(manifestTarget, manifestPath);
    const mp3Path = path.join(packRoot, "winning-goal.mp3");
    const mp3Target = path.join(packRoot, "winning-goal-target.mp3");
    await rename(mp3Path, mp3Target);
    await symlink("winning-goal-target.mp3", mp3Path);
    expect(load).toThrow(/winning-goal.*regular|symlink/i);
  });

  it("rejects oversized manifests and MP3s before reading them", async () => {
    const manifestPath = path.join(packRoot, "manifest.json");
    await truncate(manifestPath, 256 * 1_024 + 1);
    expect(load).toThrow(/manifest.*large|256/i);

    await cp(COMMITTED_PACK, packRoot, { force: true, recursive: true });
    await truncate(
      path.join(packRoot, "winning-goal.mp3"),
      2 * 1_024 * 1_024 + 1,
    );
    expect(load).toThrow(/winning-goal.*large|2 MiB/i);
  });

  it("fails closed when an asset SHA-256 does not match", async () => {
    await mutateManifest((manifest) => {
      const entry = manifest.entries.find(
        ({ beatKey }) => beatKey === "winning-goal",
      );
      if (entry) entry.sha256 = "0".repeat(64);
    });
    expect(load).toThrow(/sha-?256|hash/i);
  });

  it("rejects duplicate beat keys and duplicate asset files", async () => {
    await mutateManifest((manifest) => {
      const entry = manifest.entries[0];
      if (entry) manifest.entries.push({ ...entry });
    });
    expect(load).toThrow(/duplicate/i);

    await cp(COMMITTED_PACK, packRoot, { force: true, recursive: true });
    await mutateManifest((manifest) => {
      const first = manifest.entries[0];
      const second = manifest.entries[1];
      if (first && second) second.mp3Path = first.mp3Path;
    });
    expect(load).toThrow(/duplicate/i);
  });

  it("rejects a partial pack without the Memory introduction", async () => {
    await mutateManifest((manifest) => {
      manifest.entries = manifest.entries.filter(
        ({ beatKey }) => beatKey !== "memory-intro",
      );
    });
    expect(load).toThrow(/memory|partial|coverage/i);
  });

  it.each([
    {
      contract: {
        bitrateKbps: 32 as const,
        channels: 1 as const,
        sampleRateHz: 44_100 as const,
      },
      mismatch: "bitrate",
    },
    {
      contract: {
        bitrateKbps: 64 as const,
        channels: 1 as const,
        sampleRateHz: 48_000 as const,
      },
      mismatch: "sample rate",
    },
    {
      contract: {
        bitrateKbps: 64 as const,
        channels: 2 as const,
        sampleRateHz: 44_100 as const,
      },
      mismatch: "channels",
    },
  ])("rejects an asset with incompatible $mismatch", async ({ contract }) => {
    await replaceWinningGoal(syntheticMp3(contract));
    expect(load).toThrow(/MP3|stream|bitrate|sampleRateHz|channels/i);
  });

  it("rejects manifest duration and transcript drift", async () => {
    await mutateManifest((manifest) => {
      const entry = manifest.entries.find(
        ({ beatKey }) => beatKey === "winning-goal",
      );
      if (entry) entry.durationMs += 1_000;
    });
    expect(load).toThrow(/duration/i);

    await cp(COMMITTED_PACK, packRoot, { force: true, recursive: true });
    await mutateManifest((manifest) => {
      const entry = manifest.entries.find(
        ({ beatKey }) => beatKey === "winning-goal",
      );
      if (entry) entry.transcript = "Wrong words.";
    });
    expect(load).toThrow(/transcript/i);
  });

  it.each([
    ["kind", "card.red"],
    ["minute", "79'"],
  ] as const)("rejects authored beat %s drift", async (field, value) => {
    await mutateManifest((manifest) => {
      const entry = manifest.entries.find(
        ({ beatKey }) => beatKey === "winning-goal",
      );
      if (entry) entry[field] = value;
    });
    expect(load).toThrow(/metadata|kind|minute/i);
  });

  it("rejects unsafe asset paths", async () => {
    await mutateManifest((manifest) => {
      const entry = manifest.entries.find(
        ({ beatKey }) => beatKey === "winning-goal",
      );
      if (entry) entry.mp3Path = "../winning-goal.mp3";
    });
    expect(load).toThrow(/path|basename|filename/i);
  });

  it("returns null for unknown beats and live provenance", () => {
    const pack = load();
    expect(pack.forMoment(moment("run-1:beat:not-authored"))).toBeNull();
    expect(
      pack.forMoment(moment("run-1:beat:winning-goal", "live_txline")),
    ).toBeNull();
  });

  it("parses only the suffix after the final beat delimiter", () => {
    const pack = load();
    expect(
      pack.forMoment(moment("run:id:beat:old:beat:winning-goal"))?.beatKey,
    ).toBe("winning-goal");
  });

  it("isolates stored bytes from mutation through every returned asset", () => {
    const pack = load();
    const first = pack.forMoment(moment("run-1:beat:winning-goal"));
    const originalFirstByte = first?.bytes[0];
    expect(originalFirstByte).toBeDefined();
    if (!first || originalFirstByte === undefined) return;
    first.bytes[0] = 0;
    expect(pack.forMoment(moment("run-1:beat:winning-goal"))?.bytes[0]).toBe(
      originalFirstByte,
    );

    const intro = pack.memoryIntro;
    const originalIntroByte = intro.bytes[0];
    expect(originalIntroByte).toBeDefined();
    if (originalIntroByte === undefined) return;
    intro.bytes[0] = 0;
    expect(pack.memoryIntro.bytes[0]).toBe(originalIntroByte);
  });
});
