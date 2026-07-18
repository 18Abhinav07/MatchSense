import type {
  FixtureProjectionRecord,
  FixtureTruthRepository,
  RawSourceRecordWrite,
  SourceEnvelopeCommitPlan,
  SourceFence,
} from "@matchsense/db";
import {
  createFixtureProjection,
  toFixtureSnapshot,
} from "@matchsense/event-engine";
import {
  VERIFIED_TXLINE_DEVNET_ENDPOINTS,
  hashTxlineScorePayload,
  reduceDurableTxlineDelivery,
  txlineFixtureIdFromPayload,
  type DurableTxlineFixture,
  type DurableTxlineReduction,
  type TxlineRawRecord,
} from "@matchsense/txline-adapter";

import {
  createFixtureSourceEnvelopePlanDeriver,
  restoreFixtureProjection,
} from "../fixture-processor.js";
import type {
  ArchiveRebuildResult,
  ArchiveService,
} from "./archive-service.js";

export interface HistoricalArchiveImporterOptions {
  archive: ArchiveService;
  fixtureTruth: Pick<
    FixtureTruthRepository,
    "commitCollectorFrame" | "commitFencedFixtureUpsert" | "get"
  >;
  rightsGrantId: string;
  /** Recorded imports do not acquire a live stream lease, but retain this key for the collector frame contract. */
  sourceFence: SourceFence;
}

export interface HistoricalFixtureImportInput {
  fixture: DurableTxlineFixture;
  records: readonly TxlineRawRecord[];
}

export type HistoricalFixtureImportResult =
  | { kind: "empty" }
  | { kind: "fenced" }
  | { archive: ArchiveRebuildResult; kind: "replay_ready" }
  | { archive: ArchiveRebuildResult; kind: "terminal_pending" };

export interface HistoricalArchiveImporter {
  importFixture(
    input: HistoricalFixtureImportInput,
  ): Promise<HistoricalFixtureImportResult>;
}

interface PreparedHistoricalDelivery {
  derive?: (
    current: FixtureProjectionRecord | null,
  ) => readonly SourceEnvelopeCommitPlan[];
  raw: RawSourceRecordWrite;
  reduction: DurableTxlineReduction;
}

type SourceReference = {
  actionId: string | null;
  observedSeq: string | null;
  payloadHash: string;
  sourceTimestampMs: number | null;
};

function occurredAt(timestampMs: number | null) {
  return timestampMs === null ? null : new Date(timestampMs).toISOString();
}

function orderingKey(input: SourceReference) {
  if (input.observedSeq && /^\d+$/u.test(input.observedSeq)) {
    return `seq:${input.observedSeq.padStart(24, "0")}:${input.payloadHash}`;
  }
  return `time:${String(input.sourceTimestampMs ?? 0).padStart(16, "0")}:${input.payloadHash}`;
}

function sourceFor(
  reduction: DurableTxlineReduction,
  payload: unknown,
): SourceReference {
  if (reduction.kind === "canonical") return reduction.update.source;
  if (reduction.kind === "source_only") return reduction.source.source;
  return {
    actionId: null,
    observedSeq: reduction.warning.observedSeq,
    payloadHash: hashTxlineScorePayload(payload),
    sourceTimestampMs: null,
  };
}

function initialSnapshot(fixture: DurableTxlineFixture, receivedAt: string) {
  return toFixtureSnapshot(
    createFixtureProjection({
      awayTeam: fixture.awayTeam,
      fixtureId: fixture.fixtureId,
      homeTeam: fixture.homeTeam,
      kickoffAt: fixture.kickoffAt,
      observedAt: receivedAt,
      provenance: "recorded_txline_authorised",
    }),
  );
}

function validateHistoricalRecord(
  fixture: DurableTxlineFixture,
  record: TxlineRawRecord,
) {
  if (record.metadata.delivery !== "reconciliation") {
    throw new Error("Historical import requires reconciliation records");
  }
  if (record.metadata.requestedFixtureId !== fixture.fixtureId) {
    throw new Error("Historical record does not match the requested fixture");
  }
  if (
    record.metadata.sourcePath !==
    VERIFIED_TXLINE_DEVNET_ENDPOINTS.historicalScorePath(fixture.fixtureId)
  ) {
    throw new Error(
      "Historical record did not originate from the TxLINE historical path",
    );
  }
  if (txlineFixtureIdFromPayload(record.payload) !== fixture.fixtureId) {
    throw new Error(
      "Historical record payload does not match the requested fixture",
    );
  }
}

function fixtureUpsert(
  fixture: DurableTxlineFixture,
  status: "tracking" | "final",
) {
  return {
    awayTeamId: fixture.awayTeam,
    homeTeamId: fixture.homeTeam,
    id: fixture.fixtureId,
    metadata: {
      participant1IsHome: fixture.participant1IsHome,
      source: "txline_historical",
      sourceFixtureId: fixture.fixtureId,
    },
    mode: "recorded" as const,
    provenance: "recorded_txline_authorised" as const,
    scheduledAt: fixture.kickoffAt,
    status,
  };
}

