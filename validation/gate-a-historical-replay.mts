import { createHash } from "node:crypto";

import {
  createTxlineAuthenticatedClient,
  createTxlineOrderedCanonicalizer,
  decodeTxlineRecordBody,
  fetchTxlineWorldCupSchedule,
  normalizeTxlineScoreUpdate,
  VERIFIED_TXLINE_DEVNET_ENDPOINTS,
  type TxlineCanonicalEvent,
  type TxlineFixtureContext,
  type TxlineNormalizedUpdate,
  type TxlineSourceOnlyRecord,
  type TxlineSourceReference,
} from "../packages/txline-adapter/src/index.ts";

/**
 * Gate A is an external-source proof, not a product fallback. It retains no
 * provider payload: stdout contains only hashes, counts, action labels, and
 * terminal metadata. A failure removes Recorded Replay from the public scope.
 */
const fixtureId = process.env.TXLINE_SPIKE_FIXTURE_ID ?? "18237038";
const scheduleStartEpochDay = Number(
  process.env.TXLINE_SPIKE_START_EPOCH_DAY ?? "20648",
);
const token = process.env.TXLINE_API_TOKEN;
if (!token) throw new Error("TXLINE_API_TOKEN is required for Gate A");
if (!Number.isSafeInteger(scheduleStartEpochDay) || scheduleStartEpochDay < 0) {
  throw new Error(
    "TXLINE_SPIKE_START_EPOCH_DAY must be a non-negative integer",
  );
}

const receivedAt = "2026-07-18T00:00:00.000Z";
const sourceLabel = "txline_historical_score_v1";
const historicalPath =
  VERIFIED_TXLINE_DEVNET_ENDPOINTS.historicalScorePath(fixtureId);
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const client = createTxlineAuthenticatedClient({ apiToken: token });

const schedule = await fetchTxlineWorldCupSchedule(client, {
  startEpochDay: scheduleStartEpochDay,
});
const scheduled = schedule.find((fixture) => fixture.fixtureId === fixtureId);
if (!scheduled) {
  throw new Error(
    `Schedule did not return authoritative fixture context for ${fixtureId}`,
  );
}
const context: TxlineFixtureContext = scheduled;
const scheduleContextHash = hash(
  JSON.stringify({
    fixtureId: scheduled.fixtureId,
    participant1: scheduled.participant1,
    participant1IsHome: scheduled.participant1IsHome,
    participant2: scheduled.participant2,
    startEpochDay: scheduleStartEpochDay,
  }),
);

interface CanonicalHistoricalRecord {
  kind: "canonical";
  normalized: TxlineNormalizedUpdate;
  ordinal: number;
  payload: unknown;
}

interface SourceOnlyHistoricalRecord {
  kind: "source_only";
  ordinal: number;
  payload: unknown;
  record: TxlineSourceOnlyRecord;
}

type HistoricalRecord = CanonicalHistoricalRecord | SourceOnlyHistoricalRecord;

interface HistoricalFetch {
  bodyHash: string;
  canonicalRecords: CanonicalHistoricalRecord[];
  manifestHash: string;
  records: HistoricalRecord[];
  sourceOnlyRecords: SourceOnlyHistoricalRecord[];
}

function numericSequence(value: string | null): bigint {
  if (value === null || !/^\d+$/u.test(value)) {
    throw new Error("Historical source lacks a numeric observed sequence");
  }
  return BigInt(value);
}

function safeActionLabel(payload: unknown) {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return "<non-object>";
  }
  const record = payload as Record<string, unknown>;
  const action = record.Action ?? record.action;
  if (typeof action === "string") return action;
  return `<missing; keys=${Object.keys(record).sort().join(",")}>`;
}

function sourceOf(record: HistoricalRecord): TxlineSourceReference {
  return record.kind === "canonical"
    ? record.normalized.source
    : record.record.source;
}

function fixtureOf(record: HistoricalRecord) {
  return record.kind === "canonical"
    ? record.normalized.fixtureId
    : record.record.fixtureId;
}

function manifestEntry(record: HistoricalRecord) {
  const source = sourceOf(record);
  const deliveryKey = hash(
    [
      sourceLabel,
      historicalPath,
      fixtureId,
      source.observedSeq,
      source.actionId ?? "",
      source.payloadHash,
    ].join("\0"),
  );
  return [
    source.observedSeq,
    record.ordinal,
    record.kind,
    source.actionId ?? "",
    source.payloadHash,
    deliveryKey,
  ].join(":");
}

