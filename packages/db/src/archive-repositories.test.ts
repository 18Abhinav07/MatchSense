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
  insertDelivery(input: Record<string, unknown>): Promise<unknown>;
  invalidateArchive(fixtureId: string, reason: string): Promise<void>;
  orderedDeliveries(fixtureId: string): Promise<readonly unknown[]>;
  replayReady(fixtureId: string): Promise<unknown>;
  verifyArchive(input: Record<string, unknown>): Promise<unknown>;
};

type DatabaseModuleContract = {
  createArchiveRepository?: (client: TestClient) => ArchiveRepository;
};

const db = databaseModule as DatabaseModuleContract;

const fixtureId = "18237038";
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
  payload: { Action: "game_finalised", FixtureId: fixtureId, StatusId: 100 },
  payloadHash: "e".repeat(64),
  responseHash: "f".repeat(64),
  sourceRecordId: "final-1026",
  sourceSequence: "1026",
} as const;

function sourceDeliveryRow(
  input: typeof sourceOnlyDelivery | typeof terminalDelivery,
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

function manifestRow(status: string) {
  return {
    created_at: "2026-07-18T12:01:00.000Z",
    delivery_manifest_hash: "1".repeat(64),
    fixture_id: fixtureId,
    id: "manifest-1",
    invalidated_at: null,
    invalidation_reason: null,
    mode: "recorded",
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

describe("archive repository", () => {
  it("retains one immutable source-only delivery and keeps its duplicate inert", async () => {
    let insertCount = 0;
    const fake = testClient((query) => {
      if (query.includes("FROM matchsense.rights_grants")) {
        return [
          {
            active: true,
            expires_at: null,
            raw_retention_until: null,
            revoked_at: null,
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

  it("publishes a replay only from an ordered authorised terminal archive and invalidates it on correction", async () => {
    let invalidated = false;
    const fake = testClient((query) => {
      if (query.includes("FROM matchsense.raw_source_records")) {
        return [
          sourceDeliveryRow(sourceOnlyDelivery),
          sourceDeliveryRow(terminalDelivery),
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
        terminalDeliveryId: terminalDelivery.id,
      }),
    ).resolves.toMatchObject({ status: "REPLAY_READY" });
    await archive?.invalidateArchive(fixtureId, "canonical correction");
    await expect(archive?.replayReady(fixtureId)).resolves.toBeNull();
    expect(
      fake.queries.some(({ query }) => query.includes("ORDER BY ordering_key")),
    ).toBe(true);
    expect(
      fake.queries.some(({ query }) => query.includes("REPLAY_INVALIDATED")),
    ).toBe(true);
  });
});
