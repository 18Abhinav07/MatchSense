import { describe, expect, it } from "vitest";

import type { VerifiedFixtureMemory } from "./memory-api.js";
import {
  loadVerifiedMemory,
  loadVerifiedMemoryHistory,
} from "./memory-loader.js";

const memory = {
  archiveManifestId: "archive-final",
  fixture: {
    archiveManifestId: "archive-final",
    archiveStatus: "REPLAY_READY",
    awayTeam: "FRA",
    fixtureId: "fx-final",
    homeTeam: "ARG",
    lifecycle: "FINAL",
    minute: "FT",
    mode: "recorded",
    provenance: "recorded_txline_authorised",
    score: { away: 1, home: 2 },
  },
  timeline: [],
} as VerifiedFixtureMemory;

describe("verified Memory loading", () => {
  it("returns the archive-backed response without a browser fallback", async () => {
    await expect(
      loadVerifiedMemory({ fetchRemote: async () => memory }),
    ).resolves.toEqual({ memory, source: "archive-verified" });
  });

  it("propagates an unavailable archive instead of rendering device-created history", async () => {
    await expect(
      loadVerifiedMemory({
        fetchRemote: async () => {
          throw new Error("archive unavailable");
        },
      }),
    ).rejects.toThrow("archive unavailable");
  });

  it("returns only server-verified history entries", async () => {
    await expect(
      loadVerifiedMemoryHistory({ fetchRemote: async () => [memory] }),
    ).resolves.toEqual({ entries: [memory], source: "archive-verified" });
  });
});
