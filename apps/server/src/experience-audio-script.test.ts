import { describe, expect, it } from "vitest";

import {
  EXPERIENCE_AUDIO_SCRIPT,
  EXPERIENCE_MEMORY_INTRO,
} from "./experience-audio-script.js";
describe("authored Experience audio script", () => {
  it("exposes a runtime-frozen transcript registry", () => {
    expect(Object.isFrozen(EXPERIENCE_AUDIO_SCRIPT)).toBe(true);
    expect(Array.isArray(EXPERIENCE_AUDIO_SCRIPT)).toBe(false);
  });

  it("keeps every transcript nonempty and within 200 Unicode characters", () => {
    for (const [beatKey, transcript] of Object.entries(
      EXPERIENCE_AUDIO_SCRIPT,
    )) {
      expect(typeof transcript, beatKey).toBe("string");
      if (typeof transcript !== "string") continue;
      expect(transcript.trim(), beatKey).not.toBe("");
      expect(Array.from(transcript).length, beatKey).toBeLessThanOrEqual(200);
    }
  });

  it("provides a concise nonempty Match Memory introduction", () => {
    expect(EXPERIENCE_MEMORY_INTRO.trim()).not.toBe("");
    expect(Array.from(EXPERIENCE_MEMORY_INTRO).length).toBeLessThanOrEqual(200);
  });
});
