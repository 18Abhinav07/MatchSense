import { createHash, randomUUID } from "node:crypto";

import type {
  CommentaryInput,
  CommentaryPipeline,
} from "@matchsense/commentary";
import type {
  CommentaryJob,
  CommentaryJobInput,
  CommentaryJobRepository,
} from "@matchsense/db";

const COMMENTARY_LANGUAGE = "en";
const COMMENTARY_LOCALE = "en-IN";
const COMMENTARY_TEMPLATE_VERSION = "factual-v1";
const COMMENTARY_VOICE = "Kore";
const COMMENTARY_VOICE_REVISION = "factual-v1";

const narratableKinds = new Set([
  "phase.kickoff",
  "goal",
  "card.yellow",
  "card.red",
  "corner",
  "penalty.awarded",
  "penalty.scored",
  "penalty.missed",
  "var.started",
  "var.stands",
  "phase.half_time",
  "phase.second_half_start",
  "phase.regulation_end",
  "phase.extra_time_start",
  "phase.extra_time_half",
  "phase.extra_time_second_half_start",
  "phase.shootout_start",
  "shootout.kick_scored",
  "shootout.kick_missed",
  "phase.full_time",
] as const);

type NarratableKind = (typeof narratableKinds extends Set<infer Kind>
  ? Kind
  : never) &
  CommentaryInput["event"]["kind"];

interface CanonicalMomentValue {
  eventTeam: string | null;
  familyId: string;
  fixtureId: string;
  kind: string;
  minute: string;
  player: { displayName: string | null } | null;
  provenance: string;
  revision: number;
  score: { away: number; home: number };
  status: string;
}

interface FixtureIdentity {
  awayTeamId: string;
  homeTeamId: string;
  id: string;
}

export interface CommentaryGeneratorResult {
  audioBytes: Buffer;
  transcript: string;
}

/**
 * The generator must return a real transcoded MP3. A provider failure rejects
 * instead of manufacturing a successful speech artifact.
 */
export type CommentaryGenerator = (
  input: CommentaryInput,
) => Promise<CommentaryGeneratorResult>;

export interface CommentaryPipelineForWorker {
  generate(input: CommentaryInput): Promise<{
    artifact: {
      audio: { bytes: Buffer };
      provenance: {
        speechFallbackReason?: string | null;
        speechProvider: string;
      };
      transcript: string;
    };
  }>;
}

export interface CommentaryMomentReader {
  eventsAfter(input: {
    afterSequence: number;
    fixtureId: string;
    limit?: number;
    mode: "live";
  }): Promise<readonly { payload: unknown }[]>;
  get(input: {
    fixtureId: string;
    mode: "live";
  }): Promise<FixtureIdentity | null>;
}

export interface CommentaryJobWorkerOptions {
  generator: CommentaryGenerator;
  jobs: Pick<
    CommentaryJobRepository,
    "claim" | "complete" | "enqueue" | "fail" | "supersede"
  >;
  now?: () => Date;
  pollIntervalMs?: number;
  truth: CommentaryMomentReader;
  workerId?: string;
}

export type CommentaryOutboxMessage = {
  mode: string;
  payload: unknown;
  topic: string;
};

export type CommentaryJobRunResult =
  | { kind: "failed" }
  | { kind: "idle" }
  | { kind: "ready" }
  | { kind: "superseded" };

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonempty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function score(value: unknown): { away: number; home: number } | null {
  const record = object(value);
  const home = record?.home;
  const away = record?.away;
  return typeof home === "number" &&
    Number.isSafeInteger(home) &&
    home >= 0 &&
    typeof away === "number" &&
    Number.isSafeInteger(away) &&
    away >= 0
    ? { away, home }
    : null;
}

function canonicalMoment(value: unknown): CanonicalMomentValue | null {
  const record = object(value);
  if (!record) return null;
  const eventTeam = record.eventTeam;
  const playerValue = record.player;
  const player = object(playerValue);
  const parsedScore = score(record.score);
  const revision = positiveInteger(record.revision);
  const moment = {
    eventTeam: eventTeam === null ? null : nonempty(eventTeam),
    familyId: nonempty(record.familyId),
    fixtureId: nonempty(record.fixtureId),
    kind: nonempty(record.kind),
    minute: nonempty(record.minute),
    player:
      playerValue === null
        ? null
        : player &&
            (player.displayName === null ||
              typeof player.displayName === "string")
          ? { displayName: player.displayName }
          : null,
    provenance: nonempty(record.provenance),
    revision,
    score: parsedScore,
    status: nonempty(record.status),
  };
  if (
    (eventTeam !== null && moment.eventTeam === null) ||
    !moment.familyId ||
    !moment.fixtureId ||
    !moment.kind ||
    !moment.minute ||
    !moment.provenance ||
    !moment.revision ||
    !moment.score ||
    !moment.status
  ) {
    return null;
  }
  return moment as CanonicalMomentValue;
}

