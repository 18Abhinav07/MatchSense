import type {
  ArchiveImportSourceContext,
  FixtureProjectionRecord,
  FixtureTruthRepository,
  LiveTerminalArchiveImportJobInput,
  RecordedArchiveInvalidation,
  RawSourceRecordWrite,
  SourceEnvelopeCommitPlan,
  SourceFence,
} from "@matchsense/db";
import {
  createFixtureProjection,
  toFixtureSnapshot,
} from "@matchsense/event-engine";
import {
  hashTxlineScorePayload,
  reduceDurableTxlineDelivery,
  txlineFixtureIdFromPayload,
  type DurableTxlineFixture,
  type DurableTxlineReduction,
  type TxlineRawLiveFrame,
  type TxlineRawRecord,
} from "@matchsense/txline-adapter";

import {
  createFixtureSourceEnvelopePlanDeriver,
  restoreFixtureProjection,
} from "../fixture-processor.js";

export interface CollectorFixtureDefinition extends DurableTxlineFixture {
  archiveImport: {
    contextHash: string;
    sourceContext: ArchiveImportSourceContext;
  };
}

export interface TxlineCollectorOptions {
  fixtureForId: (fixtureId: string) => CollectorFixtureDefinition | null;
  fixtureTruth: Pick<FixtureTruthRepository, "commitCollectorFrame">;
  rightsGrantId: string;
  sourceFence: SourceFence;
}

export type CollectorEffect = "fixture_event";

export type CollectorIngestResult =
  | { effects: readonly CollectorEffect[]; kind: "committed" }
  | { effects: readonly []; kind: "conflict" | "fenced" | "ignored" };

interface PreparedDelivery {
  archiveImportJob?: LiveTerminalArchiveImportJobInput | undefined;
  fixture: CollectorFixtureDefinition;
  recordedArchiveInvalidation?: RecordedArchiveInvalidation | undefined;
  raw: RawSourceRecordWrite;
  record: TxlineRawRecord;
  reduction: DurableTxlineReduction;
  derive?: (
    current: FixtureProjectionRecord | null,
  ) => readonly SourceEnvelopeCommitPlan[];
}

function deliveryIntent(record: TxlineRawRecord) {
  return record.metadata.delivery === "live" ? "realtime" : "reconcile";
}

function occurredAt(timestampMs: number | null) {
  return timestampMs === null ? null : new Date(timestampMs).toISOString();
}

function orderingKey(input: {
  observedSeq: string | null;
  payloadHash: string;
  sourceTimestampMs: number | null;
}) {
  if (input.observedSeq && /^\d+$/u.test(input.observedSeq)) {
    return `seq:${input.observedSeq.padStart(24, "0")}:${input.payloadHash}`;
  }
  const timestamp = input.sourceTimestampMs ?? 0;
  return `time:${String(timestamp).padStart(16, "0")}:${input.payloadHash}`;
}

function rawFor(
  record: TxlineRawRecord,
  source: {
    actionId: string | null;
    observedSeq: string | null;
    payloadHash: string;
    sourceTimestampMs: number | null;
  },
  fixture: CollectorFixtureDefinition,
  options: TxlineCollectorOptions,
): RawSourceRecordWrite {
  const key = [
    fixture.fixtureId,
    source.observedSeq ?? source.actionId ?? "no-provider-id",
    source.payloadHash,
  ].join(":");
  return {
    canonicalEligible: true,
    dedupeKey: key,
    deliveryIntent: deliveryIntent(record),
    id: `txline:delivery:${fixture.fixtureId}:${source.payloadHash}`,
    occurredAt: occurredAt(source.sourceTimestampMs),
    orderingKey: orderingKey(source),
    payload: record.payload,
    payloadHash: source.payloadHash,
    provenance: "live_txline",
    rawRetention: "authorised_raw",
    receivedAt: record.metadata.receivedAt,
    responseHash: source.payloadHash,
    rightsGrantId: options.rightsGrantId,
    source: options.sourceFence.source,
    sourcePath: record.metadata.sourcePath,
    sourceRecordId: source.actionId,
    sourceSequence: source.observedSeq,
    streamKey: options.sourceFence.streamKey,
  };
}

