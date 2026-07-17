import { describe, expect, it, vi } from "vitest";

import {
  buildTxlineFixtureSnapshotPath,
  createTxlineAuthenticatedClient,
  fetchTxlineWorldCupSchedule,
  parseTxlineScheduleFixture,
} from "./index.js";

const franceEngland = {
  Competition: "World Cup",
  CompetitionId: 72,
  FixtureGroupId: 10_115_771,
  FixtureId: 18_257_865,
  GameState: 1,
  Participant1: "France",
  Participant1Id: 1_999,
  Participant1IsHome: true,
  Participant2: "England",
  Participant2Id: 1_888,
  StartTime: 1_784_408_400_000,
  Ts: 1_784_000_000_001,
} as const;

const spainArgentina = {
  Competition: "World Cup",
  CompetitionId: 72,
  FixtureGroupId: 10_115_676,
  FixtureId: 18_257_739,
  GameState: 3,
  Participant1: "Spain",
  Participant1Id: 3_021,
  Participant1IsHome: false,
  Participant2: "Argentina",
  Participant2Id: 1_489,
  StartTime: 1_784_487_600_000,
  Ts: 1_784_000_000_002,
} as const;

describe("TxLINE schedule contract", () => {
  it("parses only the observed schedule fields and normalizes numeric identifiers", () => {
    expect(parseTxlineScheduleFixture(franceEngland)).toEqual({
      competition: "World Cup",
      competitionId: "72",
      fixtureGroupId: "10115771",
      fixtureId: "18257865",
      gameState: 1,
      participant1: { id: "1999", name: "France" },
      participant1IsHome: true,
      participant2: { id: "1888", name: "England" },
      sourceTimestampMs: 1_784_000_000_001,
      startTimeMs: 1_784_408_400_000,
    });
    expect(parseTxlineScheduleFixture(spainArgentina)).toMatchObject({
      fixtureId: "18257739",
      gameState: 3,
      participant1IsHome: false,
    });
  });

  it("rejects a fixture with a missing required observed field without throwing", () => {
    const { Participant2: _missing, ...incomplete } = franceEngland;

    expect(parseTxlineScheduleFixture(incomplete)).toBeNull();
    expect(parseTxlineScheduleFixture(null)).toBeNull();
    expect(
      parseTxlineScheduleFixture({
        competition: "World Cup",
        fixtureId: 18_257_865,
      }),
    ).toBeNull();
  });

  it("builds the exact optional snapshot query without inventing pagination", () => {
    expect(buildTxlineFixtureSnapshotPath()).toBe("/api/fixtures/snapshot");
    expect(buildTxlineFixtureSnapshotPath({ startEpochDay: 20_648 })).toBe(
      "/api/fixtures/snapshot?startEpochDay=20648",
    );
    expect(buildTxlineFixtureSnapshotPath({ competitionId: 72 })).toBe(
      "/api/fixtures/snapshot?competitionId=72",
    );
    expect(
      buildTxlineFixtureSnapshotPath({
        competitionId: 72,
        startEpochDay: 20_648,
      }),
    ).toBe("/api/fixtures/snapshot?startEpochDay=20648&competitionId=72");
  });

  it("fetches World Cup competition 72 and neutrally excludes other competitions and invalid rows", async () => {
    const requested: string[] = [];
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("/auth/guest/start")) {
        return new Response(JSON.stringify({ token: "fixture-guest-jwt" }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify([
          franceEngland,
          spainArgentina,
          { ...franceEngland, CompetitionId: 999, FixtureId: 1 },
          { ...franceEngland, Participant1: undefined, FixtureId: 2 },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const client = createTxlineAuthenticatedClient({
      apiToken: "fixture-activated-server-token",
      fetchImpl,
    });

    const fixtures = await fetchTxlineWorldCupSchedule(client, {
      startEpochDay: 20_648,
    });

    expect(fixtures.map(({ fixtureId }) => fixtureId)).toEqual([
      "18257865",
      "18257739",
    ]);
    expect(requested).toContain(
      "https://txline-dev.txodds.com/api/fixtures/snapshot?startEpochDay=20648&competitionId=72",
    );
  });
});