function messageMoment(payload: unknown): CanonicalMomentValue | null {
  const record = object(payload);
  const event = object(record?.event);
  return canonicalMoment(event?.moment ?? record?.moment);
}

function isRealtimeLivePayload(payload: unknown) {
  const record = object(payload);
  return record?.deliveryIntent === "realtime" && record.mode === "live";
}

function isSupersedingMoment(moment: CanonicalMomentValue) {
  return (
    moment.kind === "correction" ||
    moment.kind === "var.overturned" ||
    moment.status === "corrected" ||
    moment.status === "overturned"
  );
}

function isConfirmedNarratable(moment: CanonicalMomentValue) {
  return (
    moment.provenance === "live_txline" &&
    moment.status === "confirmed" &&
    narratableKinds.has(moment.kind as NarratableKind)
  );
}

function jobId(input: {
  familyId: string;
  fixtureId: string;
  revision: number;
}) {
  const digest = createHash("sha256")
    .update(
      [
        input.fixtureId,
        input.familyId,
        input.revision,
        COMMENTARY_LANGUAGE,
        COMMENTARY_VOICE,
        COMMENTARY_TEMPLATE_VERSION,
      ].join("|"),
    )
    .digest("hex")
    .slice(0, 32);
  return `commentary_${digest}`;
}

function jobInput(moment: CanonicalMomentValue): CommentaryJobInput {
  return {
    familyId: moment.familyId,
    fixtureId: moment.fixtureId,
    id: jobId({
      familyId: moment.familyId,
      fixtureId: moment.fixtureId,
      revision: moment.revision,
    }),
    language: COMMENTARY_LANGUAGE,
    mode: "live",
    momentRevision: moment.revision,
    templateVersion: COMMENTARY_TEMPLATE_VERSION,
    voice: COMMENTARY_VOICE,
  };
}

function failureMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "commentary_failed";
  return message.trim().slice(0, 1_000) || "commentary_failed";
}

function fixtureIdentity(value: unknown): FixtureIdentity | null {
  const record = object(value);
  const awayTeamId = nonempty(record?.awayTeamId);
  const homeTeamId = nonempty(record?.homeTeamId);
  const id = nonempty(record?.id);
  return awayTeamId && homeTeamId && id ? { awayTeamId, homeTeamId, id } : null;
}

function eventMoment(payload: unknown): CanonicalMomentValue | null {
  const record = object(payload);
  return canonicalMoment(record?.moment);
}

function commentaryInput(
  fixture: FixtureIdentity,
  moment: CanonicalMomentValue,
): CommentaryInput {
  if (!isConfirmedNarratable(moment)) {
    throw new Error("commentary_moment_is_not_confirmed_live_truth");
  }
  return {
    event: {
      awayTeam: { id: fixture.awayTeamId, name: fixture.awayTeamId },
      eventTeamId: moment.eventTeam,
      fixtureId: moment.fixtureId,
      homeTeam: { id: fixture.homeTeamId, name: fixture.homeTeamId },
      kind: moment.kind as CommentaryInput["event"]["kind"],
      minute: moment.minute,
      momentId: moment.familyId,
      playerDisplayName: moment.player?.displayName ?? null,
      revision: moment.revision,
      score: moment.score,
      status: "confirmed",
    },
    fan: {
      eventMode: "live",
      language: COMMENTARY_LANGUAGE,
      locale: COMMENTARY_LOCALE,
      perspectiveTeamId: null,
      voice: { name: COMMENTARY_VOICE, revision: COMMENTARY_VOICE_REVISION },
    },
  };
}

async function currentMoment(
  truth: CommentaryMomentReader,
  job: CommentaryJob,
) {
  const events = await truth.eventsAfter({
    afterSequence: 0,
    fixtureId: job.fixtureId,
    limit: 1_000,
    mode: "live",
  });
  const revisions = events
    .map(({ payload }) => eventMoment(payload))
    .filter(
      (moment): moment is CanonicalMomentValue =>
        moment !== null && moment.familyId === job.familyId,
    )
    .sort((left, right) => right.revision - left.revision);
  return revisions[0] ?? null;
}

