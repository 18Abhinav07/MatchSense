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
import type { ArchiveService } from "./archive-service.js";

export type CollectorFixtureDefinition = DurableTxlineFixture;

export interface TxlineCollectorOptions {
  archive?: ArchiveService | undefined;
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
  fixture: CollectorFixtureDefinition;
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

function shouldRebuildArchive(reduction: DurableTxlineReduction) {
  return (
    reduction.kind === "canonical" &&
    (reduction.invalidatesArchive ||
      (reduction.update.action === "game_finalised" &&
        reduction.update.statusId === 100 &&
        reduction.update.confirmed !== false))
  );
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

    const prepared: PreparedDelivery = { fixture, raw, record, reduction };
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
        return reduction.kind === "canonical"
          ? createFixtureSourceEnvelopePlanDeriver({
              deliveryIntent: raw.deliveryIntent ?? "realtime",
              facts: reduction.facts,
              fixture,
              mode: "live",
            })(currentRecord)
          : [];
      };
    }
    return prepared;
  };

  const rebuildArchives = async (prepared: readonly PreparedDelivery[]) => {
    if (!options.archive) return true;
    const requests = new Map<
      string,
      { correctionObserved: boolean; fixture: CollectorFixtureDefinition }
    >();
    for (const delivery of prepared) {
      if (!shouldRebuildArchive(delivery.reduction)) continue;
      const previous = requests.get(delivery.fixture.fixtureId);
      requests.set(delivery.fixture.fixtureId, {
        correctionObserved:
          (previous?.correctionObserved ?? false) ||
          (delivery.reduction.kind === "canonical" &&
            delivery.reduction.invalidatesArchive),
        fixture: delivery.fixture,
      });
    }
    for (const [fixtureId, request] of requests) {
      const archive = await options.archive.rebuild({
        correctionObserved: request.correctionObserved,
        fixture: request.fixture,
        manifestId: `archive:live:${fixtureId}`,
        mode: "live",
        rightsGrantId: options.rightsGrantId,
        sourceFence: options.sourceFence,
      });
      if (archive.status === "FENCED") return false;
    }
    return true;
  };

  const effectsFor = (
    prepared: readonly PreparedDelivery[],
    deliveries: readonly { kind: string; eventSequences?: readonly number[] }[],
  ): readonly CollectorEffect[] => {
    const hasRealtimeEvent = prepared.some(
      (delivery, index) =>
        delivery.raw.deliveryIntent === "realtime" &&
        delivery.reduction.kind === "canonical" &&
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
        ...(delivery.derive ? { derive: delivery.derive } : {}),
        fixtureId: delivery.fixture.fixtureId,
        raw: delivery.raw,
      })),
      mode: "live",
      sourceFence: options.sourceFence,
    });
    if (result.kind === "fenced") return { effects: [], kind: "fenced" };
    if (result.kind === "conflict") return { effects: [], kind: "conflict" };
    if (!(await rebuildArchives(prepared))) {
      return { effects: [], kind: "fenced" };
    }
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
