import { describe, expect, it, vi } from "vitest";

import { createFixtureEventSourceStream } from "./fixture-stream.js";

class FakeEventSource {
  closed = false;
  onerror: (() => void) | null = null;
  readonly listeners = new Map<string, (event: MessageEvent<string>) => void>();

  addEventListener(
    type: string,
    listener: (event: MessageEvent<string>) => void,
  ) {
    this.listeners.set(type, listener);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, payload: unknown) {
    this.listeners.get(type)?.({
      data: JSON.stringify(payload),
    } as MessageEvent<string>);
  }
}

const snapshot = {
  awayTeam: "FRA",
  fixtureId: "fx-1",
  freshness: "live",
  homeTeam: "ARG",
  lifecycle: "LIVE",
  minute: "23′",
  provenance: "live_txline",
  score: { away: 0, home: 1 },
};

describe("fixture EventSource stream", () => {
  it("parses real snapshot and canonical event envelopes with durable sequence", () => {
    const source = new FakeEventSource();
    let openedUrl = "";
    const onSnapshot = vi.fn();
    const onCanonicalEvent = vi.fn();
    const onReset = vi.fn();
    const onTransportError = vi.fn();
    const stream = createFixtureEventSourceStream({
      eventSourceFactory: (url) => {
        openedUrl = url;
        return source;
      },
    });

    const subscription = stream.subscribe({
      afterSequence: 0,
      fixtureId: "fx-1",
      handlers: {
        onCanonicalEvent,
        onCatchup: vi.fn(),
        onCommentary: vi.fn(),
        onReset,
        onSnapshot,
        onTransportError,
      },
    });

    expect(openedUrl).toBe("/api/v1/fixtures/fx-1/stream?after=0");
    source.emit("snapshot", { highWaterSequence: 4, snapshot });
    expect(onSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ fixtureId: "fx-1" }),
      0,
    );

    for (const sequence of [1, 2, 3]) {
      source.emit("snapshot", {
        event: {
          eventType: "snapshot",
          payload: {
            event: "snapshot",
            id: `snapshot-${sequence}`,
            snapshot: { ...snapshot, minute: `${sequence}′` },
          },
          sequence,
        },
      });
    }

    source.emit("moment.created", {
      event: {
        eventType: "moment.created",
        payload: {
          event: "moment.created",
          id: "goal-history:1",
          moment: {
            celebratesGoal: true,
            eventTeam: "ARG",
            id: "goal-history",
            identity: "goal-history:1",
            kind: "goal",
            minute: "12′",
            revision: 1,
            score: { away: 0, home: 1 },
            status: "confirmed",
          },
          snapshot,
        },
        sequence: 4,
      },
    });
    expect(onCanonicalEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        deliveryIntent: "reconcile",
        id: "goal-history:1",
        sequence: 4,
      }),
    );
    onCanonicalEvent.mockClear();

    source.emit("moment.created", {
      event: {
        eventType: "moment.created",
        payload: {
          event: "moment.created",
          id: "goal-1:1",
          moment: {
            celebratesGoal: true,
            eventTeam: "ARG",
            id: "goal-1",
            identity: "goal-1:1",
            kind: "goal",
            minute: "23′",
            revision: 1,
            score: { away: 0, home: 1 },
            status: "confirmed",
          },
          snapshot,
        },
        sequence: 5,
      },
    });
    expect(onCanonicalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryIntent: "realtime",
        id: "goal-1:1",
        sequence: 5,
      }),
    );

    source.emit("snapshot", {
      event: {
        eventType: "snapshot",
        payload: {
          event: "snapshot",
          id: "snapshot-6",
          snapshot: { ...snapshot, minute: "25′" },
        },
        sequence: 6,
      },
    });
    expect(onSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ minute: "25′" }),
      6,
    );

    source.emit("snapshot", { highWaterSequence: 7, snapshot });
    expect(onSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ fixtureId: "fx-1" }),
      6,
    );

    source.emit("stream.reset", { highWaterSequence: 8, snapshot });
    expect(onSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({ fixtureId: "fx-1" }),
      8,
    );
    expect(onReset).toHaveBeenCalledOnce();

    source.onerror?.();
    expect(onTransportError).toHaveBeenCalledOnce();
    subscription.close();
    expect(source.closed).toBe(true);
  });
});
