import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  assertCompatibleMp3Streams,
  createPacedMp3Chunks,
  inspectMp3,
  resolveMp3WriteIntervalMs,
  splitMp3Frames,
} from "./mp3.js";

describe("generated MP3 fixtures", () => {
  it("are complete constant mono CBR streams with one shared frame contract", async () => {
    const [silenceBytes, cueBytes] = await Promise.all([
      readFile(new URL("../assets/silence.mp3", import.meta.url)),
      readFile(new URL("../assets/goal-cue.mp3", import.meta.url)),
    ]);
    const silence = inspectMp3(silenceBytes);
    const cue = inspectMp3(cueBytes);

    expect(silence.channels).toBe(1);
    expect(silence.bitrateKbps).toBe(64);
    expect(silence.sampleRateHz).toBe(44_100);
    expect(silence.durationMs).toBeGreaterThan(900);
    expect(() => assertCompatibleMp3Streams(silence, cue)).not.toThrow();
    expect(resolveMp3WriteIntervalMs(silence)).toBe(
      Math.round(silence.durationMs),
    );
  });

  it("pads paced commentary only with complete compatible MP3 frames", async () => {
    const [silenceBytes, cueBytes] = await Promise.all([
      readFile(new URL("../assets/silence.mp3", import.meta.url)),
      readFile(new URL("../assets/goal-cue.mp3", import.meta.url)),
    ]);
    const cueFrames = splitMp3Frames(cueBytes);
    const commentary = Buffer.concat([
      ...cueFrames,
      ...cueFrames,
      ...cueFrames.slice(0, 7),
    ]);

    const chunks = createPacedMp3Chunks(commentary, silenceBytes);
    const silence = inspectMp3(silenceBytes);

    expect(chunks).toHaveLength(3);
    for (const chunk of chunks) {
      const contract = inspectMp3(chunk);
      expect(contract.frameCount).toBe(silence.frameCount);
      expect(() => assertCompatibleMp3Streams(silence, contract)).not.toThrow();
    }
  });
});
