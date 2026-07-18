import { describe, expect, it, vi } from "vitest";

import {
  createFixtureReadRepository,
  type FixtureReadRepository,
} from "./index.js";

type QueryRow = Record<string, unknown>;
type UnsafeQuery = (
  query: string,
  parameters?: readonly unknown[],
) => Promise<readonly QueryRow[]>;

function fixtureRow(overrides: Partial<QueryRow> = {}): QueryRow {
  return {
    archive_manifest_id: null,
    archive_status: null,
    away_team_id: "FRA",
    fixture_id: "fx-1",
    fixture_mode: "live",
    fixture_status: "scheduled",
    home_team_id: "ARG",
    kickoff_at: "2026-07-11T12:00:00.000Z",
    metadata: "{}",
    projection_payload: null,
    projection_revision: null,
    projection_source_sequence: null,
    projection_updated_at: null,
    provenance: "live_txline",
    ...overrides,
  };
}

function testClient(
  resolve: (
    query: string,
    parameters: readonly unknown[],
  ) => readonly QueryRow[] | Promise<readonly QueryRow[]>,
) {
  const queries: { parameters: readonly unknown[]; query: string }[] = [];
  const unsafe = vi.fn<UnsafeQuery>(async (query, parameters = []) => {
    queries.push({ parameters, query });
    return resolve(query, parameters);
  });
  return {
    client: {
      begin: async <T>(
        work: (transaction: { unsafe: UnsafeQuery }) => Promise<T>,
      ) => work({ unsafe }),
      unsafe,
    },
    queries,
  };
}

describe("fixture read repository", () => {
  it("derives the final history bucket from stored lifecycle rather than elapsed kickoff time", async () => {
    const fake = testClient((query) => {
      if (query.includes("FROM matchsense.fixtures AS fixture")) {
        return [
          fixtureRow(),
          fixtureRow({
            archive_manifest_id: "archive-final",
            archive_status: "REPLAY_READY",
            fixture_id: "fx-2",
            fixture_status: "final",
            projection_payload: JSON.stringify({
              fixtureId: "fx-2",
              phase: "full_time",
              score: { away: 1, home: 2 },
            }),
            projection_revision: "8",
            projection_updated_at: "2026-07-11T15:00:00.000Z",
          }),
        ];
      }
      return [];
    });
    const repository = createFixtureReadRepository(fake.client);

    await expect(repository.listFixtures({ bucket: "final" })).resolves.toEqual(
      [
        expect.objectContaining({
          bucket: "final",
          fixtureId: "fx-2",
          lifecycle: "final",
          replayReady: true,
        }),
      ],
    );
  });

  it("returns a reset feed when the supplied durable cursor does not exist", async () => {
    const fake = testClient((query) => {
      if (query.includes("FROM matchsense.fixtures AS fixture")) {
        return [
          fixtureRow({
            fixture_status: "live",
            projection_payload: JSON.stringify({ fixtureId: "fx-1" }),
            projection_revision: "4",
            projection_updated_at: "2026-07-18T12:00:00.000Z",
          }),
        ];
      }
      if (query.includes("AS high_water_sequence")) {
        return [{ earliest_sequence: "1", high_water_sequence: "4" }];
      }
      if (query.includes("AS cursor_exists")) return [{ cursor_exists: false }];
      if (query.includes("FROM matchsense.fixture_events")) {
        return [
          {
            created_at: "2026-07-18T12:00:00.000Z",
            event_id: "fx-1:4",
            event_type: "moment.created",
            payload: JSON.stringify({ event: "moment.created" }),
            sequence: "4",
          },
        ];
      }
      return [];
    });
    const repository = createFixtureReadRepository(fake.client);

    await expect(
      repository.readFixtureFeed({ afterSequence: 3, fixtureId: "fx-1" }),
    ).resolves.toMatchObject({
      events: [expect.objectContaining({ sequence: 4 })],
      highWaterSequence: 4,
      reset: true,
      snapshot: expect.objectContaining({ fixtureId: "fx-1" }),
    });
  });

  it("resolves a requested Moment revision and its latest durable revision", async () => {
    const fake = testClient((query, parameters) => {
      if (query.includes("FROM matchsense.fixtures AS fixture")) {
        return [
          fixtureRow({
            fixture_status: "live",
            projection_payload: JSON.stringify({ fixtureId: "fx-1" }),
            projection_revision: "7",
            projection_updated_at: "2026-07-18T12:00:00.000Z",
          }),
        ];
      }
      if (query.includes("FROM matchsense.canonical_moments")) {
        expect(parameters).toEqual(["live", "fx-1", "goal-family"]);
        return [{ current_revision: "3" }];
      }
      if (query.includes("FROM matchsense.moment_revisions")) {
        const revision = parameters.at(-1);
        return [
          {
            created_at: "2026-07-18T12:00:00.000Z",
            payload: JSON.stringify({ id: "goal-family", revision }),
            revision: String(revision),
            source_record_id: "source-1",
          },
        ];
      }
      return [];
    });
    const repository = createFixtureReadRepository(fake.client);

    await expect(
      repository.readMoment({
        familyId: "goal-family",
        fixtureId: "fx-1",
        revision: 2,
      }),
    ).resolves.toMatchObject({
      latest: expect.objectContaining({ revision: 3 }),
      requested: expect.objectContaining({ revision: 2 }),
      superseded: true,
    });
  });

  it("exposes a replay fixture only from a REPLAY_READY archive manifest", async () => {
    const fake = testClient((query, parameters) => {
      if (
        query.includes("archive.status = 'REPLAY_READY'") &&
        parameters[0] === "fx-final"
      ) {
        return [
          fixtureRow({
            archive_manifest_id: "archive-final",
            archive_status: "REPLAY_READY",
            fixture_id: "fx-final",
            fixture_status: "final",
            projection_payload: JSON.stringify({ fixtureId: "fx-final" }),
            projection_revision: "9",
            projection_updated_at: "2026-07-18T12:00:00.000Z",
          }),
        ];
      }
      return [];
    });
    const repository: FixtureReadRepository = createFixtureReadRepository(
      fake.client,
    );

    await expect(repository.getReplayReady("fx-final")).resolves.toMatchObject({
      archiveManifestId: "archive-final",
      fixture: expect.objectContaining({ fixtureId: "fx-final" }),
    });
    await expect(repository.getReplayReady("fx-missing")).resolves.toBeNull();
  });
});