async function historical(): Promise<HistoricalFetch> {
  const response = await client.get(historicalPath, {
    accept: "text/event-stream, application/json",
  });
  const body = await response.text();
  const records = decodeTxlineRecordBody(body).map((payload, ordinal) => {
    const normalized = normalizeTxlineScoreUpdate(payload, {
      delivery: "replay",
      fixtureContext: context,
      provenance: "recorded_txline_authorised",
      receivedAt,
      sseEventId: null,
    });
    if (normalized.kind === "unsupported") {
      throw new Error(
        `Historical action at ordinal ${ordinal} remains unclassified: ${safeActionLabel(payload)} (${normalized.warning.code})`,
      );
    }
    if (normalized.kind === "source_only") {
      return {
        kind: "source_only" as const,
        ordinal,
        payload,
        record: normalized.record,
      };
    }
    return {
      kind: "canonical" as const,
      normalized: normalized.update,
      ordinal,
      payload,
    };
  });

  if (records.length === 0) {
    throw new Error("Historical source returned no score records");
  }
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (fixtureOf(record) !== fixtureId) {
      throw new Error(
        `Historical action at ordinal ${record.ordinal} belongs to another fixture`,
      );
    }
    const currentSequence = numericSequence(sourceOf(record).observedSeq);
    if (index > 0) {
      const previousSequence = numericSequence(
        sourceOf(records[index - 1]!).observedSeq,
      );
      if (currentSequence <= previousSequence) {
        throw new Error(
          "Historical source lacks a strictly increasing provider-owned sequence",
        );
      }
    }
  }

  const canonicalRecords = records.filter(
    (record): record is CanonicalHistoricalRecord =>
      record.kind === "canonical",
  );
  const sourceOnlyRecords = records.filter(
    (record): record is SourceOnlyHistoricalRecord =>
      record.kind === "source_only",
  );
  if (canonicalRecords.length === 0) {
    throw new Error("Historical source has no canonical football records");
  }

  return {
    bodyHash: hash(body),
    canonicalRecords,
    manifestHash: hash(records.map(manifestEntry).join("\n")),
    records,
    sourceOnlyRecords,
  };
}

const first = await historical();
const second = await historical();
if (
  first.bodyHash !== second.bodyHash ||
  first.manifestHash !== second.manifestHash
) {
  throw new Error(
    "Historical responses are not stable across two clean fetches",
  );
}

const terminal = first.canonicalRecords.at(-1)?.normalized;
if (
  !terminal ||
  terminal.action !== "game_finalised" ||
  terminal.confirmed === false ||
  terminal.statusId !== 100
) {
  throw new Error(
    `The highest canonical historical record is not an authoritative StatusId=100 game_finalised (action=${terminal?.action ?? "<none>"}, confirmed=${terminal?.confirmed ?? "<none>"}, statusId=${terminal?.statusId ?? "<none>"}, seq=${terminal?.source.observedSeq ?? "<none>"})`,
  );
}

function reduce(records: readonly HistoricalRecord[]) {
  const canonicalizer = createTxlineOrderedCanonicalizer({
    fixtureContexts: [context],
  });
  const acceptedEvents: TxlineCanonicalEvent[] = [];
  for (const record of records) {
    const result = canonicalizer.accept(record.payload, {
      delivery: "replay",
      provenance: "recorded_txline_authorised",
      receivedAt,
      sseEventId: null,
    });
    if (record.kind === "source_only") {
      if (result.kind !== "source_only") {
        throw new Error(
          "Source-only history record created a canonical outcome",
        );
      }
      continue;
    }
    if (result.kind !== "accepted") {
      throw new Error("Canonical historical sequence did not reduce in order");
    }
    acceptedEvents.push(result.event);
  }

  for (const record of records) {
    const result = canonicalizer.accept(record.payload, {
      delivery: "replay",
      provenance: "recorded_txline_authorised",
      receivedAt,
      sseEventId: null,
    });
    if (record.kind === "source_only") {
      if (result.kind !== "source_only") {
        throw new Error(
          "Reingested source-only history record became canonical",
        );
      }
      continue;
    }
    if (result.kind !== "duplicate") {
      throw new Error(
        "Historical reingestion produced a new canonical outcome",
      );
    }
  }

  return hash(JSON.stringify(acceptedEvents));
}

const firstReduction = reduce(first.records);
const secondReduction = reduce(second.records);
if (firstReduction !== secondReduction) {
  throw new Error("Historical replay produced different canonical output");
}

process.stdout.write(
  `${JSON.stringify({
    canonicalHash: firstReduction,
    canonicalRecords: first.canonicalRecords.length,
    firstBodyHash: first.bodyHash,
    firstManifestHash: first.manifestHash,
    fixtureId,
    historicalPath,
    scheduleContextHash,
    scheduleStartEpochDay,
    secondBodyHash: second.bodyHash,
    secondManifestHash: second.manifestHash,
    sourceOnlyRecords: first.sourceOnlyRecords.length,
    sourceOnlyActions: [
      ...new Set(first.sourceOnlyRecords.map((record) => record.record.action)),
    ].sort(),
    terminal: {
      action: terminal.action,
      confirmed: terminal.confirmed,
      observedSeq: terminal.source.observedSeq,
      statusId: terminal.statusId,
    },
    totalRecords: first.records.length,
  })}\n`,
);
