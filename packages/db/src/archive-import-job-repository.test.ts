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

type ArchiveImportJob = {
  archiveManifestHash: string | null;
  archiveManifestId: string | null;
  attemptCount: number;
  availableAt: string;
  claimExpiresAt: string | null;
  claimGeneration: number;
  claimStartedAt: string | null;
  claimedBy: string | null;
  contextHash: string;
  fixtureId: string;
  kickoffAt: string;
  lastError: string | null;
  participant1IsHome: boolean;
  reason: string;
  sourceTerminalRecordId: string;
  state: string;
};

type ArchiveImportOutput = {
  archiveManifestHash: string;
  archiveManifestId: string;
  archiveTerminalDeliveryId: string;
  archiveVerifiedAt: string;
  claimGeneration: number;
  claimStartedAt: string;
  fixtureId: string;
  sourceTerminalRecordId: string;
  workerId: string;
};

type ArchiveImportJobRepository = {
  bindVerifiedArchiveOutput(
    input: Record<string, unknown>,
  ): Promise<ArchiveImportOutput>;
  claim(workerId: string, now: Date): Promise<ArchiveImportJob | null>;
  enqueue(input: Record<string, unknown>): Promise<ArchiveImportJob>;
  markBlockedRights(input: Record<string, unknown>): Promise<ArchiveImportJob>;
  markRejected(input: Record<string, unknown>): Promise<ArchiveImportJob>;
  markReplayReady(input: Record<string, unknown>): Promise<ArchiveImportJob>;
  markRetry(input: Record<string, unknown>): Promise<ArchiveImportJob>;
  recoverExpiredClaims(now: Date): Promise<number>;
  renewClaim(input: Record<string, unknown>): Promise<ArchiveImportJob | null>;
};

type FeaturedReplayRepository = {
  configure(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  ready(slot: string): Promise<Record<string, unknown> | null>;
};

type DatabaseModuleContract = {
  createArchiveImportJobRepository?: (
    client: TestClient,
  ) => ArchiveImportJobRepository;
  createFeaturedReplayRepository?: (
    client: TestClient,
  ) => FeaturedReplayRepository;
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

const jobInput = {
  awayTeamId: "ESP",
  contextHash: "a".repeat(64),
  fixtureId: "18237038",
  homeTeamId: "FRA",
  kickoffAt: "2026-07-18T12:00:00.000Z",
  participant1IsHome: true,
  reason: "featured_bootstrap",
  sourceTerminalRecordId: "delivery-final-1026",
} as const;

function jobRow(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    archive_manifest_hash: null,
    archive_manifest_id: null,
    attempt_count: 0,
    available_at: "2026-07-18T12:00:00.000Z",
    claim_expires_at: null,
    claim_generation: 0,
    claim_started_at: null,
    claimed_by: null,
    context_hash: jobInput.contextHash,
    created_at: "2026-07-18T11:59:00.000Z",
    fixture_id: jobInput.fixtureId,
    home_team_id: jobInput.homeTeamId,
    away_team_id: jobInput.awayTeamId,
    kickoff_at: jobInput.kickoffAt,
    last_error: null,
    participant1_is_home: jobInput.participant1IsHome,
    reason: jobInput.reason,
    source_terminal_record_id: jobInput.sourceTerminalRecordId,
    state: "queued",
    updated_at: "2026-07-18T11:59:00.000Z",
    ...overrides,
  };
}

function outputRow(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    archive_manifest_hash: "1".repeat(64),
    archive_manifest_id: "manifest-18237038",
    archive_terminal_delivery_id: "archive-terminal-1026",
    archive_verified_at: "2026-07-18T12:00:01.000Z",
    claim_generation: 1,
    claim_started_at: "2026-07-18T12:00:00.000Z",
    created_at: "2026-07-18T12:00:01.000Z",
    fixture_id: jobInput.fixtureId,
    source_terminal_record_id: jobInput.sourceTerminalRecordId,
    worker_id: "archive-worker-a",
    ...overrides,
  };
}

