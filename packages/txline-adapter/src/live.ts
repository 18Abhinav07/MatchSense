import { createHash } from "node:crypto";

export const VERIFIED_TXLINE_DEVNET_ENDPOINTS = {
  guestSessionPath: "/auth/guest/start",
  historicalScorePath: (fixtureId: string) =>
    `/api/scores/historical/${encodeURIComponent(fixtureId)}`,
  origin: "https://txline-dev.txodds.com",
  scoresStreamPath: "/api/scores/stream",
} as const;

export type TxlineDataProvenance =
  "live_txline" | "recorded_txline_authorised" | "synthetic_txline_shaped";

export type TxlineDelivery = "live" | "reconciliation" | "replay";

export type TxlineKnownAction =
  | "action_amend"
  | "action_discarded"
  | "comment"
  | "free_kick"
  | "game_finalised"
  | "goal"
  | "halftime_finalised"
  | "penalty"
  | "score_adjustment"
  | "shot"
  | "substitution"
  | "var"
  | "var_end";

const KNOWN_ACTIONS = new Set<TxlineKnownAction>([
  "action_amend",
  "action_discarded",
  "comment",
  "free_kick",
  "game_finalised",
  "goal",
  "halftime_finalised",
  "penalty",
  "score_adjustment",
  "shot",
  "substitution",
  "var",
  "var_end",
]);

export interface TxlineFixtureContext {
  fixtureId: string;
  participant1: { id: string; name: string };
  participant2: { id: string; name: string };
  participant1IsHome: boolean;
}

export interface TxlineFixtureMetadata extends TxlineFixtureContext {
  competition: string | null;
  fixtureGroup: string | null;
  gameState: string | null;
  startTimeMs: number;
}

export interface TxlineSourceReference {
  actionId: string | null;
  observedSeq: string | null;
  payloadHash: string;
  sseEventId: string | null;
  sourceTimestampMs: number | null;
}

export interface TxlineNormalizedUpdate {
  action: TxlineKnownAction;
  actionId: string | null;
  clockSeconds: number | null;
  confirmed: boolean | null;
  delivery: TxlineDelivery;
  fixtureId: string;
  participant: 1 | 2 | null;
  participantScore: {
    participant1: number;
    participant2: number;
  } | null;
  playerId: string | null;
  provenance: TxlineDataProvenance;
  receivedAt: string;
  score: { away: number; home: number } | null;
  source: TxlineSourceReference;
  statusId: number | null;
}

export interface TxlineCanonicalEvent extends TxlineNormalizedUpdate {
  revision: number;
  supersedesRevision: number | null;
}

export type TxlineWarningCode =
  | "invalid_fixture_metadata"
  | "invalid_record"
  | "invalid_score_shape"
  | "invalid_sse_json"
  | "missing_fixture_context"
  | "out_of_order_sequence"
  | "unsupported_action";

export interface TxlineWarning {
  code: TxlineWarningCode;
  fixtureId: string | null;
  message: string;
  observedSeq: string | null;
  sseEventId: string | null;
}

export type TxlineNormalizeResult =
  | { kind: "supported"; update: TxlineNormalizedUpdate }
  | { kind: "unsupported"; warning: TxlineWarning };

export type TxlineCanonicalizeResult =
  | { event: TxlineCanonicalEvent; kind: "accepted" }
  | { kind: "duplicate" }
  | { kind: "out_of_order"; warning: TxlineWarning }
  | { kind: "unsupported"; warning: TxlineWarning };

export interface TxlineSseFrame {
  data: string;
  event: string | null;
  id: string | null;
}

export type TxlineSourceStateName =
  | "authenticating"
  | "connecting"
  | "forbidden"
  | "live"
  | "reconnecting"
  | "reconciling"
  | "replay"
  | "stopped";

export interface TxlineSourceState {
  attempt: number;
  state: TxlineSourceStateName;
}

export interface TxlineNormalizeMetadata {
  delivery: TxlineDelivery;
  fixtureContext?: TxlineFixtureContext | undefined;
  provenance: TxlineDataProvenance;
  receivedAt: string;
  sseEventId: string | null;
}

export interface TxlineCanonicalizerOptions {
  fixtureContexts?: readonly TxlineFixtureContext[] | undefined;
}

export interface TxlineCanonicalAcceptMetadata extends Omit<
  TxlineNormalizeMetadata,
  "fixtureContext"
