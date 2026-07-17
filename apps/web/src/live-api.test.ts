import { describe, expect, it } from "vitest";

import {
  eventLabel,
  fixtureState,
  normalizeCatalog,
  normalizeFixture,
  parseCanonicalEvent,
} from "./live-api.js";

describe("live product API normalization", () => {
  it("renders dynamic catalog teams instead of enforcing a fixed team enum", () => {
    const catalog = normalizeCatalog({
      sourceLabel: "TXLINE · DEVNET SOURCE",
      teams: [
        {
          code: "MAR",
          colors: { primary: "#c1272d", secondary: "#006233" },
          name: "Morocco",
        },
      ],
    });

    expect(catalog.teams).toEqual([
      expect.objectContaining({ code: "MAR", name: "Morocco" }),
    ]);
  });

  it("accepts both team objects and legacy string codes in fixture responses", () => {
    const fixture = normalizeFixture({
      awayTeam: "MEX",
      fixtureId: "wc-final",
      homeTeam: { code: "ARG", name: "Argentina" },
      kickoffAt: "2026-07-19T19:00:00.000Z",
      minute: "67′",
      phase: "second_half",
      score: { away: 1, home: 2 },
    });

    expect(fixture).toMatchObject({
      awayTeam: "MEX",
      fixtureId: "wc-final",
      homeTeam: "ARG",
      homeTeamName: "Argentina",
      score: { away: 1, home: 2 },
    });
    expect(fixtureState(fixture!, Date.parse("2026-07-19T20:00:00.000Z"))).toBe(
      "live",
    );
  });

  it("normalizes a canonical SSE Moment without losing its revision identity", () => {
    const payload = parseCanonicalEvent(
      JSON.stringify({
        event: "moment.created",
        id: "stream:42",
        moment: {
          eventTeam: "ESP",
          id: "fixture:goal:42",
          identity: "fixture:goal:42:3",
          kind: "goal",
          minute: "82′",
          revision: 3,
          score: { away: 0, home: 1 },
          status: "confirmed",
        },
        snapshot: {
          awayTeam: "FRA",
          fixtureId: "fixture",
          homeTeam: "ESP",
          minute: "82′",
          phase: "second_half",
          score: { away: 0, home: 1 },
        },
      }),
    );

    expect(payload?.moment.identity).toBe("fixture:goal:42:3");
    expect(eventLabel(payload!.moment)).toBe("Goal");
  });
});