describe("archive import job repository", () => {
  it("only requeues a changed terminal when it is an explicit live correction", async () => {
    let insertCount = 0;
    const fake = testClient((query) => {
      if (query.includes("INSERT INTO matchsense.archive_import_jobs")) {
        insertCount += 1;
        if (insertCount === 1) return [jobRow()];
        if (insertCount === 4) {
          return [
            jobRow({
              archive_manifest_hash: null,
              reason: "live_correction",
              source_terminal_record_id: "delivery-correction-1027",
              state: "queued",
            }),
          ];
        }
        return [];
      }
      if (query.includes("SELECT") && query.includes("archive_import_jobs")) {
        return [jobRow()];
      }
      return [];
    });

    expect(db.createArchiveImportJobRepository).toBeTypeOf("function");
    const jobs = db.createArchiveImportJobRepository?.(fake.client);

    await expect(jobs?.enqueue(jobInput)).resolves.toMatchObject({
      fixtureId: jobInput.fixtureId,
      homeTeamId: jobInput.homeTeamId,
      state: "queued",
    });
    await expect(
      jobs?.enqueue({
        ...jobInput,
        homeTeamId: "ARG",
        kickoffAt: "2030-01-01T00:00:00.000Z",
        reason: "live_correction",
      }),
    ).resolves.toMatchObject({
      fixtureId: jobInput.fixtureId,
      homeTeamId: jobInput.homeTeamId,
      kickoffAt: jobInput.kickoffAt,
      reason: jobInput.reason,
      sourceTerminalRecordId: jobInput.sourceTerminalRecordId,
    });
    await expect(
      jobs?.enqueue({
        ...jobInput,
        homeTeamId: "ARG",
        kickoffAt: "2030-01-01T00:00:00.000Z",
        reason: "live_terminal",
        sourceTerminalRecordId: "new-terminal-without-correction",
      }),
    ).resolves.toMatchObject({
      fixtureId: jobInput.fixtureId,
      homeTeamId: jobInput.homeTeamId,
      kickoffAt: jobInput.kickoffAt,
      reason: jobInput.reason,
      sourceTerminalRecordId: jobInput.sourceTerminalRecordId,
    });
    await expect(
      jobs?.enqueue({
        ...jobInput,
        homeTeamId: "ARG",
        kickoffAt: "2030-01-01T00:00:00.000Z",
        reason: "live_correction",
        sourceTerminalRecordId: "delivery-correction-1027",
      }),
    ).resolves.toMatchObject({
      fixtureId: jobInput.fixtureId,
      homeTeamId: jobInput.homeTeamId,
      kickoffAt: jobInput.kickoffAt,
      reason: "live_correction",
      sourceTerminalRecordId: "delivery-correction-1027",
      state: "queued",
    });

    const insert = fake.queries.find(({ query }) =>
      query.includes("INSERT INTO matchsense.archive_import_jobs"),
    );
    expect(insert?.query).toContain("ON CONFLICT (fixture_id) DO UPDATE");
    const conflictUpdate = insert?.query.split("DO UPDATE")[1] ?? "";
    expect(conflictUpdate).not.toContain("home_team_id = EXCLUDED");
    expect(conflictUpdate).not.toContain("away_team_id = EXCLUDED");
    expect(conflictUpdate).not.toContain("kickoff_at = EXCLUDED");
    expect(conflictUpdate).not.toContain("context_hash = EXCLUDED");
    expect(conflictUpdate).toContain("EXCLUDED.reason = 'live_correction'");
    expect(conflictUpdate).toContain(
      "IS DISTINCT FROM EXCLUDED.source_terminal_record_id",
    );
    expect(conflictUpdate).not.toContain(
      "reason IS DISTINCT FROM EXCLUDED.reason",
    );
  });

  it("claims only due queued work with a lease and SKIP LOCKED", async () => {
    const fake = testClient((query) =>
      query.includes("RETURNING")
        ? [
            jobRow({
              attempt_count: 1,
              claim_expires_at: "2026-07-18T12:02:00.000Z",
              claim_generation: 1,
              claim_started_at: "2026-07-18T12:00:00.000Z",
              claimed_by: "archive-worker-a",
              state: "claimed",
            }),
          ]
        : [],
    );
    const jobs = db.createArchiveImportJobRepository?.(fake.client);

    await expect(
      jobs?.claim("archive-worker-a", new Date("2026-07-18T12:00:00.000Z")),
    ).resolves.toMatchObject({
      attemptCount: 1,
      claimGeneration: 1,
      claimedBy: "archive-worker-a",
      state: "claimed",
    });
    expect(fake.queries[0]?.query).toContain("FOR UPDATE SKIP LOCKED");
    expect(fake.queries[0]?.query).toContain(
      "state IN ('queued', 'retry_wait')",
    );
    expect(fake.queries[0]?.query).toContain("available_at <= $2::timestamptz");
    expect(fake.queries[0]?.query).toContain("interval '120 seconds'");
    expect(fake.queries[0]?.query).toContain(
      "claim_generation = job.claim_generation + 1",
    );
    expect(fake.queries[0]?.query).toContain(
      "claim_started_at = clock_timestamp()",
    );
  });

  it("renews only the current worker generation and only to a later claim expiry", async () => {
    const renewedExpiry = "2026-07-18T12:04:00.000Z";
    const fake = testClient((query) =>
      query.includes("SET claim_expires_at = $1::timestamptz")
        ? [
            jobRow({
              attempt_count: 1,
              claim_expires_at: renewedExpiry,
              claim_generation: 2,
              claim_started_at: "2026-07-18T12:00:00.000Z",
              claimed_by: "archive-worker-a",
              state: "claimed",
            }),
          ]
        : [],
    );
    const jobs = db.createArchiveImportJobRepository?.(fake.client);

    await expect(
      jobs?.renewClaim({
        claimExpiresAt: renewedExpiry,
        claimGeneration: 2,
        fixtureId: jobInput.fixtureId,
        workerId: "archive-worker-a",
      }),
    ).resolves.toMatchObject({
      claimExpiresAt: renewedExpiry,
      claimGeneration: 2,
      claimedBy: "archive-worker-a",
      state: "claimed",
    });

    expect(fake.queries[0]?.parameters).toEqual([
      renewedExpiry,
      jobInput.fixtureId,
      "archive-worker-a",
      2,
    ]);
    expect(fake.queries[0]?.query).toContain("state = 'claimed'");
    expect(fake.queries[0]?.query).toContain("claimed_by = $3");
    expect(fake.queries[0]?.query).toContain("claim_generation = $4");
    expect(fake.queries[0]?.query).toContain(
      "claim_expires_at > clock_timestamp()",
    );
    expect(fake.queries[0]?.query).toContain(
      "$1::timestamptz > claim_expires_at",
    );
  });

  it("returns null when a renewal loses ownership, expires, or is not later", async () => {
    const fake = testClient(() => []);
    const jobs = db.createArchiveImportJobRepository?.(fake.client);

    await expect(
      jobs?.renewClaim({
        claimExpiresAt: "2026-07-18T12:04:00.000Z",
        claimGeneration: 2,
        fixtureId: jobInput.fixtureId,
        workerId: "archive-worker-a",
      }),
    ).resolves.toBeNull();
    expect(fake.queries[0]?.query).toContain("RETURNING");
  });

  it("rejects an invalid archive claim renewal timestamp before issuing SQL", async () => {
    const fake = testClient(() => []);
    const jobs = db.createArchiveImportJobRepository?.(fake.client);

    await expect(
      jobs?.renewClaim({
        claimExpiresAt: "not-a-timestamp",
        claimGeneration: 2,
        fixtureId: jobInput.fixtureId,
        workerId: "archive-worker-a",
      }),
    ).rejects.toThrow("Archive import claim expiry is invalid");
    expect(fake.queries).toHaveLength(0);
  });

  it("recovers expired leases before a new worker claims work", async () => {
    const fake = testClient((query) =>
      query.includes("recovered_count") ? [{ recovered_count: "2" }] : [],
    );
    const jobs = db.createArchiveImportJobRepository?.(fake.client);

    await expect(
      jobs?.recoverExpiredClaims(new Date("2026-07-18T12:03:00.000Z")),
    ).resolves.toBe(2);
    expect(fake.queries[0]?.query).toContain("state = 'retry_wait'");
    expect(fake.queries[0]?.query).toContain(
      "claim_expires_at <= $1::timestamptz",
    );
    expect(fake.queries[0]?.query).toContain("claimed_by = NULL");
  });

  it("transitions a worker-owned claim through retry and terminal archive outcomes", async () => {
    const fake = testClient((query) => {
      if (query.includes("INSERT INTO matchsense.archive_import_job_outputs")) {
        return [outputRow()];
      }
      if (query.includes("state = 'retry_wait'")) {
        return [
          jobRow({
            last_error: "temporary history timeout",
            state: "retry_wait",
          }),
        ];
      }
      if (query.includes("state = 'replay_ready'")) {
        return [
          jobRow({
            archive_manifest_hash: "1".repeat(64),
            archive_manifest_id: "manifest-18237038",
            state: "replay_ready",
          }),
        ];
      }
      if (query.includes("state = 'blocked_rights'")) {
        return [
          jobRow({ last_error: "rights expired", state: "blocked_rights" }),
        ];
      }
      if (query.includes("state = 'rejected'")) {
        return [
          jobRow({
            last_error: "terminal validation failed",
            state: "rejected",
          }),
        ];
      }
      return [];
    });
    const jobs = db.createArchiveImportJobRepository?.(fake.client);

    await expect(
      jobs?.markRetry({
        availableAt: "2026-07-18T12:05:00.000Z",
        claimGeneration: 1,
        error: "temporary history timeout",
        fixtureId: jobInput.fixtureId,
        workerId: "archive-worker-a",
      }),
    ).resolves.toMatchObject({ state: "retry_wait" });
    await expect(
      jobs?.bindVerifiedArchiveOutput({
        archiveManifestHash: "1".repeat(64),
        archiveManifestId: "manifest-18237038",
        claimGeneration: 1,
        fixtureId: jobInput.fixtureId,
        workerId: "archive-worker-a",
      }),
    ).resolves.toMatchObject({
      archiveManifestHash: "1".repeat(64),
      claimGeneration: 1,
    });
    await expect(
      jobs?.markReplayReady({
        claimGeneration: 1,
        fixtureId: jobInput.fixtureId,
        workerId: "archive-worker-a",
      }),
    ).resolves.toMatchObject({ state: "replay_ready" });
    await expect(
      jobs?.markBlockedRights({
        claimGeneration: 1,
        error: "rights expired",
        fixtureId: jobInput.fixtureId,
        workerId: "archive-worker-a",
      }),
    ).resolves.toMatchObject({ state: "blocked_rights" });
    await expect(
      jobs?.markRejected({
        claimGeneration: 1,
        error: "terminal validation failed",
        fixtureId: jobInput.fixtureId,
        workerId: "archive-worker-a",
      }),
    ).resolves.toMatchObject({ state: "rejected" });

    for (const transition of fake.queries) {
      if (transition.query.includes("UPDATE matchsense.archive_import_jobs")) {
        expect(transition.query).toContain("state = 'claimed'");
        expect(transition.query).toContain("claimed_by = $");
        expect(transition.query).toContain(
          "claim_expires_at > clock_timestamp()",
        );
        expect(transition.query).toContain("claim_generation = $");
      }
    }
    const replayReady = fake.queries.find(({ query }) =>
      query.includes("state = 'replay_ready'"),
    );
    expect(replayReady?.query).toContain(
      "archive_manifest_hash = output.archive_manifest_hash",
    );
    expect(replayReady?.query).toContain(
      "output.claim_generation = job.claim_generation",
    );
    expect(replayReady?.query).toContain(
      "archive.terminal_delivery_id = output.archive_terminal_delivery_id",
    );
    expect(replayReady?.query).toContain(
      "JOIN matchsense.rights_grants AS grant",
    );
    expect(replayReady?.query).toContain("grant.active = true");
    expect(replayReady?.query).toContain("grant.revoked_at IS NULL");
    expect(replayReady?.query).toContain(
      "grant.scopes @> ARRAY['replay']::text[]",
    );
  });

  it("fences stale claims and requires a current-generation archive output binding", async () => {
    const h1 = "1".repeat(64);
    const h2 = "2".repeat(64);
    let claimCount = 0;
    let currentGeneration = 0;
    let boundGeneration: number | null = null;
    const fake = testClient((query, parameters) => {
      if (query.includes("WITH candidate AS")) {
        claimCount += 1;
        currentGeneration = claimCount;
        return [
          jobRow({
            claim_expires_at: "2026-07-18T12:02:00.000Z",
            claim_generation: currentGeneration,
            claim_started_at: "2026-07-18T12:00:00.000Z",
            claimed_by: "archive-worker-a",
            source_terminal_record_id:
              currentGeneration === 1
                ? "source-terminal-h1"
                : "source-terminal-h2",
            state: "claimed",
          }),
        ];
      }
      if (query.includes("recovered_count")) {
        return [{ recovered_count: "1" }];
      }
      if (query.includes("INSERT INTO matchsense.archive_import_job_outputs")) {
        const hash = parameters[1];
        const generation = parameters.at(-1);
        if (generation === currentGeneration && hash === h2) {
          boundGeneration = currentGeneration;
          return [
            outputRow({
              archive_manifest_hash: h2,
              archive_terminal_delivery_id: "archive-terminal-h2",
              claim_generation: currentGeneration,
              source_terminal_record_id: "source-terminal-h2",
            }),
          ];
        }
        return [];
      }
      if (query.includes("SET state = 'replay_ready'")) {
        const generation = parameters.at(-1);
        return boundGeneration === generation &&
          generation === currentGeneration
          ? [
              jobRow({
                archive_manifest_hash: h2,
                archive_manifest_id: "manifest-18237038",
                claim_generation: currentGeneration,
                state: "replay_ready",
              }),
            ]
          : [];
      }
      return [];
    });
    const jobs = db.createArchiveImportJobRepository?.(fake.client);

    const h1Claim = await jobs?.claim(
      "archive-worker-a",
      new Date("2026-07-18T12:00:00.000Z"),
    );
    expect(h1Claim?.claimGeneration).toBe(1);

    // h1 is deliberately not bindable to the correction generation below.
    await expect(
      jobs?.recoverExpiredClaims(new Date("2026-07-18T12:03:00.000Z")),
    ).resolves.toBe(1);
    const h2Claim = await jobs?.claim(
      "archive-worker-a",
      new Date("2026-07-18T12:03:00.000Z"),
    );
    expect(h2Claim?.claimGeneration).toBe(2);

    await expect(
      jobs?.markRetry({
        availableAt: "2026-07-18T12:05:00.000Z",
        claimGeneration: 1,
        error: "stale retry",
        fixtureId: jobInput.fixtureId,
        workerId: "archive-worker-a",
      }),
    ).rejects.toThrow("Archive import job is not claimed by this worker");
    await expect(
      jobs?.markBlockedRights({
        claimGeneration: 1,
        error: "stale rights",
        fixtureId: jobInput.fixtureId,
        workerId: "archive-worker-a",
      }),
    ).rejects.toThrow("Archive import job is not claimed by this worker");
    await expect(
      jobs?.markRejected({
        claimGeneration: 1,
        error: "stale terminal",
        fixtureId: jobInput.fixtureId,
        workerId: "archive-worker-a",
      }),
    ).rejects.toThrow("Archive import job is not claimed by this worker");
    await expect(
      jobs?.markReplayReady({
        claimGeneration: 1,
        fixtureId: jobInput.fixtureId,
        workerId: "archive-worker-a",
      }),
    ).rejects.toThrow(
      "Archive import job claim or verified archive output is invalid",
    );

    await expect(
      jobs?.bindVerifiedArchiveOutput({
        archiveManifestHash: h1,
        archiveManifestId: "manifest-18237038",
        claimGeneration: 2,
        fixtureId: jobInput.fixtureId,
        workerId: "archive-worker-a",
      }),
    ).rejects.toThrow(
      "Archive import job claim or current archive output is invalid",
    );
    await expect(
      jobs?.markReplayReady({
        claimGeneration: 2,
        fixtureId: jobInput.fixtureId,
        workerId: "archive-worker-a",
      }),
    ).rejects.toThrow(
      "Archive import job claim or verified archive output is invalid",
    );
    await expect(
      jobs?.bindVerifiedArchiveOutput({
        archiveManifestHash: h2,
        archiveManifestId: "manifest-18237038",
        claimGeneration: 2,
        fixtureId: jobInput.fixtureId,
        workerId: "archive-worker-a",
      }),
    ).resolves.toMatchObject({
      archiveManifestHash: h2,
      claimGeneration: 2,
      sourceTerminalRecordId: "source-terminal-h2",
    });
    await expect(
      jobs?.markReplayReady({
        claimGeneration: 2,
        fixtureId: jobInput.fixtureId,
        workerId: "archive-worker-a",
      }),
    ).resolves.toMatchObject({
      archiveManifestHash: h2,
      claimGeneration: 2,
      state: "replay_ready",
    });

    const binding = fake.queries.find(({ query }) =>
      query.includes("INSERT INTO matchsense.archive_import_job_outputs"),
    );
    expect(binding?.query).toContain("job.claim_generation = $5");
    expect(binding?.query).toContain("archive.delivery_manifest_hash = $2");
    expect(binding?.query).toContain(
      "archive.verified_at >= job.claim_started_at",
    );
    const ready = fake.queries.find(({ query }) =>
      query.includes("SET state = 'replay_ready'"),
    );
    expect(ready?.query).toContain(
      "output.claim_generation = job.claim_generation",
    );
    expect(ready?.query).toContain(
      "output.source_terminal_record_id = job.source_terminal_record_id",
    );
  });
});