> {}

export interface TxlineReplayRecord {
  payload: unknown;
  receivedAt: string;
  sseEventId?: string | null | undefined;
}

export interface TxlineReplaySourceOptions {
  fixtures?: readonly TxlineFixtureContext[] | undefined;
  onEvent: (event: TxlineCanonicalEvent) => void | Promise<void>;
  onState?: ((state: TxlineSourceState) => void) | undefined;
  onWarning?: ((warning: TxlineWarning) => void) | undefined;
  provenance: Exclude<TxlineDataProvenance, "live_txline">;
  records: readonly TxlineReplayRecord[];
}

export interface TxlineLiveSourceOptions {
  apiToken: string;
  fetchImpl?: typeof fetch | undefined;
  fixtures: readonly TxlineFixtureContext[];
  now?: (() => string) | undefined;
  onEvent: (event: TxlineCanonicalEvent) => void | Promise<void>;
  onState?: ((state: TxlineSourceState) => void) | undefined;
  onWarning?: ((warning: TxlineWarning) => void) | undefined;
  random?: (() => number) | undefined;
  sleep?: ((delayMs: number, signal: AbortSignal) => Promise<void>) | undefined;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pick(object: JsonObject | null, ...keys: readonly string[]) {
  if (!object) return undefined;
  for (const key of keys) {
    if (Object.hasOwn(object, key)) return object[key];
  }
  return undefined;
}

function asIdentifier(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }
  return null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function asOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function stableJson(value: unknown): string | undefined {
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
    return `[${value.map((entry) => stableJson(entry) ?? "null").join(",")}]`;
  }
  if (isObject(value)) {
    const entries = Object.keys(value)
      .sort()
      .flatMap((key) => {
        const serialized = stableJson(value[key]);
        return serialized === undefined
          ? []
          : [`${JSON.stringify(key)}:${serialized}`];
      });
    return `{${entries.join(",")}}`;
  }
  return undefined;
}

function hashPayload(payload: unknown) {
  return createHash("sha256")
    .update(stableJson(payload) ?? "null")
    .digest("hex");
}

function unwrapUpdate(payload: unknown): unknown {
  if (!isObject(payload)) return payload;
  return pick(payload, "Update", "update") ?? payload;
}

function warning(input: {
  code: TxlineWarningCode;
  fixtureId?: string | null | undefined;
  message: string;
  observedSeq?: string | null | undefined;
  sseEventId?: string | null | undefined;
}): TxlineWarning {
  return {
    code: input.code,
    fixtureId: input.fixtureId ?? null,
    message: input.message,
    observedSeq: input.observedSeq ?? null,
    sseEventId: input.sseEventId ?? null,
  };
}

export function adaptTxlineFixtureMetadata(
  payload: unknown,
): TxlineFixtureMetadata | null {
  if (!isObject(payload)) return null;
  const fixtureId = asIdentifier(pick(payload, "FixtureId", "fixtureId"));
  const participant1Id = asIdentifier(
    pick(payload, "Participant1Id", "participant1Id"),
  );
  const participant2Id = asIdentifier(
    pick(payload, "Participant2Id", "participant2Id"),
  );
  const participant1Name = asOptionalString(
    pick(payload, "Participant1", "participant1"),
  );
  const participant2Name = asOptionalString(
    pick(payload, "Participant2", "participant2"),
  );
  const participant1IsHome = pick(
    payload,
    "Participant1IsHome",
    "participant1IsHome",
  );
  const startTimeMs = asFiniteNumber(pick(payload, "StartTime", "startTime"));
  if (
    fixtureId === null ||
    participant1Id === null ||
    participant2Id === null ||
    participant1Name === null ||
    participant2Name === null ||
    typeof participant1IsHome !== "boolean" ||
    startTimeMs === null
  ) {
    return null;
  }

  const gameState = pick(payload, "GameState", "gameState");
  return {
    competition: asOptionalString(pick(payload, "Competition", "competition")),
    fixtureGroup: asOptionalString(
      pick(payload, "FixtureGroup", "fixtureGroup"),
    ),
    fixtureId,
    gameState:
      typeof gameState === "string" || typeof gameState === "number"
        ? String(gameState)
        : null,
    participant1: { id: participant1Id, name: participant1Name },
    participant1IsHome,
    participant2: { id: participant2Id, name: participant2Name },
    startTimeMs,
  };
}