function sourceFor(reduction: DurableTxlineReduction, payload: unknown) {
  if (reduction.kind === "canonical") return reduction.update.source;
  if (reduction.kind === "source_only") return reduction.source.source;
  return {
    actionId: null,
    observedSeq: reduction.warning.observedSeq,
    payloadHash: hashTxlineScorePayload(payload),
    sseEventId: reduction.warning.sseEventId,
    sourceTimestampMs: null,
  };
}

function createInitialSnapshot(
  fixture: CollectorFixtureDefinition,
  receivedAt: string,
) {
  return toFixtureSnapshot(
    createFixtureProjection({
      awayTeam: fixture.awayTeam,
      fixtureId: fixture.fixtureId,
      homeTeam: fixture.homeTeam,
      kickoffAt: fixture.kickoffAt,
      observedAt: receivedAt,
      provenance: "live_txline",
    }),
  );
}

function archiveImportJobFor(input: {
  fixture: CollectorFixtureDefinition;
  raw: RawSourceRecordWrite;
  reduction: DurableTxlineReduction;
}): LiveTerminalArchiveImportJobInput | null {
  if (
    input.raw.canonicalEligible === false ||
    input.raw.deliveryIntent !== "realtime" ||
    input.reduction.kind !== "canonical"
  ) {
    return null;
  }
  const update = input.reduction.update;
  if (
    update.action !== "game_finalised" ||
    update.statusId !== 100 ||
    update.confirmed === false
  ) {
    return null;
  }
  const sourceTerminalRecordId = update.actionId ?? update.source.actionId;
  if (
    !sourceTerminalRecordId ||
    input.raw.sourceRecordId !== sourceTerminalRecordId
  ) {
    return null;
  }
  return {
    awayTeamId: input.fixture.awayTeam,
    contextHash: input.fixture.archiveImport.contextHash,
    fixtureId: input.fixture.fixtureId,
    homeTeamId: input.fixture.homeTeam,
    kickoffAt: input.fixture.kickoffAt,
    participant1IsHome: input.fixture.participant1IsHome,
    sourceContext: input.fixture.archiveImport.sourceContext,
    sourceTerminalRecordId,
  };
}

function recordedArchiveInvalidationFor(input: {
  raw: RawSourceRecordWrite;
  reduction: DurableTxlineReduction;
}): RecordedArchiveInvalidation | null {
  if (
    input.raw.canonicalEligible === false ||
    input.raw.deliveryIntent !== "realtime" ||
    input.reduction.kind !== "canonical" ||
    !input.reduction.invalidatesArchive
  ) {
    return null;
  }
  switch (input.reduction.update.action) {
    case "action_amend":
    case "action_discarded":
    case "score_adjustment":
    case "var_end":
      return { action: input.reduction.update.action };
    default:
      throw new Error(
        "Archive-invalidating TxLINE reduction lacks a closed correction action",
      );
  }
}

function sameRecordedArchiveInvalidation(
  left: RecordedArchiveInvalidation | null,
  right: RecordedArchiveInvalidation | null,
) {
  return left?.action === right?.action;
}

/**
 * Owns TxLINE raw delivery persistence. Every known SSE frame delegates one
 * transaction to the repository: raw deliveries, derived truth/outbox, then
 * its fenced cursor. Reconciliation deliberately has no cursor or fan effect.
 */
