import { createHash, randomUUID } from "node:crypto";

import type { ExperienceRepository, ExperienceRunRecord } from "@matchsense/db";
import type {
  CanonicalEventFact,
  CanonicalEventKind,
  CanonicalFactStatus,
  FixtureProjection,
  FixtureStreamEvent,
  TeamCode,
} from "@matchsense/contracts";

import type { FixtureProcessor } from "./fixture-processor.js";
import type { ProductFixture, ProductRuntime } from "./product-runtime.js";

const EXPERIENCE_TEMPLATE_ID = "five-minute-match";
const EXPERIENCE_TEMPLATE_VERSION = 2;

interface ExperienceBeatDefinition {
  key: string;
  kind: CanonicalEventKind;
  minute: string;
  offsetMs: number;
  status: CanonicalFactStatus;
  targetKey?: string;
  team: "away" | "home" | null;
}

const EXPERIENCE_BEATS: readonly ExperienceBeatDefinition[] = [
  {
    key: "kickoff",
    kind: "phase.kickoff",
    minute: "0'",
    offsetMs: 0,
    status: "confirmed",
    team: null,
  },
  {
    key: "opening-goal",
    kind: "goal",
    minute: "12'",
    offsetMs: 25_000,
    // The authored Experience demonstrates the real product's truth gate:
    // the score is held until the following VAR decision confirms it.
    status: "provisional",
    team: "home",
  },
  {
    key: "opening-goal-var-review",
    kind: "var.started",
    minute: "13'",
    offsetMs: 35_000,
    status: "under_review",
    targetKey: "opening-goal",
    team: null,
  },
  {
    key: "opening-goal-var-stands",
    kind: "var.stands",
    minute: "13'",
    offsetMs: 50_000,
    status: "confirmed",
    targetKey: "opening-goal",
    team: null,
  },
  {
    key: "home-yellow",
    kind: "card.yellow",
    minute: "24'",
    offsetMs: 70_000,
    status: "confirmed",
    team: "home",
  },
  {
    key: "away-yellow-first-half",
    kind: "card.yellow",
    minute: "31'",
    offsetMs: 85_000,
    status: "confirmed",
    team: "away",
  },
  {
    key: "away-penalty-awarded",
    kind: "penalty.awarded",
    minute: "40'",
    offsetMs: 100_000,
    status: "confirmed",
    team: "away",
  },
  {
    key: "away-penalty-scored",
    kind: "penalty.scored",
    minute: "41'",
    offsetMs: 115_000,
    status: "confirmed",
    team: "away",
  },
  {
    key: "half-time",
    kind: "phase.half_time",
    minute: "HT",
    offsetMs: 135_000,
    status: "confirmed",
    team: null,
  },
  {
    key: "second-half",
    kind: "phase.second_half_start",
    minute: "46'",
    offsetMs: 150_000,
    status: "confirmed",
    team: null,
  },
  {
    key: "away-red",
    kind: "card.red",
    minute: "58'",
    offsetMs: 180_000,
    status: "confirmed",
    team: "away",
  },
  {
    key: "home-yellow-second-half",
    kind: "card.yellow",
    minute: "67'",
    offsetMs: 200_000,
    status: "confirmed",
    team: "home",
  },
  {
    key: "away-yellow-second-half",
    kind: "card.yellow",
    minute: "67'",
    offsetMs: 201_000,
    status: "confirmed",
    team: "away",
  },
  {
    key: "winning-goal",
    kind: "goal",
    minute: "78'",
    offsetMs: 225_000,
    status: "confirmed",
    team: "home",
  },
  {
    key: "apparent-equalizer",
    kind: "goal",
    minute: "88'",
    offsetMs: 250_000,
    status: "provisional",
    team: "away",
  },
  {
    key: "equalizer-var-review",
    kind: "var.started",
    minute: "89'",
    offsetMs: 260_000,
    status: "under_review",
    targetKey: "apparent-equalizer",
    team: null,
  },
  {
    key: "equalizer-var-overturned",
    kind: "var.overturned",
    minute: "89'",
    offsetMs: 275_000,
    status: "confirmed",
    targetKey: "apparent-equalizer",
    team: null,
  },
  {
    key: "late-corner",
    kind: "corner",
    minute: "90+2'",
    offsetMs: 285_000,
    status: "confirmed",
    team: "home",
  },
  {
    key: "regulation-end",
    kind: "phase.regulation_end",
    minute: "90+4'",
    offsetMs: 295_000,
    status: "confirmed",
    team: null,
  },
  {
    key: "full-time",
    kind: "phase.full_time",
    minute: "FT",
    offsetMs: 300_000,
    status: "confirmed",
    team: null,
  },
] as const;

interface PersistedExperienceEnvelope {
  fact: CanonicalEventFact;
  fixture: ProductFixture;
}

