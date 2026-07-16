import { describe, expect, it } from "vitest";

import { adaptSyntheticEnvelope } from "@matchsense/txline-adapter";

import { createFixtureProjection, reduceSourceFact } from "./index.js";

describe("canonical fixture reducer", () => {
  it("creates one revision-linked goal moment and ignores duplicate source delivery", () => {
    const envelope = {
      id: "synthetic-goal-arg-fra-1",
      fixtureId: "arg-fra-demo",
      provenance: "synthetic_txline_shaped" as const,
      receivedAt: "2026-07-16T12:00:00.000Z",
      source: "replay" as const,
      supportedFact: {
        awayGoals: 0,
        homeGoals: 1,
        minute: "23'",
        type: "score_snapshot" as const,
      },
    };
    const fact = adaptSyntheticEnvelope(envelope);
    const cold = createFixtureProjection({
      awayTeam: "FRA",
      fixtureId: envelope.fixtureId,
      homeTeam: "ARG",
      kickoffAt: "2026-07-16T18:00:00.000Z",
      observedAt: "2026-07-16T11:59:00.000Z",
    });

    const first = reduceSourceFact(cold, fact);
    const duplicate = reduceSourceFact(first.projection, fact);

    expect(first.changed).toBe(true);
    expect(first.projection.score).toEqual({ away: 0, home: 1 });
    expect(first.projection.minute).toBe("23'");
    expect(cold.updatedAt).toBe("2026-07-16T11:59:00.000Z");
    expect(first.projection.updatedAt).toBe(envelope.receivedAt);
    expect(first.moment).toMatchObject({
      id: "arg-fra-demo:score:1-0",
      revision: 1,
      sourceEnvelopeId: envelope.id,
      status: "confirmed",
    });
    expect(first.moment?.identity).toBe("arg-fra-demo:score:1-0:1");
    expect(duplicate).toEqual({
      changed: false,
      moment: null,
      projection: first.projection,
    });
  });
});
