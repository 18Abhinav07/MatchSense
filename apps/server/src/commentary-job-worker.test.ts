import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { CommentaryJob } from "@matchsense/db";

import {
  createCommentaryJobWorker,
  createPipelineCommentaryGenerator,
  type CommentaryGenerator,
} from "./commentary-job-worker.js";

const fixtureId = "fixture-arg-fra";
const familyId = "txline:fixture-arg-fra:action:goal-23";

function moment(overrides: Record<string, unknown> = {}) {
  return {
    celebratesGoal: true,
    eventTeam: "ARG",
    familyId,
    fixtureId,
    id: familyId,
    identity: `${familyId}:3`,
    kind: "goal",
    minute: "23'",
    occurredAt: "2026-07-18T12:23:00.000Z",
    player: { displayName: "Lionel Messi", id: "player-messi" },
    provenance: "live_txline",
    revision: 3,
    score: { away: 0, home: 1 },
    sourceEnvelopeId: "txline-envelope-23",
    status: "confirmed",
    ...overrides,
  };
}

function outboxPayload(overrides: Record<string, unknown> = {}) {
  return {
    deliveryIntent: "realtime",
    event: {
      event: "moment.created",
      id: `${fixtureId}:revision:3`,
      moment: moment(),
      snapshot: { fixtureId, updatedAt: "2026-07-18T12:23:00.000Z" },
    },
    mode: "live",
    ...overrides,
  };
}

function queuedJob(overrides: Partial<CommentaryJob> = {}): CommentaryJob {
  return {
    artifactId: null,
    artifactSha256: null,
    attemptCount: 1,
    claimExpiresAt: "2026-07-18T12:25:00.000Z",
    claimedAt: "2026-07-18T12:24:00.000Z",
    claimedBy: "commentary-worker:test",
    createdAt: "2026-07-18T12:23:00.000Z",
    familyId,
    fixtureId,
    id: "commentary-job-1",
    language: "en",
    lastError: null,
    mode: "live",
    momentRevision: 3,
    status: "claimed",
    templateVersion: "factual-v1",
    updatedAt: "2026-07-18T12:24:00.000Z",
    voice: "Kore",
    ...overrides,
  };
}

function harness(options: { generator?: CommentaryGenerator } = {}) {
  const jobs = new Map<string, CommentaryJob>();
  const enqueue = vi.fn(async (input: CommentaryJob) => {
    const existing = jobs.get(
      [
        input.fixtureId,
        input.familyId,
        input.momentRevision,
        input.language,
        input.voice,
        input.templateVersion,
      ].join("|"),
    );
    if (existing) return existing;
    const job = queuedJob({
      ...input,
      status: "queued",
      claimedAt: null,
      claimedBy: null,
      claimExpiresAt: null,
    });
    jobs.set(
      [
        input.fixtureId,
        input.familyId,
        input.momentRevision,
        input.language,
        input.voice,
        input.templateVersion,
      ].join("|"),
      job,
    );
    return job;
  });
  const claimed = queuedJob();
  const repository = {
    claim: vi.fn(async () => claimed),
    complete: vi.fn(async () => undefined),
    enqueue,
    fail: vi.fn(async () => undefined),
    supersede: vi.fn(async () => undefined),
  };
  const truth = {
    eventsAfter: vi.fn(async () => [
      {
        payload: {
          event: "moment.created",
          id: `${fixtureId}:revision:3`,
          moment: moment(),
          snapshot: { fixtureId, updatedAt: "2026-07-18T12:23:00.000Z" },
        },
      },
    ]),
    get: vi.fn(async () => ({
      awayTeamId: "FRA",
      homeTeamId: "ARG",
      id: fixtureId,
    })),
  };
  const generator =
    options.generator ??
    vi.fn(async () => ({
      audioBytes: Buffer.from("valid-mp3-bytes"),
      transcript: "Goal. Argentina lead France one nil.",
    }));
  return {
    generator,
    jobs,
    repository,
    truth,
    worker: createCommentaryJobWorker({
      generator,
      jobs: repository,
      now: () => new Date("2026-07-18T12:24:00.000Z"),
      truth,
      workerId: "commentary-worker:test",
    }),
  };
}

