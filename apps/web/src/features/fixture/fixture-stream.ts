import type {
  CanonicalEventPayload,
  CatchupEventPayload,
  CommentaryEventPayload,
  LiveSnapshot,
} from "../../product-state.js";

export interface FixtureStreamHandlers {
  onCanonicalEvent(payload: CanonicalEventPayload): void;
  onCatchup(payload: CatchupEventPayload): void;
  onCommentary(payload: CommentaryEventPayload): void;
  onReset(): void;
  onSnapshot(snapshot: LiveSnapshot): void;
  onTransportError(): void;
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

/**
 * The Match Hub consumes this narrow port rather than constructing synthetic
 * events locally. The API-backed EventSource implementation lands with the
 * durable fixture stream routes; tests can inject this port immediately.
 */
export function unavailableFixtureStream(): FixtureStreamPort {
  return {
    subscribe: ({ handlers }) => {
      queueMicrotask(() => handlers.onTransportError());
      return { close: () => undefined };
    },
  };
}
