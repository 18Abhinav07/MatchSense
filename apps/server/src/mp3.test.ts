import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { assertCompatibleMp3Streams, inspectMp3 } from "./mp3.js";

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
  });
});
