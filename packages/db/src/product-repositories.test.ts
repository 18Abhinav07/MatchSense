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
  const begin = vi.fn(
    async <T>(work: (tx: { unsafe: UnsafeQuery }) => Promise<T>) =>
      work({ unsafe }),
  );
  return { client: { begin, unsafe } satisfies TestClient, queries };
}

describe("durable fan repositories", () => {
  it("creates a guest fan and hashed session atomically", async () => {
    const row = {
      avatar_variant: null,
      created_at: "2026-07-17T10:00:00.000Z",
      deleted_at: null,
      favorite_team: null,
      handle: null,
      handle_normalized: null,
      id: "fan-1",
      preferences: "{}",
      profile: "{}",
      updated_at: "2026-07-17T10:00:00.000Z",
    };
    const fake = testClient((query) =>
      query.includes("RETURNING") ? [row] : [],
    );
    const repository = databaseModule.createFanRepository(fake.client);

    await expect(
      repository.createGuest({
        csrfHash: "b".repeat(64),
        expiresAt: "2026-08-17T10:00:00.000Z",
        fanId: "fan-1",
        sessionHash: "a".repeat(64),
      }),
    ).resolves.toMatchObject({ id: "fan-1", profile: {}, preferences: {} });

    expect(fake.client.begin).toHaveBeenCalledTimes(1);
    expect(fake.queries.map(({ query }) => query)).toEqual([
      expect.stringContaining("INSERT INTO matchsense.fans"),
      expect.stringContaining("INSERT INTO matchsense.fan_sessions"),
    ]);
  });

  it("normalizes a public handle and persists fixture alert preferences", async () => {
    const fanRow = {
      avatar_variant: "crest-1",
      created_at: "2026-07-17T10:00:00.000Z",
      deleted_at: null,
      favorite_team: "ARG",
      handle: "Abhinav",
      handle_normalized: "abhinav",
      id: "fan-1",
      preferences: '{"alerts":{"goal":true}}',
      profile: '{"displayName":"Abhinav"}',
      updated_at: "2026-07-17T10:01:00.000Z",
    };
    const fake = testClient((query) =>
      query.includes("UPDATE matchsense.fans") ? [fanRow] : [],
    );
    const repository = databaseModule.createFanRepository(fake.client);

    await repository.updateProfile({
      avatarVariant: "crest-1",
      fanId: "fan-1",
      favoriteTeam: "ARG",
      handle: "Abhinav",
      preferences: { alerts: { goal: true } },
      profile: { displayName: "Abhinav" },
    });
    await repository.upsertFollow({
      eventPreferences: { goal: true, redCard: true },
      fanId: "fan-1",
      fixtureId: "fx-1",
      mode: "demo",
    });
    await repository.listFollowers({ fixtureId: "fx-1", mode: "demo" });

    expect(fake.queries[0]?.parameters).toContain("abhinav");
    expect(fake.queries[1]?.query).toContain("matchsense.fan_follows");
    expect(fake.queries[2]?.query).toContain("fixture_id = $2");
  });
});

