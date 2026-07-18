import type { FixtureTruthRepository } from "@matchsense/db";
import type { TxlineScheduleFixture } from "@matchsense/txline-adapter";
import { describe, expect, it, vi } from "vitest";

import {
  createScheduleSync,
  durableFixtureFromSchedule,
  durableTeamCatalogFromSchedule,
} from "./schedule-sync.js";

const scheduleFixture: TxlineScheduleFixture = {
  competition: "World Cup",
  competitionId: "72",
  fixtureGroupId: "group-a",
  fixtureId: "fixture-1",
  gameState: 1,
  participant1: { id: "team-arg", name: "Argentina" },
  participant1IsHome: true,
  participant2: { id: "team-fra", name: "France" },
  sourceTimestampMs: 1_784_403_000_000,
  startTimeMs: 1_784_408_400_000,
};

const fence = {
  fencingToken: 3,
  holderId: "collector-a",
  source: "txline",
  streamKey: "scores:mainnet",
};

const knownTxlineCountryCodes = [
  ["Algeria", "ALG"],
  ["Argentina", "ARG"],
  ["Australia", "AUS"],
  ["Austria", "AUT"],
  ["Belgium", "BEL"],
  ["Bolivia", "BOL"],
  ["Bosnia & Herzegovina", "BIH"],
  ["Brazil", "BRA"],
  ["Cameroon", "CMR"],
  ["Canada", "CAN"],
  ["Cape Verde", "CPV"],
  ["Chile", "CHI"],
  ["Colombia", "COL"],
  ["Costa Rica", "CRC"],
  ["Cote d'Ivoire", "CIV"],
  ["Côte d'Ivoire", "CIV"],
  ["Croatia", "CRO"],
  ["Curacao", "CUW"],
  ["Curaçao", "CUW"],
  ["Democratic Republic of the Congo", "COD"],
  ["Congo DR", "COD"],
  ["DR Congo", "COD"],
  ["Denmark", "DEN"],
  ["Ecuador", "ECU"],
  ["Egypt", "EGY"],
  ["England", "ENG"],
  ["Finland", "FIN"],
  ["France", "FRA"],
  ["Germany", "GER"],
  ["Ghana", "GHA"],
  ["Haiti", "HAI"],
  ["Iceland", "ISL"],
  ["Iran", "IRN"],
  ["Iraq", "IRQ"],
  ["Ivory Coast", "CIV"],
  ["Jamaica", "JAM"],
  ["Japan", "JPN"],
  ["Jordan", "JOR"],
  ["Korea Republic", "KOR"],
  ["Mexico", "MEX"],
  ["Morocco", "MAR"],
  ["Netherlands", "NED"],
  ["New Zealand", "NZL"],
  ["Nigeria", "NGA"],
  ["Norway", "NOR"],
  ["Panama", "PAN"],
  ["Paraguay", "PAR"],
  ["Poland", "POL"],
  ["Portugal", "POR"],
  ["Qatar", "QAT"],
  ["Saudi Arabia", "KSA"],
  ["Scotland", "SCO"],
  ["Senegal", "SEN"],
  ["Serbia", "SRB"],
  ["South Africa", "RSA"],
  ["South Korea", "KOR"],
  ["Spain", "ESP"],
  ["Sweden", "SWE"],
  ["Switzerland", "SUI"],
  ["Tunisia", "TUN"],
  ["Turkey", "TUR"],
  ["Türkiye", "TUR"],
  ["Ukraine", "UKR"],
  ["United States", "USA"],
  ["USA", "USA"],
  ["Uruguay", "URU"],
  ["Uzbekistan", "UZB"],
  ["Wales", "WAL"],
] as const;

