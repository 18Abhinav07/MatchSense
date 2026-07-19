import type { ExperienceRepository } from "@matchsense/db";

import type { DurablePushService } from "./durable-push.js";
import type { MomentPushInput } from "./push-delivery.js";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integer(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

export function experiencePushCandidate(
  payload: unknown,
): { input: MomentPushInput; runId: string } | null {
  const envelope = record(payload);
  const event = record(envelope?.event);
  const moment = record(event?.moment);
  const snapshot = record(event?.snapshot);
  const score = record(moment?.score);
  if (
    envelope?.mode !== "demo" ||
    envelope.deliveryIntent !== "realtime" ||
    !moment ||
    moment.provenance !== "synthetic_txline_shaped" ||
    moment.status !== "confirmed"
  ) {
    return null;
  }
  const fixtureId = text(moment.fixtureId);
  if (!fixtureId?.startsWith("experience:")) return null;
  const runId = fixtureId.slice("experience:".length);
  const familyId = text(moment.familyId);
  const minute = text(moment.minute);
  const revision = integer(moment.revision);
  const home = integer(score?.home);
  const away = integer(score?.away);
  const occurredAt = text(moment.occurredAt) ?? text(snapshot?.updatedAt);
  const team = text(moment.eventTeam) ?? "MATCH";
  if (
    !runId ||
    !familyId ||
    !minute ||
    revision === null ||
    revision < 1 ||
    home === null ||
    away === null ||
    !occurredAt
  ) {
    return null;
  }
  const kind = text(moment.kind);
  const eventKind: MomentPushInput["eventKind"] =
    moment.celebratesGoal === true &&
    (kind === "goal" || kind === "var.stands" || kind === "penalty.scored")
      ? "goal"
      : kind === "card.red"
        ? "card.red"
        : kind === "phase.full_time"
          ? "phase.full_time"
          : undefined;
  if (!eventKind) return null;

  const base = {
    eventKind,
    familyId,
    fixtureId,
    momentId: familyId,
    occurredAt,
    revision,
  };
  if (eventKind === "goal") {
    return {
      input: {
        ...base,
        body: `SIMULATED TXLINE-SHAPED DATA · Score ${home}–${away}. Tap to open the exact Moment.`,
        title: `EXPERIENCE · ⚽ GOAL — ${team}, ${minute}`,
      },
      runId,
    };
  }
  if (eventKind === "card.red") {
    return {
      input: {
        ...base,
        body: `SIMULATED TXLINE-SHAPED DATA · Red card for ${team}. Score ${home}–${away}.`,
        title: `EXPERIENCE · 🟥 RED CARD — ${minute}`,
      },
      runId,
    };
  }
  return {
    input: {
      ...base,
      body: `SIMULATED TXLINE-SHAPED DATA · Final score ${home}–${away}. Tap for Match Memory.`,
      title: `EXPERIENCE · FULL TIME — ${home}–${away}`,
    },
    runId,
  };
}

export function createExperienceDelivery(options: {
  experiences: Pick<ExperienceRepository, "getRun">;
  push: Pick<DurablePushService, "deliverExperienceToFans">;
  roomFanIds?: (runId: string) => Promise<readonly string[]>;
}) {
  return {
    async deliver(payload: unknown) {
      const candidate = experiencePushCandidate(payload);
      if (!candidate) return { accepted: 0, attempted: 0 };
      const run = await options.experiences.getRun(candidate.runId);
      if (
        !run ||
        run.fixtureMode !== "demo" ||
        run.fixtureId !== candidate.input.fixtureId ||
        !run.ownerFanId
      ) {
        return { accepted: 0, attempted: 0 };
      }
      const roomFanIds = await options.roomFanIds?.(candidate.runId);
      return options.push.deliverExperienceToFans(candidate.input, [
        ...new Set([run.ownerFanId, ...(roomFanIds ?? [])]),
      ]);
    },
  };
}

export type ExperienceDelivery = ReturnType<typeof createExperienceDelivery>;
