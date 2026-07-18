import { createHash } from "node:crypto";

import type {
  ArchiveManifest,
  ArchiveManifestStatus,
  ArchiveMode,
  ArchiveRepository,
  DurableSourceDelivery,
  SourceFence,
} from "@matchsense/db";
import {
  createFixtureProjection,
  reduceSourceFact,
  toFixtureSnapshot,
} from "@matchsense/event-engine";
import {
  reduceDurableTxlineDelivery,
  type DurableTxlineFixture,
} from "@matchsense/txline-adapter";

export type ArchiveFixtureDefinition = DurableTxlineFixture;

export interface ArchiveRebuildInput {
  /** Callers set this whenever an amendment/correction was committed. */
  correctionObserved?: boolean | undefined;
  fixture: ArchiveFixtureDefinition;
  manifestId: string;
  mode: ArchiveMode;
  rightsGrantId: string;
  sourceFence: SourceFence;
}

export interface ArchiveRebuildResult {
  manifest: ArchiveManifest | null;
  projectionHash: string | null;
  status: ArchiveManifestStatus | "FENCED" | "TERMINAL_PENDING";
  terminalDeliveryId: string | null;
}

export interface ArchiveService {
  rebuild(input: ArchiveRebuildInput): Promise<ArchiveRebuildResult>;
}

export interface CreateArchiveServiceOptions {
  archive: Pick<
    ArchiveRepository,
    "invalidateArchive" | "orderedDeliveries" | "verifyArchive"
  >;
}

export const DURABLE_TXLINE_REDUCER_VERSION = "durable-txline-v1";

function provenanceForArchiveMode(mode: ArchiveMode) {
  return mode === "live"
    ? ("live_txline" as const)
    : ("recorded_txline_authorised" as const);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return "null";
}

function sha256(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function ordered(
  deliveries: readonly DurableSourceDelivery[],
): readonly DurableSourceDelivery[] {
  return [...deliveries].sort(
    (left, right) =>
      left.orderingKey.localeCompare(right.orderingKey) ||
      left.deliveryKey.localeCompare(right.deliveryKey) ||
      left.id.localeCompare(right.id),
  );
}

function authoritativeTerminal(
  delivery: DurableSourceDelivery | undefined,
): boolean {
  if (!delivery || !delivery.canonicalEligible || !isObject(delivery.payload)) {
    return false;
  }
  return (
    delivery.payload.Action === "game_finalised" &&
    delivery.payload.StatusId === 100 &&
    delivery.payload.Confirmed !== false
  );
}

/**
 * Replays durable raw deliveries with no process-local canonicalizer state.
 * Only an exact provider terminal delivery makes an archive replay-ready.
 */
export function createArchiveService(
  options: CreateArchiveServiceOptions,
): ArchiveService {
  return {
    async rebuild(input) {
      const provenance = provenanceForArchiveMode(input.mode);
      if (input.correctionObserved) {
        const invalidated = await options.archive.invalidateArchive({
          fixtureId: input.fixture.fixtureId,
          mode: input.mode,
          reason: "canonical correction observed",
          sourceFence: input.sourceFence,
        });
        if (invalidated.kind === "fenced") {
          return {
            manifest: null,
            projectionHash: null,
            status: "FENCED",
            terminalDeliveryId: null,
          };
        }
      }

      const deliveries = ordered(
        await options.archive.orderedDeliveries({
          fixtureId: input.fixture.fixtureId,
          mode: input.mode,
        }),
      );
      if (
        deliveries.some(
          (delivery) => delivery.fixtureId !== input.fixture.fixtureId,
        )
      ) {
        throw new Error(
          "Archive delivery fixture does not match rebuild fixture",
        );
      }

      const observedAt = deliveries[0]?.receivedAt ?? input.fixture.kickoffAt;
      let projection = createFixtureProjection({
        awayTeam: input.fixture.awayTeam,
        fixtureId: input.fixture.fixtureId,
        homeTeam: input.fixture.homeTeam,
        kickoffAt: input.fixture.kickoffAt,
        observedAt,
        provenance,
      });

      for (const delivery of deliveries) {
        const reduced = reduceDurableTxlineDelivery({
          current: toFixtureSnapshot(projection),
          fixture: input.fixture,
          metadata: {
            delivery:
              delivery.deliveryIntent === "realtime"
                ? "live"
                : "reconciliation",
            provenance,
            receivedAt: delivery.receivedAt,
            sseEventId: null,
          },
          payload: delivery.payload,
        });
        if (reduced.kind !== "canonical") continue;
        for (const fact of reduced.facts) {
          projection = reduceSourceFact(projection, fact).projection;
        }
      }

      const projectionHash = sha256({
        projection: toFixtureSnapshot(projection),
        reducerVersion: DURABLE_TXLINE_REDUCER_VERSION,
      });
      const terminal = deliveries.at(-1);
      if (!terminal || !authoritativeTerminal(terminal)) {
        return {
          manifest: null,
          projectionHash,
          status: "TERMINAL_PENDING",
          terminalDeliveryId: null,
        };
      }

      const verified = await options.archive.verifyArchive({
        fixtureId: input.fixture.fixtureId,
        manifestId: input.manifestId,
        mode: input.mode,
        projectionHash,
        reducerVersion: DURABLE_TXLINE_REDUCER_VERSION,
        rightsGrantId: input.rightsGrantId,
        sourceFence: input.sourceFence,
        terminalDeliveryId: terminal.id,
      });
      if (verified.kind === "fenced") {
        return {
          manifest: null,
          projectionHash,
          status: "FENCED",
          terminalDeliveryId: null,
        };
      }
      const manifest = verified.manifest;
      return {
        manifest,
        projectionHash,
        status: manifest.status,
        terminalDeliveryId: terminal.id,
      };
    },
  };
}