describe("durable commentary job worker", () => {
  it("deduplicates one confirmed realtime canonical revision across its outbox topics", async () => {
    const { jobs, repository, worker } = harness();
    const message = {
      mode: "live" as const,
      payload: outboxPayload(),
      topic: "fixture.broadcast",
    };

    await worker.handleOutbox(message);
    await worker.handleOutbox({ ...message, topic: "commentary.prepare" });

    expect(jobs).toHaveLength(1);
    expect(repository.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId,
        fixtureId,
        language: "en",
        momentRevision: 3,
        templateVersion: "factual-v1",
        voice: "Kore",
      }),
    );
  });

  it("rejects recorded, reconciliation, and non-confirmed payloads before any job exists", async () => {
    const { repository, worker } = harness();
    const base = { topic: "fixture.broadcast" };

    await worker.handleOutbox({
      ...base,
      mode: "recorded",
      payload: outboxPayload({ mode: "recorded" }),
    });
    await worker.handleOutbox({
      ...base,
      mode: "live",
      payload: outboxPayload({ deliveryIntent: "reconcile" }),
    });
    await worker.handleOutbox({
      ...base,
      mode: "live",
      payload: outboxPayload({
        event: {
          event: "moment.created",
          id: `${fixtureId}:revision:3`,
          moment: moment({ status: "under_review" }),
          snapshot: { fixtureId, updatedAt: "2026-07-18T12:23:00.000Z" },
        },
      }),
    });

    expect(repository.enqueue).not.toHaveBeenCalled();
  });

  it("supersedes unstarted prior audio for a real-time correction without enqueuing replacement speech", async () => {
    const { repository, worker } = harness();

    await worker.handleOutbox({
      mode: "live",
      payload: outboxPayload({
        event: {
          event: "moment.revised",
          id: `${fixtureId}:revision:4`,
          moment: moment({
            identity: `${familyId}:4`,
            kind: "correction",
            revision: 4,
            status: "corrected",
          }),
          snapshot: { fixtureId, updatedAt: "2026-07-18T12:24:00.000Z" },
        },
      }),
      topic: "fixture.broadcast",
    });

    expect(repository.supersede).toHaveBeenCalledWith({
      familyId,
      fixtureId,
      mode: "live",
      revision: 3,
    });
    expect(repository.enqueue).not.toHaveBeenCalled();
  });

  it("writes only a nonempty hashed MP3 after factual generation succeeds", async () => {
    const { generator, repository, worker } = harness();

    await expect(worker.runOnce()).resolves.toEqual({ kind: "ready" });

    expect(generator).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          fixtureId,
          kind: "goal",
          revision: 3,
          status: "confirmed",
        }),
      }),
    );
    expect(repository.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        audioBytes: Buffer.from("valid-mp3-bytes"),
        audioHash: createHash("sha256").update("valid-mp3-bytes").digest("hex"),
        jobId: "commentary-job-1",
        mediaType: "audio/mpeg",
        workerId: "commentary-worker:test",
      }),
    );
    expect(repository.fail).not.toHaveBeenCalled();
  });

  it("records an explicit failure and never marks a provider failure ready", async () => {
    const { repository, worker } = harness({
      generator: async () => {
        throw new Error("commentary_tts_unavailable:gemini_missing_key");
      },
    });

    await expect(worker.runOnce()).resolves.toEqual({ kind: "failed" });

    expect(repository.complete).not.toHaveBeenCalled();
    expect(repository.fail).toHaveBeenCalledWith({
      error: "commentary_tts_unavailable:gemini_missing_key",
      jobId: "commentary-job-1",
      workerId: "commentary-worker:test",
    });
  });

  it("fails closed when the configured pipeline falls back to a synthetic cue", async () => {
    const generator = createPipelineCommentaryGenerator({
      pipeline: {
        generate: async () => ({
          artifact: {
            audio: { bytes: Buffer.from("cue") },
            provenance: {
              speechFallbackReason: "gemini_missing_key",
              speechProvider: "deterministic-cue",
            },
            transcript: "Goal.",
          },
          cache: "generated" as const,
        }),
      },
      transcode: async () => Buffer.from("mp3"),
    });

    await expect(
      generator({
        event: {
          awayTeam: { id: "FRA", name: "FRA" },
          eventTeamId: "ARG",
          fixtureId,
          homeTeam: { id: "ARG", name: "ARG" },
          kind: "goal",
          minute: "23'",
          momentId: familyId,
          playerDisplayName: null,
          revision: 3,
          score: { away: 0, home: 1 },
          status: "confirmed",
        },
        fan: {
          eventMode: "live",
          language: "en",
          locale: "en-IN",
          perspectiveTeamId: null,
          voice: { name: "Kore", revision: "factual-v1" },
        },
      }),
    ).rejects.toThrow("commentary_tts_unavailable:gemini_missing_key");
  });
});
