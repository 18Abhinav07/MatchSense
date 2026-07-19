import type {
  ExperienceBeatRecord,
  ExperienceRepository,
  ExperienceRunRecord,
} from "@matchsense/db";
import type {
  CanonicalEventFact,
  FixtureStreamEvent,
} from "@matchsense/contracts";
import {
  createFixtureProjection,
  reduceSourceFact,
  toFixtureSnapshot,
} from "@matchsense/event-engine";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import {
  createExperienceRuntime,
  type ExperienceRuntime,
} from "./experience-runtime.js";
import type { FixtureProcessor } from "./fixture-processor.js";
import { createProductRuntime } from "./product-runtime.js";

function memoryExperiences(): ExperienceRepository & {
  beats: Map<string, ExperienceBeatRecord>;
} {
  const runs = new Map<string, ExperienceRunRecord>();
  const beats = new Map<string, ExperienceBeatRecord>();
  const key = (runId: string, beatIndex: number) => `${runId}:${beatIndex}`;
  return {
    beats,
    claimDueBeats: async (input) => {
      const due = [...beats.values()]
        .filter(
          (beat) =>
            Date.parse(beat.dueAt) <= Date.parse(input.now) &&
            beat.state === "pending",
        )
        .sort(
          (left, right) =>
            left.dueAt.localeCompare(right.dueAt) ||
            left.beatIndex - right.beatIndex,
        )
        .slice(0, input.limit);
      return due.map((beat) => {
        const claimed: ExperienceBeatRecord = {
          ...beat,
          attemptCount: beat.attemptCount + 1,
          claimedAt: input.now,
          claimToken: input.claimToken,
          state: "claimed",
        };
        beats.set(key(beat.runId, beat.beatIndex), claimed);
        return claimed;
      });
    },
    completeBeat: async (input) => {
      const beat = beats.get(key(input.runId, input.beatIndex));
      if (beat?.claimToken !== input.claimToken || beat.state !== "claimed") {
        return false;
      }
      beats.set(key(input.runId, input.beatIndex), {
        ...beat,
        claimedAt: null,
        claimToken: null,
        deliveredAt: input.deliveredAt,
        state: "delivered",
      });
      const run = runs.get(input.runId)!;
      const isFinal = [...beats.values()].every(
        (candidate) =>
          candidate.runId !== input.runId ||
          candidate.beatIndex === input.beatIndex ||
          candidate.state === "delivered",
      );
      runs.set(input.runId, {
        ...run,
        completedAt: isFinal ? input.deliveredAt : run.completedAt,
        nextBeatIndex: Math.max(run.nextBeatIndex, input.beatIndex + 1),
        status: isFinal
          ? "final"
          : run.status === "countdown"
            ? "live"
            : run.status,
        updatedAt: input.deliveredAt,
        version: run.version + 1,
      });
      return true;
    },
    createRun: async (input) => {
      const run: ExperienceRunRecord = {
        completedAt: null,
        createdAt: input.run.kickoffAt,
        fixtureId: input.run.fixtureId,
        fixtureMode: "demo",
        id: input.run.id,
        journey: input.run.journey,
        kickoffAt: input.run.kickoffAt,
        nextBeatIndex: 0,
        ownerFanId: input.run.ownerFanId,
        status: input.run.status,
        templateId: input.run.templateId,
        templateVersion: input.run.templateVersion,
        updatedAt: input.run.kickoffAt,
        version: 0,
      };
      runs.set(run.id, run);
      for (const beat of input.beats) {
        beats.set(key(run.id, beat.beatIndex), {
          attemptCount: 0,
          beatIndex: beat.beatIndex,
          beatKey: beat.beatKey,
          claimedAt: null,
          claimToken: null,
          deliveredAt: null,
          dueAt: beat.dueAt,
          envelope: beat.envelope,
          lastError: null,
          runId: run.id,
          state: "pending",
        });
      }
      return run;
    },
    failBeat: async (input) => {
      const beat = beats.get(key(input.runId, input.beatIndex));
      if (beat?.claimToken !== input.claimToken || beat.state !== "claimed") {
        return false;
      }
      beats.set(key(input.runId, input.beatIndex), {
        ...beat,
        claimedAt: null,
        claimToken: null,
        dueAt: input.retryAt,
        lastError: input.error,
        state: "pending",
      });
      return true;
    },
    getRun: async (runId) => runs.get(runId) ?? null,
    listForOwner: async (fanId) =>
      [...runs.values()].filter((run) => run.ownerFanId === fanId),
    listRecoverableRuns: async () =>
      [...runs.values()].filter((run) =>
        ["ready", "countdown", "live"].includes(run.status),
      ),
  };
}