export function createTxlineCollector(options: TxlineCollectorOptions) {
  const prepare = (record: TxlineRawRecord): PreparedDelivery | null => {
    const fixtureId = txlineFixtureIdFromPayload(record.payload);
    if (!fixtureId) return null;
    const fixture = options.fixtureForId(fixtureId);
    if (!fixture) return null;
    const metadata = {
      delivery:
        record.metadata.delivery === "live"
          ? ("live" as const)
          : ("reconciliation" as const),
      provenance: "live_txline" as const,
      receivedAt: record.metadata.receivedAt,
      sseEventId: record.metadata.sseEventId,
    };
    let reduction = reduceDurableTxlineDelivery({
      current: createInitialSnapshot(fixture, record.metadata.receivedAt),
      fixture,
      metadata,
      payload: record.payload,
    });
    const raw = rawFor(
      record,
      sourceFor(reduction, record.payload),
      fixture,
      options,
    );
    raw.canonicalEligible = reduction.kind !== "source_only";

    const archiveImportJob = archiveImportJobFor({ fixture, raw, reduction });
    const recordedArchiveInvalidation = recordedArchiveInvalidationFor({
      raw,
      reduction,
    });
    const prepared: PreparedDelivery = {
      ...(archiveImportJob ? { archiveImportJob } : {}),
      fixture,
      ...(recordedArchiveInvalidation ? { recordedArchiveInvalidation } : {}),
      raw,
      record,
      reduction,
    };
    if (raw.canonicalEligible) {
      prepared.derive = (currentRecord) => {
        const current = currentRecord
          ? toFixtureSnapshot(
              restoreFixtureProjection({
                fixture,
                provenance: "live_txline",
                record: currentRecord,
              }),
            )
          : createInitialSnapshot(fixture, record.metadata.receivedAt);
        reduction = reduceDurableTxlineDelivery({
          current,
          fixture,
          metadata,
          payload: record.payload,
        });
        prepared.reduction = reduction;
        const currentInvalidation = recordedArchiveInvalidationFor({
          raw,
          reduction,
        });
        if (
          !sameRecordedArchiveInvalidation(
            recordedArchiveInvalidation,
            currentInvalidation,
          )
        ) {
          throw new Error(
            "TxLINE archive invalidation classification changed after projection derivation",
          );
        }
        if (reduction.kind !== "canonical") return [];
        const plans = createFixtureSourceEnvelopePlanDeriver({
          deliveryIntent: raw.deliveryIntent ?? "realtime",
          facts: reduction.facts,
          fixture,
          mode: "live",
        })(currentRecord);
        return currentInvalidation
          ? plans.map((plan) => ({ ...plan, outbox: [] }))
          : plans;
      };
    }
    return prepared;
  };

  const effectsFor = (
    prepared: readonly PreparedDelivery[],
    deliveries: readonly { kind: string; eventSequences?: readonly number[] }[],
  ): readonly CollectorEffect[] => {
    const hasRealtimeEvent = prepared.some(
      (delivery, index) =>
        delivery.raw.deliveryIntent === "realtime" &&
        delivery.reduction.kind === "canonical" &&
        !delivery.reduction.invalidatesArchive &&
        delivery.reduction.facts.length > 0 &&
        deliveries[index]?.kind === "committed" &&
        (deliveries[index]?.eventSequences?.length ?? 0) > 0,
    );
    return hasRealtimeEvent ? ["fixture_event"] : [];
  };

  const commit = async (
    prepared: readonly PreparedDelivery[],
    cursor?: { expectedCursor: string | null; nextCursor: string },
  ): Promise<CollectorIngestResult> => {
    const result = await options.fixtureTruth.commitCollectorFrame({
      ...(cursor ? { cursor } : {}),
      deliveries: prepared.map((delivery) => ({
        ...(delivery.archiveImportJob
          ? { archiveImportJob: delivery.archiveImportJob }
          : {}),
        ...(delivery.recordedArchiveInvalidation
          ? {
              recordedArchiveInvalidation: delivery.recordedArchiveInvalidation,
            }
          : {}),
        ...(delivery.derive ? { derive: delivery.derive } : {}),
        fixtureId: delivery.fixture.fixtureId,
        raw: delivery.raw,
      })),
      mode: "live",
      sourceFence: options.sourceFence,
    });
    if (result.kind === "fenced") return { effects: [], kind: "fenced" };
    if (result.kind === "conflict") return { effects: [], kind: "conflict" };
    return {
      effects: effectsFor(prepared, result.deliveries),
      kind: "committed",
    };
  };

  return {
    async ingest(record: TxlineRawRecord): Promise<CollectorIngestResult> {
      const delivery = prepare(record);
      if (!delivery) return { effects: [], kind: "ignored" };
      return commit([delivery]);
    },

    async ingestLiveFrame(frame: TxlineRawLiveFrame): Promise<boolean> {
      const prepared = frame.records.flatMap((record) => {
        const delivery = prepare(record);
        return delivery ? [delivery] : [];
      });
      const result = await commit(prepared, {
        expectedCursor: frame.expectedCursor,
        nextCursor: frame.nextCursor,
      });
      return result.kind === "committed";
    },
  };
}
