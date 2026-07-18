import { describe, expect, it, vi } from "vitest";

import * as databaseModule from "./index.js";

type QueryRow = Record<string, unknown>;
type UnsafeQuery = (
  query: string,
  parameters?: readonly unknown[],
) => Promise<readonly QueryRow[]>;

interface TestClient {
  begin<T>(
    work: (transaction: { unsafe: UnsafeQuery }) => Promise<T>,
  ): Promise<T>;
  unsafe: UnsafeQuery;
}

type TeamCatalogEntry = {
  code: string;
  name: string;
  participantId: string;
  sourceTimestampMs: number;
};

type TeamCatalogRepository = {
  list(): Promise<readonly TeamCatalogEntry[]>;
  upsert(entries: readonly TeamCatalogEntry[]): Promise<void>;
};

type DatabaseModuleContract = {
  createTeamCatalogRepository?: (client: TestClient) => TeamCatalogRepository;
};

const db = databaseModule as DatabaseModuleContract;

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
    } satisfies TestClient,
    queries,
  };
}

const argentina: TeamCatalogEntry = {
  code: "ARG",
  name: "Argentina",
  participantId: "participant-argentina",
  sourceTimestampMs: 1_784_487_600_000,
};

describe("team catalogue repository", () => {
  it("persists only validated live identities and reads the public catalogue deterministically", async () => {
    const fake = testClient((query) =>
      query.includes("FROM matchsense.team_catalog_entries")
        ? [
            {
              code: "ARG",
              name: "Argentina",
              participant_id: "participant-argentina",
              source_timestamp_ms: "1784487600000",
            },
          ]
        : [],
    );

    expect(db.createTeamCatalogRepository).toBeTypeOf("function");
    const catalogue = db.createTeamCatalogRepository?.(fake.client);

    await expect(catalogue?.upsert([argentina])).resolves.toBeUndefined();
    await expect(catalogue?.list()).resolves.toEqual([argentina]);

    const upsert = fake.queries.find(({ query }) =>
      query.includes("INSERT INTO matchsense.team_catalog_entries"),
    );
    expect(upsert?.parameters).toEqual([
      argentina.participantId,
      argentina.code,
      argentina.name,
      argentina.sourceTimestampMs,
    ]);
    expect(upsert?.query).toContain("ON CONFLICT (participant_id) DO UPDATE");
    expect(upsert?.query).toMatch(
      /EXCLUDED\.source_timestamp_ms > (?:matchsense\.)?team_catalog_entries\.source_timestamp_ms/u,
    );

    const list = fake.queries.find(({ query }) =>
      query.includes("FROM matchsense.team_catalog_entries"),
    );
    expect(list?.query).toContain("ORDER BY code ASC, participant_id ASC");
    expect(list?.query).not.toContain("SELECT *");
  });

  it("rejects malformed, ambiguous, or unsafe input before it reaches PostgreSQL", async () => {
    const fake = testClient(() => []);
    const catalogue = db.createTeamCatalogRepository?.(fake.client);

    await expect(
      catalogue?.upsert([{ ...argentina, code: "arg" }]),
    ).rejects.toThrow("Team catalogue code is invalid");
    await expect(
      catalogue?.upsert([{ ...argentina, name: "   " }]),
    ).rejects.toThrow("Team catalogue name is required");
    await expect(
      catalogue?.upsert([{ ...argentina, sourceTimestampMs: -1 }]),
    ).rejects.toThrow("Team catalogue source timestamp is invalid");
    await expect(
      catalogue?.upsert([
        argentina,
        {
          ...argentina,
          code: "ARA",
          name: "Argentina Alternate",
        },
      ]),
    ).rejects.toThrow("same timestamp has conflicting identity");
    expect(fake.queries).toHaveLength(0);
  });

  it("canonicalizes whitespace while preserving the first stable team code", async () => {
    const fake = testClient(() => []);
    const catalogue = db.createTeamCatalogRepository?.(fake.client);

    await expect(
      catalogue?.upsert([
        {
          ...argentina,
          code: " ARG ",
          name: " Argentina ",
          participantId: " participant-argentina ",
        },
      ]),
    ).resolves.toBeUndefined();

    const upsert = fake.queries.find(({ query }) =>
      query.includes("INSERT INTO matchsense.team_catalog_entries"),
    );
    expect(upsert?.parameters).toEqual([
      argentina.participantId,
      argentina.code,
      argentina.name,
      argentina.sourceTimestampMs,
    ]);
    expect(upsert?.query).not.toContain("SET code = EXCLUDED.code");
  });
});
