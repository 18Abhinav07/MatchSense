import { describe, expect, it } from "vitest";

import type { VerifiedFixtureMemory } from "./memory-api.js";
import { verifiedMemoryView } from "./memory-view.js";

const memory: VerifiedFixtureMemory = {
  archiveManifestId: "archive-ready",
  fixture: {
    archiveManifestId: "archive-ready",
    archiveStatus: "REPLAY_READY",
    awayTeam: "FRA",
    fixtureId: "arg-fra",
    homeTeam: "ARG",
    lifecycle: "FINAL",
    minute: "FT",
    mode: "recorded",
    provenance: "recorded_txline_authorised",
    score: { away: 1, home: 2 },
  },
  timeline: [
    {
      createdAt: "2026-07-18T15:00:00.000Z",
      eventId: "goal-1",
      eventType: "moment.created",
      moment: {
        celebratesGoal: true,
        eventTeam: "ARG",
        id: "goal-1",
        identity: "goal-1:2",
        kind: "goal",
        minute: "81'",
        revision: 2,
        score: { away: 1, home: 2 },
        status: "confirmed",
      },
      sequence: 14,
    },
  ],
};

describe("verified Match Memory view model", () => {
  it("uses only verified final facts and canonical Moments", () => {
    expect(verifiedMemoryView(memory)).toEqual({
      archiveManifestId: "archive-ready",
      fixture: memory.fixture,
      moments: [memory.timeline[0]?.moment],
      summary: "ARG 2—1 FRA · final archive verified",
    });
  });
});
