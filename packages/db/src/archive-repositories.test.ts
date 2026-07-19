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

type ArchiveRepository = {
  ensureRightsGrant?(input: Record<string, unknown>): Promise<unknown>;
  insertDelivery(input: Record<string, unknown>): Promise<unknown>;
  invalidateArchive(input: Record<string, unknown>): Promise<void>;
  orderedDeliveries(
    input: Record<string, unknown>,
  ): Promise<readonly unknown[]>;
  replayReady(input: Record<string, unknown>): Promise<unknown>;
  verifyArchive(input: Record<string, unknown>): Promise<unknown>;
};

type DatabaseModuleContract = {
  createArchiveRepository?: (client: TestClient) => ArchiveRepository;
};

const db = databaseModule as DatabaseModuleContract;

const fixtureId = "18237038";
const recordedFence = {
  fencingToken: 7,
  holderId: "archive-worker-a",
  source: "txline",
  streamKey: "historical:18237038",
} as const;
const liveFence = {
  fencingToken: 4,
  holderId: "collector-a",
  source: "txline",
  streamKey: "scores:mainnet",
} as const;
const sourceOnlyDelivery = {
  canonicalEligible: false,
  deliveryIntent: "reconcile",
  deliveryKey: "a".repeat(64),
  fixtureId,
  id: "delivery-coverage-1",
  mode: "recorded",
  orderingKey: "000000000042",
  payload: { coverage: "closed", fixtureId },
  payloadHash: "b".repeat(64),
  rawRetention: "authorised_raw",
  receivedAt: "2026-07-18T12:00:00.000Z",
  responseHash: "c".repeat(64),
  rightsGrantId: "txodds-hackathon-2026",
  source: "txline",
  sourcePath: "/api/scores/historical/18237038",
  sourceRecordId: "coverage-42",
  sourceSequence: "42",
  streamKey: "historical:18237038",
} as const;

const terminalDelivery = {
  ...sourceOnlyDelivery,
  canonicalEligible: true,
  deliveryKey: "d".repeat(64),
  id: "delivery-final-1026",
  orderingKey: "000000001026",
  payload: {
    Action: "game_finalised",
    Confirmed: true,
    FixtureId: fixtureId,
    StatusId: 100,
  },
  payloadHash: "e".repeat(64),
  responseHash: "f".repeat(64),
  sourceRecordId: "final-1026",
  sourceSequence: "1026",
} as const;

const wrappedTerminalDelivery = {
  ...terminalDelivery,
  payload: {
    Action: "goal",
    Confirmed: false,
    StatusId: 0,
    update: {
      action: "GAME_FINALISED",
      confirmed: true,
      statusId: 100,
    },
  },
} as const;

function sourceDeliveryRow(
  input:
    | typeof sourceOnlyDelivery
    | typeof terminalDelivery
    | typeof wrappedTerminalDelivery,
) {
  return {
    canonical_eligible: input.canonicalEligible,
    delivery_intent: input.deliveryIntent,
    delivery_key: input.deliveryKey,
    fixture_id: input.fixtureId,
    id: input.id,
    mode: input.mode,
    ordering_key: input.orderingKey,
    payload: JSON.stringify(input.payload),
    payload_hash: input.payloadHash,
    persisted_at: "2026-07-18T12:00:01.000Z",
    raw_retention: input.rawRetention,
    received_at: input.receivedAt,
    response_hash: input.responseHash,
    rights_grant_id: input.rightsGrantId,
    source: input.source,
    source_path: input.sourcePath,
    source_record_id: input.sourceRecordId,
    source_sequence: input.sourceSequence,
    stream_key: input.streamKey,
  };
}

function manifestRow(status: string, mode: "live" | "recorded" = "recorded") {
  return {
    created_at: "2026-07-18T12:01:00.000Z",
    delivery_manifest_hash: "1".repeat(64),
    fixture_id: fixtureId,
    id: "manifest-1",
    invalidated_at: null,
    invalidation_reason: null,
    mode,
    projection_hash: "2".repeat(64),
    reducer_version: "txline-reducer-v1",
    rights_grant_id: "txodds-hackathon-2026",
    status,
    terminal_delivery_id: "delivery-final-1026",
    updated_at: "2026-07-18T12:01:00.000Z",
    verified_at: "2026-07-18T12:01:00.000Z",
  };
}

