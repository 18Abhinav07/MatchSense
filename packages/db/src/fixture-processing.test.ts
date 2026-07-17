import { describe, expect, it, vi } from "vitest";

import {
  createFixtureTruthRepository,
  type FixtureProjectionRecord,
} from "./index.js";

type QueryRow = Record<string, unknown>;
type UnsafeQuery = (
  query: string,
  parameters?: readonly unknown[],
) => Promise<readonly QueryRow[]>;

function fakeClient() {
  const queries: { parameters: readonly unknown[]; query: string }[] = [];
  const unsafe = vi.fn<UnsafeQuery>(async (query, parameters = []) => {
    queries.push({ parameters, query });
    if (query.includes("FROM matchsense.source_leases")) {
      return [{ fencing_token: "1" }];
    }
    if (query.includes("INSERT INTO matchsense.raw_source_records")) {
      return [{ id: "raw-live-1" }];
    }
    if (
      query.includes("FROM matchsense.fixtures") &&
      query.includes("FOR UPDATE")
    ) {
      return [{ id: "fixture-1" }];
    }
    if (query.includes("FROM matchsense.fixture_projections")) return [];
    if (query.includes("INSERT INTO matchsense.fixture_events")) {
      return [{ sequence: "1" }];
    }
    return [];
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

describe("atomic fixture envelope processing", () => {
  it("commits one derived revision and every outbox topic in one transaction", async () => {
    const fake = fakeClient();
    const repository = createFixtureTruthRepository(fake.client);
    const observed: (FixtureProjectionRecord | null)[] = [];

    await expect(
      repository.processSourceEnvelope({
        derive: (current) => {
          observed.push(current);
          return {
            event: {
              id: "event-1",
              payload: { momentId: "goal-family-1" },
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
                id: "outbox-broadcast",
                idempotencyKey: "goal-family-1:1:broadcast",
                payload: { revision: 1 },
                topic: "fixture.broadcast",
              },
              {
                id: "outbox-push",
                idempotencyKey: "goal-family-1:1:push",
                payload: { revision: 1 },
                topic: "push.candidate",
              },
            ],
            projection: { payload: { revision: 1 }, revision: 1 },
          };
        },
        fixtureId: "fixture-1",
        mode: "live",
        raw: {
          dedupeKey: "txline:action-1",
          deliveryIntent: "realtime",
          id: "raw-live-1",
          occurredAt: "2026-07-17T12:00:58.000Z",
          payload: { secretRawTxlinePayload: true },
          payloadHash: "a".repeat(64),
          provenance: "live_txline",
          receivedAt: "2026-07-17T12:01:00.000Z",
          source: "txline",
          sourceRecordId: "action-1",
          sourceSequence: "620",
        },
        sourceFence: {
          fencingToken: 1,
          holderId: "txline-worker",
          source: "txline",
          streamKey: "scores:mainnet",
        },
      }),
    ).resolves.toEqual({
      eventSequence: 1,
      kind: "committed",
      revision: 1,
    });

    expect(observed).toEqual([null]);
    const rawInsert = fake.queries.find(({ query }) =>
      query.includes("INSERT INTO matchsense.raw_source_records"),
    );
    expect(rawInsert?.parameters).not.toContain(
      JSON.stringify({ secretRawTxlinePayload: true }),
    );
    expect(rawInsert?.parameters).toContain(null);
    const outboxWrites = fake.queries.filter(({ query }) =>
      query.includes("INSERT INTO matchsense.outbox"),
    );
    expect(outboxWrites).toHaveLength(2);
    expect(outboxWrites.map(({ parameters }) => parameters[3])).toEqual([
      "fixture.broadcast",
      "push.candidate",
    ]);
  });

  it("does not derive or emit again when the source identity is duplicate", async () => {
    const unsafe = vi.fn<UnsafeQuery>(async (query) =>
      query.includes("INSERT INTO matchsense.raw_source_records") ? [] : [],
    );
    const repository = createFixtureTruthRepository({
      begin: async (work) => work({ unsafe }),
      unsafe,
    });
    const derive = vi.fn();

    await expect(
      repository.processSourceEnvelope({
        derive,
        fixtureId: "fixture-1",
        mode: "demo",
        raw: {
          dedupeKey: "run-1:goal",
          deliveryIntent: "realtime",
          id: "raw-demo-1",
          occurredAt: null,
          payload: { kind: "goal" },
          payloadHash: "b".repeat(64),
          provenance: "synthetic_txline_shaped",
          receivedAt: "2026-07-17T12:01:00.000Z",
          source: "experience",
          sourceRecordId: "goal",
          sourceSequence: "1",
        },
      }),
    ).resolves.toEqual({ kind: "duplicate" });
    expect(derive).not.toHaveBeenCalled();
  });
});