describe("featured replay repository", () => {
  it("returns a featured replay only when its pinned manifest is current and replay-ready", async () => {
    let ready = false;
    const fake = testClient((query) => {
      if (query.includes("INSERT INTO matchsense.featured_replay_configs")) {
        return [
          {
            archive_manifest_hash: "1".repeat(64),
            archive_manifest_id: "manifest-18237038",
            enabled: true,
            fixture_id: jobInput.fixtureId,
            slot: "primary",
          },
        ];
      }
      if (query.includes("FROM matchsense.featured_replay_configs") && ready) {
        return [
          {
            archive_manifest_hash: "1".repeat(64),
            archive_manifest_id: "manifest-18237038",
            fixture_id: jobInput.fixtureId,
            slot: "primary",
          },
        ];
      }
      return [];
    });
    const featured = db.createFeaturedReplayRepository?.(fake.client);

    await expect(
      featured?.configure({
        archiveManifestId: "manifest-18237038",
        fixtureId: jobInput.fixtureId,
        slot: "primary",
      }),
    ).resolves.toMatchObject({
      archiveManifestHash: "1".repeat(64),
      slot: "primary",
    });
    await expect(featured?.ready("primary")).resolves.toBeNull();
    ready = true;
    await expect(featured?.ready("primary")).resolves.toMatchObject({
      archiveManifestHash: "1".repeat(64),
      archiveManifestId: "manifest-18237038",
      fixtureId: jobInput.fixtureId,
    });

    const readiness = fake.queries.find(({ query }) =>
      query.includes("FROM matchsense.featured_replay_configs"),
    );
    const configure = fake.queries.find(({ query }) =>
      query.includes("INSERT INTO matchsense.featured_replay_configs"),
    );
    expect(configure?.query).toContain(
      "matchsense.archive_import_jobs AS archive_job",
    );
    expect(configure?.query).toContain(
      "matchsense.archive_import_job_outputs AS archive_output",
    );
    expect(configure?.query).toContain("archive_job.claim_generation");
    expect(readiness?.query).toContain("archive.status = 'REPLAY_READY'");
    expect(readiness?.query).toContain("job.state = 'replay_ready'");
    expect(readiness?.query).toContain(
      "JOIN matchsense.archive_import_job_outputs AS output",
    );
    expect(readiness?.query).toContain(
      "output.claim_generation = job.claim_generation",
    );
    expect(readiness?.query).toContain(
      "output.archive_manifest_id = job.archive_manifest_id",
    );
    expect(readiness?.query).toContain(
      "output.archive_manifest_hash = job.archive_manifest_hash",
    );
    expect(readiness?.query).toContain(
      "job.archive_manifest_id = config.archive_manifest_id",
    );
    expect(readiness?.query).toContain(
      "job.archive_manifest_hash = config.archive_manifest_hash",
    );
    expect(readiness?.query).toContain(
      "archive.delivery_manifest_hash = config.archive_manifest_hash",
    );
    expect(readiness?.query).toContain(
      "JOIN matchsense.rights_grants AS grant",
    );
    expect(readiness?.query).toContain("grant.active = true");
    expect(readiness?.query).toContain("grant.revoked_at IS NULL");
    expect(readiness?.query).toContain(
      "(grant.expires_at IS NULL OR grant.expires_at > clock_timestamp())",
    );
    expect(readiness?.query).toContain(
      "grant.scopes @> ARRAY['replay']::text[]",
    );
  });

  it("rejects an unverified, mismatched, or unauthorised manifest before changing a featured slot", async () => {
    const fake = testClient((query) =>
      query.includes("INSERT INTO matchsense.featured_replay_configs")
        ? []
        : [],
    );
    const featured = db.createFeaturedReplayRepository?.(fake.client);

    await expect(
      featured?.configure({
        archiveManifestId: "manifest-not-authorised",
        fixtureId: jobInput.fixtureId,
        slot: "primary",
      }),
    ).rejects.toThrow(
      "Featured replay manifest is not current, replay-ready, and authorised",
    );
    const configure = fake.queries[0];
    expect(configure?.query).toContain(
      "INSERT INTO matchsense.featured_replay_configs",
    );
    expect(configure?.query).toContain("SELECT");
    expect(configure?.query).toContain("manifest.id = $4");
    expect(configure?.query).toContain("manifest.fixture_id = $2");
    expect(configure?.query).toContain("manifest.mode = 'recorded'");
    expect(configure?.query).toContain("manifest.status = 'REPLAY_READY'");
    expect(configure?.query).toContain("grant.active = true");
    expect(configure?.query).toContain("grant.revoked_at IS NULL");
    expect(configure?.query).toContain(
      "(grant.expires_at IS NULL OR grant.expires_at > clock_timestamp())",
    );
    expect(configure?.query).toContain(
      "grant.scopes @> ARRAY['replay']::text[]",
    );
  });
});