function productRuntime() {
  return createProductRuntime({
    cueBytes: Buffer.from("goal-cue"),
    silenceBytes: Buffer.from("silence"),
    writeIntervalMs: 60_000,
  });
}

describe("server-owned Experience Match", () => {
  it("prepares a private fixture without beats and starts that same fixture idempotently", async () => {
    const repository = memoryExperiences();
    const product = productRuntime();
    const experience = createExperienceRuntime({
      countdownMs: 10_000,
      id: () => "prepared-run",
      now: () => "2026-07-17T12:00:00.000Z",
      prepareWindowMs: 30 * 60_000,
      processor: {
        process: async () => ({ kind: "accepted_no_change" }),
      },
      productRuntime: product,
      repository,
    });

    const prepared = await experience.prepareFixture({
      awayTeam: "FRA",
      homeTeam: "ARG",
      ownerFanId: "fan-1",
    });
    expect(prepared).toMatchObject({
      fixture: {
        fixtureId: "experience:prepared-run",
        kickoffAt: "2026-07-17T12:30:00.000Z",
      },
      runId: "prepared-run",
    });
    expect(await experience.getRun("prepared-run")).toBeNull();
    expect(repository.beats.size).toBe(0);

    const started = await experience.startRun({
      awayTeam: "FRA",
      homeTeam: "ARG",
      ownerFanId: "fan-1",
      runId: prepared.runId,
    });
    const duplicate = await experience.startRun({
      awayTeam: "FRA",
      homeTeam: "ARG",
      ownerFanId: "fan-1",
      runId: prepared.runId,
    });
    expect(started).toMatchObject({
      fixtureId: prepared.fixture.fixtureId,
      kickoffAt: "2026-07-17T12:00:10.000Z",
      status: "countdown",
    });
    expect(duplicate).toEqual(started);
    expect(product.fixture(started.fixtureId)).toMatchObject({
      kickoffAt: started.kickoffAt,
      phase: "scheduled",
      revision: 0,
    });
    expect(repository.beats.size).toBe(20);
    await experience.close();
    await product.close();
  });

  it("persists each due authored beat before publishing without a browser connection", async () => {
    const repository = memoryExperiences();
    const product = productRuntime();
    const order: string[] = [];
    const processor: FixtureProcessor = {
      process: vi.fn(async (input) => {
        order.push(`persist:${input.fact.sourceEnvelopeId}`);
        return { eventSequence: 1, kind: "committed" as const, revision: 1 };
      }),
    };
    const experience = createExperienceRuntime({
      id: () => "run-1",
      now: () => "2026-07-17T12:00:00.000Z",
      processor,
      productRuntime: product,
      repository,
    });
    const run = await experience.startRun({
      awayTeam: "FRA",
      homeTeam: "ARG",
      ownerFanId: "fan-1",
    });
    product.subscribeFixture(run.fixtureId, (event) => {
      if (event.event !== "snapshot") order.push(`publish:${event.id}`);
    });

    await experience.tick();

    expect(product.fixture(run.fixtureId)).toMatchObject({
      fixtureId: "experience:run-1",
      phase: "first_half",
      revision: 1,
    });
    expect(order).toEqual([
      "persist:run-1:beat:kickoff",
      "publish:experience:run-1:revision:1",
    ]);
    expect(repository.beats.get("run-1:0")).toMatchObject({
      beatKey: "kickoff",
      state: "delivered",
    });
    await experience.close();
    await product.close();
  });

  it("recovers a failed due claim on a new scheduler instance", async () => {
    let now = "2026-07-17T12:00:00.000Z";
    const repository = memoryExperiences();
    const product = productRuntime();
    const failing: FixtureProcessor = {
      process: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
    };
    const first = createExperienceRuntime({
      id: () => "run-recovery",
      now: () => now,
      processor: failing,
      productRuntime: product,
      repository,
      retryDelayMs: 1_000,
    });
    const run = await first.startRun({
      awayTeam: "FRA",
      homeTeam: "ARG",
      ownerFanId: null,
    });
    await first.tick();
    expect(repository.beats.get("run-recovery:0")).toMatchObject({
      lastError: "database unavailable",
      state: "pending",
    });
    await first.close();

    now = "2026-07-17T12:00:02.000Z";
    const succeeding: FixtureProcessor = {
      process: vi.fn(async () => ({
        eventSequence: 1,
        kind: "committed" as const,
        revision: 1,
      })),
    };
    const recovered = createExperienceRuntime({
      id: () => "worker-2",
      now: () => now,
      processor: succeeding,
      productRuntime: product,
      repository,
    });
    await recovered.tick();

    expect(succeeding.process).toHaveBeenCalledOnce();
    expect(repository.beats.get("run-recovery:0")?.state).toBe("delivered");
    expect(product.fixture(run.fixtureId)?.phase).toBe("first_half");
    await recovered.close();
    await product.close();
  });

  it("rehydrates fixture truth and exact Moment history before resuming a run", async () => {
    const repository = memoryExperiences();
    const originalProduct = productRuntime();
    const creator = createExperienceRuntime({
      countdownMs: 60_000,
      id: () => "restart-run",
      now: () => "2026-07-17T12:00:00.000Z",
      processor: {
        process: async () => ({
          eventSequence: 1,
          kind: "committed" as const,
          revision: 1,
        }),
      },
      productRuntime: originalProduct,
      repository,
    });
    const run = await creator.startRun({
      awayTeam: "FRA",
      homeTeam: "ARG",
      ownerFanId: "fan-restart",
    });
    expect(originalProduct.fixture(run.fixtureId)).not.toBeNull();
    expect(
      originalProduct.fixtures().map(({ fixtureId }) => fixtureId),
    ).not.toContain(run.fixtureId);
    await creator.close();
    await originalProduct.close();

    const fixture = {
      awayTeam: "FRA",
      fixtureId: run.fixtureId,
      homeTeam: "ARG",
      kickoffAt: run.kickoffAt,
      observedAt: run.kickoffAt,
      provenance: "synthetic_txline_shaped" as const,
    };
    const goal: CanonicalEventFact = {
      familyId: "restart-run:event:goal",
      fixtureId: run.fixtureId,
      kind: "goal",
      minute: "12'",
      occurredAt: "2026-07-17T12:00:30.000Z",
      player: null,
      provenance: "synthetic_txline_shaped",
      receivedAt: "2026-07-17T12:00:30.000Z",
      sourceEnvelopeId: "restart-run:goal-envelope",
      sourceEventId: "goal",
      status: "confirmed",
      team: "ARG",
      type: "canonical_event",
    };
    const reduced = reduceSourceFact(createFixtureProjection(fixture), goal);
    const event: FixtureStreamEvent = {
      event: "moment.created",
      id: `${run.fixtureId}:revision:1`,
      moment: reduced.moment!,
      snapshot: toFixtureSnapshot(reduced.projection),
    };
    const restoredProduct = productRuntime();
    const recoverRun = vi.fn(async () => ({
      events: [event],
      fixture,
      projection: reduced.projection,
    }));
    const resumed = createExperienceRuntime({
      now: () => "2026-07-17T12:00:10.000Z",
      pollIntervalMs: 60_000,
      processor: {
        process: async () => ({
          eventSequence: 2,
          kind: "committed" as const,
          revision: 2,
        }),
      },
      productRuntime: restoredProduct,
      recoverRun,
      repository,
    });

    await resumed.start();

    expect(recoverRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: "restart-run" }),
    );
    expect(restoredProduct.fixture(run.fixtureId)).toMatchObject({
      score: { away: 0, home: 1 },
      revision: 1,
    });
    expect(
      restoredProduct.fixtures().map(({ fixtureId }) => fixtureId),
    ).not.toContain(run.fixtureId);
    expect(
      restoredProduct.resolveMoment(run.fixtureId, reduced.moment!.identity),
    ).toMatchObject({
      latest: { identity: reduced.moment!.identity },
      requested: { identity: reduced.moment!.identity },
      superseded: false,
    });
    await resumed.close();
    await restoredProduct.close();
  });

  it("holds the authored goal and celebration until VAR confirms it", async () => {
    let now = "2026-07-17T12:00:00.000Z";
    const repository = memoryExperiences();
    const product = productRuntime();
    const experience = createExperienceRuntime({
      id: () => "truth-gated-run",
      now: () => now,
      processor: {
        process: async (_input) => ({
          eventSequence: 1,
          kind: "committed" as const,
          revision: 1,
        }),
      },
      productRuntime: product,
      repository,
    });
    const run = await experience.startRun({
      awayTeam: "FRA",
      homeTeam: "ARG",
      ownerFanId: null,
    });

    now = "2026-07-17T12:00:36.000Z";
    await experience.tick();
    expect(product.fixture(run.fixtureId)).toMatchObject({
      score: { away: 0, home: 0 },
      lastEvent: { kind: "var.started", status: "under_review" },
    });

    now = "2026-07-17T12:00:51.000Z";
    await experience.tick();
    expect(product.fixture(run.fixtureId)).toMatchObject({
      score: { away: 0, home: 1 },
      lastEvent: {
        celebratesGoal: true,
        kind: "var.stands",
        status: "confirmed",
      },
    });
    expect(product.fixtureEvents(run.fixtureId).at(-1)).toMatchObject({
      moment: { celebratesGoal: true, kind: "var.stands" },
    });
    await experience.close();
    await product.close();
  });

  it("runs the complete authored match in canonical order after scheduler delay", async () => {
    let now = "2026-07-17T12:00:00.000Z";
    const repository = memoryExperiences();
    const product = productRuntime();
    const persisted: string[] = [];
    const experience = createExperienceRuntime({
      id: () => "full-run",
      now: () => now,
      processor: {
        process: async ({ fact }) => {
          persisted.push(fact.sourceEnvelopeId);
          return {
            eventSequence: persisted.length,
            kind: "committed" as const,
            revision: persisted.length,
          };
        },
      },
      productRuntime: product,
      repository,
    });
    const run = await experience.startRun({
      awayTeam: "FRA",
      homeTeam: "ARG",
      ownerFanId: null,
    });
    now = "2026-07-17T12:05:01.000Z";

    await experience.tick();

    expect(persisted).toHaveLength(20);
    expect(product.fixture(run.fixtureId)).toMatchObject({
      phase: "full_time",
      score: { away: 1, home: 2 },
      stats: {
        away: { redCards: 1, yellowCards: 2 },
        home: { corners: 1, yellowCards: 2 },
      },
    });
    const final = product.fixture(run.fixtureId)!;
    const stats = final.stats!;
    expect(final.score.home + final.score.away).toBe(3);
    expect(
      stats.home.yellowCards +
        stats.home.redCards +
        stats.away.yellowCards +
        stats.away.redCards,
    ).toBe(5);
    expect(await experience.getRun(run.id)).toMatchObject({
      nextBeatIndex: 20,
      status: "final",
    });
    await experience.close();
    await product.close();
  });

  it("authors the exact five-minute Experience sequence and VAR targets", async () => {
    const repository = memoryExperiences();
    const product = productRuntime();
    const experience = createExperienceRuntime({
      id: () => "sequence-run",
      now: () => "2026-07-17T12:00:00.000Z",
      processor: {
        process: async () => ({
          eventSequence: 1,
          kind: "committed" as const,
          revision: 1,
        }),
      },
      productRuntime: product,
      repository,
    });

    const run = await experience.startRun({
      awayTeam: "FRA",
      homeTeam: "ARG",
      ownerFanId: null,
    });
    const authored = [...repository.beats.values()]
      .sort((left, right) => left.beatIndex - right.beatIndex)
      .map((beat) => {
        const envelope = beat.envelope as { fact: CanonicalEventFact };
        return {
          dueAt: beat.dueAt,
          key: beat.beatKey,
          kind: envelope.fact.kind,
          status: envelope.fact.status,
          targetFamilyId: envelope.fact.targetFamilyId ?? null,
          team: envelope.fact.team,
        };
      });

    expect(run.templateVersion).toBe(2);
    expect(authored).toEqual([
      {
        dueAt: "2026-07-17T12:00:00.000Z",
        key: "kickoff",
        kind: "phase.kickoff",
        status: "confirmed",
        targetFamilyId: null,
        team: null,
      },
      {
        dueAt: "2026-07-17T12:00:25.000Z",
        key: "opening-goal",
        kind: "goal",
        status: "provisional",
        targetFamilyId: null,
        team: "ARG",
      },
      {
        dueAt: "2026-07-17T12:00:35.000Z",
        key: "opening-goal-var-review",
        kind: "var.started",
        status: "under_review",
        targetFamilyId: "sequence-run:event:opening-goal",
        team: null,
      },
      {
        dueAt: "2026-07-17T12:00:50.000Z",
        key: "opening-goal-var-stands",
        kind: "var.stands",
        status: "confirmed",
        targetFamilyId: "sequence-run:event:opening-goal",
        team: null,
      },
      {
        dueAt: "2026-07-17T12:01:10.000Z",
        key: "home-yellow",
        kind: "card.yellow",
        status: "confirmed",
        targetFamilyId: null,
        team: "ARG",
      },
      {
        dueAt: "2026-07-17T12:01:25.000Z",
        key: "away-yellow-first-half",
        kind: "card.yellow",
        status: "confirmed",
        targetFamilyId: null,
        team: "FRA",
      },
      {
        dueAt: "2026-07-17T12:01:40.000Z",
        key: "away-penalty-awarded",
        kind: "penalty.awarded",
        status: "confirmed",
        targetFamilyId: null,
        team: "FRA",
      },
      {
        dueAt: "2026-07-17T12:01:55.000Z",
        key: "away-penalty-scored",
        kind: "penalty.scored",
        status: "confirmed",
        targetFamilyId: null,
        team: "FRA",
      },
      {
        dueAt: "2026-07-17T12:02:15.000Z",
        key: "half-time",
        kind: "phase.half_time",
        status: "confirmed",
        targetFamilyId: null,
        team: null,
      },
      {
        dueAt: "2026-07-17T12:02:30.000Z",
        key: "second-half",
        kind: "phase.second_half_start",
        status: "confirmed",
        targetFamilyId: null,
        team: null,
      },
      {
        dueAt: "2026-07-17T12:03:00.000Z",
        key: "away-red",
        kind: "card.red",
        status: "confirmed",
        targetFamilyId: null,
        team: "FRA",
      },
      {
        dueAt: "2026-07-17T12:03:20.000Z",
        key: "home-yellow-second-half",
        kind: "card.yellow",
        status: "confirmed",
        targetFamilyId: null,
        team: "ARG",
      },
      {
        dueAt: "2026-07-17T12:03:21.000Z",
        key: "away-yellow-second-half",
        kind: "card.yellow",
        status: "confirmed",
        targetFamilyId: null,
        team: "FRA",
      },
      {
        dueAt: "2026-07-17T12:03:45.000Z",
        key: "winning-goal",
        kind: "goal",
        status: "confirmed",
        targetFamilyId: null,
        team: "ARG",
      },
      {
        dueAt: "2026-07-17T12:04:10.000Z",
        key: "apparent-equalizer",
        kind: "goal",
        status: "provisional",
        targetFamilyId: null,
        team: "FRA",
      },
      {
        dueAt: "2026-07-17T12:04:20.000Z",
        key: "equalizer-var-review",
        kind: "var.started",
        status: "under_review",
        targetFamilyId: "sequence-run:event:apparent-equalizer",
        team: null,
      },
      {
        dueAt: "2026-07-17T12:04:35.000Z",
        key: "equalizer-var-overturned",
        kind: "var.overturned",
        status: "confirmed",
        targetFamilyId: "sequence-run:event:apparent-equalizer",
        team: null,
      },
      {
        dueAt: "2026-07-17T12:04:45.000Z",
        key: "late-corner",
        kind: "corner",
        status: "confirmed",
        targetFamilyId: null,
        team: "ARG",
      },
      {
        dueAt: "2026-07-17T12:04:55.000Z",
        key: "regulation-end",
        kind: "phase.regulation_end",
        status: "confirmed",
        targetFamilyId: null,
        team: null,
      },
      {
        dueAt: "2026-07-17T12:05:00.000Z",
        key: "full-time",
        kind: "phase.full_time",
        status: "confirmed",
        targetFamilyId: null,
        team: null,
      },
    ]);

    await experience.close();
    await product.close();
  });
});

