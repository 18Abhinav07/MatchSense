import type { FixtureTruthRepository } from "@matchsense/db";
import type { TxlineScheduleFixture } from "@matchsense/txline-adapter";
import { describe, expect, it, vi } from "vitest";

import { createScheduleSync } from "./schedule-sync.js";

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

describe("durable schedule sync", () => {
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