export interface ExperienceRuntimeOptions {
  claimLimit?: number;
  countdownMs?: number;
  id?: () => string;
  lockTimeoutMs?: number;
  now?: () => string;
  persistFixture?: (fixture: ProductFixture) => Promise<void>;
  prepareWindowMs?: number;
  pollIntervalMs?: number;
  processor: FixtureProcessor;
  productRuntime: ProductRuntime;
  recoverRun?: (run: ExperienceRunRecord) => Promise<{
    events: readonly FixtureStreamEvent[];
    fixture: ProductFixture;
    projection: FixtureProjection | null;
  } | null>;
  repository: ExperienceRepository;
  retryDelayMs?: number;
}

export interface StartExperienceRunInput {
  awayTeam: TeamCode;
  homeTeam: TeamCode;
  ownerFanId: string | null;
  runId?: string;
}

export interface ExperienceRuntime {
  close(): Promise<void>;
  getRun(runId: string): Promise<ExperienceRunRecord | null>;
  prepareFixture(input: StartExperienceRunInput): Promise<{
    fixture: ProductFixture;
    runId: string;
  }>;
  start(): Promise<void>;
  startRun(input: StartExperienceRunInput): Promise<ExperienceRunRecord>;
  tick(): Promise<void>;
}

function dueAt(kickoffAt: string, offsetMs: number) {
  return new Date(Date.parse(kickoffAt) + offsetMs).toISOString();
}

function teamForBeat(beat: ExperienceBeatDefinition, fixture: ProductFixture) {
  if (beat.team === "home") return fixture.homeTeam;
  if (beat.team === "away") return fixture.awayTeam;
  return null;
}

function authoredEnvelope(
  runId: string,
  kickoffAt: string,
  fixture: ProductFixture,
  beat: ExperienceBeatDefinition,
): PersistedExperienceEnvelope {
  const receivedAt = dueAt(kickoffAt, beat.offsetMs);
  const familyId = `${runId}:event:${beat.key}`;
  return {
    fact: {
      familyId,
      fixtureId: fixture.fixtureId,
      kind: beat.kind,
      minute: beat.minute,
      occurredAt: receivedAt,
      player: null,
      provenance: "synthetic_txline_shaped",
      receivedAt,
      sourceEnvelopeId: `${runId}:beat:${beat.key}`,
      sourceEventId: beat.key,
      status: beat.status,
      ...(beat.targetKey
        ? { targetFamilyId: `${runId}:event:${beat.targetKey}` }
        : {}),
      team: teamForBeat(beat, fixture),
      type: "canonical_event",
    },
    fixture,
  };
}

function parseEnvelope(value: unknown): PersistedExperienceEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Experience beat envelope is invalid");
  }
  const envelope = value as Partial<PersistedExperienceEnvelope>;
  if (
    !envelope.fact ||
    envelope.fact.type !== "canonical_event" ||
    !envelope.fixture ||
    typeof envelope.fixture.fixtureId !== "string" ||
    envelope.fact.fixtureId !== envelope.fixture.fixtureId
  ) {
    throw new Error("Experience beat envelope is invalid");
  }
  return envelope as PersistedExperienceEnvelope;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Experience beat failed";
}