describe("durable push, Experience, Room, and Memory repositories", () => {
  it("stores encrypted push material and lists only active devices", async () => {
    const row = {
      auth_tag: new Uint8Array([3]),
      created_at: "2026-07-17T10:00:00.000Z",
      endpoint_hash: "d".repeat(64),
      expires_at: null,
      fan_id: "fan-1",
      id: "device-1",
      invalidated_at: null,
      iv: new Uint8Array([2]),
      key_version: 1,
      last_failure_at: null,
      last_success_at: null,
      preferences: '{"goal":true}',
      subscription_ciphertext: new Uint8Array([1]),
      updated_at: "2026-07-17T10:00:00.000Z",
    };
    const fake = testClient((query) =>
      query.includes("RETURNING") || query.includes("SELECT") ? [row] : [],
    );
    const repository = databaseModule.createPushDeviceRepository(fake.client);

    await expect(
      repository.upsertDevice({
        authTag: new Uint8Array([3]),
        ciphertext: new Uint8Array([1]),
        endpointHash: "d".repeat(64),
        expiresAt: null,
        fanId: "fan-1",
        id: "device-1",
        iv: new Uint8Array([2]),
        keyVersion: 1,
        preferences: { goal: true },
      }),
    ).resolves.toMatchObject({ id: "device-1", preferences: { goal: true } });
    await repository.listActiveForFan("fan-1");
    await expect(
      repository.getActiveForFan({ deviceId: "device-1", fanId: "fan-1" }),
    ).resolves.toMatchObject({ id: "device-1" });

    expect(fake.queries[1]?.query).toMatch(/invalidated_at IS NULL/u);
    expect(fake.queries[2]?.parameters).toEqual(["device-1", "fan-1"]);
  });

  it("creates a run with materialized beats in one transaction", async () => {
    const runRow = {
      completed_at: null,
      created_at: "2026-07-17T10:00:00.000Z",
      fixture_id: "experience:run-1",
      fixture_mode: "demo",
      id: "run-1",
      journey: "experience_match",
      kickoff_at: "2026-07-17T10:01:00.000Z",
      next_beat_index: 0,
      owner_fan_id: "fan-1",
      status: "ready",
      template_id: "five-minute",
      template_version: 1,
      updated_at: "2026-07-17T10:00:00.000Z",
      version: 0,
    };
    const fake = testClient((query) =>
      query.includes("INSERT INTO matchsense.experience_runs") ? [runRow] : [],
    );
    const repository = databaseModule.createExperienceRepository(fake.client);

    await repository.createRun({
      beats: [
        {
          beatIndex: 0,
          beatKey: "kickoff",
          dueAt: "2026-07-17T10:01:00.000Z",
          envelope: { kind: "phase.kickoff" },
        },
      ],
      run: {
        fixtureId: "experience:run-1",
        id: "run-1",
        journey: "experience_match",
        kickoffAt: "2026-07-17T10:01:00.000Z",
        ownerFanId: "fan-1",
        status: "ready",
        templateId: "five-minute",
        templateVersion: 1,
      },
      template: {
        active: true,
        definition: { durationSeconds: 300 },
        id: "five-minute",
        version: 1,
      },
    });

    expect(fake.client.begin).toHaveBeenCalledTimes(1);
    expect(fake.queries.map(({ query }) => query)).toEqual([
      expect.stringContaining("experience_templates"),
      expect.stringContaining("experience_runs"),
      expect.stringContaining("experience_run_beats"),
    ]);
  });

  it("lists Experience runs owned by one fan newest first", async () => {
    const runRow = {
      completed_at: "2026-07-17T10:05:00.000Z",
      created_at: "2026-07-17T10:00:00.000Z",
      fixture_id: "experience:run-1",
      fixture_mode: "demo",
      id: "run-1",
      journey: "experience_match",
      kickoff_at: "2026-07-17T10:00:00.000Z",
      next_beat_index: 11,
      owner_fan_id: "fan-1",
      status: "final",
      template_id: "five-minute",
      template_version: 1,
      updated_at: "2026-07-17T10:05:00.000Z",
      version: 11,
    };
    const fake = testClient(() => [runRow]);
    const repository = databaseModule.createExperienceRepository(fake.client);

    await expect(repository.listForOwner("fan-1")).resolves.toMatchObject([
      { id: "run-1", ownerFanId: "fan-1" },
    ]);

    expect(fake.queries[0]?.query).toMatch(/owner_fan_id = \$1/u);
    expect(fake.queries[0]?.query).toMatch(/ORDER BY created_at DESC/u);
    expect(fake.queries[0]?.parameters).toEqual(["fan-1"]);
  });

  it("compare-and-swaps one JSONB Room aggregate", async () => {
    const row = {
      aggregate: '{"members":["fan-1"],"picks":{}}',
      created_at: "2026-07-17T10:00:00.000Z",
      finalized_at: null,
      fixture_id: "fx-1",
      id: "room-1",
      invite_expires_at: "2026-07-17T11:00:00.000Z",
      invite_hash: "e".repeat(64),
      mode: "demo",
      owner_fan_id: "fan-1",
      status: "lobby",
      updated_at: "2026-07-17T10:01:00.000Z",
      version: 1,
    };
    const fake = testClient((query) =>
      query.includes("UPDATE matchsense.rooms") ? [row] : [],
    );
    const repository = databaseModule.createRoomAggregateRepository(
      fake.client,
    );

    await expect(
      repository.compareAndSwap({
        aggregate: { members: ["fan-1"], picks: {} },
        expectedVersion: 0,
        finalizedAt: null,
        roomId: "room-1",
        status: "lobby",
      }),
    ).resolves.toMatchObject({
      aggregate: { members: ["fan-1"], picks: {} },
      version: 1,
    });

    expect(fake.queries[0]?.query).toMatch(/version = \$2/u);
  });

  it("joins a member and advances the Room aggregate atomically", async () => {
    const row = {
      aggregate: '{"members":["fan-1","fan-2"],"picks":{}}',
      created_at: "2026-07-17T10:00:00.000Z",
      finalized_at: null,
      fixture_id: "fx-1",
      id: "room-1",
      invite_expires_at: "2026-07-17T11:00:00.000Z",
      invite_hash: "e".repeat(64),
      mode: "demo",
      owner_fan_id: "fan-1",
      status: "lobby",
      updated_at: "2026-07-17T10:01:00.000Z",
      version: 1,
    };
    const fake = testClient((query) =>
      query.includes("UPDATE matchsense.rooms") ? [row] : [],
    );
    const repository = databaseModule.createRoomAggregateRepository(
      fake.client,
    );

    await expect(
      repository.joinAndCompareAndSwap({
        aggregate: { members: ["fan-1", "fan-2"], picks: {} },
        expectedVersion: 0,
        finalizedAt: null,
        member: {
          fanId: "fan-2",
          nickname: "Pratik",
          role: "member",
          teamCode: "FRA",
        },
        roomId: "room-1",
        status: "lobby",
      }),
    ).resolves.toMatchObject({ version: 1 });

    expect(fake.client.begin).toHaveBeenCalledTimes(1);
    expect(fake.queries.map(({ query }) => query)).toEqual([
      expect.stringContaining("UPDATE matchsense.rooms"),
      expect.stringContaining("INSERT INTO matchsense.room_memberships"),
    ]);
  });

  it("lists persisted Room aggregates by mode for Experience recovery", async () => {
    const row = {
      aggregate: '{"schemaVersion":3}',
      created_at: "2026-07-17T10:00:00.000Z",
      finalized_at: null,
      fixture_id: "experience:run-1",
      id: "room-1",
      invite_expires_at: "2026-07-17T11:00:00.000Z",
      invite_hash: "e".repeat(64),
      mode: "demo",
      owner_fan_id: "fan-1",
      status: "lobby",
      updated_at: "2026-07-17T10:01:00.000Z",
      version: 0,
    };
    const fake = testClient(() => [row]);
    const repository = databaseModule.createRoomAggregateRepository(
      fake.client,
    );

    await expect(repository.listByMode?.("demo")).resolves.toMatchObject([
      { fixtureId: "experience:run-1", mode: "demo" },
    ]);
    expect(fake.queries[0]?.query).toMatch(/WHERE mode = \$1/u);
    expect(fake.queries[0]?.parameters).toEqual(["demo"]);
  });

  it("appends immutable Memory revisions and resolves the latest", async () => {
    const row = {
      created_at: "2026-07-17T10:00:00.000Z",
      fan_id: "fan-1",
      fixture_id: "fx-1",
      mode: "demo",
      payload: '{"headline":"A night to remember"}',
      revision: 2,
    };
    const fake = testClient((query) =>
      query.includes("RETURNING") || query.includes("SELECT") ? [row] : [],
    );
    const repository = databaseModule.createMemoryRepository(fake.client);

    await repository.append({
      fanId: "fan-1",
      fixtureId: "fx-1",
      mode: "demo",
      payload: { headline: "A night to remember" },
      revision: 2,
    });
    await expect(
      repository.latestForFanFixture({
        fanId: "fan-1",
        fixtureId: "fx-1",
        mode: "demo",
      }),
    ).resolves.toMatchObject({ revision: 2 });

    await repository.listLatestForFan("fan-1");

    expect(fake.queries[1]?.query).toMatch(/ORDER BY revision DESC/u);
    expect(fake.queries[2]?.query).toMatch(
      /SELECT DISTINCT ON \(mode, fixture_id\)/u,
    );
    expect(fake.queries[2]?.query).toMatch(/ORDER BY created_at DESC/u);
  });
});