function participantScoreOf(
  record: JsonObject,
): { participant1: number; participant2: number } | null | "invalid" {
  const score = pick(record, "Score", "score");
  if (score === undefined || score === null) return null;
  if (!isObject(score)) return "invalid";
  const participant1 = pick(score, "Participant1", "participant1");
  const participant2 = pick(score, "Participant2", "participant2");
  if (!isObject(participant1) || !isObject(participant2)) return "invalid";
  const participant1Total = pick(participant1, "Total", "total");
  const participant2Total = pick(participant2, "Total", "total");
  if (!isObject(participant1Total) || !isObject(participant2Total)) {
    return "invalid";
  }
  const participant1Goals = pick(participant1Total, "Goals", "goals") ?? 0;
  const participant2Goals = pick(participant2Total, "Goals", "goals") ?? 0;
  const first = asNonNegativeInteger(participant1Goals);
  const second = asNonNegativeInteger(participant2Goals);
  return first === null || second === null
    ? "invalid"
    : { participant1: first, participant2: second };
}

function knownAction(value: unknown): TxlineKnownAction | null {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase();
  return KNOWN_ACTIONS.has(normalized as TxlineKnownAction)
    ? (normalized as TxlineKnownAction)
    : null;
}

export function normalizeTxlineScoreUpdate(
  payload: unknown,
  metadata: TxlineNormalizeMetadata,
): TxlineNormalizeResult {
  const unwrapped = unwrapUpdate(payload);
  if (!isObject(unwrapped)) {
    return {
      kind: "unsupported",
      warning: warning({
        code: "invalid_record",
        message: "TxLINE score update is not an object",
        sseEventId: metadata.sseEventId,
      }),
    };
  }

  const fixtureId = asIdentifier(pick(unwrapped, "FixtureId", "fixtureId"));
  const observedSeq = asIdentifier(pick(unwrapped, "Seq", "seq"));
  if (fixtureId === null) {
    return {
      kind: "unsupported",
      warning: warning({
        code: "invalid_record",
        message: "TxLINE score update has no verified fixture identifier",
        observedSeq,
        sseEventId: metadata.sseEventId,
      }),
    };
  }

  const actionValue = pick(unwrapped, "Action", "action");
  const action = knownAction(actionValue);
  if (action === null) {
    return {
      kind: "unsupported",
      warning: warning({
        code: "unsupported_action",
        fixtureId,
        message: `Unsupported TxLINE action ${String(actionValue ?? "<missing>")}`,
        observedSeq,
        sseEventId: metadata.sseEventId,
      }),
    };
  }

  const participantScore = participantScoreOf(unwrapped);
  if (
    participantScore === "invalid" ||
    (action === "goal" && participantScore === null)
  ) {
    return {
      kind: "unsupported",
      warning: warning({
        code: "invalid_score_shape",
        fixtureId,
        message:
          "TxLINE score update lacks both participant Total objects with valid goal counts",
        observedSeq,
        sseEventId: metadata.sseEventId,
      }),
    };
  }

  const context = metadata.fixtureContext;
  const score =
    participantScore !== null && context?.fixtureId === fixtureId
      ? context.participant1IsHome
        ? {
            away: participantScore.participant2,
            home: participantScore.participant1,
          }
        : {
            away: participantScore.participant1,
            home: participantScore.participant2,
          }
      : null;
  const confirmed = pick(unwrapped, "Confirmed", "confirmed");
  const participantValue = pick(unwrapped, "Participant", "participant");
  const clock = pick(unwrapped, "Clock", "clock");
  const data = pick(unwrapped, "Data", "data");
  const sourceTimestampMs = asFiniteNumber(pick(unwrapped, "Ts", "ts"));
  const statusId = asFiniteNumber(pick(unwrapped, "StatusId", "statusId"));

  return {
    kind: "supported",
    update: {
      action,
      actionId: asIdentifier(pick(unwrapped, "Id", "id")),
      clockSeconds: isObject(clock)
        ? asNonNegativeInteger(pick(clock, "Seconds", "seconds"))
        : null,
      confirmed: typeof confirmed === "boolean" ? confirmed : null,
      delivery: metadata.delivery,
      fixtureId,
      participant:
        participantValue === 1 || participantValue === 2
          ? participantValue
          : null,
      participantScore,
      playerId: isObject(data)
        ? asIdentifier(pick(data, "PlayerId", "playerId"))
        : null,
      provenance: metadata.provenance,
      receivedAt: metadata.receivedAt,
      score,
      source: {
        actionId: asIdentifier(pick(unwrapped, "Id", "id")),
        observedSeq,
        payloadHash: hashPayload(unwrapped),
        sseEventId: metadata.sseEventId,
        sourceTimestampMs,
      },
      statusId,
    },
  };
}