function rawFor(input: {
  fixture: DurableTxlineFixture;
  record: TxlineRawRecord;
  rightsGrantId: string;
  source: SourceReference;
  sourceFence: SourceFence;
}): RawSourceRecordWrite {
  const key = [
    input.fixture.fixtureId,
    input.source.observedSeq ?? input.source.actionId ?? "no-provider-id",
    input.source.payloadHash,
  ].join(":");
  return {
    canonicalEligible: true,
    dedupeKey: key,
    deliveryIntent: "reconcile",
    id: `txline:recorded:${input.fixture.fixtureId}:${input.source.payloadHash}`,
    occurredAt: occurredAt(input.source.sourceTimestampMs),
    orderingKey: orderingKey(input.source),
    payload: input.record.payload,
    payloadHash: input.source.payloadHash,
    provenance: "recorded_txline_authorised",
    rawRetention: "authorised_raw",
    receivedAt: input.record.metadata.receivedAt,
    responseHash: input.source.payloadHash,
    rightsGrantId: input.rightsGrantId,
    source: input.sourceFence.source,
    sourcePath: input.record.metadata.sourcePath,
    sourceRecordId: input.source.actionId,
    sourceSequence: input.source.observedSeq,
    streamKey: input.sourceFence.streamKey,
  };
}

/**
 * Imports only genuine TxLINE historical reconciliation records. It deliberately
 * emits no Moment/outbox work: recorded archives are replay/history material,
 * never a path into live notifications, Rooms, or commentary preparation.
 */
export function createHistoricalArchiveImporter(
  options: HistoricalArchiveImporterOptions,
): HistoricalArchiveImporter {
  const prepare = (
    fixture: DurableTxlineFixture,
    record: TxlineRawRecord,
  ): PreparedHistoricalDelivery => {
    validateHistoricalRecord(fixture, record);
    const metadata = {
      delivery: "reconciliation" as const,
      provenance: "recorded_txline_authorised" as const,
      receivedAt: record.metadata.receivedAt,
      sseEventId: record.metadata.sseEventId,
    };
    let reduction = reduceDurableTxlineDelivery({
      current: initialSnapshot(fixture, record.metadata.receivedAt),
      fixture,
      metadata,
      payload: record.payload,
    });
    const raw = rawFor({
      fixture,
      record,
      rightsGrantId: options.rightsGrantId,
      source: sourceFor(reduction, record.payload),
      sourceFence: options.sourceFence,
    });
    raw.canonicalEligible = reduction.kind !== "source_only";

    const prepared: PreparedHistoricalDelivery = { raw, reduction };
    if (raw.canonicalEligible) {
      prepared.derive = (currentRecord) => {
        const current = currentRecord
          ? toFixtureSnapshot(
              restoreFixtureProjection({
                fixture,
                provenance: "recorded_txline_authorised",
                record: currentRecord,
              }),
            )
          : initialSnapshot(fixture, record.metadata.receivedAt);
        reduction = reduceDurableTxlineDelivery({
          current,
          fixture,
          metadata,
          payload: record.payload,
        });
        prepared.reduction = reduction;
        return reduction.kind === "canonical"
          ? createFixtureSourceEnvelopePlanDeriver({
              deliveryIntent: "reconcile",
              facts: reduction.facts,
              fixture,
              mode: "recorded",
            })(currentRecord)
          : [];
      };
    }
    return prepared;
  };

  return {
    async importFixture(input) {
      if (input.records.length === 0) return { kind: "empty" };
      const prepared = input.records.map((record) =>
        prepare(input.fixture, record),
      );
      prepared.sort(
        (left, right) =>
          (left.raw.orderingKey ?? "").localeCompare(
            right.raw.orderingKey ?? "",
          ) ||
          left.raw.dedupeKey.localeCompare(right.raw.dedupeKey) ||
          left.raw.id.localeCompare(right.raw.id),
      );

      const existing = await options.fixtureTruth.get({
        fixtureId: input.fixture.fixtureId,
        mode: "recorded",
      });
      if (existing?.status !== "final") {
        const tracked = await options.fixtureTruth.commitFencedFixtureUpsert({
          fixture: fixtureUpsert(input.fixture, "tracking"),
          sourceFence: options.sourceFence,
        });
        if (tracked.kind === "fenced") return { kind: "fenced" };
      }
      const persisted = await options.fixtureTruth.commitCollectorFrame({
        deliveries: prepared.map((delivery) => ({
          ...(delivery.derive ? { derive: delivery.derive } : {}),
          fixtureId: input.fixture.fixtureId,
          raw: delivery.raw,
        })),
        mode: "recorded",
        sourceFence: options.sourceFence,
      });
      if (persisted.kind === "fenced") return { kind: "fenced" };
      if (persisted.kind !== "committed") {
        throw new Error(
          "Historical import attempted an unexpected cursor transition",
        );
      }

      const archive = await options.archive.rebuild({
        correctionObserved: prepared.some(
          (delivery) =>
            delivery.reduction.kind === "canonical" &&
            delivery.reduction.invalidatesArchive,
        ),
        fixture: input.fixture,
        manifestId: `archive:recorded:${input.fixture.fixtureId}`,
        mode: "recorded",
        rightsGrantId: options.rightsGrantId,
      });
      if (archive.status !== "REPLAY_READY") {
        return { archive, kind: "terminal_pending" };
      }
      const finalized = await options.fixtureTruth.commitFencedFixtureUpsert({
        fixture: fixtureUpsert(input.fixture, "final"),
        sourceFence: options.sourceFence,
      });
      if (finalized.kind === "fenced") return { kind: "fenced" };
      return { archive, kind: "replay_ready" };
    },
  };
}
