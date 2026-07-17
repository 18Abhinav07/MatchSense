import { describe, expect, it } from "vitest";

import { createInMemoryFixtureTruthRepository } from "./index.js";

const raw = {
  dedupeKey: "run-1:beat-1",
  deliveryIntent: "realtime" as const,
  id: "raw-1",
  occurredAt: "2026-07-17T12:01:00.000Z",
  payload: { kind: "goal" },
  payloadHash: "a".repeat(64),
  provenance: "synthetic_txline_shaped" as const,
  receivedAt: "2026-07-17T12:01:00.000Z",
  source: "experience",
  sourceRecordId: "beat-1",
  sourceSequence: "1",
};

describe("in-process atomic fixture truth repository", () => {
  it("serializes one fixture and deduplicates concurrent source delivery", async () => {
    const repository = createInMemoryFixtureTruthRepository();
    repository.seedFixture({ fixtureId: "fixture-1", mode: "demo" });
    let deriveCalls = 0;
    const input = {
      derive: () => {
        deriveCalls += 1;
        return {
          event: {
            id: "fixture-1:revision:1",
            payload: { revision: 1 },
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
              idempotencyKey: "fixture-1:1:broadcast",
              payload: { revision: 1 },
              topic: "fixture.broadcast",
            },
            {
              id: "outbox-room",
              idempotencyKey: "fixture-1:1:room",
              payload: { revision: 1 },
              topic: "room.project",
            },
          ],
          projection: { payload: { revision: 1 }, revision: 1 },
        };
      },
      fixtureId: "fixture-1",
      mode: "demo" as const,
      raw,
    };

    const results = await Promise.all([
      repository.processSourceEnvelope(input),
      repository.processSourceEnvelope(input),
    ]);

    expect(results.map(({ kind }) => kind).sort()).toEqual([
      "committed",
      "duplicate",
    ]);
    expect(deriveCalls).toBe(1);
    expect(
      repository.inspect({ fixtureId: "fixture-1", mode: "demo" }),
    ).toMatchObject({
      events: [{ eventId: "fixture-1:revision:1", sequence: 1 }],
      moments: [{ id: "goal-family-1", revisions: [1] }],
      outbox: [
        { id: "outbox-broadcast", topic: "fixture.broadcast" },
        { id: "outbox-room", topic: "room.project" },
      ],
      projection: { revision: 1 },
      sourceRecords: [{ id: "raw-1" }],
    });
  });

  it("rolls back the source identity when derivation fails", async () => {
    const repository = createInMemoryFixtureTruthRepository();
    repository.seedFixture({ fixtureId: "fixture-1", mode: "demo" });

    await expect(
      repository.processSourceEnvelope({
        derive: () => {
          throw new Error("reducer failed");
        },
        fixtureId: "fixture-1",
        mode: "demo",
        raw,
      }),
    ).rejects.toThrow("reducer failed");

    expect(
      repository.inspect({ fixtureId: "fixture-1", mode: "demo" })
        .sourceRecords,
    ).toEqual([]);
  });

  it("swaps no partial state when cloning a derived write fails, then accepts a clean retry", async () => {
    const repository = createInMemoryFixtureTruthRepository();
    repository.seedFixture({ fixtureId: "fixture-1", mode: "demo" });
    const invalidInput = {
      derive: () => ({
        event: {
          id: "fixture-1:revision:1",
          payload: { revision: 1 },
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
            idempotencyKey: "fixture-1:1:broadcast",
            payload: { revision: 1 },
            topic: "fixture.broadcast",
          },
          {
            id: "outbox-uncloneable",
            idempotencyKey: "fixture-1:1:uncloneable",
            payload: { cannotClone: () => undefined },
            topic: "room.project",
          },
        ],
        projection: { payload: { revision: 1 }, revision: 1 },
      }),
      fixtureId: "fixture-1",
      mode: "demo" as const,
      raw,
    };

    await expect(
      repository.processSourceEnvelope(invalidInput),
    ).rejects.toThrow();
    expect(
      repository.inspect({ fixtureId: "fixture-1", mode: "demo" }),
    ).toMatchObject({
      events: [],
      moments: [],
      outbox: [],
      projection: null,
      sourceRecords: [],
    });

    await expect(
      repository.processSourceEnvelope({
        ...invalidInput,
        derive: () => ({
          ...invalidInput.derive(),
          outbox: [
            {
              id: "outbox-broadcast",
              idempotencyKey: "fixture-1:1:broadcast",
              payload: { revision: 1 },
              topic: "fixture.broadcast",
            },
          ],
        }),
      }),
    ).resolves.toMatchObject({ kind: "committed", revision: 1 });
    expect(
      repository.inspect({ fixtureId: "fixture-1", mode: "demo" }),
    ).toMatchObject({
      events: [{ sequence: 1 }],
      moments: [{ id: "goal-family-1", revisions: [1] }],
      outbox: [{ id: "outbox-broadcast" }],
      projection: { revision: 1 },
      sourceRecords: [{ id: "raw-1" }],
    });
  });
});
