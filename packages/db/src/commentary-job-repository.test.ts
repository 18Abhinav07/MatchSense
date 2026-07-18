import { createHash } from "node:crypto";

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

type CommentaryJobRepository = {
  claim(workerId: string, now: Date): Promise<unknown>;
  complete(input: Record<string, unknown>): Promise<void>;
  enqueue(input: Record<string, unknown>): Promise<unknown>;
  fail(input: Record<string, unknown>): Promise<void>;
  supersede(input: Record<string, unknown>): Promise<void>;
};

type DatabaseModuleContract = {
  createCommentaryJobRepository?: (
    client: TestClient,
  ) => CommentaryJobRepository;
};

const db = databaseModule as DatabaseModuleContract;

const jobInput = {
  familyId: "goal-23",
  fixtureId: "18237038",
  id: "job-goal-23-en",
  language: "en-IN",
  mode: "recorded",
  momentRevision: 1,
  templateVersion: "factual-v1",
  voice: "kore",
} as const;

const claimedJobRow = {
  artifact_id: null,
  artifact_sha256: null,
  attempt_count: 1,
  claim_expires_at: "2026-07-18T12:01:00.000Z",
  claimed_at: "2026-07-18T12:00:00.000Z",
  claimed_by: "worker-a",
  created_at: "2026-07-18T11:59:00.000Z",
  family_id: jobInput.familyId,
  fixture_id: jobInput.fixtureId,
  id: jobInput.id,
  language: jobInput.language,
  last_error: null,
  mode: jobInput.mode,
  moment_revision: String(jobInput.momentRevision),
  status: "claimed",
  template_version: jobInput.templateVersion,
  updated_at: "2026-07-18T12:00:00.000Z",
  voice: jobInput.voice,
};

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

describe("commentary job repository", () => {
  it("claims queued or expired work with SKIP LOCKED", async () => {
    const fake = testClient((query) =>
      query.includes("RETURNING") ? [claimedJobRow] : [],
    );
    const jobs = db.createCommentaryJobRepository?.(fake.client);

    await expect(
      jobs?.claim("worker-a", new Date("2026-07-18T12:00:00.000Z")),
    ).resolves.toMatchObject({ status: "claimed" });
    expect(fake.queries[0]?.query).toContain("FOR UPDATE SKIP LOCKED");
    expect(fake.queries[0]?.query).toContain(
      "claim_expires_at <= $2::timestamptz",
    );
  });

  it("only marks a claimed job ready while atomically saving nonempty hashed audio", async () => {
    const audioBytes = new Uint8Array([73, 68, 51, 4]);
    const audioHash = createHash("sha256").update(audioBytes).digest("hex");
    const fake = testClient((query) => {
      if (
        query.includes("SELECT") &&
        query.includes("matchsense.commentary_jobs")
      ) {
        return [claimedJobRow];
      }
      if (query.includes("INSERT INTO matchsense.commentary_artifacts")) {
        return [{ id: "artifact-canonical-identity" }];
      }
      if (query.includes("UPDATE matchsense.commentary_jobs")) {
        return [claimedJobRow];
      }
      return [];
    });
    const jobs = db.createCommentaryJobRepository?.(fake.client);

    await expect(
      jobs?.complete({
        artifactId: "artifact-goal-23-en",
        audioBytes,
        audioHash,
        jobId: jobInput.id,
        workerId: "worker-a",
      }),
    ).resolves.toBeUndefined();
    await expect(
      jobs?.complete({
        artifactId: "artifact-empty",
        audioBytes: new Uint8Array(),
        audioHash: createHash("sha256").update(new Uint8Array()).digest("hex"),
        jobId: jobInput.id,
        workerId: "worker-a",
      }),
    ).rejects.toThrow("Commentary audio bytes must not be empty");
    expect(
      fake.queries.some(({ query }) => query.includes("commentary_artifacts")),
    ).toBe(true);
    expect(
      fake.queries.some(({ query }) => query.includes("status = 'ready'")),
    ).toBe(true);
    const readyUpdate = fake.queries.find(({ query }) =>
      query.includes("UPDATE matchsense.commentary_jobs"),
    );
    expect(readyUpdate?.parameters[0]).toBe("artifact-canonical-identity");
  });

  it("reuses the unique artifact identity and retires superseded revisions", async () => {
    let enqueueCount = 0;
    const fake = testClient((query) => {
      if (query.includes("INSERT INTO matchsense.commentary_jobs")) {
        enqueueCount += 1;
        return [claimedJobRow];
      }
      if (query.includes("RETURNING id")) {
        return [{ id: jobInput.id }];
      }
      return [];
    });
    const jobs = db.createCommentaryJobRepository?.(fake.client);

    await expect(jobs?.enqueue(jobInput)).resolves.toMatchObject({
      familyId: jobInput.familyId,
      id: jobInput.id,
    });
    await expect(
      jobs?.enqueue({ ...jobInput, id: "job-duplicate" }),
    ).resolves.toMatchObject({
      id: jobInput.id,
    });
    await jobs?.supersede({
      fixtureId: jobInput.fixtureId,
      mode: jobInput.mode,
      familyId: jobInput.familyId,
      revision: jobInput.momentRevision,
    });
    await jobs?.fail({
      error: "provider timeout",
      jobId: jobInput.id,
      workerId: "worker-a",
    });
    expect(enqueueCount).toBe(2);
    expect(fake.queries[0]?.query).toContain(
      "ON CONFLICT (mode, fixture_id, family_id, moment_revision, language, voice, template_version)",
    );
    expect(
      fake.queries.some(({ query }) => query.includes("status = 'superseded'")),
    ).toBe(true);
    const supersede = fake.queries.find(({ query }) =>
      query.includes("status = 'superseded'"),
    );
    expect(supersede?.parameters).toEqual([
      jobInput.mode,
      jobInput.fixtureId,
      jobInput.familyId,
      jobInput.momentRevision,
    ]);
    expect(
      fake.queries.some(({ query }) => query.includes("status = 'failed'")),
    ).toBe(true);
  });
});
