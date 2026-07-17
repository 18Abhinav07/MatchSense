import {
  TxlineHttpError,
  VERIFIED_TXLINE_DEVNET_ENDPOINTS,
  type TxlineAuthenticatedClient,
} from "./client.js";
import { TxlineSseDecoder, type TxlineSseFrame } from "./live.js";

export type TxlineRawDelivery = "live" | "reconciliation";

export interface TxlineRawRecordMetadata {
  delivery: TxlineRawDelivery;
  receivedAt: string;
  requestedFixtureId: string | null;
  sourcePath: string;
  sseEventId: string | null;
}

export interface TxlineRawRecord {
  metadata: TxlineRawRecordMetadata;
  payload: unknown;
}

export type TxlineRawSourceStateName =
  | "authenticating"
  | "connecting"
  | "error"
  | "forbidden"
  | "live"
  | "reconnecting"
  | "reconciling"
  | "stopped"
  | "unauthorized";

export interface TxlineRawSourceState {
  attempt: number;
  state: TxlineRawSourceStateName;
}

export type TxlineRawSourceWarningCode =
  "cursor_conflict" | "invalid_sse_json" | "transport_error";

export interface TxlineRawSourceWarning {
  code: TxlineRawSourceWarningCode;
  message: string;
  state: TxlineRawSourceStateName;
}

export interface TxlineRawScoreSourceOptions {
  advanceCursor: (
    expected: string | null,
    next: string,
  ) => boolean | Promise<boolean>;
  client: TxlineAuthenticatedClient;
  fixtureIds: readonly string[];
  loadCursor: () => Promise<string | null>;
  now?: (() => string) | undefined;
  onRawRecord: (record: TxlineRawRecord) => void | Promise<void>;
  onState?: ((state: TxlineRawSourceState) => void) | undefined;
  onWarning?: ((warning: TxlineRawSourceWarning) => void) | undefined;
  random?: (() => number) | undefined;
  sleep?: ((delayMs: number, signal: AbortSignal) => Promise<void>) | undefined;
}

class TxlineCursorConflictError extends Error {
  override readonly name = "TxlineCursorConflictError";
}

function recordsFromJson(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  return [payload];
}