function testClient(
  resolve: (
    query: string,
    parameters: readonly unknown[],
  ) => readonly QueryRow[] | Promise<readonly QueryRow[]>,
  sourceLease: "current" | "stale" = "current",
) {
  const queries: { parameters: readonly unknown[]; query: string }[] = [];
  const unsafe = vi.fn<UnsafeQuery>(async (query, parameters = []) => {
    queries.push({ parameters, query });
    if (query.includes("FROM matchsense.source_leases")) {
      return sourceLease === "current" ? [{ fencing_token: 7 }] : [];
    }
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

describe("archive repository", () => {
  it("preserves an existing revoked rights grant when bootstrap rights are ensured", async () => {
    const existing = {
      active: false,
      created_at: "2026-07-17T12:00:00.000Z",
      expires_at: "2026-08-01T12:00:00.000Z",
      id: "txline-world-cup-hackathon-2026",
      raw_retention_until: "2026-07-25T12:00:00.000Z",
      reference: "manually revoked TxLINE grant",
      revoked_at: "2026-07-18T11:00:00.000Z",
      scopes: ["replay"],
      updated_at: "2026-07-18T11:00:00.000Z",
    };
    const fake = testClient((query) => {
      if (query.includes("INSERT INTO matchsense.rights_grants")) return [];
      if (query.includes("FROM matchsense.rights_grants")) return [existing];
      return [];
    });
    const archive = db.createArchiveRepository?.(fake.client);

    const ensured = await archive?.ensureRightsGrant?.({
      active: true,
      id: "txline-world-cup-hackathon-2026",
      reference: "TxLINE World Cup Hackathon 2026",
      scopes: ["audio", "raw_retention", "replay"],
    });

    expect(ensured).toEqual({
      active: false,
      createdAt: existing.created_at,
      expiresAt: existing.expires_at,
      id: existing.id,
      rawRetentionUntil: existing.raw_retention_until,
      reference: existing.reference,
      revokedAt: existing.revoked_at,
      scopes: ["replay"],
      updatedAt: existing.updated_at,
    });
    expect(fake.queries).toHaveLength(2);
    expect(fake.queries[0]?.query).toContain("ON CONFLICT (id) DO NOTHING");
    expect(fake.queries[0]?.query).not.toContain("DO UPDATE");
    expect(fake.queries[1]?.query).toContain("FROM matchsense.rights_grants");
  });

  it("retains one immutable source-only delivery and keeps its duplicate inert", async () => {
    let insertCount = 0;
    const fake = testClient((query) => {
      if (query.includes("FROM matchsense.rights_grants")) {
        if (query.includes("ARRAY['replay']")) return [];
        return [
          {
            active: true,
            expires_at: null,
            raw_retention_until: null,
            revoked_at: null,
            scopes: ["raw_retention", "replay"],
          },
        ];
      }
      if (query.includes("INSERT INTO matchsense.raw_source_records")) {
        insertCount += 1;
        return insertCount === 1 ? [sourceDeliveryRow(sourceOnlyDelivery)] : [];
      }
      return [];
    });
    const archive = db.createArchiveRepository?.(fake.client);

    await expect(
      archive?.insertDelivery(sourceOnlyDelivery),
    ).resolves.toMatchObject({
      canonicalEligible: false,
      inserted: true,
    });
    await expect(
      archive?.insertDelivery(sourceOnlyDelivery),
    ).resolves.toMatchObject({
      duplicate: true,
      inserted: false,
    });
    expect(
      fake.queries.some(({ query }) => query.includes("canonical_eligible")),
    ).toBe(true);
    expect(
      fake.queries.some(({ query }) => query.includes("ON CONFLICT")),
    ).toBe(true);
    expect(
      fake.queries.some(({ query }) =>
        /canonical_moments|moment_revisions|fixture_events|outbox/u.test(query),
      ),
    ).toBe(false);
  });

  it("rejects raw archive writes when a grant lacks the raw-retention scope", async () => {
    const fake = testClient(() => []);
    const archive = db.createArchiveRepository?.(fake.client);

    await expect(archive?.insertDelivery(sourceOnlyDelivery)).rejects.toThrow(
      "Authorised raw retention grant is inactive, expired, revoked, or missing raw-retention scope",
    );
    expect(
      fake.queries.some(({ query }) =>
        query.includes("INSERT INTO matchsense.raw_source_records"),
      ),
    ).toBe(false);
  });

  it("publishes a replay only from an ordered authorised terminal archive and invalidates it in the same mode", async () => {
    let invalidated = false;
    const fake = testClient((query) => {
      if (query.includes("FROM matchsense.raw_source_records")) {
        return [
          sourceDeliveryRow(sourceOnlyDelivery),
          sourceDeliveryRow(terminalDelivery),
        ];
      }
      if (query.includes("FROM matchsense.rights_grants")) {
        return [
          {
            active: true,
            expires_at: null,
            revoked_at: null,
            scopes: ["raw_retention", "replay"],
          },
        ];
      }
      if (query.includes("INSERT INTO matchsense.archive_manifests")) {
        return [manifestRow("REPLAY_READY")];
      }
      if (query.includes("UPDATE matchsense.archive_manifests")) {
        invalidated = true;
        return [];
      }
      if (query.includes("FROM matchsense.archive_manifests")) {
        return invalidated ? [] : [manifestRow("REPLAY_READY")];
      }
      return [];
    });
    const archive = db.createArchiveRepository?.(fake.client);

    await expect(
      archive?.verifyArchive({
        fixtureId,
        manifestId: "manifest-1",
        mode: "recorded",
        projectionHash: "2".repeat(64),
        reducerVersion: "txline-reducer-v1",
        rightsGrantId: "txodds-hackathon-2026",
        sourceFence: recordedFence,
        terminalDeliveryId: terminalDelivery.id,
      }),
    ).resolves.toMatchObject({
      kind: "verified",
      manifest: { status: "REPLAY_READY" },
    });
    await expect(
      archive?.invalidateArchive({
        fixtureId,
        mode: "recorded",
        reason: "canonical correction",
        sourceFence: recordedFence,
      }),
    ).resolves.toEqual({ kind: "applied" });
    await expect(
      archive?.replayReady({ fixtureId, mode: "recorded" }),
    ).resolves.toBeNull();
    expect(
      fake.queries.some(({ query }) => query.includes("ORDER BY ordering_key")),
    ).toBe(true);
    expect(
      fake.queries.some(({ query }) => query.includes("REPLAY_INVALIDATED")),
    ).toBe(true);
    const invalidate = fake.queries.find(({ query }) =>
      query.includes("UPDATE matchsense.archive_manifests"),
    );
    expect(invalidate?.parameters).toEqual([
      "recorded",
      fixtureId,
      "canonical correction",
    ]);
    const sourceLeaseQueries = fake.queries.filter(({ query }) =>
      query.includes("FROM matchsense.source_leases"),
    );
    expect(sourceLeaseQueries).toHaveLength(2);
    expect(sourceLeaseQueries[0]?.parameters).toEqual([
      "recorded",
      recordedFence.source,
      recordedFence.streamKey,
      recordedFence.holderId,
      recordedFence.fencingToken,
    ]);
    expect(sourceLeaseQueries[0]?.query).toContain(
      "lease_until > clock_timestamp()",
    );
    expect(sourceLeaseQueries[0]?.query).toContain("FOR UPDATE");
    const firstLeaseLock = fake.queries.findIndex(({ query }) =>
      query.includes("FROM matchsense.source_leases"),
    );
    const firstManifestMutation = fake.queries.findIndex(({ query }) =>
      /INSERT INTO matchsense\.archive_manifests|UPDATE matchsense\.archive_manifests/u.test(
        query,
      ),
    );
    expect(firstLeaseLock).toBeGreaterThanOrEqual(0);
    expect(firstLeaseLock).toBeLessThan(firstManifestMutation);
  });

  it("treats a replay-ready manifest as unavailable without its current replay-ready job/output binding", async () => {
    const stale = testClient((query) => {
      if (query.includes("archive_import_jobs AS archive_job")) return [];
      if (query.includes("FROM matchsense.archive_manifests")) {
        return [manifestRow("REPLAY_READY")];
      }
      return [];
    });
    const staleArchive = db.createArchiveRepository?.(stale.client);
    await expect(
      staleArchive?.replayReady({ fixtureId, mode: "recorded" }),
    ).resolves.toBeNull();

    const current = testClient((query) =>
      query.includes("archive_import_jobs AS archive_job")
        ? [manifestRow("REPLAY_READY")]
        : [],
    );
    const currentArchive = db.createArchiveRepository?.(current.client);
    await expect(
      currentArchive?.replayReady({ fixtureId, mode: "recorded" }),
    ).resolves.toMatchObject({ id: "manifest-1", status: "REPLAY_READY" });

    const replayQuery = current.queries.find(({ query }) =>
      query.includes("FROM matchsense.archive_manifests"),
    );
    expect(replayQuery?.query).toContain("EXISTS (");
    expect(replayQuery?.query).toContain(
      "FROM matchsense.archive_import_jobs AS archive_job",
    );
    expect(replayQuery?.query).toContain(
      "JOIN matchsense.archive_import_job_outputs AS archive_output",
    );
    expect(replayQuery?.query).toContain("archive_job.state = 'replay_ready'");
    expect(replayQuery?.query).toContain(
      "archive_job.archive_manifest_id = manifest.id",
    );
    expect(replayQuery?.query).toContain(
      "archive_job.archive_manifest_hash = manifest.delivery_manifest_hash",
    );
  });

  it("accepts the final canonical terminal when a source-only delivery follows it", async () => {
    const laterDelivery = {
      ...sourceOnlyDelivery,
      deliveryKey: "9".repeat(64),
      id: "delivery-after-final",
      orderingKey: "000000001027",
      payloadHash: "8".repeat(64),
      responseHash: "7".repeat(64),
    };
    const fake = testClient((query) => {
      if (query.includes("FROM matchsense.rights_grants")) {
        return [
          {
            active: true,
            expires_at: null,
            revoked_at: null,
            scopes: ["raw_retention", "replay"],
          },
        ];
      }
      if (query.includes("FROM matchsense.raw_source_records")) {
        return [
          sourceDeliveryRow(terminalDelivery),
          sourceDeliveryRow(laterDelivery),
        ];
      }
      if (query.includes("INSERT INTO matchsense.archive_manifests")) {
        return [manifestRow("REPLAY_READY")];
      }
      return [];
    });
    const archive = db.createArchiveRepository?.(fake.client);

    await expect(
      archive?.verifyArchive({
        fixtureId,
        manifestId: "manifest-not-terminal",
        mode: "recorded",
        projectionHash: "2".repeat(64),
        reducerVersion: "txline-reducer-v1",
        rightsGrantId: "txodds-hackathon-2026",
        sourceFence: recordedFence,
        terminalDeliveryId: terminalDelivery.id,
      }),
    ).resolves.toMatchObject({
      kind: "verified",
      manifest: { status: "REPLAY_READY" },
    });
  });

  it("rejects a terminal delivery superseded by a later canonical delivery", async () => {
    const laterCanonicalDelivery = {
      ...terminalDelivery,
      deliveryKey: "9".repeat(64),
      id: "delivery-canonical-after-final",
      orderingKey: "000000001027",
      payload: { Action: "action_amend", FixtureId: fixtureId },
      payloadHash: "8".repeat(64),
      responseHash: "7".repeat(64),
      sourceRecordId: "amend-1027",
      sourceSequence: "1027",
    };
    const fake = testClient((query) => {
      if (query.includes("FROM matchsense.rights_grants")) {
        return [
          {
            active: true,
            expires_at: null,
            revoked_at: null,
            scopes: ["raw_retention", "replay"],
          },
        ];
      }
      if (query.includes("FROM matchsense.raw_source_records")) {
        return [
          sourceDeliveryRow(terminalDelivery),
          sourceDeliveryRow(laterCanonicalDelivery),
        ];
      }
      return [];
    });
    const archive = db.createArchiveRepository?.(fake.client);

    await expect(
      archive?.verifyArchive({
        fixtureId,
        manifestId: "manifest-superseded-terminal",
        mode: "recorded",
        projectionHash: "2".repeat(64),
        reducerVersion: "txline-reducer-v1",
        rightsGrantId: "txodds-hackathon-2026",
        sourceFence: recordedFence,
        terminalDeliveryId: terminalDelivery.id,
      }),
    ).rejects.toThrow(
      "Archive terminal delivery must be the final canonical delivery",
    );
  });

  it.each([
    [
      "explicitly unconfirmed",
      { ...terminalDelivery.payload, Confirmed: false },
    ],
    ["a non-final status", { ...terminalDelivery.payload, StatusId: 99 }],
    [
      "a malformed wrapper that overrides a valid root final",
      {
        ...terminalDelivery.payload,
        Update: { ...terminalDelivery.payload, Action: "action-amend" },
      },
    ],
  ])(
    "rejects %s game_finalised data before it can become replay ready",
    async (_label, payload) => {
      const fake = testClient((query) => {
        if (query.includes("FROM matchsense.rights_grants")) {
          return [{ id: "txodds-hackathon-2026" }];
        }
        if (query.includes("FROM matchsense.raw_source_records")) {
          return [
            {
              ...sourceDeliveryRow(terminalDelivery),
              payload: JSON.stringify(payload),
            },
          ];
        }
        return [];
      });
      const archive = db.createArchiveRepository?.(fake.client);

      await expect(
        archive?.verifyArchive({
          fixtureId,
          manifestId: `manifest-${String(_label)}`,
          mode: "recorded",
          projectionHash: "2".repeat(64),
          reducerVersion: "txline-reducer-v1",
          rightsGrantId: "txodds-hackathon-2026",
          sourceFence: recordedFence,
          terminalDeliveryId: terminalDelivery.id,
        }),
      ).rejects.toThrow(
        "Archive terminal delivery must be confirmed game_finalised with StatusId 100",
      );
    },
  );

  it("accepts a one-level adapter-wrapped authoritative terminal", async () => {
    const fake = testClient((query) => {
      if (query.includes("FROM matchsense.rights_grants")) {
        return [
          {
            active: true,
            expires_at: null,
            revoked_at: null,
            scopes: ["raw_retention", "replay"],
          },
        ];
      }
      if (query.includes("FROM matchsense.raw_source_records")) {
        return [sourceDeliveryRow(wrappedTerminalDelivery)];
      }
      if (query.includes("INSERT INTO matchsense.archive_manifests")) {
        return [manifestRow("REPLAY_READY")];
      }
      return [];
    });
    const archive = db.createArchiveRepository?.(fake.client);

    await expect(
      archive?.verifyArchive({
        fixtureId,
        manifestId: "manifest-wrapped-terminal",
        mode: "recorded",
        projectionHash: "2".repeat(64),
        reducerVersion: "txline-reducer-v1",
        rightsGrantId: "txodds-hackathon-2026",
        sourceFence: recordedFence,
        terminalDeliveryId: wrappedTerminalDelivery.id,
      }),
    ).resolves.toMatchObject({
      kind: "verified",
      manifest: { status: "REPLAY_READY" },
    });
  });

  it("requires an active replay scope both while verifying and while reading a ready replay", async () => {
    const fake = testClient((query) => {
      if (query.includes("FROM matchsense.rights_grants")) {
        if (query.includes("ARRAY['replay']")) return [];
        return [
          {
            active: true,
            expires_at: null,
            revoked_at: null,
            scopes: ["raw_retention"],
          },
        ];
      }
      if (query.includes("FROM matchsense.raw_source_records")) {
        return [sourceDeliveryRow(terminalDelivery)];
      }
      return [];
    });
    const archive = db.createArchiveRepository?.(fake.client);

    await expect(
      archive?.verifyArchive({
        fixtureId,
        manifestId: "manifest-no-replay-right",
        mode: "recorded",
        projectionHash: "2".repeat(64),
        reducerVersion: "txline-reducer-v1",
        rightsGrantId: "txodds-hackathon-2026",
        sourceFence: recordedFence,
        terminalDeliveryId: terminalDelivery.id,
      }),
    ).rejects.toThrow(
      "Archive replay grant is inactive, expired, revoked, or missing replay scope",
    );
    await expect(
      archive?.replayReady({ fixtureId, mode: "recorded" }),
    ).resolves.toBeNull();
    const replayQuery = fake.queries.find(({ query }) =>
      query.includes("FROM matchsense.archive_manifests"),
    );
    expect(replayQuery?.query).toContain("grant.active = true");
    expect(replayQuery?.query).toContain("grant.revoked_at IS NULL");
    expect(replayQuery?.query).toContain(
      "grant.scopes @> ARRAY['replay']::text[]",
    );
  });

  it("keeps ordered deliveries scoped to one mode and fixture", async () => {
    const fake = testClient((query) =>
      query.includes("FROM matchsense.raw_source_records")
        ? [sourceDeliveryRow(terminalDelivery)]
        : [],
    );
    const archive = db.createArchiveRepository?.(fake.client);

    await expect(
      archive?.orderedDeliveries({ fixtureId, mode: "recorded" }),
    ).resolves.toHaveLength(1);
    expect(fake.queries[0]?.parameters).toEqual(["recorded", fixtureId]);
    expect(fake.queries[0]?.query).toContain(
      "WHERE mode = $1 AND fixture_id = $2",
    );
  });

  it("returns fenced and leaves both archive mutations untouched for a stale recorded lease", async () => {
    const fake = testClient((query) => {
      if (query.includes("FROM matchsense.rights_grants")) {
        return [
          {
            active: true,
            expires_at: null,
            revoked_at: null,
            scopes: ["raw_retention", "replay"],
          },
        ];
      }
      if (query.includes("FROM matchsense.raw_source_records")) {
        return [sourceDeliveryRow(terminalDelivery)];
      }
      if (query.includes("INSERT INTO matchsense.archive_manifests")) {
        return [manifestRow("REPLAY_READY")];
      }
      return [];
    }, "stale");
    const archive = db.createArchiveRepository?.(fake.client);

    await expect(
      archive?.verifyArchive({
        fixtureId,
        manifestId: "manifest-stale-fence",
        mode: "recorded",
        projectionHash: "2".repeat(64),
        reducerVersion: "txline-reducer-v1",
        rightsGrantId: "txodds-hackathon-2026",
        sourceFence: recordedFence,
        terminalDeliveryId: terminalDelivery.id,
      }),
    ).resolves.toEqual({ kind: "fenced" });
    await expect(
      archive?.invalidateArchive({
        fixtureId,
        mode: "recorded",
        reason: "canonical correction",
        sourceFence: recordedFence,
      }),
    ).resolves.toEqual({ kind: "fenced" });

    expect(
      fake.queries.some(({ query }) =>
        /INSERT INTO matchsense\.archive_manifests|UPDATE matchsense\.archive_manifests|archive_manifest_entries/u.test(
          query,
        ),
      ),
    ).toBe(false);
  });

  it("publishes a live archive when its exact live lease is current", async () => {
    const liveTerminalDelivery = {
      ...terminalDelivery,
      mode: "live" as const,
      streamKey: liveFence.streamKey,
    };
    const fake = testClient((query) => {
      if (query.includes("FROM matchsense.rights_grants")) {
        return [
          {
            active: true,
            expires_at: null,
            revoked_at: null,
            scopes: ["raw_retention", "replay"],
          },
        ];
      }
      if (query.includes("FROM matchsense.raw_source_records")) {
        return [sourceDeliveryRow(liveTerminalDelivery)];
      }
      if (query.includes("INSERT INTO matchsense.archive_manifests")) {
        return [manifestRow("REPLAY_READY", "live")];
      }
      return [];
    });
    const archive = db.createArchiveRepository?.(fake.client);

    await expect(
      archive?.verifyArchive({
        fixtureId,
        manifestId: "manifest-live-fence",
        mode: "live",
        projectionHash: "2".repeat(64),
        reducerVersion: "txline-reducer-v1",
        rightsGrantId: "txodds-hackathon-2026",
        sourceFence: liveFence,
        terminalDeliveryId: liveTerminalDelivery.id,
      }),
    ).resolves.toMatchObject({
      kind: "verified",
      manifest: { mode: "live", status: "REPLAY_READY" },
    });
    const sourceLease = fake.queries.find(({ query }) =>
      query.includes("FROM matchsense.source_leases"),
    );
    expect(sourceLease?.parameters).toEqual([
      "live",
      liveFence.source,
      liveFence.streamKey,
      liveFence.holderId,
      liveFence.fencingToken,
    ]);
  });
});