describe("durable schedule sync", () => {
  it.each(knownTxlineCountryCodes)(
    "normalizes known TxLINE participant name %s to %s",
    (name, code) => {
      const product = durableFixtureFromSchedule({
        ...scheduleFixture,
        participant1: { id: `participant-${code}`, name },
      });

      expect(product.homeTeam).toBe(code);
    },
  );

  it("builds one freshest team identity per participant from every roster schedule slice", () => {
    const older = {
      ...scheduleFixture,
      fixtureId: "fixture-older",
      participant1: { id: "team-arg", name: "Argentina" },
      participant2: { id: "team-fra", name: "France" },
      sourceTimestampMs: 1,
    };
    const fresher = {
      ...scheduleFixture,
      fixtureId: "fixture-fresher",
      participant1: { id: "team-arg", name: "Argentina" },
      participant2: { id: "team-esp", name: "Spain" },
      sourceTimestampMs: 2,
    };

    expect(durableTeamCatalogFromSchedule([older, fresher])).toEqual([
      {
        code: "ARG",
        name: "Argentina",
        participantId: "team-arg",
        sourceTimestampMs: 2,
      },
      {
        code: "ESP",
        name: "Spain",
        participantId: "team-esp",
        sourceTimestampMs: 2,
      },
      {
        code: "FRA",
        name: "France",
        participantId: "team-fra",
        sourceTimestampMs: 1,
      },
    ]);
  });

  it("rejects a same-timestamp participant identity contradiction", () => {
    const first = {
      ...scheduleFixture,
      fixtureId: "fixture-first",
      participant1: { id: "team-arg", name: "Argentina" },
      sourceTimestampMs: 3,
    };
    const contradictory = {
      ...scheduleFixture,
      fixtureId: "fixture-contradictory",
      participant1: { id: "team-arg", name: "Argentina Revised" },
      sourceTimestampMs: 3,
    };

    expect(() =>
      durableTeamCatalogFromSchedule([first, contradictory]),
    ).toThrow("Team catalogue same timestamp has conflicting identity");
  });

  it("keeps unknown participant codes unique instead of collapsing fan identities", () => {
    const first = durableFixtureFromSchedule({
      ...scheduleFixture,
      fixtureId: "fixture-unknown-1",
      participant1: { id: "participant-1", name: "Alpha United" },
      participant2: { id: "opponent-1", name: "Opponent One" },
    });
    const second = durableFixtureFromSchedule({
      ...scheduleFixture,
      fixtureId: "fixture-unknown-2",
      participant1: { id: "participant-2", name: "Alphaville" },
      participant2: { id: "opponent-2", name: "Opponent Two" },
    });

    expect(first.homeTeam).not.toBe(second.homeTeam);
  });

  it("keeps distinct numeric participant ids unique when their final twelve digits match", () => {
    const first = durableFixtureFromSchedule({
      ...scheduleFixture,
      fixtureId: "fixture-numeric-unknown-1",
      participant1: { id: "1000123456789012", name: "Alpha United" },
      participant2: { id: "4000123456789012", name: "Opponent One" },
    });
    const second = durableFixtureFromSchedule({
      ...scheduleFixture,
      fixtureId: "fixture-numeric-unknown-2",
      participant1: { id: "2000123456789012", name: "Alphaville" },
      participant2: { id: "5000123456789012", name: "Opponent Two" },
    });

    expect(first.homeTeam).not.toBe(second.homeTeam);
  });

  it("persists a source-timestamped schedule observation and creates a mutable fixture", async () => {
    const repository: Pick<FixtureTruthRepository, "observeFixtureSchedule"> = {
      observeFixtureSchedule: vi.fn(async () => ({
        fixture: {} as never,
        kind: "committed" as const,
        metadataUpdated: true,
      })),
    };
    const sync = createScheduleSync({
      repository,
      rightsGrantId: "grant-1",
      sourceFence: fence,
    });

    await expect(sync.sync([scheduleFixture])).resolves.toEqual({
      observed: 1,
      updated: 1,
    });
    expect(repository.observeFixtureSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        fixture: expect.objectContaining({
          awayTeamId: "FRA",
          homeTeamId: "ARG",
          id: "fixture-1",
          status: "scheduled",
        }),
        observation: expect.objectContaining({
          observedAt: new Date(scheduleFixture.sourceTimestampMs).toISOString(),
          responseHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          rightsGrantId: "grant-1",
        }),
        sourceFence: fence,
      }),
    );
  });

  it("retains a schedule observation but cannot overwrite a tracking or final fixture", async () => {
    const repository: Pick<FixtureTruthRepository, "observeFixtureSchedule"> = {
      observeFixtureSchedule: vi.fn(async () => ({
        fixture: {} as never,
        kind: "committed" as const,
        metadataUpdated: false,
      })),
    };
    const sync = createScheduleSync({
      repository,
      rightsGrantId: "grant-1",
      sourceFence: fence,
    });

    await expect(sync.sync([scheduleFixture])).resolves.toEqual({
      observed: 1,
      updated: 0,
    });
    expect(repository.observeFixtureSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        fixture: expect.objectContaining({ id: scheduleFixture.fixtureId }),
        sourceFence: fence,
      }),
    );
  });
});
