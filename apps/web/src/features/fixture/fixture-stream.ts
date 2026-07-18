import type {
  CanonicalEventPayload,
  CatchupEventPayload,
  CommentaryEventPayload,
  LiveSnapshot,
} from "../../product-state.js";
import {
  parseCanonicalEvent,
  parseCatchupEvent,
  parseCommentaryEvent,
  parseSnapshotEvent,
} from "../../live-api.js";

export interface FixtureStreamHandlers {
  onCanonicalEvent(payload: CanonicalEventPayload): void;
  onCatchup(payload: CatchupEventPayload): void;
  onCommentary(payload: CommentaryEventPayload): void;
  onReset(): void;
  onSnapshot(snapshot: LiveSnapshot, sequence?: number): void;
  onTransportError(): void;
}

export interface FixtureEventSourceLike {
  addEventListener(
    type: string,
    listener: (event: MessageEvent<string>) => void,
  ): void;
  close(): void;
  onerror: ((event: Event) => void) | null;
}

export interface FixtureStreamSubscription {
  close(): void;
}

export interface FixtureStreamPort {
  subscribe(input: {
    afterSequence: number | null;
    fixtureId: string;
    handlers: FixtureStreamHandlers;
  }): FixtureStreamSubscription;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function safeJson(value: string): JsonRecord | null {
  try {
    return record(JSON.parse(value));
  } catch {
    return null;
  }
}

function safeSequence(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function unwrapDurableEvent(value: string) {
  const outer = safeJson(value);
  if (!outer) return null;
  const event = record(outer.event);
  const payload = event?.payload ?? outer;
  return {
    payload: JSON.stringify(payload),
    sequence: safeSequence(event?.sequence),
  };
}

function browserEventSource(url: string): FixtureEventSourceLike {
  return new EventSource(url, {
    withCredentials: true,
  }) as unknown as FixtureEventSourceLike;
}

export function createFixtureEventSourceStream(
  options: {
    eventSourceFactory?: ((url: string) => FixtureEventSourceLike) | undefined;
  } = {},
): FixtureStreamPort {
  const eventSourceFactory = options.eventSourceFactory ?? browserEventSource;
  return {
    subscribe: ({ afterSequence, fixtureId, handlers }) => {
      let firstSnapshot = true;
      let reconcileThrough: number | null = null;
      let lastDeliveredSequence = afterSequence ?? 0;
      const query =
        afterSequence === null
          ? ""
          : `?after=${encodeURIComponent(String(afterSequence))}`;
      const source = eventSourceFactory(
        `/api/v1/fixtures/${encodeURIComponent(fixtureId)}/stream${query}`,
      );
      const fail = () => handlers.onTransportError();
      const reset = () => {
        fail();
        handlers.onReset();
      };
      const canApplySequence = (sequence: number | undefined) => {
        if (sequence === undefined) {
          reset();
          return false;
        }
        if (sequence <= lastDeliveredSequence) return false;
        if (sequence !== lastDeliveredSequence + 1) {
          reset();
          return false;
        }
        return true;
      };
      const snapshot = (event: MessageEvent<string>) => {
        try {
          const envelope = safeJson(event.data);
          const highWaterSequence = safeSequence(envelope?.highWaterSequence);
          if (highWaterSequence === undefined) {
            const durable = unwrapDurableEvent(event.data);
            if (!durable || !canApplySequence(durable.sequence)) return;
            const parsed = parseSnapshotEvent(durable.payload);
            if (!parsed || durable.sequence === undefined) return reset();
            lastDeliveredSequence = durable.sequence;
            handlers.onSnapshot(parsed, durable.sequence);
            return;
          }
          const parsed = parseSnapshotEvent(event.data);
          if (!parsed) return fail();
          const appliedSequence =
            firstSnapshot && afterSequence !== null
              ? afterSequence
              : firstSnapshot
                ? highWaterSequence
                : lastDeliveredSequence;
          if (
            appliedSequence !== undefined &&
            appliedSequence < highWaterSequence
          ) {
            reconcileThrough = highWaterSequence;
          }
          if (appliedSequence !== undefined) {
            lastDeliveredSequence = appliedSequence;
          }
          firstSnapshot = false;
          handlers.onSnapshot(parsed, appliedSequence);
        } catch {
          fail();
        }
      };
      source.addEventListener("snapshot", snapshot);
      source.addEventListener("stream.reset", (event) => {
        try {
          const parsed = parseSnapshotEvent(event.data);
          const envelope = safeJson(event.data);
          const highWaterSequence = safeSequence(envelope?.highWaterSequence);
          if (!parsed || highWaterSequence === undefined) return fail();
          firstSnapshot = false;
          reconcileThrough = null;
          lastDeliveredSequence = highWaterSequence;
          handlers.onSnapshot(parsed, highWaterSequence);
        } catch {
          return fail();
        }
        handlers.onReset();
      });
      for (const type of ["moment.created", "moment.revised"]) {
        source.addEventListener(type, (event) => {
          const durable = unwrapDurableEvent(event.data);
          if (!durable) return fail();
          try {
            const parsed = parseCanonicalEvent(durable.payload);
            if (!parsed) return fail();
            if (!canApplySequence(durable.sequence)) return;
            const historical =
              durable.sequence !== undefined &&
              reconcileThrough !== null &&
              durable.sequence <= reconcileThrough;
            handlers.onCanonicalEvent({
              ...parsed,
              deliveryIntent: historical ? "reconcile" : "realtime",
              ...(durable.sequence === undefined
                ? {}
                : { sequence: durable.sequence }),
            });
            if (durable.sequence !== undefined) {
              lastDeliveredSequence = durable.sequence;
            }
          } catch {
            fail();
          }
        });
      }
      source.addEventListener("commentary.ready", (event) => {
        const durable = unwrapDurableEvent(event.data);
        if (!durable) return fail();
        try {
          const parsed = parseCommentaryEvent(durable.payload);
          if (!parsed || !canApplySequence(durable.sequence)) return;
          handlers.onCommentary({
            ...parsed,
            ...(durable.sequence === undefined
              ? {}
              : { sequence: durable.sequence }),
          });
          if (durable.sequence !== undefined) {
            lastDeliveredSequence = durable.sequence;
          }
        } catch {
          return fail();
        }
      });
      source.addEventListener("catchup.ready", (event) => {
        const durable = unwrapDurableEvent(event.data);
        if (!durable) return fail();
        try {
          const parsed = parseCatchupEvent(durable.payload);
          if (!parsed || !canApplySequence(durable.sequence)) return;
          handlers.onCatchup({
            ...parsed,
            ...(durable.sequence === undefined
              ? {}
              : { sequence: durable.sequence }),
          });
          if (durable.sequence !== undefined) {
            lastDeliveredSequence = durable.sequence;
          }
        } catch {
          return fail();
        }
      });
      source.onerror = fail;
      return { close: () => source.close() };
    },
  };
}

/**
 * The Match Hub consumes this narrow port rather than constructing synthetic
 * events locally. Tests may inject this honest unavailable port when a browser
 * has no EventSource capability.
 */
export function unavailableFixtureStream(): FixtureStreamPort {
  return {
    subscribe: ({ handlers }) => {
      queueMicrotask(() => handlers.onTransportError());
      return { close: () => undefined };
    },
  };
}