/**
 * Bridges the existing configured Gemini/Groq pipeline to durable jobs. The
 * pipeline's deterministic audible cue remains useful for foreground UX, but
 * it is never persisted as successful TTS commentary.
 */
export function createPipelineCommentaryGenerator(options: {
  pipeline: CommentaryPipelineForWorker | Pick<CommentaryPipeline, "generate">;
  transcode: (wavBytes: Buffer) => Promise<Buffer>;
}): CommentaryGenerator {
  return async (input) => {
    const generated = await options.pipeline.generate(input);
    const artifact = generated.artifact;
    if (artifact.provenance.speechProvider !== "gemini") {
      throw new Error(
        `commentary_tts_unavailable:${
          artifact.provenance.speechFallbackReason ??
          artifact.provenance.speechProvider
        }`,
      );
    }
    if (!artifact.transcript.trim()) {
      throw new Error("commentary_transcript_missing");
    }
    const audioBytes = await options.transcode(artifact.audio.bytes);
    if (!Buffer.isBuffer(audioBytes) || audioBytes.byteLength === 0) {
      throw new Error("commentary_transcode_empty");
    }
    return { audioBytes, transcript: artifact.transcript };
  };
}

export function createCommentaryJobWorker(options: CommentaryJobWorkerOptions) {
  const now = options.now ?? (() => new Date());
  const workerId = options.workerId ?? `commentary-worker:${randomUUID()}`;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 50) {
    throw new Error("Commentary job polling interval is invalid");
  }
  let stopRequested = false;
  let loop: Promise<void> | null = null;

  const handleOutbox = async (message: CommentaryOutboxMessage) => {
    if (message.mode !== "live" || !isRealtimeLivePayload(message.payload)) {
      return { kind: "ignored" as const };
    }
    const moment = messageMoment(message.payload);
    if (!moment || moment.provenance !== "live_txline") {
      return { kind: "ignored" as const };
    }
    if (isSupersedingMoment(moment)) {
      if (moment.revision > 1) {
        await options.jobs.supersede({
          familyId: moment.familyId,
          fixtureId: moment.fixtureId,
          mode: "live",
          revision: moment.revision - 1,
        });
      }
      return { kind: "superseded" as const };
    }
    if (!isConfirmedNarratable(moment)) return { kind: "ignored" as const };
    const job = await options.jobs.enqueue(jobInput(moment));
    return { job, kind: "queued" as const };
  };

  const runOnce = async (): Promise<CommentaryJobRunResult> => {
    const job = await options.jobs.claim(workerId, now());
    if (!job) return { kind: "idle" };
    try {
      if (job.mode !== "live") {
        throw new Error("commentary_source_ineligible");
      }
      const [fixtureValue, latest] = await Promise.all([
        options.truth.get({ fixtureId: job.fixtureId, mode: "live" }),
        currentMoment(options.truth, job),
      ]);
      const fixture = fixtureIdentity(fixtureValue);
      if (
        !fixture ||
        latest === null ||
        latest.revision !== job.momentRevision ||
        !isConfirmedNarratable(latest)
      ) {
        await options.jobs.supersede({
          familyId: job.familyId,
          fixtureId: job.fixtureId,
          mode: "live",
          revision: job.momentRevision,
        });
        return { kind: "superseded" };
      }
      const output = await options.generator(commentaryInput(fixture, latest));
      if (!output.transcript.trim() || output.audioBytes.byteLength === 0) {
        throw new Error("commentary_generation_incomplete");
      }
      await options.jobs.complete({
        artifactId: `audio_${createHash("sha256")
          .update(job.id)
          .digest("hex")
          .slice(0, 32)}`,
        audioBytes: output.audioBytes,
        audioHash: createHash("sha256").update(output.audioBytes).digest("hex"),
        jobId: job.id,
        mediaType: "audio/mpeg",
        workerId,
      });
      return { kind: "ready" };
    } catch (error) {
      await options.jobs.fail({
        error: failureMessage(error),
        jobId: job.id,
        workerId,
      });
      return { kind: "failed" };
    }
  };

  const start = () => {
    if (loop) return;
    stopRequested = false;
    loop = (async () => {
      while (!stopRequested) {
        await runOnce().catch(() => undefined);
        if (!stopRequested) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, pollIntervalMs);
            timer.unref?.();
          });
        }
      }
    })().finally(() => {
      loop = null;
    });
  };

  const stop = async () => {
    stopRequested = true;
    await loop;
  };

  return { handleOutbox, runOnce, start, stop };
}

export type CommentaryJobWorker = ReturnType<typeof createCommentaryJobWorker>;
