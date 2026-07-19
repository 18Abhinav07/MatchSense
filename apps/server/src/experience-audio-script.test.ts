import { describe, expect, it } from "vitest";

import {
  EXPERIENCE_AUDIO_SCRIPT,
  EXPERIENCE_MEMORY_INTRO,
} from "./experience-audio-script.js";
import { EXPERIENCE_BEAT_KEYS } from "./experience-runtime.js";

describe("authored Experience audio script", () => {
  it("has one unique transcript for every authored Experience beat", () => {
    const audioKeys = EXPERIENCE_AUDIO_SCRIPT.map(({ beatKey }) => beatKey);
    expect(new Set(audioKeys).size).toBe(audioKeys.length);
    expect([...audioKeys].sort()).toEqual([...EXPERIENCE_BEAT_KEYS].sort());
  });

  it("keeps every transcript nonempty and within 200 Unicode characters", () => {
    for (const entry of EXPERIENCE_AUDIO_SCRIPT) {
      expect(entry.transcript.trim(), entry.beatKey).not.toBe("");
      expect(
        Array.from(entry.transcript).length,
        entry.beatKey,
      ).toBeLessThanOrEqual(200);
    }
  });

  it("provides a concise nonempty Match Memory introduction", () => {
    expect(EXPERIENCE_MEMORY_INTRO.trim()).not.toBe("");
    expect(Array.from(EXPERIENCE_MEMORY_INTRO).length).toBeLessThanOrEqual(200);
  });
});