describe("exact Moment resolver and Experience HTTP contract", () => {
  it("returns requested and latest family truth and preserves missing identities", async () => {
    const product = productRuntime();
    product.registerFixture(
      {
        awayTeam: "FRA",
        fixtureId: "experience:resolver",
        homeTeam: "ARG",
        kickoffAt: "2026-07-17T12:00:00.000Z",
        provenance: "synthetic_txline_shaped",
      },
      { public: true },
    );
    const goal: CanonicalEventFact = {
      familyId: "resolver:goal",
      fixtureId: "experience:resolver",
      kind: "goal",
      minute: "23'",
      occurredAt: "2026-07-17T12:23:00.000Z",
      player: null,
      provenance: "synthetic_txline_shaped",
      receivedAt: "2026-07-17T12:23:00.000Z",
      sourceEnvelopeId: "resolver:goal-envelope",
      sourceEventId: "goal",
      status: "confirmed",
      team: "ARG",
      type: "canonical_event",
    };
    product.acceptSourceFact(goal);
    product.acceptSourceFact({
      ...goal,
      kind: "var.started",
      sourceEnvelopeId: "resolver:var-envelope",
      sourceEventId: "var-started",
      status: "under_review",
      targetFamilyId: goal.familyId,
      team: null,
    });
    const app = buildApp({
      demo: false,
      readinessProbe: {
        check: async () => ({
          databaseReachable: true,
          migrationsCurrent: true,
        }),
      },
      runtime: product,
      webDistPath: process.cwd(),
    });

    const exact = await app.inject({
      url: "/api/v1/fixtures/experience%3Aresolver/moments/resolver%3Agoal%3A1",
    });
    expect(exact.statusCode).toBe(200);
    expect(exact.json()).toMatchObject({
      latest: {
        identity: "resolver:goal:2",
        status: "under_review",
      },
      requested: { identity: "resolver:goal:1", status: "confirmed" },
      snapshot: { score: { away: 0, home: 0 }, revision: 2 },
      superseded: true,
    });

    const missingRevision = await app.inject({
      url: "/api/v1/fixtures/experience%3Aresolver/moments/resolver%3Agoal%3A99",
    });
    expect(missingRevision.statusCode).toBe(200);
    expect(missingRevision.json()).toMatchObject({
      latest: { identity: "resolver:goal:2" },
      requested: null,
      superseded: true,
    });
    product.acceptSourceFact({
      ...goal,
      kind: "var.stands",
      sourceEnvelopeId: "resolver:stands-envelope",
      sourceEventId: "var-stands",
      targetFamilyId: goal.familyId,
      team: null,
    });
    const confirmed = await app.inject({
      url: "/api/v1/fixtures/experience%3Aresolver/moments/resolver%3Agoal%3A3",
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({
      latest: {
        celebratesGoal: true,
        identity: "resolver:goal:3",
        kind: "var.stands",
      },
      requested: { celebratesGoal: true, identity: "resolver:goal:3" },
      superseded: false,
    });
    const missingFixture = await app.inject({
      url: "/api/v1/fixtures/missing/moments/resolver%3Agoal%3A1",
    });
    expect(missingFixture.statusCode).toBe(404);
    await app.close();
  });

  it("starts and reports a durable Experience run over HTTP", async () => {
    const repository = memoryExperiences();
    const product = productRuntime();
    const experience: ExperienceRuntime = createExperienceRuntime({
      id: () => "route-run",
      now: () => "2026-07-17T12:00:00.000Z",
      processor: {
        process: async () => ({
          eventSequence: 1,
          kind: "committed",
          revision: 1,
        }),
      },
      productRuntime: product,
      repository,
    });
    const app = buildApp({
      demo: false,
      experience,
      readinessProbe: {
        check: async () => ({
          databaseReachable: true,
          migrationsCurrent: true,
        }),
      },
      runtime: product,
      webDistPath: process.cwd(),
    });

    const started = await app.inject({
      method: "POST",
      payload: { awayTeam: "FRA", homeTeam: "ARG" },
      url: "/api/v1/experience/runs",
    });
    expect(started.statusCode).toBe(201);
    expect(started.json()).toMatchObject({
      run: {
        fixtureId: "experience:route-run",
        id: "route-run",
        status: "countdown",
      },
    });
    const status = await app.inject({
      url: "/api/v1/experience/runs/route-run",
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      run: { id: "route-run", nextBeatIndex: 0 },
    });
    await app.close();
  });
});
