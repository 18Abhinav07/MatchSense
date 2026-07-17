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
    commitFixtureSchedule(input: Record<string, unknown>): Promise<unknown>;
    commitRawSourceRecord(input: Record<string, unknown>): Promise<unknown>;
    commitSourceChange(input: Record<string, unknown>): Promise<unknown>;
    eventsAfter(input: Record<string, unknown>): Promise<unknown>;
    get(input: Record<string, unknown>): Promise<unknown>;
    getLatestProjection(input: Record<string, unknown>): Promise<unknown>;
    list(input: Record<string, unknown>): Promise<unknown>;
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

const liveFixtureInput = {
  ...fixtureInput,
  mode: "live",
  provenance: "live_txline",
};

const liveRaw = {
  ...sourceChange.raw,
  provenance: "live_txline",
  source: "txline",
};

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
  it("gets and upserts fixture-scoped MP3 bytes", async () => {
    const row = {
      bytes: new Uint8Array([1, 2, 3]),
      created_at: "2026-07-17T12:02:00.000Z",
      fixture_id: "fx-1",
      id: "commentary-1",
      language: "en-IN",
      media_type: "audio/mpeg",
      mode: "demo",
      moment_id: "moment-1",
      moment_revision: "1",
      updated_at: "2026-07-17T12:02:00.000Z",
      voice: "kore",
    };
    const fake = testClient(() => [row]);
    const repository = db.createCommentaryArtifactRepository?.(fake.client);
    const key = {
      fixtureId: "fx-1",
      language: "en-IN",
      mode: "demo",
      momentId: "moment-1",
      momentRevision: 1,
      voice: "kore",
    };

    await expect(repository?.get(key)).resolves.toMatchObject({
      bytes: new Uint8Array([1, 2, 3]),
      momentRevision: 1,
    });
    await expect(
      repository?.upsert({
        ...key,
        bytes: new Uint8Array([1, 2, 3]),
        id: "commentary-1",
        mediaType: "audio/mpeg",
      }),
    ).resolves.toMatchObject({ id: "commentary-1" });
    expect(fake.queries[1]?.query).toContain(
      "ON CONFLICT (mode, fixture_id, moment_id, moment_revision, language, voice)",
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