function parseSseBlock(block: string): TxlineSseFrame | null {
  let data = "";
  let event: string | null = null;
  let id: string | null = null;
  for (const line of block.replaceAll("\r\n", "\n").split("\n")) {
    if (line.length === 0 || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const rawValue = colon === -1 ? "" : line.slice(colon + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "data") data += `${data.length === 0 ? "" : "\n"}${value}`;
    if (field === "event") event = value;
    if (field === "id" && !value.includes("\0")) id = value;
  }
  return data.length > 0 || event !== null || id !== null
    ? { data, event, id }
    : null;
}

export class TxlineSseDecoder {
  private buffer = "";

  push(chunk: string): TxlineSseFrame[] {
    this.buffer += chunk;
    const frames: TxlineSseFrame[] = [];
    while (true) {
      const boundary = /\r?\n\r?\n/.exec(this.buffer);
      if (!boundary || boundary.index === undefined) break;
      const block = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
      const frame = parseSseBlock(block);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  finish(): TxlineSseFrame[] {
    if (this.buffer.length === 0) return [];
    const frame = parseSseBlock(this.buffer);
    this.buffer = "";
    return frame ? [frame] : [];
  }
}

function recordsFromParsedJson(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (!isObject(parsed)) return [parsed];
  for (const key of [
    "events",
    "Events",
    "data",
    "Data",
    "items",
    "Items",
  ] as const) {
    if (Array.isArray(parsed[key])) return parsed[key];
  }
  return [parsed];
}

function parseFrameData(frame: TxlineSseFrame): unknown[] {
  if (frame.data.length === 0 || frame.data === "[DONE]") return [];
  return recordsFromParsedJson(JSON.parse(frame.data));
}

export function decodeTxlineRecordBody(body: string): unknown[] {
  const trimmed = body.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    return recordsFromParsedJson(JSON.parse(trimmed));
  }
  const decoder = new TxlineSseDecoder();
  return [...decoder.push(body), ...decoder.finish()].flatMap(parseFrameData);
}

function numericSequence(value: string | null): bigint | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

export function createTxlineOrderedCanonicalizer(
  options: TxlineCanonicalizerOptions = {},
) {
  const contexts = new Map(
    (options.fixtureContexts ?? []).map((context) => [
      context.fixtureId,
      context,
    ]),
  );
  const seen = new Set<string>();
  const fixtureState = new Map<
    string,
    {
      actionRevisions: Map<string, number>;
      lastNumericSeq: bigint | null;
      revision: number;
    }
  >();

  return {
    accept(
      payload: unknown,
      metadata: TxlineCanonicalAcceptMetadata,
    ): TxlineCanonicalizeResult {
      const unwrapped = unwrapUpdate(payload);
      const fixtureId = isObject(unwrapped)
        ? asIdentifier(pick(unwrapped, "FixtureId", "fixtureId"))
        : null;
      const normalized = normalizeTxlineScoreUpdate(payload, {
        ...metadata,
        fixtureContext:
          fixtureId === null ? undefined : contexts.get(fixtureId),
      });
      if (normalized.kind === "unsupported") return normalized;

      const update = normalized.update;
      const dedupeKey = [
        update.fixtureId,
        update.source.observedSeq ?? "<no-seq>",
        update.source.payloadHash,
      ].join("\0");
      if (seen.has(dedupeKey)) return { kind: "duplicate" };

      const current = fixtureState.get(update.fixtureId) ?? {
        actionRevisions: new Map<string, number>(),
        lastNumericSeq: null,
        revision: 0,
      };
      const incomingNumericSeq = numericSequence(update.source.observedSeq);
      if (
        incomingNumericSeq !== null &&
        current.lastNumericSeq !== null &&
        incomingNumericSeq < current.lastNumericSeq
      ) {
        seen.add(dedupeKey);
        return {
          kind: "out_of_order",
          warning: warning({
            code: "out_of_order_sequence",
            fixtureId: update.fixtureId,
            message: `TxLINE sequence ${update.source.observedSeq} is older than the applied fixture cursor`,
            observedSeq: update.source.observedSeq,
            sseEventId: update.source.sseEventId,
          }),
        };
      }

      seen.add(dedupeKey);
      const revision = current.revision + 1;
      const actionFamily =
        update.actionId === null
          ? null
          : `${update.fixtureId}:action:${update.actionId}`;
      const supersedesRevision =
        actionFamily === null
          ? null
          : (current.actionRevisions.get(actionFamily) ?? null);
      if (actionFamily !== null) {
        current.actionRevisions.set(actionFamily, revision);
      }
      current.revision = revision;
      if (
        incomingNumericSeq !== null &&
        (current.lastNumericSeq === null ||
          incomingNumericSeq > current.lastNumericSeq)
      ) {
        current.lastNumericSeq = incomingNumericSeq;
      }
      fixtureState.set(update.fixtureId, current);

      return {
        event: { ...update, revision, supersedesRevision },
        kind: "accepted",
      };
    },
  };
}

export class TxlineHttpError extends Error {
  override readonly name = "TxlineHttpError";

  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    super(`TxLINE ${path} returned HTTP ${status}`);
  }
}

function defaultSleep(delayMs: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted || delayMs === 0) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function sortRecoveryRecords(records: readonly unknown[]) {
  return records
    .map((payload, index) => {
      const unwrapped = unwrapUpdate(payload);
      const sequence = isObject(unwrapped)
        ? numericSequence(asIdentifier(pick(unwrapped, "Seq", "seq")))
        : null;
      return { index, payload, sequence };
    })
    .sort((left, right) => {
      if (left.sequence === null || right.sequence === null) {
        return left.index - right.index;
      }
      return left.sequence < right.sequence
        ? -1
        : left.sequence > right.sequence
          ? 1
          : left.index - right.index;
    })
    .map(({ payload }) => payload);
}

export function createTxlineLiveScoreSource(options: TxlineLiveSourceOptions) {
  if (options.apiToken.trim().length === 0) {
    throw new Error("TxLINE API token is required");
  }
  if (options.fixtures.length === 0) {
    throw new Error("At least one verified TxLINE fixture context is required");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date().toISOString());
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;
  const canonicalizer = createTxlineOrderedCanonicalizer({
    fixtureContexts: options.fixtures,
  });
  let running = false;

  const state = (name: TxlineSourceStateName, attempt: number) =>
    options.onState?.({ attempt, state: name });

  const publish = async (
    payload: unknown,
    metadata: TxlineCanonicalAcceptMetadata,
  ) => {
    const result = canonicalizer.accept(payload, metadata);
    if (result.kind === "accepted") await options.onEvent(result.event);
    if (result.kind === "out_of_order" || result.kind === "unsupported") {
      options.onWarning?.(result.warning);
    }
  };

  return {
    async run(signal: AbortSignal) {
      if (running) throw new Error("TxLINE live source is already running");
      running = true;
      let attempt = 0;
      let guestJwt: string | null = null;
      let lastEventId: string | null = null;

      const authenticate = async () => {
        state("authenticating", attempt);
        const response = await fetchImpl(
          `${VERIFIED_TXLINE_DEVNET_ENDPOINTS.origin}${VERIFIED_TXLINE_DEVNET_ENDPOINTS.guestSessionPath}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal,
          },
        );
        if (!response.ok) {
          throw new TxlineHttpError(
            response.status,
            VERIFIED_TXLINE_DEVNET_ENDPOINTS.guestSessionPath,
          );
        }
        const body: unknown = await response.json();
        const token = isObject(body) ? body.token : null;
        if (typeof token !== "string" || token.length === 0) {
          throw new Error("TxLINE guest session returned no JWT");
        }
        guestJwt = token;
      };

      const authenticatedGet = async (
        path: string,
        cursor: string | null = null,
      ) => {
        if (guestJwt === null) await authenticate();
        const request = () => {
          const headers = new Headers({
            Accept: "text/event-stream, application/json",
            Authorization: `Bearer ${guestJwt ?? ""}`,
            "X-Api-Token": options.apiToken,
          });
          if (cursor !== null) headers.set("Last-Event-ID", cursor);
          return fetchImpl(
            `${VERIFIED_TXLINE_DEVNET_ENDPOINTS.origin}${path}`,
            { headers, signal },
          );
        };
        let response = await request();
        if (response.status === 401) {
          guestJwt = null;
          await authenticate();
          response = await request();
        }
        if (!response.ok) throw new TxlineHttpError(response.status, path);
        return response;
      };

      try {
        while (!signal.aborted) {
          try {
            state("reconciling", attempt);
            for (const fixture of options.fixtures) {
              const path = VERIFIED_TXLINE_DEVNET_ENDPOINTS.historicalScorePath(
                fixture.fixtureId,
              );
              const response = await authenticatedGet(path);
              const records = sortRecoveryRecords(
                decodeTxlineRecordBody(await response.text()),
              );
              for (const payload of records) {
                await publish(payload, {
                  delivery: "reconciliation",
                  provenance: "live_txline",
                  receivedAt: now(),
                  sseEventId: null,
                });
                if (signal.aborted) break;
              }
              if (signal.aborted) break;
            }
            if (signal.aborted) break;

            state("connecting", attempt);
            const response = await authenticatedGet(
              VERIFIED_TXLINE_DEVNET_ENDPOINTS.scoresStreamPath,
              lastEventId,
            );
            if (!response.body) {
              throw new Error("TxLINE scores stream returned no body");
            }
            state("live", attempt);
            attempt = 0;
            const decoder = new TxlineSseDecoder();
            const reader = response.body.getReader();
            const textDecoder = new TextDecoder();

            const consume = async (frames: readonly TxlineSseFrame[]) => {
              for (const frame of frames) {
                if (frame.id !== null) lastEventId = frame.id;
                if (
                  frame.event === "heartbeat" ||
                  frame.data.length === 0 ||
                  frame.data === "[DONE]"
                ) {
                  continue;
                }
                let payloads: unknown[];
                try {
                  payloads = recordsFromParsedJson(JSON.parse(frame.data));
                } catch {
                  options.onWarning?.(
                    warning({
                      code: "invalid_sse_json",
                      message: "TxLINE SSE frame contained invalid JSON",
                      sseEventId: frame.id,
                    }),
                  );
                  continue;
                }
                for (const payload of payloads) {
                  await publish(payload, {
                    delivery: "live",
                    provenance: "live_txline",
                    receivedAt: now(),
                    sseEventId: frame.id,
                  });
                  if (signal.aborted) return;
                }
              }
            };

            while (!signal.aborted) {
              const chunk = await reader.read();
              if (chunk.done) break;
              await consume(
                decoder.push(textDecoder.decode(chunk.value, { stream: true })),
              );
            }
            if (!signal.aborted) await consume(decoder.finish());
          } catch (error) {
            if (signal.aborted) break;
            if (error instanceof TxlineHttpError && error.status === 403) {
              state("forbidden", attempt);
              throw error;
            }
            if (error instanceof TxlineHttpError && error.status === 401) {
              throw error;
            }
          }

          if (signal.aborted) break;
          attempt += 1;
          state("reconnecting", attempt);
          const maximumDelayMs = Math.min(30_000, 500 * 2 ** (attempt - 1));
          await sleep(Math.floor(random() * maximumDelayMs), signal);
        }
      } finally {
        running = false;
        state("stopped", attempt);
      }
    },
  };
}

export function createTxlineReplaySource(options: TxlineReplaySourceOptions) {
  const canonicalizer = createTxlineOrderedCanonicalizer({
    fixtureContexts: options.fixtures,
  });
  let running = false;

  return {
    async run(signal: AbortSignal) {
      if (running) throw new Error("TxLINE replay source is already running");
      running = true;
      options.onState?.({ attempt: 0, state: "replay" });
      try {
        for (const record of options.records) {
          if (signal.aborted) break;
          const result = canonicalizer.accept(record.payload, {
            delivery: "replay",
            provenance: options.provenance,
            receivedAt: record.receivedAt,
            sseEventId: record.sseEventId ?? null,
          });
          if (result.kind === "accepted") await options.onEvent(result.event);
          if (result.kind === "out_of_order" || result.kind === "unsupported") {
            options.onWarning?.(result.warning);
          }
        }
      } finally {
        running = false;
        options.onState?.({ attempt: 0, state: "stopped" });
      }
    },
  };
}