function hashPayload(payload: unknown) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function createExperienceRuntime(
  options: ExperienceRuntimeOptions,
): ExperienceRuntime {
  const claimLimit = options.claimLimit ?? 32;
  const countdownMs = options.countdownMs ?? 0;
  const id = options.id ?? randomUUID;
  const lockTimeoutMs = options.lockTimeoutMs ?? 30_000;
  const now = options.now ?? (() => new Date().toISOString());
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const prepareWindowMs = options.prepareWindowMs ?? 30 * 60_000;
  const retryDelayMs = options.retryDelayMs ?? 2_000;
  let timer: ReturnType<typeof setInterval> | null = null;
  let activeTick: Promise<void> | null = null;
  let closed = false;

  const runTick = async () => {
    const claimedAt = now();
    const claimId = `experience-worker:${randomUUID()}`;
    const beats = await options.repository.claimDueBeats({
      claimToken: claimId,
      limit: claimLimit,
      lockTimeoutMs,
      now: claimedAt,
    });
    for (const beat of beats) {
      try {
        const run = await options.repository.getRun(beat.runId);
        if (!run) throw new Error("Experience run is missing");
        if (beat.beatIndex !== run.nextBeatIndex) {
          throw new Error("Experience beat is waiting for its prior beat");
        }
        const envelope = parseEnvelope(beat.envelope);
        options.productRuntime.registerFixture(envelope.fixture, {
          public: false,
        });
        const payload = {
          beatIndex: beat.beatIndex,
          beatKey: beat.beatKey,
          fact: envelope.fact,
          fixture: envelope.fixture,
          runId: beat.runId,
        };
        const persisted = await options.processor.process({
          deliveryIntent: "realtime",
          fact: envelope.fact,
          fixture: envelope.fixture,
          mode: "demo",
          raw: {
            canonicalEligible: true,
            dedupeKey: envelope.fact.sourceEnvelopeId,
            id: envelope.fact.sourceEnvelopeId,
            payload,
            payloadHash: hashPayload(payload),
            rawRetention: "normalised_only",
            receivedAt: envelope.fact.receivedAt,
            rightsGrantId: "matchsense-experience-v2",
            source: "experience_match",
            sourceRecordId: envelope.fact.sourceEventId,
            sourceSequence: String(beat.beatIndex),
          },
        });
        if (persisted.kind === "fenced") {
          throw new Error("Experience beat persistence was fenced");
        }

        options.productRuntime.acceptSourceFact(envelope.fact);
        const completed = await options.repository.completeBeat({
          beatIndex: beat.beatIndex,
          claimToken: claimId,
          deliveredAt: now(),
          runId: beat.runId,
        });
        if (!completed) {
          throw new Error("Experience beat claim was lost before completion");
        }
      } catch (error) {
        await options.repository.failBeat({
          beatIndex: beat.beatIndex,
          claimToken: claimId,
          error: errorMessage(error),
          retryAt: new Date(Date.parse(now()) + retryDelayMs).toISOString(),
          runId: beat.runId,
        });
      }
    }
  };

  const runtime: ExperienceRuntime = {
    close: async () => {
      closed = true;
      if (timer) clearInterval(timer);
      timer = null;
      if (activeTick) await activeTick;
    },
    getRun: (runId) => options.repository.getRun(runId),
    prepareFixture: async (input) => {
      const runId = input.runId ?? id();
      const fixtureId = `experience:${runId}`;
      const existing = options.productRuntime.fixture(fixtureId);
      if (existing) {
        return {
          fixture: {
            awayTeam: existing.awayTeam,
            fixtureId,
            homeTeam: existing.homeTeam,
            kickoffAt: existing.kickoffAt,
            provenance: "synthetic_txline_shaped",
          },
          runId,
        };
      }
      const fixture: ProductFixture = {
        awayTeam: input.awayTeam,
        fixtureId,
        homeTeam: input.homeTeam,
        kickoffAt: new Date(Date.parse(now()) + prepareWindowMs).toISOString(),
        provenance: "synthetic_txline_shaped",
      };
      await options.persistFixture?.(fixture);
      options.productRuntime.registerFixture(fixture, { public: false });
      return { fixture, runId };
    },
    start: async () => {
      if (timer || closed) return;
      if (options.recoverRun) {
        const runs = await options.repository.listRecoverableRuns();
        for (const run of runs) {
          const recovered = await options.recoverRun(run);
          if (!recovered) continue;
          options.productRuntime.registerFixture(recovered.fixture, {
            events: recovered.events,
            ...(recovered.projection
              ? { projection: recovered.projection }
              : {}),
            public: false,
          });
        }
      }
      const scheduleTick = () => {
        void runtime.tick().catch(() => undefined);
      };
      scheduleTick();
      timer = setInterval(scheduleTick, pollIntervalMs);
      timer.unref?.();
    },
    startRun: async (input) => {
      const runId = input.runId ?? id();
      const existing = await options.repository.getRun(runId);
      if (existing) return existing;
      const kickoffAt = new Date(Date.parse(now()) + countdownMs).toISOString();
      const fixture: ProductFixture = {
        awayTeam: input.awayTeam,
        fixtureId: `experience:${runId}`,
        homeTeam: input.homeTeam,
        kickoffAt,
        provenance: "synthetic_txline_shaped",
      };
      const beats = EXPERIENCE_BEATS.map((beat, beatIndex) => ({
        beatIndex,
        beatKey: beat.key,
        dueAt: dueAt(kickoffAt, beat.offsetMs),
        envelope: authoredEnvelope(runId, kickoffAt, fixture, beat),
      }));
      await options.persistFixture?.(fixture);
      const run = await options.repository.createRun({
        beats,
        run: {
          fixtureId: fixture.fixtureId,
          id: runId,
          journey: "experience_match",
          kickoffAt,
          ownerFanId: input.ownerFanId,
          status: "countdown",
          templateId: EXPERIENCE_TEMPLATE_ID,
          templateVersion: EXPERIENCE_TEMPLATE_VERSION,
        },
        template: {
          active: true,
          definition: EXPERIENCE_BEATS,
          id: EXPERIENCE_TEMPLATE_ID,
          version: EXPERIENCE_TEMPLATE_VERSION,
        },
      });
      options.productRuntime.registerFixture(fixture, { public: false });
      return run;
    },
    tick: async () => {
      if (closed) return;
      if (activeTick) return activeTick;
      activeTick = runTick().finally(() => {
        activeTick = null;
      });
      return activeTick;
    },
  };

  return runtime;
}