function parseFrame(frame: TxlineSseFrame) {
  if (
    frame.event === "heartbeat" ||
    frame.data.length === 0 ||
    frame.data === "[DONE]"
  ) {
    return [];
  }
  return recordsFromJson(JSON.parse(frame.data));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function defaultSleep(delayMs: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted || delayMs === 0) {
      resolve();
      return;
    }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    timer = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

async function framesFromResponse(response: Response) {
  const decoder = new TxlineSseDecoder();
  const body = await response.text();
  return [...decoder.push(body), ...decoder.finish()];
}

export function createTxlineRawScoreSource(
  options: TxlineRawScoreSourceOptions,
) {
  if (options.fixtureIds.length === 0) {
    throw new Error("At least one TxLINE fixture ID is required");
  }
  if (options.fixtureIds.some((fixtureId) => fixtureId.length === 0)) {
    throw new Error("TxLINE fixture IDs must not be empty");
  }
  const now = options.now ?? (() => new Date().toISOString());
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;
  let running = false;

  const state = (name: TxlineRawSourceStateName, attempt: number) => {
    options.onState?.({ attempt, state: name });
  };

  const isEventStream = (contentType: string) =>
    contentType.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream";
  const warn = (
    code: TxlineRawSourceWarningCode,
    message: string,
    currentState: TxlineRawSourceStateName,
  ) => options.onWarning?.({ code, message, state: currentState });
  const authenticationOptions = (attempt: number, signal: AbortSignal) => ({
    onAuthenticating: () => state("authenticating", attempt),
    signal,
  });

  const deliver = async (
    payload: unknown,
    metadata: Omit<TxlineRawRecordMetadata, "receivedAt">,
  ) => {
    await options.onRawRecord({
      metadata: { ...metadata, receivedAt: now() },
      payload,
    });
  };

  const reconcile = async (signal: AbortSignal, attempt: number) => {
    for (const fixtureId of options.fixtureIds) {
      if (signal.aborted) return;
      const path =
        VERIFIED_TXLINE_DEVNET_ENDPOINTS.historicalScorePath(fixtureId);
      let authenticationObserved = false;
      const response = await options.client.get(path, {
        accept: "text/event-stream, application/json",
        onAuthenticating: () => {
          authenticationObserved = true;
          state("authenticating", attempt);
        },
        signal,
      });
      if (authenticationObserved) state("reconciling", attempt);
      const contentType = response.headers.get("content-type") ?? "";
      if (isEventStream(contentType)) {
        for (const frame of await framesFromResponse(response)) {
          let payloads: unknown[];
          try {
            payloads = parseFrame(frame);
          } catch (error) {
            warn(
              "invalid_sse_json",
              `TxLINE historical SSE frame was invalid: ${errorMessage(error)}`,
              "reconciling",
            );
            continue;
          }
          for (const payload of payloads) {
            await deliver(payload, {
              delivery: "reconciliation",
              requestedFixtureId: fixtureId,
              sourcePath: path,
              sseEventId: frame.id,
            });
          }
        }
      } else {
        const payload: unknown = await response.json();
        for (const record of recordsFromJson(payload)) {
          await deliver(record, {
            delivery: "reconciliation",
            requestedFixtureId: fixtureId,
            sourcePath: path,
            sseEventId: null,
          });
        }
      }
    }
  };

  const consumeLiveStream = async (
    signal: AbortSignal,
    connectionAttempt: number,
    onValidatedLive: () => void,
  ) => {
    let cursor = await options.loadCursor();
    state("connecting", connectionAttempt);
    const path = VERIFIED_TXLINE_DEVNET_ENDPOINTS.scoresStreamPath;
    let authenticationObserved = false;
    const response = await options.client.get(path, {
      accept: "text/event-stream",
      lastEventId: cursor,
      onAuthenticating: () => {
        authenticationObserved = true;
        state("authenticating", connectionAttempt);
      },
      signal,
    });
    if (authenticationObserved) state("connecting", connectionAttempt);
    const contentType = response.headers.get("content-type") ?? "";
    if (!isEventStream(contentType)) {
      try {
        await response.body?.cancel();
      } catch (error) {
        warn(
          "transport_error",
          `TxLINE non-SSE response cancellation failed: ${errorMessage(error)}`,
          "error",
        );
      }
      throw new Error(
        "TxLINE scores stream requires Content-Type text/event-stream",
      );
    }
    if (!response.body)
      throw new Error("TxLINE scores stream returned no body");
    const decoder = new TxlineSseDecoder();
    const reader = response.body.getReader();
    const textDecoder = new TextDecoder();
    let validated = false;
    const markValidated = () => {
      if (validated) return;
      validated = true;
      state("live", connectionAttempt);
      onValidatedLive();
    };

    const consumeFrames = async (frames: readonly TxlineSseFrame[]) => {
      for (const frame of frames) {
        let payloads: unknown[];
        let validForHealth = false;
        try {
          payloads = parseFrame(frame);
          validForHealth =
            frame.event === "heartbeat" ||
            (frame.data.length > 0 && frame.data !== "[DONE]");
        } catch (error) {
          warn(
            "invalid_sse_json",
            `TxLINE live SSE frame was invalid: ${errorMessage(error)}`,
            validated ? "live" : "connecting",
          );
          payloads = [];
        }
        for (const payload of payloads) {
          if (signal.aborted) return;
          await deliver(payload, {
            delivery: "live",
            requestedFixtureId: null,
            sourcePath: path,
            sseEventId: frame.id,
          });
        }
        if (signal.aborted) return;
        if (frame.id !== null && frame.id !== cursor) {
          const advanced = await options.advanceCursor(cursor, frame.id);
          if (!advanced) {
            warn(
              "cursor_conflict",
              `TxLINE cursor changed before ${frame.id} could be committed`,
              "live",
            );
            throw new TxlineCursorConflictError(
              `TxLINE cursor compare-and-set failed for ${frame.id}`,
            );
          }
          cursor = frame.id;
        }
        if (validForHealth) markValidated();
      }
    };

    try {
      while (!signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) break;
        await consumeFrames(
          decoder.push(textDecoder.decode(chunk.value, { stream: true })),
        );
      }
      if (!signal.aborted) await consumeFrames(decoder.finish());
      if (!signal.aborted) throw new Error("TxLINE scores stream ended");
    } finally {
      try {
        await reader.cancel();
      } catch (error) {
        warn(
          "transport_error",
          `TxLINE stream reader cancellation failed: ${errorMessage(error)}`,
          "error",
        );
      }
      try {
        reader.releaseLock();
      } catch (error) {
        warn(
          "transport_error",
          `TxLINE stream reader release failed: ${errorMessage(error)}`,
          "error",
        );
      }
    }
  };

  return {
    async run(signal: AbortSignal) {
      if (running) throw new Error("TxLINE raw source is already running");
      running = true;
      let attempt = 0;
      try {
        while (!signal.aborted) {
          try {
            await options.client.prepare(
              authenticationOptions(attempt, signal),
            );
            state("reconciling", attempt);
            await reconcile(signal, attempt);
            if (signal.aborted) break;
            await consumeLiveStream(signal, attempt, () => {
              attempt = 0;
            });
            if (signal.aborted) break;
          } catch (error) {
            if (signal.aborted) break;
            if (error instanceof TxlineHttpError && error.status === 401) {
              state("unauthorized", attempt);
              throw error;
            }
            if (error instanceof TxlineHttpError && error.status === 403) {
              state("forbidden", attempt);
              throw error;
            }
            state("error", attempt);
            warn("transport_error", errorMessage(error), "error");
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
