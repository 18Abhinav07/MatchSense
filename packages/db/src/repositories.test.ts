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
  end(options: { timeout: number }): Promise<void>;
  unsafe: UnsafeQuery;
}

type RepositoryModule = {
  createCommentaryArtifactRepository?: (client: TestClient) => {
    get(input: Record<string, unknown>): Promise<unknown>;
    upsert(input: Record<string, unknown>): Promise<unknown>;
  };
  createFixtureTruthRepository?: (client: TestClient) => {
    commitCollectorFrame(input: Record<string, unknown>): Promise<unknown>;
    commitFencedFixtureUpsert(input: Record<string, unknown>): Promise<unknown>;
    commitFixtureSchedule(input: Record<string, unknown>): Promise<unknown>;
    commitRawSourceRecord(input: Record<string, unknown>): Promise<unknown>;
    commitSourceChange(input: Record<string, unknown>): Promise<unknown>;
    eventsAfter(input: Record<string, unknown>): Promise<unknown>;
    get(input: Record<string, unknown>): Promise<unknown>;
    getLatestProjection(input: Record<string, unknown>): Promise<unknown>;
    list(input: Record<string, unknown>): Promise<unknown>;
    observeFixtureSchedule(input: Record<string, unknown>): Promise<unknown>;
    upsert(input: Record<string, unknown>): Promise<unknown>;
  };
  createOutboxRepository?: (client: TestClient) => {
    claim(input: Record<string, unknown>): Promise<unknown>;
    complete(input: Record<string, unknown>): Promise<unknown>;
    enqueue(input: Record<string, unknown>): Promise<unknown>;
    hasConsumerReceipt(input: Record<string, unknown>): Promise<boolean>;
    recordConsumerReceipt(input: Record<string, unknown>): Promise<boolean>;
    retryOrDeadLetter(input: Record<string, unknown>): Promise<unknown>;
  };
  createSourceStateRepository?: (client: TestClient) => {
    acquireLease(input: Record<string, unknown>): Promise<unknown>;
    advanceCursor(input: Record<string, unknown>): Promise<unknown>;
    getCursor(input: Record<string, unknown>): Promise<unknown>;
    releaseLease(input: Record<string, unknown>): Promise<boolean>;
    renewLease(input: Record<string, unknown>): Promise<unknown>;
  };
};

const db = databaseModule as RepositoryModule;

function testClient(
  resolve: (
    query: string,
    parameters: readonly unknown[],
  ) => readonly QueryRow[] | Promise<readonly QueryRow[]>,
) {
  const queries: {
    parameters: readonly unknown[];
    query: string;
    transaction: boolean;
  }[] = [];
  let inTransaction = false;
  const unsafe = vi.fn<UnsafeQuery>(async (query, parameters = []) => {
    queries.push({ parameters, query, transaction: inTransaction });
    return resolve(query, parameters);
  });
  const begin = vi.fn(
    async <T>(work: (tx: { unsafe: UnsafeQuery }) => Promise<T>) => {
      inTransaction = true;
      try {
        return await work({ unsafe });
      } finally {
        inTransaction = false;
      }
    },
  );

  return {
    client: {
      begin,
      end: vi.fn(async () => undefined),
      unsafe,
    } satisfies TestClient,
    queries,
  };
}

const fixtureRow = {
  away_team_id: "ESP",
  created_at: "2026-07-17T00:00:00.000Z",
  home_team_id: "FRA",
  id: "fx-1",
  metadata: '{"competition":"Final"}',
  mode: "demo",
  provenance: "synthetic_txline_shaped",
  scheduled_at: "2026-07-17T12:00:00.000Z",
  status: "scheduled",
  updated_at: "2026-07-17T00:00:00.000Z",
};

const fixtureInput = {
  awayTeamId: "ESP",
  homeTeamId: "FRA",
  id: "fx-1",
  metadata: { competition: "Final" },
  mode: "demo",
  provenance: "synthetic_txline_shaped",
  scheduledAt: "2026-07-17T12:00:00.000Z",
  status: "scheduled",
};

const sourceChange = {
  event: {
    id: "event-1",
    payload: { event: "moment.created" },
    type: "moment.created",
  },
  expectedRevision: 0,
  fixtureId: "fx-1",
  mode: "demo",
  moment: {
    id: "moment-1",
    kind: "goal",
    payload: { score: { away: 0, home: 1 } },
    revision: 1,
  },
  outbox: {
    id: "outbox-1",
    idempotencyKey: "moment-1:1:foreground",
    payload: { momentId: "moment-1", revision: 1 },
    topic: "moment.created",
  },
  projection: {
    payload: { revision: 1, score: { away: 0, home: 1 } },
    revision: 1,
  },
  raw: {
    dedupeKey: "seq:620:hash:abc",
    id: "raw-1",
    payload: { action: "goal" },
    payloadHash: "a".repeat(64),
    provenance: "synthetic_txline_shaped",
    receivedAt: "2026-07-17T12:01:00.000Z",
    source: "replay",
    sourceRecordId: null,
    sourceSequence: "620",
  },
};

const projectionRow = {
  fixture_id: "fx-1",
  mode: "demo",
  payload: '{"revision":1,"score":{"away":0,"home":1}}',
  revision: "1",
  source_sequence: "620",
  updated_at: "2026-07-17T12:01:00.000Z",
};

const currentGeneration = 2;
const expiredGeneration = 1;

const sourceCursorRow = {
  cursor_value: "cursor-620",
  fencing_token: String(currentGeneration),
  mode: "live",
  source: "txline",
  stream_key: "scores:mainnet",
  updated_at: "2026-07-17T12:01:00.000Z",
};

const sourceLeaseRow = {
  fencing_token: String(currentGeneration),
  holder_id: "worker-new",
  lease_until: "2026-07-17T12:02:00.000Z",
  mode: "live",
  source: "txline",
  stream_key: "scores:mainnet",
  updated_at: "2026-07-17T12:01:00.000Z",
};

const liveSourceFence = {
  fencingToken: currentGeneration,
  holderId: "worker-new",
  source: "txline",
  streamKey: "scores:mainnet",
};

const recordedSourceFence = {
  fencingToken: currentGeneration,
  holderId: "archive-import-worker",
  source: "txline_historical",
  streamKey: "archive-imports",
};

const recordedSourceLeaseRow = {
  ...sourceLeaseRow,
  holder_id: recordedSourceFence.holderId,
  mode: "recorded",
  source: recordedSourceFence.source,
  stream_key: recordedSourceFence.streamKey,
};

const liveFixtureInput = {
  ...fixtureInput,
  mode: "live",
  provenance: "live_txline",
};

const recordedFixtureInput = {
  ...fixtureInput,
  mode: "recorded",
  provenance: "recorded_txline_authorised",
};

const recordedFixtureRow = {
  ...fixtureRow,
  mode: "recorded",
  provenance: "recorded_txline_authorised",
};

const liveFinalFixtureRow = {
  ...fixtureRow,
  mode: "live",
  provenance: "live_txline",
  status: "full_time",
};

const liveRaw = {
  ...sourceChange.raw,
  provenance: "live_txline",
  source: "txline",
  streamKey: "scores:mainnet",
};

function stableJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : "null";
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(",")}}`;
  }
  return "null";
}

const liveTerminalSourceContext = {
  fixtureGroupId: "group-1",
  fixtureId: "fx-1",
  gameState: 2,
  kickoffAt: "2026-07-18T18:00:00.000Z",
  participant1: {
    code: "ALP-provider-101",
    id: "provider-101",
    name: "Alpha United",
  },
  participant1IsHome: true,
  participant2: {
    code: "BRV-provider-202",
    id: "provider-202",
    name: "Bravo City",
  },
  schedule: {
    competition: "World Cup",
    competitionId: "72",
    responseHash: "d".repeat(64),
    source: "txline_world_cup_schedule",
    sourcePath: "/api/fixtures/snapshot?competitionId=72",
    sourceTimestampMs: 1_784_403_000_000,
  },
};

const liveTerminalSourceContextHash = createHash("sha256")
  .update(stableJson(liveTerminalSourceContext))
  .digest("hex");

function liveTerminalArchiveImportJob(sourceTerminalRecordId: string) {
  return {
    awayTeamId: "BRV-provider-202",
    contextHash: liveTerminalSourceContextHash,
    fixtureId: "fx-1",
    homeTeamId: "ALP-provider-101",
    kickoffAt: "2026-07-18T18:00:00.000Z",
    participant1IsHome: true,
    sourceContext: liveTerminalSourceContext,
    sourceTerminalRecordId,
  };
}

function liveTerminalRaw(sourceTerminalRecordId: string, id: string) {
  return {
    ...liveRaw,
    canonicalEligible: true,
    deliveryIntent: "realtime" as const,
    deliveryKey: createHash("sha256").update(id).digest("hex"),
    id,
    orderingKey: `terminal:${sourceTerminalRecordId}`,
    payload: {
      Action: "game_finalised",
      FixtureId: "fx-1",
      Id: sourceTerminalRecordId,
      StatusId: 100,
    },
    rawRetention: "authorised_raw" as const,
    responseHash: createHash("sha256").update(`response:${id}`).digest("hex"),
    rightsGrantId: "grant-1",
    sourcePath: "/api/scores/stream",
    sourceRecordId: sourceTerminalRecordId,
    sourceSequence: sourceTerminalRecordId,
    streamKey: "scores:mainnet",
  };
}

function archiveImportJobRow(sourceTerminalRecordId: string) {
  return {
    archive_manifest_hash: null,
    archive_manifest_id: null,
    attempt_count: 0,
    available_at: "2026-07-18T18:21:00.000Z",
    away_team_id: "BRV-provider-202",
    claim_expires_at: null,
    claim_generation: 0,
    claim_started_at: null,
    claimed_by: null,
    context_hash: liveTerminalSourceContextHash,
    created_at: "2026-07-18T18:21:00.000Z",
    fixture_id: "fx-1",
    home_team_id: "ALP-provider-101",
    kickoff_at: "2026-07-18T18:00:00.000Z",
    last_error: null,
    participant1_is_home: true,
    reason: "live_terminal",
    source_context: liveTerminalSourceContext,
    source_terminal_record_id: sourceTerminalRecordId,
    state: "queued",
    updated_at: "2026-07-18T18:21:00.000Z",
  };
}

function liveCorrectionRaw(
  action: "action_amend" | "action_discarded" | "score_adjustment",
  id: string,
) {
  const sourceRecordId = `provider-${action}-${id}`;
  return {
    ...liveTerminalRaw(sourceRecordId, id),
    orderingKey: `correction:${sourceRecordId}`,
    payload: { Action: action, FixtureId: "fx-1", Id: sourceRecordId },
    sourceSequence: sourceRecordId,
  };
}

function canonicalFramePlans(eventId: string) {
  return () => [
    {
      event: {
        id: eventId,
        payload: { revision: 1 },
        type: "fixture.corrected",
      },
      outbox: [],
      projection: { payload: { revision: 1 }, revision: 1 },
    },
  ];
}

describe("fixture truth repository", () => {
  it("upserts, gets, and lists fixtures through typed mode-scoped queries", async () => {
    const fake = testClient((query) =>
      query.includes("RETURNING") || query.includes("SELECT")
        ? [fixtureRow]
        : [],
    );
    const repository = db.createFixtureTruthRepository?.(fake.client);

    expect(repository).toBeDefined();
    await expect(repository?.upsert(fixtureInput)).resolves.toMatchObject({
      awayTeamId: "ESP",
      id: "fx-1",
      metadata: { competition: "Final" },
      mode: "demo",
    });
    await expect(
      repository?.get({ fixtureId: "fx-1", mode: "demo" }),
    ).resolves.toMatchObject({ id: "fx-1", mode: "demo" });
    await expect(
      repository?.list({ limit: 20, mode: "demo" }),
    ).resolves.toEqual([expect.objectContaining({ id: "fx-1", mode: "demo" })]);

    expect(fake.queries[0]?.query).toContain("ON CONFLICT (mode, id)");
    expect(fake.queries[1]?.parameters).toEqual(["demo", "fx-1"]);
    expect(fake.queries[2]?.query).toContain("ORDER BY scheduled_at ASC");
  });

  it("commits recorded fixture state only under its current source fence", async () => {
    const fake = testClient((query) => {
      if (query.includes("FROM matchsense.source_leases")) {
        return [recordedSourceLeaseRow];
      }
      if (query.includes("INSERT INTO matchsense.fixtures")) {
        return [recordedFixtureRow];
      }
      return [];
    });
    const repository = db.createFixtureTruthRepository?.(fake.client);

    await expect(
      repository?.commitFencedFixtureUpsert({
        fixture: recordedFixtureInput,
        sourceFence: recordedSourceFence,
      }),
    ).resolves.toEqual({
      fixture: expect.objectContaining({
        id: recordedFixtureInput.id,
        mode: "recorded",
      }),
      kind: "committed",
    });
    expect(fake.queries[0]?.parameters).toEqual([
      "recorded",
      recordedSourceFence.source,
      recordedSourceFence.streamKey,
      recordedSourceFence.holderId,
      recordedSourceFence.fencingToken,
    ]);
  });

  it("returns fenced before mutating a recorded fixture when its source lease is lost", async () => {
    const fake = testClient((query) => {
      if (query.includes("FROM matchsense.source_leases")) return [];
      if (query.includes("INSERT INTO matchsense.fixtures")) {
        throw new Error("A lost recorded lease must not mutate fixture state");
      }
      return [];
    });
    const repository = db.createFixtureTruthRepository?.(fake.client);

    await expect(
      repository?.commitFencedFixtureUpsert({
        fixture: recordedFixtureInput,
        sourceFence: recordedSourceFence,
      }),
    ).resolves.toEqual({ kind: "fenced" });
    expect(
      fake.queries.some(({ query }) =>
        query.includes("INSERT INTO matchsense.fixtures"),
      ),
    ).toBe(false);
  });

  it("inserts raw first and returns a duplicate as a no-op", async () => {
    const fake = testClient(() => []);
    const repository = db.createFixtureTruthRepository?.(fake.client);

    await expect(repository?.commitSourceChange(sourceChange)).resolves.toEqual(
      {
        kind: "duplicate",
      },
    );
    expect(fake.queries).toHaveLength(1);
    expect(fake.queries[0]).toMatchObject({ transaction: true });
    expect(fake.queries[0]?.query).toContain(
      "INSERT INTO matchsense.raw_source_records",
    );
    expect(fake.queries[0]?.query).toContain(
      "ON CONFLICT (mode, source, fixture_id, dedupe_key) DO NOTHING",
    );
  });

  it("commits a schedule raw-first and leaves duplicate payloads as a true no-op", async () => {
    const committed = testClient((query) => {
      if (query.includes("INSERT INTO matchsense.raw_source_records")) {
        return [{ id: "raw-schedule-1" }];
      }
      if (query.includes("INSERT INTO matchsense.fixtures"))
        return [fixtureRow];
      return [];
    });
    const repository = db.createFixtureTruthRepository?.(committed.client);
    const input = {
      fixture: fixtureInput,
      raw: { ...sourceChange.raw, id: "raw-schedule-1" },
    };

    await expect(repository?.commitFixtureSchedule(input)).resolves.toEqual({
      fixture: expect.objectContaining({ id: "fx-1", mode: "demo" }),
      kind: "committed",
    });
    expect(committed.queries.map(({ query }) => query)).toEqual([
      expect.stringContaining("INSERT INTO matchsense.raw_source_records"),
      expect.stringContaining("INSERT INTO matchsense.fixtures"),
    ]);
    expect(committed.queries.every(({ transaction }) => transaction)).toBe(
      true,
    );

    const duplicate = testClient(() => []);
    const duplicateRepository = db.createFixtureTruthRepository?.(
      duplicate.client,
    );
    await expect(
      duplicateRepository?.commitFixtureSchedule(input),
    ).resolves.toEqual({ kind: "duplicate" });
    expect(duplicate.queries).toHaveLength(1);
  });

  it("keeps schedule observations out of the match-event archive and cannot downgrade final truth", async () => {
    const fake = testClient((query) => {
      if (query.includes("FROM matchsense.source_leases")) {
        return [sourceLeaseRow];
      }
      if (query.includes("FROM matchsense.fixtures")) {
        return [liveFinalFixtureRow];
      }
      if (
        query.includes("INSERT INTO matchsense.fixture_schedule_observations")
      ) {
        return [{ fixture_id: "fx-1" }];
      }
      if (query.includes("INSERT INTO matchsense.fixtures")) {
        throw new Error(
          "A final fixture must not be rewritten by schedule data",
        );
      }
      return [];
    });
    const repository = db.createFixtureTruthRepository?.(fake.client);

    await expect(
      repository?.observeFixtureSchedule({
        fixture: liveFixtureInput,
        observation: {
          observedAt: "2026-07-18T12:00:00.000Z",
          payload: { FixtureId: "fx-1", StartTime: 1_784_408_400_000 },
          responseHash: "d".repeat(64),
          rightsGrantId: "grant-1",
          source: "txline",
          sourcePath: "/api/fixtures/snapshot?competitionId=72",
        },
        sourceFence: liveSourceFence,
      }),
    ).resolves.toMatchObject({
      fixture: { status: "full_time" },
      kind: "committed",
      metadataUpdated: false,
    });
    expect(
      fake.queries.some(({ query }) =>
        query.includes("INSERT INTO matchsense.fixture_schedule_observations"),
      ),
    ).toBe(true);
    expect(
      fake.queries.some(({ query }) =>
        query.includes("INSERT INTO matchsense.raw_source_records"),
      ),
    ).toBe(false);
  });

  it("commits a raw-only update without creating projection, Moment, event, or outbox", async () => {
    const fake = testClient((query) =>
      query.includes("INSERT INTO matchsense.raw_source_records")
        ? [{ id: "raw-neutral-1" }]
        : [],
    );
    const repository = db.createFixtureTruthRepository?.(fake.client);

    await expect(
      repository?.commitRawSourceRecord({
        fixtureId: "fx-1",
        mode: "demo",
        raw: { ...sourceChange.raw, id: "raw-neutral-1" },
      }),
    ).resolves.toEqual({ kind: "committed" });
    expect(fake.queries).toHaveLength(1);
    expect(fake.queries[0]?.query).toContain(
      "INSERT INTO matchsense.raw_source_records",
    );
  });

  it("fences every live source write before raw insertion when the lease is stale", async () => {
    const fake = testClient(() => []);
    const repository = db.createFixtureTruthRepository?.(fake.client);

    await expect(
      repository?.commitFixtureSchedule({
        fixture: liveFixtureInput,
        raw: liveRaw,
        sourceFence: liveSourceFence,
      }),
    ).resolves.toEqual({ kind: "fenced" });
    await expect(
      repository?.commitRawSourceRecord({
        fixtureId: "fx-1",
        mode: "live",
        raw: liveRaw,
        sourceFence: liveSourceFence,
      }),
    ).resolves.toEqual({ kind: "fenced" });
    await expect(
      repository?.commitSourceChange({
        ...sourceChange,
        mode: "live",
        raw: liveRaw,
        sourceFence: liveSourceFence,
      }),
    ).resolves.toEqual({ kind: "fenced" });

    expect(fake.queries).toHaveLength(3);
    expect(fake.queries.every(({ transaction }) => transaction)).toBe(true);
    expect(
      fake.queries.every(({ query }) =>
        query.includes("FROM matchsense.source_leases"),
      ),
    ).toBe(true);
    expect(
      fake.queries.every(({ query }) => query.includes("FOR UPDATE")),
    ).toBe(true);
    expect(
      fake.queries.some(({ query }) =>
        query.includes("INSERT INTO matchsense.raw_source_records"),
      ),
    ).toBe(false);
  });

  it("locks a current live source fence before committing its raw record", async () => {
    const fake = testClient((query) => {
      if (query.includes("FROM matchsense.source_leases")) {
        return [sourceLeaseRow];
      }
      if (query.includes("INSERT INTO matchsense.raw_source_records")) {
        return [{ id: "raw-live-1" }];
      }
      return [];
    });
    const repository = db.createFixtureTruthRepository?.(fake.client);

    await expect(
      repository?.commitRawSourceRecord({
        fixtureId: "fx-1",
        mode: "live",
        raw: { ...liveRaw, id: "raw-live-1" },
        sourceFence: liveSourceFence,
      }),
    ).resolves.toEqual({ kind: "committed" });
    expect(fake.queries.map(({ query }) => query)).toEqual([
      expect.stringMatching(/FROM matchsense\.source_leases[\s\S]*FOR UPDATE/u),
      expect.stringContaining("INSERT INTO matchsense.raw_source_records"),
    ]);
  });

  it("reads the latest projection with its per-fixture observed sequence", async () => {
    const fake = testClient(() => [projectionRow]);
    const repository = db.createFixtureTruthRepository?.(fake.client);

    await expect(
      repository?.getLatestProjection({ fixtureId: "fx-1", mode: "demo" }),
    ).resolves.toEqual({
      fixtureId: "fx-1",
      mode: "demo",
      payload: { revision: 1, score: { away: 0, home: 1 } },
      revision: 1,
      sourceSequence: "620",
      updatedAt: "2026-07-17T12:01:00.000Z",
    });
    expect(fake.queries[0]?.query).toContain(
      "FROM matchsense.fixture_projections",
    );
  });

  it("locks the fixture revision and atomically appends truth, event, and outbox", async () => {
    const fake = testClient((query) => {
      if (query.includes("INSERT INTO matchsense.raw_source_records")) {
        return [{ id: "raw-1" }];
      }
      if (query.includes("SELECT id") && query.includes("FOR UPDATE")) {
        return [{ id: "fx-1" }];
      }
      if (query.includes("SELECT revision")) return [{ revision: "0" }];
      if (query.includes("INSERT INTO matchsense.fixture_events")) {
        return [{ sequence: "1" }];
      }
      return [];
    });
    const repository = db.createFixtureTruthRepository?.(fake.client);

    await expect(repository?.commitSourceChange(sourceChange)).resolves.toEqual(
      {
        eventSequence: 1,
        kind: "committed",
        revision: 1,
      },
    );

    expect(fake.queries.every(({ transaction }) => transaction)).toBe(true);
    expect(fake.queries.map(({ query }) => query)).toEqual([
      expect.stringContaining("INSERT INTO matchsense.raw_source_records"),
      expect.stringMatching(/SELECT id[\s\S]*FOR UPDATE/u),
      expect.stringContaining("SELECT revision"),
      expect.stringContaining("INSERT INTO matchsense.fixture_projections"),
      expect.stringContaining("INSERT INTO matchsense.canonical_moments"),
      expect.stringContaining("INSERT INTO matchsense.moment_revisions"),
      expect.stringContaining("INSERT INTO matchsense.fixture_events"),
      expect.stringContaining("INSERT INTO matchsense.outbox"),
    ]);
    expect(fake.queries[4]?.query).toContain("current_revision");
  });

  it("rejects an unexpected revision before derived writes", async () => {
    const fake = testClient((query) => {
      if (query.includes("raw_source_records")) return [{ id: "raw-1" }];
      if (query.includes("SELECT id")) return [{ id: "fx-1" }];
      if (query.includes("SELECT revision")) return [{ revision: "4" }];
      return [];
    });
    const repository = db.createFixtureTruthRepository?.(fake.client);

    await expect(
      repository?.commitSourceChange(sourceChange),
    ).rejects.toMatchObject({
      actualRevision: 4,
      code: "FIXTURE_REVISION_CONFLICT",
      expectedRevision: 0,
    });
    expect(fake.queries).toHaveLength(3);
  });

  it("reads restart-safe fixture events after a durable sequence", async () => {
    const fake = testClient(() => [
      {
        created_at: "2026-07-17T12:01:00.000Z",
        event_id: "event-2",
        event_type: "moment.revised",
        fixture_id: "fx-1",
        mode: "demo",
        payload: '{"revision":2}',
        sequence: "2",
      },
    ]);
    const repository = db.createFixtureTruthRepository?.(fake.client);

    await expect(
      repository?.eventsAfter({
        afterSequence: 1,
        fixtureId: "fx-1",
        limit: 100,
        mode: "demo",
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        eventId: "event-2",
        payload: { revision: 2 },
        sequence: 2,
      }),
    ]);
    expect(fake.queries[0]?.query).toContain("sequence > $3");
    expect(fake.queries[0]?.query).toContain("ORDER BY sequence ASC");
  });

  it("commits a wrapped live terminal's raw truth, projection, archive-import job, and fenced cursor in one transaction", async () => {
    const fake = testClient((query) => {
      if (query.includes("FROM matchsense.source_leases")) {
        return [sourceLeaseRow];
      }
      if (query.includes("FROM matchsense.source_cursors")) return [];
      if (query.includes("INSERT INTO matchsense.raw_source_records")) {
        return [{ id: "raw-frame-1" }];
      }
      if (query.includes("SELECT id") && query.includes("FOR UPDATE")) {
        return [{ id: "fx-1" }];
      }
      if (query.includes("FROM matchsense.fixture_projections")) return [];
      if (query.includes("INSERT INTO matchsense.fixture_events")) {
        return [{ sequence: "1" }];
      }
      if (query.includes("INSERT INTO matchsense.archive_import_jobs")) {
        return [
          {
            archive_manifest_hash: null,
            archive_manifest_id: null,
            attempt_count: 0,
            available_at: "2026-07-18T18:21:00.000Z",
            away_team_id: "BRV-provider-202",
            claim_expires_at: null,
            claim_generation: 0,
            claim_started_at: null,
            claimed_by: null,
            context_hash: liveTerminalSourceContextHash,
            created_at: "2026-07-18T18:21:00.000Z",
            fixture_id: "fx-1",
            home_team_id: "ALP-provider-101",
            kickoff_at: "2026-07-18T18:00:00.000Z",
            last_error: null,
            participant1_is_home: true,
            reason: "live_terminal",
            source_context: liveTerminalSourceContext,
            source_terminal_record_id: "provider-terminal-1026",
            state: "queued",
            updated_at: "2026-07-18T18:21:00.000Z",
          },
        ];
      }
      if (query.includes("INSERT INTO matchsense.source_cursors")) {
        return [
          {
            ...sourceCursorRow,
            cursor_value: "cursor:51",
          },
        ];
      }
      return [];
    });
    const repository = db.createFixtureTruthRepository?.(fake.client);
    const raw = {
      ...liveRaw,
      canonicalEligible: true,
      deliveryIntent: "realtime" as const,
      deliveryKey: "e".repeat(64),
      id: "raw-frame-1",
      orderingKey: "00000000000000000051",
      payload: {
        Update: {
          Action: "GAME_FINAlised",
          FixtureId: "fx-1",
          Id: "provider-terminal-1026",
          StatusId: 100,
        },
      },
      rawRetention: "authorised_raw" as const,
      responseHash: "f".repeat(64),
      rightsGrantId: "grant-1",
      sourceRecordId: "provider-terminal-1026",
      sourceSequence: "1026",
      sourcePath: "/api/scores/stream",
      streamKey: "scores:mainnet",
    };

    await expect(
      repository?.commitCollectorFrame({
        deliveries: [
          {
            derive: () => [
              {
                event: {
                  id: "event-frame-1",
                  payload: { event: "moment.created" },
                  type: "moment.created",
                },
                moment: {
                  id: "goal-family-1",
                  kind: "goal",
                  payload: { identity: "goal-family-1:1" },
                  revision: 1,
                },
                outbox: [
                  {
                    id: "outbox-frame-1",
                    idempotencyKey: "goal-family-1:1:fixture.broadcast",
                    payload: { revision: 1 },
                    topic: "fixture.broadcast",
                  },
                ],
                projection: { payload: { revision: 1 }, revision: 1 },
              },
            ],
            archiveImportJob: {
              awayTeamId: "BRV-provider-202",
              contextHash: liveTerminalSourceContextHash,
              fixtureId: "fx-1",
              homeTeamId: "ALP-provider-101",
              kickoffAt: "2026-07-18T18:00:00.000Z",
              participant1IsHome: true,
              sourceContext: liveTerminalSourceContext,
              sourceTerminalRecordId: "provider-terminal-1026",
            },
            fixtureId: "fx-1",
            raw,
          },
        ],
        cursor: { expectedCursor: null, nextCursor: "cursor:51" },
        mode: "live",
        sourceFence: liveSourceFence,
      }),
    ).resolves.toMatchObject({
      cursor: { cursorValue: "cursor:51" },
      deliveries: [{ kind: "committed", revisions: [1] }],
      kind: "advanced",
    });

    expect(fake.client.begin).toHaveBeenCalledTimes(1);
    expect(fake.queries.every(({ transaction }) => transaction)).toBe(true);
    const rawIndex = fake.queries.findIndex(({ query }) =>
      query.includes("INSERT INTO matchsense.raw_source_records"),
    );
    const projectionIndex = fake.queries.findIndex(({ query }) =>
      query.includes("INSERT INTO matchsense.fixture_projections"),
    );
    const archiveJobIndex = fake.queries.findIndex(({ query }) =>
      query.includes("INSERT INTO matchsense.archive_import_jobs"),
    );
    const cursorIndex = fake.queries.findIndex(({ query }) =>
      query.includes("INSERT INTO matchsense.source_cursors"),
    );
    expect(rawIndex).toBeGreaterThan(-1);
    expect(projectionIndex).toBeGreaterThan(rawIndex);
    expect(archiveJobIndex).toBeGreaterThan(projectionIndex);
    expect(cursorIndex).toBeGreaterThan(archiveJobIndex);
    expect(fake.queries[archiveJobIndex]?.parameters).toContain(
      "provider-terminal-1026",
    );
  });

  it("enqueues an authoritative reconciliation terminal without fixture or fan writes when truth is unchanged", async () => {
    const sourceTerminalRecordId = "provider-terminal-reconciliation";
    const fake = testClient((query) => {
      if (query.includes("FROM matchsense.source_leases")) {
        return [sourceLeaseRow];
      }
      if (query.includes("INSERT INTO matchsense.raw_source_records")) {
        return [{ id: "raw-terminal-reconciliation" }];
      }
      if (query.includes("SELECT id") && query.includes("FOR UPDATE")) {
        return [{ id: "fx-1" }];
      }
      if (query.includes("FROM matchsense.fixture_projections")) return [];
      if (query.includes("INSERT INTO matchsense.archive_import_jobs")) {
        return [archiveImportJobRow(sourceTerminalRecordId)];
      }
      return [];
    });
    const repository = db.createFixtureTruthRepository?.(fake.client);
    const raw = {
      ...liveTerminalRaw(sourceTerminalRecordId, "raw-terminal-reconciliation"),
      deliveryIntent: "reconcile" as const,
    };

    await expect(
      repository?.commitCollectorFrame({
        deliveries: [
          {
            archiveImportJob: liveTerminalArchiveImportJob(
              sourceTerminalRecordId,
            ),
            derive: () => [],
            fixtureId: "fx-1",
            raw,
          },
        ],
        mode: "live",
        sourceFence: liveSourceFence,
      }),
    ).resolves.toEqual({
      deliveries: [{ kind: "accepted_no_change" }],
      kind: "committed",
    });
    expect(
      fake.queries.some(({ query }) =>
        query.includes("INSERT INTO matchsense.archive_import_jobs"),
      ),
    ).toBe(true);
    expect(
      fake.queries.some(
        ({ query }) =>
          query.includes("INSERT INTO matchsense.fixture_events") ||
          query.includes("INSERT INTO matchsense.moments") ||
          query.includes("INSERT INTO matchsense.outbox"),
      ),
    ).toBe(false);
  });

  it.each([
    {
      expectedError:
        "Archive import jobs require a canonical realtime or reconciliation delivery",
      label: "source-only",
      raw: {
        ...liveTerminalRaw(
          "provider-terminal-source-only-reconciliation",
          "raw-source-only-reconciliation",
        ),
        canonicalEligible: false,
        deliveryIntent: "reconcile" as const,
      },
      sourceTerminalRecordId: "provider-terminal-source-only-reconciliation",
    },
    {
      expectedError:
        "Archive import job must be confirmed game_finalised with StatusId 100",
      label: "non-terminal",
      raw: {
        ...liveTerminalRaw(
          "provider-terminal-non-terminal-reconciliation",
          "raw-non-terminal-reconciliation",
        ),
        deliveryIntent: "reconcile" as const,
        payload: {
          Action: "goal",
          FixtureId: "fx-1",
          Id: "provider-terminal-non-terminal-reconciliation",
          StatusId: 100,
        },
      },
      sourceTerminalRecordId: "provider-terminal-non-terminal-reconciliation",
    },
  ])(
    "rejects a $label reconciliation archive instruction before transaction work",
    async ({ expectedError, raw, sourceTerminalRecordId }) => {
      const fake = testClient(() => {
        throw new Error(
          "Invalid reconciliation must not start transaction work",
        );
      });
      const repository = db.createFixtureTruthRepository?.(fake.client);

      await expect(
        repository?.commitCollectorFrame({
          deliveries: [
            {
              archiveImportJob: liveTerminalArchiveImportJob(
                sourceTerminalRecordId,
              ),
              derive: () => [],
              fixtureId: "fx-1",
              raw,
            },
          ],
          mode: "live",
          sourceFence: liveSourceFence,
        }),
      ).rejects.toThrow(expectedError);
      expect(fake.client.begin).not.toHaveBeenCalled();
      expect(fake.queries).toHaveLength(0);
    },
  );

  it("rejects a terminal archive instruction for another fixture before opening a frame transaction", async () => {
    const fake = testClient(() => {
      throw new Error("A malformed frame must not start transaction work");
    });
    const repository = db.createFixtureTruthRepository?.(fake.client);
    const raw = liveTerminalRaw(
      "provider-terminal-cross-fixture",
      "raw-cross-fixture",
    );

    await expect(
      repository?.commitCollectorFrame({
        deliveries: [
          {
            archiveImportJob: {
              ...liveTerminalArchiveImportJob(
                "provider-terminal-cross-fixture",
              ),
              fixtureId: "fx-other",
            },
            derive: canonicalFramePlans("event-cross-fixture"),
            fixtureId: "fx-1",
            raw,
          },
        ],
        mode: "live",
        sourceFence: liveSourceFence,
      }),
    ).rejects.toThrow(
      "Archive import job fixture must match its collector delivery",
    );
    expect(fake.client.begin).not.toHaveBeenCalled();
    expect(fake.queries).toHaveLength(0);
  });

  it.each([
    [
      "a non-terminal goal",
      { Action: "goal", StatusId: 100 },
      "Archive import job must be confirmed game_finalised with StatusId 100",
    ],
    [
      "a non-100 terminal",
      { Action: "game_finalised", StatusId: 90 },
      "Archive import job must be confirmed game_finalised with StatusId 100",
    ],
    [
      "an explicitly unconfirmed terminal",
      { Action: "game_finalised", Confirmed: false, StatusId: 100 },
      "Archive import job must be confirmed game_finalised with StatusId 100",
    ],
    [
      "a payload fixture for another delivery",
      {
        Action: "game_finalised",
        FixtureId: "fx-other",
        Id: "provider-terminal-other-fixture",
        StatusId: 100,
      },
      "Archive import job payload fixture must match its collector delivery",
    ],
    [
      "a payload id for another source record",
      {
        Action: "game_finalised",
        FixtureId: "fx-1",
        Id: "provider-terminal-other-id",
        StatusId: 100,
      },
      "Archive import job payload id must match its terminal source record",
    ],
  ])(
    "rejects a terminal archive instruction with %s before opening a frame transaction",
    async (_label, payload, expectedError) => {
      const fake = testClient(() => {
        throw new Error("A malformed terminal must not start transaction work");
      });
      const repository = db.createFixtureTruthRepository?.(fake.client);
      const sourceTerminalRecordId = `provider-terminal-${_label}`;
      const raw = {
        ...liveTerminalRaw(sourceTerminalRecordId, `raw-terminal-${_label}`),
        payload,
      };

      await expect(
        repository?.commitCollectorFrame({
          deliveries: [
            {
              archiveImportJob: liveTerminalArchiveImportJob(
                sourceTerminalRecordId,
              ),
              derive: canonicalFramePlans(`event-terminal-${_label}`),
              fixtureId: "fx-1",
              raw,
            },
          ],
          mode: "live",
          sourceFence: liveSourceFence,
        }),
      ).rejects.toThrow(expectedError);
      expect(fake.client.begin).not.toHaveBeenCalled();
      expect(fake.queries).toHaveLength(0);
    },
  );

  it("accepts a wrapped authoritative terminal with an adapter-compatible numeric fixture id", async () => {
    const fixtureId = "101";
    const sourceTerminalRecordId = "provider-terminal-numeric-fixture";
    const sourceContext = {
      ...liveTerminalSourceContext,
      fixtureId,
    };
    const contextHash = createHash("sha256")
      .update(stableJson(sourceContext))
      .digest("hex");
    const fake = testClient((query) => {
      if (query.includes("FROM matchsense.source_leases")) {
        return [sourceLeaseRow];
      }
      if (query.includes("INSERT INTO matchsense.raw_source_records")) {
        return [{ id: "raw-terminal-numeric-fixture" }];
      }
      if (query.includes("SELECT id") && query.includes("FOR UPDATE")) {
        return [{ id: fixtureId }];
      }
      if (query.includes("FROM matchsense.fixture_projections")) return [];
      return [];
    });
    const repository = db.createFixtureTruthRepository?.(fake.client);
    const raw = {
      ...liveTerminalRaw(
        sourceTerminalRecordId,
        "raw-terminal-numeric-fixture",
      ),
      payload: {
        Update: {
          Action: "game_finalised",
          FixtureId: 101,
          Id: sourceTerminalRecordId,
          StatusId: 100,
        },
      },
    };

    await expect(
      repository?.commitCollectorFrame({
        deliveries: [
          {
            archiveImportJob: {
              ...liveTerminalArchiveImportJob(sourceTerminalRecordId),
              contextHash,
              fixtureId,
              sourceContext,
            },
            derive: () => [],
            fixtureId,
            raw,
          },
        ],
        mode: "live",
        sourceFence: liveSourceFence,
      }),
    ).resolves.toMatchObject({
      deliveries: [{ kind: "accepted_no_change" }],
      kind: "committed",
    });
    expect(fake.client.begin).toHaveBeenCalledTimes(1);
  });

  it("atomically invalidates only a replay-ready recorded archive for a wrapped canonical live correction without enqueueing a job", async () => {
    const fake = testClient((query) => {
      if (query.includes("FROM matchsense.source_leases")) {
        return [sourceLeaseRow];
      }
      if (query.includes("INSERT INTO matchsense.raw_source_records")) {
        return [{ id: "raw-correction-amend" }];
      }
      if (query.includes("SELECT id") && query.includes("FOR UPDATE")) {
        return [{ id: "fx-1" }];
      }
      if (query.includes("FROM matchsense.fixture_projections")) return [];
      if (query.includes("INSERT INTO matchsense.fixture_events")) {
        return [{ sequence: "1" }];
      }
      if (query.includes("INSERT INTO matchsense.archive_import_jobs")) {
        throw new Error("A generic correction must not enqueue archive work");
      }
      if (query.includes("INSERT INTO matchsense.source_cursors")) {
        return [{ ...sourceCursorRow, cursor_value: "cursor:53" }];
      }
      return [];
    });
    const repository = db.createFixtureTruthRepository?.(fake.client);
    const correction = liveCorrectionRaw(
      "action_amend",
      "raw-correction-amend",
    );
    const raw = {
      ...correction,
      payload: { Update: correction.payload },
    };

    await expect(
      repository?.commitCollectorFrame({
        cursor: { expectedCursor: null, nextCursor: "cursor:53" },
        deliveries: [
          {
            derive: canonicalFramePlans("event-correction-amend"),
            fixtureId: "fx-1",
            raw,
            recordedArchiveInvalidation: {
              action: "action_amend",
            },
          },
        ],
        mode: "live",
        sourceFence: liveSourceFence,
      }),
    ).resolves.toMatchObject({ kind: "advanced" });

    expect(fake.client.begin).toHaveBeenCalledTimes(1);
    expect(
      fake.queries.filter(({ query }) =>
        query.includes("FROM matchsense.source_leases"),
      ),
    ).toHaveLength(1);
    const invalidations = fake.queries.filter(({ query }) =>
      query.includes("UPDATE matchsense.archive_manifests"),
    );
    expect(invalidations).toHaveLength(1);
    expect(invalidations[0]?.query).toContain("mode = 'recorded'");
    expect(invalidations[0]?.query).toContain("status = 'REPLAY_READY'");
    expect(invalidations[0]?.parameters).toEqual([
      "fx-1",
      "live_txline_canonical_correction:action_amend",
    ]);
    const supersessions = fake.queries.filter(({ query }) =>
      query.includes("UPDATE matchsense.archive_import_jobs"),
    );
    expect(supersessions).toHaveLength(1);
    expect(supersessions[0]?.query).toContain("SET state = 'rejected'");
    expect(supersessions[0]?.query).toContain(
      "state IN ('queued', 'retry_wait', 'claimed')",
    );
    expect(supersessions[0]?.parameters).toEqual([
      "fx-1",
      "live_txline_canonical_correction:action_amend",
    ]);
    expect(
      fake.queries.some(({ query }) =>
        query.includes("INSERT INTO matchsense.archive_import_jobs"),
      ),
    ).toBe(false);
    const rawIndex = fake.queries.findIndex(({ query }) =>
      query.includes("INSERT INTO matchsense.raw_source_records"),
    );
    const invalidationIndex = fake.queries.findIndex(({ query }) =>
      query.includes("UPDATE matchsense.archive_manifests"),
    );
    const cursorIndex = fake.queries.findIndex(({ query }) =>
      query.includes("INSERT INTO matchsense.source_cursors"),
    );
    const supersessionIndex = fake.queries.findIndex(({ query }) =>
      query.includes("UPDATE matchsense.archive_import_jobs"),
    );
    expect(invalidationIndex).toBeGreaterThan(rawIndex);
    expect(supersessionIndex).toBeGreaterThan(invalidationIndex);
    expect(cursorIndex).toBeGreaterThan(supersessionIndex);
  });

  it("invalidates recorded replay history after an inserted canonical correction even when it yields no projection plans", async () => {
    const fake = testClient((query) => {
      if (query.includes("FROM matchsense.source_leases")) {
        return [sourceLeaseRow];
      }
      if (query.includes("INSERT INTO matchsense.raw_source_records")) {
        return [{ id: "raw-correction-no-plans" }];
      }
      if (query.includes("SELECT id") && query.includes("FOR UPDATE")) {
        return [{ id: "fx-1" }];
      }
      if (query.includes("FROM matchsense.fixture_projections")) return [];
      if (query.includes("INSERT INTO matchsense.archive_import_jobs")) {
        throw new Error("A generic correction must not enqueue archive work");
      }
      return [];
    });
    const repository = db.createFixtureTruthRepository?.(fake.client);
    const raw = liveCorrectionRaw(
      "action_discarded",
      "raw-correction-no-plans",
    );

    await expect(
      repository?.commitCollectorFrame({
        deliveries: [
          {
            derive: () => [],
            fixtureId: "fx-1",
            raw,
            recordedArchiveInvalidation: {
              action: "action_discarded",
            },
          },
        ],
        mode: "live",
        sourceFence: liveSourceFence,
      }),
    ).resolves.toEqual({
      deliveries: [{ kind: "accepted_no_change" }],
      kind: "committed",
    });
    expect(
      fake.queries.filter(({ query }) =>
        query.includes("UPDATE matchsense.archive_manifests"),
      ),
    ).toHaveLength(1);
    expect(
      fake.queries.filter(({ query }) =>
        query.includes("UPDATE matchsense.archive_import_jobs"),
      ),
    ).toHaveLength(1);
    expect(
      fake.queries.some(
        ({ query }) =>
          query.includes("INSERT INTO matchsense.fixture_projections") ||
          query.includes("INSERT INTO matchsense.fixture_events"),
      ),
    ).toBe(false);
  });

  it("rolls a correction frame and its recorded replay invalidation back together", async () => {
    const attempted: string[] = [];
    const committed: string[] = [];
    const client: TestClient = {
      begin: async <T>(
        work: (transaction: { unsafe: UnsafeQuery }) => Promise<T>,
      ) => {
        const staged: string[] = [];
        try {
          const result = await work({
            unsafe: async (query) => {
              if (query.includes("FROM matchsense.source_leases")) {
                return [sourceLeaseRow];
              }
              if (query.includes("INSERT INTO matchsense.raw_source_records")) {
                attempted.push("raw");
                staged.push("raw");
                return [{ id: "raw-correction-rollback" }];
              }
              if (query.includes("SELECT id") && query.includes("FOR UPDATE")) {
                return [{ id: "fx-1" }];
              }
              if (query.includes("FROM matchsense.fixture_projections")) {
                return [];
              }
              if (
                query.includes("INSERT INTO matchsense.fixture_projections")
              ) {
                attempted.push("projection");
                staged.push("projection");
                return [];
              }
              if (query.includes("INSERT INTO matchsense.fixture_events")) {
                attempted.push("event");
                staged.push("event");
                return [{ sequence: "1" }];
              }
              if (query.includes("UPDATE matchsense.archive_manifests")) {
                attempted.push("recorded_invalidation");
                staged.push("recorded_invalidation");
                return [];
              }
              if (query.includes("UPDATE matchsense.archive_import_jobs")) {
                attempted.push("archive_job_supersession");
                staged.push("archive_job_supersession");
                throw new Error("injected archive job supersession failure");
              }
              if (query.includes("INSERT INTO matchsense.source_cursors")) {
                throw new Error(
                  "Cursor must not advance after recorded invalidation failure",
                );
              }
              return [];
            },
          });
          committed.push(...staged);
          return result;
        } catch (error) {
          throw error;
        }
      },
      end: vi.fn(async () => undefined),
      unsafe: vi.fn(async () => []),
    };
    const repository = db.createFixtureTruthRepository?.(client);
    const raw = liveCorrectionRaw(
      "score_adjustment",
      "raw-correction-rollback",
    );

    await expect(
      repository?.commitCollectorFrame({
        cursor: { expectedCursor: null, nextCursor: "cursor:54" },
        deliveries: [
          {
            derive: canonicalFramePlans("event-correction-rollback"),
            fixtureId: "fx-1",
            raw,
            recordedArchiveInvalidation: {
              action: "score_adjustment",
            },
          },
        ],
        mode: "live",
        sourceFence: liveSourceFence,
      }),
    ).rejects.toThrow("injected archive job supersession failure");

    expect(attempted).toEqual([
      "raw",
      "projection",
      "event",
      "recorded_invalidation",
      "archive_job_supersession",
    ]);
    expect(committed).toEqual([]);
  });

  it("does not invalidate recorded replay history or enqueue work for duplicate, fenced, or stale-cursor corrections", async () => {
    const correction = {
      action: "action_amend" as const,
    };

    const duplicate = testClient((query) => {
      if (query.includes("FROM matchsense.source_leases")) {
        return [sourceLeaseRow];
      }
      if (query.includes("INSERT INTO matchsense.raw_source_records")) {
        return [];
      }
      if (
        query.includes("UPDATE matchsense.archive_manifests") ||
        query.includes("UPDATE matchsense.archive_import_jobs") ||
        query.includes("INSERT INTO matchsense.archive_import_jobs")
      ) {
        throw new Error("A duplicate correction must not mutate archive state");
      }
      return [];
    });
    const duplicateRepository = db.createFixtureTruthRepository?.(
      duplicate.client,
    );
    await expect(
      duplicateRepository?.commitCollectorFrame({
        deliveries: [
          {
            derive: () => {
              throw new Error("A duplicate correction must not derive plans");
            },
            fixtureId: "fx-1",
            raw: liveCorrectionRaw("action_amend", "raw-duplicate-correction"),
            recordedArchiveInvalidation: correction,
          },
        ],
        mode: "live",
        sourceFence: liveSourceFence,
      }),
    ).resolves.toEqual({
      deliveries: [{ kind: "duplicate" }],
      kind: "committed",
    });

    const fenced = testClient((query) => {
      if (query.includes("FROM matchsense.source_leases")) return [];
      if (
        query.includes("INSERT INTO matchsense.raw_source_records") ||
        query.includes("UPDATE matchsense.archive_manifests") ||
        query.includes("UPDATE matchsense.archive_import_jobs") ||
        query.includes("INSERT INTO matchsense.archive_import_jobs")
      ) {
        throw new Error("A fenced correction must not mutate archive state");
      }
      return [];
    });
    const fencedRepository = db.createFixtureTruthRepository?.(fenced.client);
    await expect(
      fencedRepository?.commitCollectorFrame({
        deliveries: [
          {
            derive: canonicalFramePlans("event-fenced-correction"),
            fixtureId: "fx-1",
            raw: liveCorrectionRaw("action_amend", "raw-fenced-correction"),
            recordedArchiveInvalidation: correction,
          },
        ],
        mode: "live",
        sourceFence: liveSourceFence,
      }),
    ).resolves.toEqual({ kind: "fenced" });

    const staleCursor = testClient((query) => {
      if (query.includes("FROM matchsense.source_leases")) {
        return [sourceLeaseRow];
      }
      if (query.includes("FROM matchsense.source_cursors")) {
        return [sourceCursorRow];
      }
      if (
        query.includes("INSERT INTO matchsense.raw_source_records") ||
        query.includes("UPDATE matchsense.archive_manifests") ||
        query.includes("UPDATE matchsense.archive_import_jobs") ||
        query.includes("INSERT INTO matchsense.archive_import_jobs")
      ) {
        throw new Error(
          "A stale cursor correction must not mutate archive state",
        );
      }
      return [];
    });
    const staleCursorRepository = db.createFixtureTruthRepository?.(
      staleCursor.client,
    );
    await expect(
      staleCursorRepository?.commitCollectorFrame({
        cursor: { expectedCursor: null, nextCursor: "cursor:55" },
        deliveries: [
          {
            derive: canonicalFramePlans("event-stale-cursor-correction"),
            fixtureId: "fx-1",
            raw: liveCorrectionRaw(
              "action_amend",
              "raw-stale-cursor-correction",
            ),
            recordedArchiveInvalidation: correction,
          },
        ],
        mode: "live",
        sourceFence: liveSourceFence,
      }),
    ).resolves.toEqual({
      currentCursor: "cursor-620",
      kind: "conflict",
    });

    for (const fake of [duplicate, fenced, staleCursor]) {
      expect(
        fake.queries.some(({ query }) =>
          query.includes("UPDATE matchsense.archive_manifests"),
        ),
      ).toBe(false);
      expect(
        fake.queries.some(({ query }) =>
          query.includes("UPDATE matchsense.archive_import_jobs"),
        ),
      ).toBe(false);
      expect(
        fake.queries.some(({ query }) =>
          query.includes("INSERT INTO matchsense.archive_import_jobs"),
        ),
      ).toBe(false);
    }
  });

  it.each([
    [
      "a reconciliation",
      {
        ...liveCorrectionRaw("action_discarded", "raw-reconcile-invalidation"),
        deliveryIntent: "reconcile" as const,
      },
      canonicalFramePlans("event-reconcile-invalidation"),
    ],
    [
      "a source-only delivery",
      {
        ...liveCorrectionRaw(
          "action_discarded",
          "raw-source-only-invalidation",
        ),
        canonicalEligible: false,
      },
      undefined,
    ],
  ])(
    "rejects a recorded archive invalidation attached to %s before transaction work",
    async (_label, raw, derive) => {
      const fake = testClient(() => {
        throw new Error(
          "Ineligible invalidation must not start transaction work",
        );
      });
      const repository = db.createFixtureTruthRepository?.(fake.client);

      await expect(
        repository?.commitCollectorFrame({
          deliveries: [
            {
              ...(derive ? { derive } : {}),
              fixtureId: "fx-1",
              raw,
              recordedArchiveInvalidation: {
                action: "action_discarded",
              },
            },
          ],
          mode: "live",
          sourceFence: liveSourceFence,
        }),
      ).rejects.toThrow(
        "Recorded archive invalidation requires a realtime canonical live delivery",
      );
      expect(fake.client.begin).not.toHaveBeenCalled();
      expect(fake.queries).toHaveLength(0);
    },
  );

  it("rejects an arbitrary recorded archive invalidation action before transaction work", async () => {
    const fake = testClient(() => {
      throw new Error(
        "Invalid archive correction must not start transaction work",
      );
    });
    const repository = db.createFixtureTruthRepository?.(fake.client);
    const raw = liveCorrectionRaw("action_amend", "raw-invalid-invalidation");

    await expect(
      repository?.commitCollectorFrame({
        deliveries: [
          {
            derive: canonicalFramePlans("event-invalid-invalidation"),
            fixtureId: "fx-1",
            raw,
            recordedArchiveInvalidation: { action: "goal" },
          },
        ],
        mode: "live",
        sourceFence: liveSourceFence,
      }),
    ).rejects.toThrow("Recorded archive invalidation action is invalid");
    expect(fake.client.begin).not.toHaveBeenCalled();
    expect(fake.queries).toHaveLength(0);
  });

  it.each([
    [
      "an allowed action that does not match its raw payload",
      liveCorrectionRaw("action_amend", "raw-mismatched-invalidation"),
      { action: "score_adjustment" },
      "Recorded archive invalidation must match its canonical TxLINE action",
    ],
    [
      "a hyphenated action the adapter would classify as unsupported",
      {
        ...liveCorrectionRaw("action_amend", "raw-hyphenated-invalidation"),
        payload: {
          Action: "action-amend",
          FixtureId: "fx-1",
          Id: "provider-action_amend-raw-hyphenated-invalidation",
        },
      },
      { action: "action_amend" },
      "Recorded archive invalidation must match its canonical TxLINE action",
    ],
    [
      "a VAR end without an overturned outcome",
      {
        ...liveTerminalRaw("provider-var-end", "raw-var-end-not-overturned"),
        orderingKey: "correction:provider-var-end",
        payload: {
          Action: "var_end",
          Data: { Outcome: "confirmed" },
          FixtureId: "fx-1",
          Id: "provider-var-end",
        },
        sourceSequence: "provider-var-end",
      },
      { action: "var_end" },
      "Recorded archive invalidation requires an overturned VAR outcome",
    ],
  ])(
    "rejects a recorded archive invalidation attached to %s before transaction work",
    async (_label, raw, recordedArchiveInvalidation, expectedError) => {
      const fake = testClient(() => {
        throw new Error(
          "Invalid archive correction must not start transaction work",
        );
      });
      const repository = db.createFixtureTruthRepository?.(fake.client);

      await expect(
        repository?.commitCollectorFrame({
          deliveries: [
            {
              derive: canonicalFramePlans(`event-${_label}`),
              fixtureId: "fx-1",
              raw,
              recordedArchiveInvalidation,
            },
          ],
          mode: "live",
          sourceFence: liveSourceFence,
        }),
      ).rejects.toThrow(expectedError);
      expect(fake.client.begin).not.toHaveBeenCalled();
      expect(fake.queries).toHaveLength(0);
    },
  );

  it("rolls a collector frame back when its transaction-local archive enqueue fails", async () => {
    const attempted: string[] = [];
    const committed: string[] = [];
    const client: TestClient = {
      begin: async <T>(
        work: (transaction: { unsafe: UnsafeQuery }) => Promise<T>,
      ) => {
        const staged: string[] = [];
        const result = await work({
          unsafe: async (query) => {
            if (query.includes("FROM matchsense.source_leases")) {
              return [sourceLeaseRow];
            }
            if (query.includes("FROM matchsense.source_cursors")) return [];
            if (query.includes("INSERT INTO matchsense.raw_source_records")) {
              attempted.push("raw");
              staged.push("raw");
              return [{ id: "raw-rollback-terminal" }];
            }
            if (query.includes("SELECT id") && query.includes("FOR UPDATE")) {
              return [{ id: "fx-1" }];
            }
            if (query.includes("FROM matchsense.fixture_projections"))
              return [];
            if (query.includes("INSERT INTO matchsense.fixture_projections")) {
              attempted.push("projection");
              staged.push("projection");
              return [];
            }
            if (query.includes("INSERT INTO matchsense.fixture_events")) {
              attempted.push("event");
              staged.push("event");
              return [{ sequence: "1" }];
            }
            if (query.includes("INSERT INTO matchsense.archive_import_jobs")) {
              attempted.push("archive_job");
              throw new Error("injected archive enqueue failure");
            }
            if (query.includes("INSERT INTO matchsense.source_cursors")) {
              throw new Error(
                "Cursor must not advance after archive enqueue failure",
              );
            }
            return [];
          },
        });
        committed.push(...staged);
        return result;
      },
      end: vi.fn(async () => undefined),
      unsafe: vi.fn(async () => []),
    };
    const repository = db.createFixtureTruthRepository?.(client);
    const raw = {
      ...liveRaw,
      canonicalEligible: true,
      deliveryIntent: "realtime" as const,
      deliveryKey: "1".repeat(64),
      id: "raw-rollback-terminal",
      orderingKey: "00000000000000000052",
      payload: {
        Action: "game_finalised",
        FixtureId: "fx-1",
        Id: "provider-terminal-rollback",
        StatusId: 100,
      },
      rawRetention: "authorised_raw" as const,
      responseHash: "2".repeat(64),
      rightsGrantId: "grant-1",
      sourcePath: "/api/scores/stream",
      sourceRecordId: "provider-terminal-rollback",
      sourceSequence: "1026",
      streamKey: "scores:mainnet",
    };

    await expect(
      repository?.commitCollectorFrame({
        cursor: { expectedCursor: null, nextCursor: "cursor:52" },
        deliveries: [
          {
            archiveImportJob: {
              awayTeamId: "BRV-provider-202",
              contextHash: liveTerminalSourceContextHash,
              fixtureId: "fx-1",
              homeTeamId: "ALP-provider-101",
              kickoffAt: "2026-07-18T18:00:00.000Z",
              participant1IsHome: true,
              sourceContext: liveTerminalSourceContext,
              sourceTerminalRecordId: "provider-terminal-rollback",
            },
            derive: () => [
              {
                event: {
                  id: "event-rollback-terminal",
                  payload: { revision: 1 },
                  type: "fixture.finalised",
                },
                outbox: [],
                projection: { payload: { revision: 1 }, revision: 1 },
              },
            ],
            fixtureId: "fx-1",
            raw,
          },
        ],
        mode: "live",
        sourceFence: liveSourceFence,
      }),
    ).rejects.toThrow("injected archive enqueue failure");

    expect(attempted).toEqual(["raw", "projection", "event", "archive_job"]);
    expect(committed).toEqual([]);
  });

  it("idempotently enqueues archive recovery for a duplicate reconciliation terminal without deriving fan effects", async () => {
    const sourceTerminalRecordId = "provider-terminal-duplicate";
    const fake = testClient((query) => {
      if (query.includes("FROM matchsense.source_leases")) {
        return [sourceLeaseRow];
      }
      if (query.includes("INSERT INTO matchsense.raw_source_records"))
        return [];
      if (query.includes("INSERT INTO matchsense.archive_import_jobs")) {
        return [];
      }
      if (query.includes("FROM matchsense.archive_import_jobs")) {
        return [archiveImportJobRow(sourceTerminalRecordId)];
      }
      return [];
    });
    const repository = db.createFixtureTruthRepository?.(fake.client);
    const raw = {
      ...liveTerminalRaw(sourceTerminalRecordId, "raw-duplicate-terminal"),
      deliveryIntent: "reconcile" as const,
    };

    await expect(
      repository?.commitCollectorFrame({
        deliveries: [
          {
            archiveImportJob: liveTerminalArchiveImportJob(
              sourceTerminalRecordId,
            ),
            derive: () => {
              throw new Error("Duplicate raw must not derive a projection");
            },
            fixtureId: "fx-1",
            raw,
          },
        ],
        mode: "live",
        sourceFence: liveSourceFence,
      }),
    ).resolves.toEqual({
      deliveries: [{ kind: "duplicate" }],
      kind: "committed",
    });
    expect(
      fake.queries.some(({ query }) =>
        query.includes("INSERT INTO matchsense.archive_import_jobs"),
      ),
    ).toBe(true);
    expect(
      fake.queries.some(({ query }) =>
        query.includes("FROM matchsense.archive_import_jobs"),
      ),
    ).toBe(true);
    expect(
      fake.queries.some(
        ({ query }) =>
          query.includes("INSERT INTO matchsense.fixture_projections") ||
          query.includes("INSERT INTO matchsense.fixture_events") ||
          query.includes("INSERT INTO matchsense.moments") ||
          query.includes("INSERT INTO matchsense.outbox"),
      ),
    ).toBe(false);
  });

  it("does not enqueue an archive job when the live source fence is stale", async () => {
    const fake = testClient((query) => {
      if (query.includes("INSERT INTO matchsense.archive_import_jobs")) {
        throw new Error("Fenced frame must not enqueue an archive import job");
      }
      return [];
    });
    const repository = db.createFixtureTruthRepository?.(fake.client);
    const raw = liveTerminalRaw(
      "provider-terminal-fenced",
      "raw-fenced-terminal",
    );

    await expect(
      repository?.commitCollectorFrame({
        deliveries: [
          {
            archiveImportJob: liveTerminalArchiveImportJob(
              "provider-terminal-fenced",
            ),
            derive: () => {
              throw new Error("Fenced frame must not derive a projection");
            },
            fixtureId: "fx-1",
            raw,
          },
        ],
        mode: "live",
        sourceFence: liveSourceFence,
      }),
    ).resolves.toEqual({ kind: "fenced" });
    expect(
      fake.queries.some(
        ({ query }) =>
          query.includes("INSERT INTO matchsense.raw_source_records") ||
          query.includes("INSERT INTO matchsense.archive_import_jobs"),
      ),
    ).toBe(false);
  });

  it("returns fenced before any recorded raw or projection write when its source lease is lost", async () => {
    const fake = testClient((query) => {
      if (query.includes("FROM matchsense.source_leases")) return [];
      if (
        query.includes("INSERT INTO matchsense.raw_source_records") ||
        query.includes("INSERT INTO matchsense.fixture_projections")
      ) {
        throw new Error(
          "Lost recorded source lease must not write archive truth",
        );
      }
      return [];
    });
    const repository = db.createFixtureTruthRepository?.(fake.client);
    const raw = {
      ...liveRaw,
      canonicalEligible: true,
      deliveryIntent: "reconcile" as const,
      deliveryKey: "c".repeat(64),
      id: "recorded-lost-fence-frame",
      orderingKey: "00000000000000000001",
      payload: { Action: "game_finalised", FixtureId: "fx-1" },
      provenance: "recorded_txline_authorised" as const,
      rawRetention: "authorised_raw" as const,
      responseHash: "d".repeat(64),
      rightsGrantId: "archive-grant-1",
      source: recordedSourceFence.source,
      sourcePath: "/historical/score",
      streamKey: recordedSourceFence.streamKey,
    };

    await expect(
      repository?.commitCollectorFrame({
        deliveries: [
          {
            derive: () => [
              {
                event: {
                  id: "recorded-lost-fence-event",
                  payload: { fixtureId: "fx-1", revision: 1 },
                  type: "fixture.reconciled",
                },
                outbox: [],
                projection: { payload: { revision: 1 }, revision: 1 },
              },
            ],
            fixtureId: "fx-1",
            raw,
          },
        ],
        mode: "recorded",
        sourceFence: recordedSourceFence,
      }),
    ).resolves.toEqual({ kind: "fenced" });

    expect(fake.queries[0]).toMatchObject({
      parameters: [
        "recorded",
        recordedSourceFence.source,
        recordedSourceFence.streamKey,
        recordedSourceFence.holderId,
        recordedSourceFence.fencingToken,
      ],
    });
    expect(
      fake.queries.some(({ query }) =>
        query.includes("INSERT INTO matchsense.raw_source_records"),
      ),
    ).toBe(false);
    expect(
      fake.queries.some(({ query }) =>
        query.includes("INSERT INTO matchsense.fixture_projections"),
      ),
    ).toBe(false);
  });

  it("does not let a recorded source lease authorise raw data from another stream", async () => {
    const fake = testClient((query) => {
      if (query.includes("FROM matchsense.source_leases")) {
        return [recordedSourceLeaseRow];
      }
      if (query.includes("INSERT INTO matchsense.raw_source_records")) {
        throw new Error("A mismatched recorded stream must not write raw data");
      }
      return [];
    });
    const repository = db.createFixtureTruthRepository?.(fake.client);
    const raw = {
      ...liveRaw,
      id: "recorded-stream-mismatch",
      provenance: "recorded_txline_authorised" as const,
      source: recordedSourceFence.source,
      streamKey: "another-recorded-stream",
    };

    await expect(
      repository?.commitRawSourceRecord({
        fixtureId: "fx-1",
        mode: "recorded",
        raw,
        sourceFence: recordedSourceFence,
      }),
    ).resolves.toEqual({ kind: "fenced" });
    expect(
      fake.queries.some(({ query }) =>
        query.includes("INSERT INTO matchsense.raw_source_records"),
      ),
    ).toBe(false);
  });

  it("fences a recorded raw write when its omitted stream key resolves to another stream", async () => {
    const fake = testClient((query) => {
      if (query.includes("FROM matchsense.source_leases")) {
        return [recordedSourceLeaseRow];
      }
      if (query.includes("INSERT INTO matchsense.raw_source_records")) {
        throw new Error("An effective stream mismatch must not write raw data");
      }
      return [];
    });
    const repository = db.createFixtureTruthRepository?.(fake.client);
    const { streamKey: _streamKey, ...rawWithoutStreamKey } = {
      ...liveRaw,
      id: "recorded-implicit-stream-mismatch",
      provenance: "recorded_txline_authorised" as const,
      source: recordedSourceFence.source,
    };

    await expect(
      repository?.commitRawSourceRecord({
        fixtureId: "fx-1",
        mode: "recorded",
        raw: rawWithoutStreamKey,
        sourceFence: recordedSourceFence,
      }),
    ).resolves.toEqual({ kind: "fenced" });
    expect(
      fake.queries.some(({ query }) =>
        query.includes("INSERT INTO matchsense.raw_source_records"),
      ),
    ).toBe(false);
  });

  it("commits a recorded collector frame only under its current source lease", async () => {
    const fake = testClient((query) => {
      if (query.includes("FROM matchsense.source_leases")) {
        return [recordedSourceLeaseRow];
      }
      if (query.includes("INSERT INTO matchsense.raw_source_records")) {
        return [{ id: "recorded-valid-fence-frame" }];
      }
      if (query.includes("SELECT id") && query.includes("FOR UPDATE")) {
        return [{ id: "fx-1" }];
      }
      if (query.includes("FROM matchsense.fixture_projections")) return [];
      if (query.includes("INSERT INTO matchsense.fixture_events")) {
        return [{ sequence: "1" }];
      }
      return [];
    });
    const repository = db.createFixtureTruthRepository?.(fake.client);
    const raw = {
      ...liveRaw,
      canonicalEligible: true,
      deliveryIntent: "reconcile" as const,
      deliveryKey: "e".repeat(64),
      id: "recorded-valid-fence-frame",
      orderingKey: "00000000000000000002",
      payload: { Action: "game_finalised", FixtureId: "fx-1" },
      provenance: "recorded_txline_authorised" as const,
      rawRetention: "authorised_raw" as const,
      responseHash: "f".repeat(64),
      rightsGrantId: "archive-grant-1",
      source: recordedSourceFence.source,
      sourcePath: "/historical/score",
      streamKey: recordedSourceFence.streamKey,
    };

    await expect(
      repository?.commitCollectorFrame({
        deliveries: [
          {
            derive: () => [
              {
                event: {
                  id: "recorded-valid-fence-event",
                  payload: { fixtureId: "fx-1", revision: 1 },
                  type: "fixture.reconciled",
                },
                outbox: [],
                projection: { payload: { revision: 1 }, revision: 1 },
              },
            ],
            fixtureId: "fx-1",
            raw,
          },
        ],
        mode: "recorded",
        sourceFence: recordedSourceFence,
      }),
    ).resolves.toEqual({
      deliveries: [{ eventSequences: [1], kind: "committed", revisions: [1] }],
      kind: "committed",
    });

    const leaseIndex = fake.queries.findIndex(({ query }) =>
      query.includes("FROM matchsense.source_leases"),
    );
    const rawIndex = fake.queries.findIndex(({ query }) =>
      query.includes("INSERT INTO matchsense.raw_source_records"),
    );
    const projectionIndex = fake.queries.findIndex(({ query }) =>
      query.includes("INSERT INTO matchsense.fixture_projections"),
    );
    expect(leaseIndex).toBeGreaterThan(-1);
    expect(rawIndex).toBeGreaterThan(leaseIndex);
    expect(projectionIndex).toBeGreaterThan(rawIndex);
  });

  it("does not persist any frame delivery when its fenced cursor is already stale", async () => {
    const fake = testClient((query) => {
      if (query.includes("FROM matchsense.source_leases")) {
        return [sourceLeaseRow];
      }
      if (query.includes("FROM matchsense.source_cursors")) {
        return [sourceCursorRow];
      }
      if (query.includes("INSERT INTO matchsense.raw_source_records")) {
        throw new Error("A stale cursor must not write raw delivery state");
      }
      return [];
    });
    const repository = db.createFixtureTruthRepository?.(fake.client);
    const raw = liveTerminalRaw(
      "provider-terminal-stale-cursor",
      "raw-stale-frame",
    );

    await expect(
      repository?.commitCollectorFrame({
        cursor: { expectedCursor: null, nextCursor: "cursor:52" },
        deliveries: [
          {
            archiveImportJob: liveTerminalArchiveImportJob(
              "provider-terminal-stale-cursor",
            ),
            derive: () => {
              throw new Error("Stale cursor must not derive a projection");
            },
            fixtureId: "fx-1",
            raw,
          },
        ],
        mode: "live",
        sourceFence: liveSourceFence,
      }),
    ).resolves.toEqual({
      currentCursor: "cursor-620",
      kind: "conflict",
    });
    expect(
      fake.queries.some(({ query }) =>
        query.includes("INSERT INTO matchsense.raw_source_records"),
      ),
    ).toBe(false);
    expect(
      fake.queries.some(({ query }) =>
        query.includes("INSERT INTO matchsense.archive_import_jobs"),
      ),
    ).toBe(false);
  });
});

describe("source stream state repository", () => {
  it("acquires an expired stream lease with a monotonically increasing fencing token", async () => {
    const fake = testClient(() => [sourceLeaseRow]);
    const repository = db.createSourceStateRepository?.(fake.client);

    await expect(
      repository?.acquireLease({
        holderId: "worker-new",
        leaseUntil: "2026-07-17T12:02:00.000Z",
        mode: "live",
        source: "txline",
        streamKey: "scores:mainnet",
      }),
    ).resolves.toEqual({
      fencingToken: currentGeneration,
      holderId: "worker-new",
      leaseUntil: "2026-07-17T12:02:00.000Z",
      mode: "live",
      source: "txline",
      streamKey: "scores:mainnet",
      updatedAt: "2026-07-17T12:01:00.000Z",
    });
    expect(fake.queries[0]?.query).toContain(
      "fencing_token = source_leases.fencing_token + 1",
    );
    expect(fake.queries[0]?.query).toContain(
      "source_leases.lease_until <= clock_timestamp()",
    );
    expect(fake.queries[0]?.parameters).toEqual([
      "live",
      "txline",
      "scores:mainnet",
      "worker-new",
      "2026-07-17T12:02:00.000Z",
    ]);
  });

  it("advances an opaque cursor only under the live fenced lease and exact expected cursor", async () => {
    const fake = testClient((query) => {
      if (query.includes("FROM matchsense.source_leases")) {
        return [sourceLeaseRow];
      }
      if (
        query.includes("FROM matchsense.source_cursors") &&
        query.includes("FOR UPDATE")
      ) {
        return [{ ...sourceCursorRow, cursor_value: "cursor-619" }];
      }
      if (query.includes("INSERT INTO matchsense.source_cursors")) {
        return [sourceCursorRow];
      }
      return [];
    });
    const repository = db.createSourceStateRepository?.(fake.client);

    await expect(
      repository?.advanceCursor({
        cursorValue: "cursor-620",
        expectedCursor: "cursor-619",
        fencingToken: currentGeneration,
        holderId: "worker-new",
        mode: "live",
        source: "txline",
        streamKey: "scores:mainnet",
      }),
    ).resolves.toEqual({
      cursor: expect.objectContaining({
        cursorValue: "cursor-620",
        fencingToken: currentGeneration,
      }),
      kind: "advanced",
    });
    expect(fake.queries.every(({ transaction }) => transaction)).toBe(true);
    expect(fake.queries[0]?.query).toMatch(
      /lease_until > clock_timestamp\(\)[\s\S]*FOR UPDATE/u,
    );
    expect(fake.queries[2]?.query).toContain(
      "INSERT INTO matchsense.source_cursors",
    );
  });

  it("reports cursor conflict without a write and fences an expired prior owner", async () => {
    const conflict = testClient((query) =>
      query.includes("source_leases")
        ? [sourceLeaseRow]
        : [{ ...sourceCursorRow, cursor_value: "cursor-620" }],
    );
    const conflictRepository = db.createSourceStateRepository?.(
      conflict.client,
    );
    await expect(
      conflictRepository?.advanceCursor({
        cursorValue: "cursor-621",
        expectedCursor: "cursor-619",
        fencingToken: currentGeneration,
        holderId: "worker-new",
        mode: "live",
        source: "txline",
        streamKey: "scores:mainnet",
      }),
    ).resolves.toEqual({
      currentCursor: "cursor-620",
      kind: "conflict",
    });
    expect(conflict.queries).toHaveLength(2);

    const fenced = testClient(() => []);
    const fencedRepository = db.createSourceStateRepository?.(fenced.client);
    await expect(
      fencedRepository?.advanceCursor({
        cursorValue: "cursor-621",
        expectedCursor: "cursor-620",
        fencingToken: expiredGeneration,
        holderId: "worker-old",
        mode: "live",
        source: "txline",
        streamKey: "scores:mainnet",
      }),
    ).resolves.toEqual({ kind: "fenced" });
    expect(fenced.queries).toHaveLength(1);
  });

  it("requires the current fencing token to renew and release a lease", async () => {
    const fake = testClient((query) =>
      query.includes("RETURNING") ? [sourceLeaseRow] : [],
    );
    const repository = db.createSourceStateRepository?.(fake.client);
    const key = {
      fencingToken: currentGeneration,
      holderId: "worker-new",
      mode: "live",
      source: "txline",
      streamKey: "scores:mainnet",
    };

    await expect(
      repository?.renewLease({
        ...key,
        leaseUntil: "2026-07-17T12:03:00.000Z",
      }),
    ).resolves.toEqual(
      expect.objectContaining({ fencingToken: currentGeneration }),
    );
    await expect(repository?.releaseLease(key)).resolves.toBe(true);
    expect(fake.queries[0]?.query).toMatch(
      /holder_id = \$4[\s\S]*fencing_token = \$5/u,
    );
    expect(fake.queries[1]?.query).toMatch(
      /holder_id = \$4[\s\S]*fencing_token = \$5/u,
    );
  });

  it("reads cursor state by stream key without a fixture key", async () => {
    const fake = testClient(() => [sourceCursorRow]);
    const repository = db.createSourceStateRepository?.(fake.client);

    await expect(
      repository?.getCursor({
        mode: "live",
        source: "txline",
        streamKey: "scores:mainnet",
      }),
    ).resolves.toEqual({
      cursorValue: "cursor-620",
      fencingToken: currentGeneration,
      mode: "live",
      source: "txline",
      streamKey: "scores:mainnet",
      updatedAt: "2026-07-17T12:01:00.000Z",
    });
    expect(fake.queries[0]?.parameters).toEqual([
      "live",
      "txline",
      "scores:mainnet",
    ]);
    expect(fake.queries[0]?.query).not.toContain("fixture_id");
  });
});

describe("commentary artifact repository", () => {
  it("keeps independently versioned commentary artifacts for the same Moment", async () => {
    const legacyRow = {
      bytes: new Uint8Array([1, 2, 3]),
      created_at: "2026-07-17T12:02:00.000Z",
      fixture_id: "fx-1",
      id: "commentary-1",
      language: "en-IN",
      media_type: "audio/mpeg",
      mode: "recorded",
      moment_id: "moment-1",
      moment_revision: "1",
      template_version: "legacy-v1",
      updated_at: "2026-07-17T12:02:00.000Z",
      voice: "kore",
    };
    const factualRow = {
      ...legacyRow,
      bytes: new Uint8Array([4, 5, 6]),
      id: "commentary-factual-v2",
      template_version: "factual-v2",
    };
    const fake = testClient((_query, parameters) =>
      parameters.at(-1) === "factual-v2" ? [factualRow] : [legacyRow],
    );
    const repository = db.createCommentaryArtifactRepository?.(fake.client);
    const key = {
      fixtureId: "fx-1",
      language: "en-IN",
      mode: "recorded",
      momentId: "moment-1",
      momentRevision: 1,
      templateVersion: "legacy-v1",
      voice: "kore",
    };

    await expect(repository?.get(key)).resolves.toMatchObject({
      bytes: new Uint8Array([1, 2, 3]),
      momentRevision: 1,
    });
    await expect(
      repository?.get({ ...key, templateVersion: "factual-v2" }),
    ).resolves.toMatchObject({
      bytes: new Uint8Array([4, 5, 6]),
      id: "commentary-factual-v2",
      templateVersion: "factual-v2",
    });
    await expect(
      repository?.upsert({
        ...key,
        bytes: new Uint8Array([1, 2, 3]),
        id: "commentary-1",
        mediaType: "audio/mpeg",
      }),
    ).resolves.toMatchObject({ id: "commentary-1" });
    expect(fake.queries[2]?.query).toContain(
      "ON CONFLICT (mode, fixture_id, moment_id, moment_revision, language, voice, template_version)",
    );
  });
});

describe("outbox repository", () => {
  const outboxRow = {
    attempt_count: 1,
    available_at: "2026-07-17T12:00:00.000Z",
    claim_token: "fixture-claim-one",
    created_at: "2026-07-17T12:00:00.000Z",
    fixture_id: "fx-1",
    id: "outbox-1",
    idempotency_key: "moment-1:1:foreground",
    last_error: null,
    locked_at: "2026-07-17T12:00:01.000Z",
    locked_by: "worker-1",
    mode: "demo",
    payload: '{"momentId":"moment-1"}',
    processed_at: null,
    topic: "moment.created",
  };

  it("claims eligible topics with SKIP LOCKED and completes its own claim", async () => {
    const fake = testClient((query) =>
      query.includes("RETURNING") ? [outboxRow] : [],
    );
    const repository = db.createOutboxRepository?.(fake.client);

    await expect(
      repository?.claim({
        claimToken: "fixture-claim-one",
        limit: 10,
        lockTimeoutMs: 30_000,
        mode: "demo",
        topics: ["moment.created"],
        workerId: "worker-1",
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        attemptCount: 1,
        claimToken: "fixture-claim-one",
        id: "outbox-1",
        payload: { momentId: "moment-1" },
      }),
    ]);
    await expect(
      repository?.complete({
        claimToken: "fixture-claim-one",
        id: "outbox-1",
        mode: "demo",
        workerId: "worker-1",
      }),
    ).resolves.toBe(true);
    expect(fake.queries[0]?.query).toContain("FOR UPDATE SKIP LOCKED");
    expect(fake.queries[0]?.query).toContain("topic = ANY");
    expect(fake.queries[0]?.query).toContain("claim_token = $6");
    expect(fake.queries[1]?.query).toMatch(
      /locked_by = \$3 AND claim_token = \$4/u,
    );
  });

  it("records consumer receipts idempotently", async () => {
    let insertCount = 0;
    const fake = testClient((query) => {
      if (query.includes("SELECT EXISTS")) return [{ exists: true }];
      if (query.includes("INSERT INTO matchsense.consumer_receipts")) {
        insertCount += 1;
        return insertCount === 1 ? [{ outbox_id: "outbox-1" }] : [];
      }
      return [];
    });
    const repository = db.createOutboxRepository?.(fake.client);
    const receipt = {
      consumer: "foreground",
      mode: "demo",
      outboxId: "outbox-1",
    };

    await expect(repository?.hasConsumerReceipt(receipt)).resolves.toBe(true);
    await expect(repository?.recordConsumerReceipt(receipt)).resolves.toBe(
      true,
    );
    await expect(repository?.recordConsumerReceipt(receipt)).resolves.toBe(
      false,
    );
    expect(fake.queries[1]?.query).toContain("ON CONFLICT DO NOTHING");
  });

  it("moves an exhausted claimed message to dead letter atomically", async () => {
    const fake = testClient((query) => {
      if (query.includes("SELECT") && query.includes("FOR UPDATE")) {
        return [{ ...outboxRow, attempt_count: 3 }];
      }
      return [];
    });
    const repository = db.createOutboxRepository?.(fake.client);

    await expect(
      repository?.retryOrDeadLetter({
        availableAt: "2026-07-17T12:01:00.000Z",
        claimToken: "fixture-claim-one",
        deadLetterId: "dead-outbox-1",
        error: "handler failed",
        id: "outbox-1",
        maxAttempts: 3,
        mode: "demo",
        workerId: "worker-1",
      }),
    ).resolves.toEqual({ kind: "dead_letter" });
    expect(fake.queries.every(({ transaction }) => transaction)).toBe(true);
    expect(fake.queries.map(({ query }) => query)).toEqual([
      expect.stringMatching(
        /SELECT[\s\S]*locked_by = \$3 AND claim_token = \$4[\s\S]*FOR UPDATE/u,
      ),
      expect.stringContaining("INSERT INTO matchsense.outbox_dead_letters"),
      expect.stringMatching(
        /UPDATE matchsense\.outbox[\s\S]*claim_token = NULL/u,
      ),
    ]);
  });
});
