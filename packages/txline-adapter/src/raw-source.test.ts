import { describe, expect, it, vi } from "vitest";

import {
  createTxlineAuthenticatedClient,
  createTxlineRawScoreSource,
  fetchTxlineHistoricalRecords,
} from "./index.js";

const historicalGoal = {
  Action: "goal",
  Confirmed: true,
  FixtureId: 18_257_865,
  Seq: 41,
};
const historicalCard = {
  Update: {
    Action: "red_card",
    FixtureId: 18_257_739,
    Seq: 42,
  },
};
const lowerCamelWrappedRecord = {
  update: {
    action: "yellow_card",
    fixtureId: 18_257_865,
    seq: 43,
  },
};
const unknownLiveAction = {
  Action: "future_action_from_txline",
  FixtureId: 18_257_865,
  GameState: 99,
  Seq: 9_999,
};

function authResponse() {
  return new Response(JSON.stringify({ token: "fixture-guest-jwt" }), {
    status: 200,
  });
}

function openSseResponse(body: string, onCancel: () => void) {
  const encoded = new TextEncoder().encode(body);
  return new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        onCancel();
      },
      start(controller) {
        controller.enqueue(encoded);
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );
}

describe("finite TxLINE historical record fetch", () => {
  it("rejects a blank fixture ID before it can make a provider request", async () => {
    const client = {
      get: vi.fn(async () => {
        throw new Error("The historical endpoint must not be called");
      }),
      prepare: vi.fn(),
    };

    await expect(
      fetchTxlineHistoricalRecords({ client, fixtureId: "   " }),
    ).rejects.toThrow("TxLINE fixture ID must not be empty");
    expect(client.get).not.toHaveBeenCalled();
  });

  it("fetches a JSON array exactly once and preserves every reconciliation payload", async () => {
    const fixtureId = "18257865";
    const historicalPath = `/api/scores/historical/${fixtureId}`;
    const first = { Action: "goal", Seq: 41 };
    const second = { Update: { Action: "red_card", Seq: 42 } };
    const requested: string[] = [];
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("/auth/guest/start")) return authResponse();
      if (url.endsWith(historicalPath)) {
        return new Response(JSON.stringify([first, second]), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const records = await fetchTxlineHistoricalRecords({
      client: createTxlineAuthenticatedClient({
        apiToken: "fixture-activated-server-token",
        fetchImpl,
      }),
      fixtureId,
      now: () => "2026-07-18T12:00:00.000Z",
    });

    expect(
      requested.filter((url) => url.endsWith(historicalPath)),
    ).toHaveLength(1);
    expect(requested).toHaveLength(2);
    expect(records).toEqual([
      {
        metadata: {
          delivery: "reconciliation",
          receivedAt: "2026-07-18T12:00:00.000Z",
          requestedFixtureId: fixtureId,
          sourcePath: historicalPath,
          sseEventId: null,
        },
        payload: first,
      },
      {
        metadata: {
          delivery: "reconciliation",
          receivedAt: "2026-07-18T12:00:00.000Z",
          requestedFixtureId: fixtureId,
          sourcePath: historicalPath,
          sseEventId: null,
        },
        payload: second,
      },
    ]);
  });

  it("wraps a JSON object unchanged as one reconciliation record", async () => {
    const fixtureId = "18257739";
    const historicalPath = `/api/scores/historical/${fixtureId}`;
    const payload = { Action: "future_provider_action", Nested: { value: 1 } };
    const client = {
      get: vi.fn(
        async () =>
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
      prepare: vi.fn(),
    };

    const records = await fetchTxlineHistoricalRecords({
      client,
      fixtureId,
      now: () => "2026-07-18T12:01:00.000Z",
    });

    expect(client.get).toHaveBeenCalledTimes(1);
    expect(client.get).toHaveBeenCalledWith(historicalPath, {
      accept: "text/event-stream, application/json",
      signal: undefined,
    });
    expect(records).toEqual([
      {
        metadata: {
          delivery: "reconciliation",
          receivedAt: "2026-07-18T12:01:00.000Z",
          requestedFixtureId: fixtureId,
          sourcePath: historicalPath,
          sseEventId: null,
        },
        payload,
      },
    ]);
  });

  it("parses a finite historical SSE body and retains each SSE id", async () => {
    const fixtureId = "18257739";
    const historicalPath = `/api/scores/historical/${fixtureId}`;
    const first = { Action: "corner", Seq: 43 };
    const second = { Action: "shot", Seq: 44 };
    const client = {
      get: vi.fn(
        async () =>
          new Response(
            `id: historical:43\nevent: score\ndata: ${JSON.stringify(first)}\n\nid: historical:44\nevent: score\ndata: ${JSON.stringify(second)}\n\n`,
            {
              status: 200,
              headers: { "content-type": "text/event-stream; charset=utf-8" },
            },
          ),
      ),
      prepare: vi.fn(),
    };

    const records = await fetchTxlineHistoricalRecords({
      client,
      fixtureId,
      now: () => "2026-07-18T12:02:00.000Z",
    });

    expect(client.get).toHaveBeenCalledTimes(1);
    expect(records).toEqual([
      {
        metadata: {
          delivery: "reconciliation",
          receivedAt: "2026-07-18T12:02:00.000Z",
          requestedFixtureId: fixtureId,
          sourcePath: historicalPath,
          sseEventId: "historical:43",
        },
        payload: first,
      },
      {
        metadata: {
          delivery: "reconciliation",
          receivedAt: "2026-07-18T12:02:00.000Z",
          requestedFixtureId: fixtureId,
          sourcePath: historicalPath,
          sseEventId: "historical:44",
        },
        payload: second,
      },
    ]);
  });

  it("throws malformed archival SSE JSON instead of silently dropping it", async () => {
    const client = {
      get: vi.fn(
        async () =>
          new Response("id: historical:bad\nevent: score\ndata: {broken\n\n", {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      ),
      prepare: vi.fn(),
    };

    await expect(
      fetchTxlineHistoricalRecords({
        client,
        fixtureId: "18257739",
      }),
    ).rejects.toThrow(SyntaxError);
    expect(client.get).toHaveBeenCalledTimes(1);
  });

  it("propagates an authenticated non-success response", async () => {
    const fixtureId = "18257739";
    const historicalPath = `/api/scores/historical/${fixtureId}`;
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/guest/start")) return authResponse();
      if (url.endsWith(historicalPath))
        return new Response(null, { status: 502 });
      throw new Error(`Unexpected URL ${url}`);
    });

    await expect(
      fetchTxlineHistoricalRecords({
        client: createTxlineAuthenticatedClient({
          apiToken: "fixture-activated-server-token",
          fetchImpl,
        }),
        fixtureId,
      }),
    ).rejects.toMatchObject({ path: historicalPath, status: 502 });
  });
});

describe("raw TxLINE score source", () => {
  it("reconciles JSON and SSE history before live, resumes the durable SSE cursor, and delivers unknown actions unchanged", async () => {
    const requested: Array<{ headers: Headers; url: string }> = [];
    const states: string[] = [];
    const delivered: Array<{
      delivery: string;
      payload: unknown;
      requestedFixtureId: string | null;
      sseEventId: string | null;
    }> = [];
    const cursorChanges: Array<{ expected: string | null; next: string }> = [];
    const controller = new AbortController();
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      requested.push({ headers: new Headers(init?.headers), url });
      if (url.endsWith("/auth/guest/start")) return authResponse();
      if (url.endsWith("/api/scores/historical/18257865")) {
        return new Response(
          JSON.stringify([historicalGoal, lowerCamelWrappedRecord]),
          {
            status: 200,
            headers: { "content-type": "application/json; charset=utf-8" },
          },
        );
      }
      if (url.endsWith("/api/scores/historical/18257739")) {
        return new Response(
          `id: history:42\nevent: score\ndata: ${JSON.stringify(historicalCard)}\n\n`,
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        );
      }
      if (url.endsWith("/api/scores/stream")) {
        return new Response(
          `id: 1784487600000:7\nevent: score\ndata: ${JSON.stringify(unknownLiveAction)}\n\n`,
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        );
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const client = createTxlineAuthenticatedClient({
      apiToken: "fixture-activated-server-token",
      fetchImpl,
    });
    const source = createTxlineRawScoreSource({
      advanceCursor: async (expected, next) => {
        cursorChanges.push({ expected, next });
        controller.abort();
        return true;
      },
      client,
      fixtureIds: ["18257865", "18257739"],
      loadCursor: async () => "1784487600000:6",
      onRawRecord: async ({ metadata, payload }) => {
        delivered.push({
          delivery: metadata.delivery,
          payload,
          requestedFixtureId: metadata.requestedFixtureId,
          sseEventId: metadata.sseEventId,
        });
      },
      onState: ({ state }) => states.push(state),
    });

    await source.run(controller.signal);

    expect(delivered).toEqual([
      {
        delivery: "reconciliation",
        payload: historicalGoal,
        requestedFixtureId: "18257865",
        sseEventId: null,
      },
      {
        delivery: "reconciliation",
        payload: lowerCamelWrappedRecord,
        requestedFixtureId: "18257865",
        sseEventId: null,
      },
      {
        delivery: "reconciliation",
        payload: historicalCard,
        requestedFixtureId: "18257739",
        sseEventId: "history:42",
      },
      {
        delivery: "live",
        payload: unknownLiveAction,
        requestedFixtureId: null,
        sseEventId: "1784487600000:7",
      },
    ]);
    expect(states).toContain("authenticating");
    expect(states.indexOf("authenticating")).toBeLessThan(
      states.indexOf("reconciling"),
    );
    expect(states.indexOf("reconciling")).toBeLessThan(states.indexOf("live"));
    expect(cursorChanges).toEqual([
      { expected: "1784487600000:6", next: "1784487600000:7" },
    ]);
    expect(
      requested
        .find(({ url }) => url.endsWith("/api/scores/stream"))
        ?.headers.get("Last-Event-ID"),
    ).toBe("1784487600000:6");
    expect(
      requested.filter(({ url }) => url.endsWith("/auth/guest/start")),
    ).toHaveLength(1);
  });

  it("advances the SSE cursor only after every raw record in the frame completes downstream", async () => {
    const order: string[] = [];
    const controller = new AbortController();
    const first = { Action: "shot", Seq: 50 };
    const second = { Action: "corner", Seq: 51 };
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/guest/start")) return authResponse();
      if (url.includes("/api/scores/historical/")) {
        return new Response("[]", {
          status: 200,
          headers: {
            "content-type": 'application/json; profile="text/event-stream"',
          },
        });
      }
      return new Response(
        `id: cursor:51\nevent: score\ndata: ${JSON.stringify([first, second])}\n\n`,
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );
    });
    const source = createTxlineRawScoreSource({
      advanceCursor: async (expected, next) => {
        order.push(`cursor:${expected}->${next}`);
        controller.abort();
        return true;
      },
      client: createTxlineAuthenticatedClient({
        apiToken: "fixture-activated-server-token",
        fetchImpl,
      }),
      fixtureIds: ["18257865"],
      loadCursor: async () => "cursor:49",
      onRawRecord: async ({ payload }) => {
        order.push(`record:${String((payload as { Seq: number }).Seq)}`);
      },
    });

    await source.run(controller.signal);

    expect(order).toEqual([
      "record:50",
      "record:51",
      "cursor:cursor:49->cursor:51",
    ]);
  });

  it("hands a whole identified live frame to the atomic collector before acknowledging its cursor", async () => {
    const controller = new AbortController();
    const individualRecords = vi.fn();
    const legacyCursor = vi.fn();
    const atomicFrames: Array<{
      expectedCursor: string | null;
      nextCursor: string;
      records: Array<{ seq: number; sseEventId: string | null }>;
    }> = [];
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/guest/start")) return authResponse();
      if (url.includes("/api/scores/historical/")) {
        return new Response("[]", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        `id: cursor:52\nevent: score\ndata: ${JSON.stringify([
          { Action: "shot", Seq: 50 },
          { Action: "corner", Seq: 51 },
        ])}\n\n`,
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );
    });
    const source = createTxlineRawScoreSource({
      advanceCursor: legacyCursor,
      client: createTxlineAuthenticatedClient({
        apiToken: "fixture-activated-server-token",
        fetchImpl,
      }),
      fixtureIds: ["18257865"],
      loadCursor: async () => "cursor:49",
      onLiveFrame: async (frame) => {
        atomicFrames.push({
          expectedCursor: frame.expectedCursor,
          nextCursor: frame.nextCursor,
          records: frame.records.map((record) => ({
            seq: (record.payload as { Seq: number }).Seq,
            sseEventId: record.metadata.sseEventId,
          })),
        });
        controller.abort();
        return true;
      },
      onRawRecord: individualRecords,
    });

    await source.run(controller.signal);

    expect(atomicFrames).toEqual([
      {
        expectedCursor: "cursor:49",
        nextCursor: "cursor:52",
        records: [
          { seq: 50, sseEventId: "cursor:52" },
          { seq: 51, sseEventId: "cursor:52" },
        ],
      },
    ]);
    expect(individualRecords).not.toHaveBeenCalled();
    expect(legacyCursor).not.toHaveBeenCalled();
  });

  it("does not advance the cursor when downstream fails and surfaces the reconnect warning", async () => {
    const controller = new AbortController();
    const cursorChanges = vi.fn();
    const warnings: Array<{ code: string; message: string }> = [];
    const states: string[] = [];
    let readerCancelCount = 0;
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/guest/start")) return authResponse();
      if (url.includes("/api/scores/historical/")) {
        return new Response("[]", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return openSseResponse(
        `id: cursor:51\nevent: score\ndata: ${JSON.stringify([
          { Action: "shot", Seq: 50 },
          { Action: "corner", Seq: 51 },
        ])}\n\n`,
        () => {
          readerCancelCount += 1;
        },
      );
    });
    let delivered = 0;
    const source = createTxlineRawScoreSource({
      advanceCursor: cursorChanges,
      client: createTxlineAuthenticatedClient({
        apiToken: "fixture-activated-server-token",
        fetchImpl,
      }),
      fixtureIds: ["18257865"],
      loadCursor: async () => "cursor:49",
      onRawRecord: async () => {
        delivered += 1;
        if (delivered === 2) throw new Error("projection transaction failed");
      },
      onState: ({ state }) => states.push(state),
      onWarning: (warning) => warnings.push(warning),
      random: () => 0,
      sleep: async () => controller.abort(),
    });

    await source.run(controller.signal);

    expect(cursorChanges).not.toHaveBeenCalled();
    expect(readerCancelCount).toBe(1);
    expect(warnings).toEqual([
      expect.objectContaining({
        code: "transport_error",
        message: expect.stringContaining("projection transaction failed"),
      }),
    ]);
    expect(states.indexOf("error")).toBeLessThan(
      states.indexOf("reconnecting"),
    );
    expect(states).toContain("reconnecting");
  });

  it("surfaces a CAS conflict and reloads the durable cursor before reconnecting", async () => {
    const controller = new AbortController();
    const loadedCursors = ["cursor:49", "cursor:external"];
    const streamCursors: Array<string | null> = [];
    const warnings: Array<{ code: string; message: string }> = [];
    const states: Array<{ attempt: number; state: string }> = [];
    let readerCancelCount = 0;
    let streamAttempt = 0;
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/auth/guest/start")) return authResponse();
      if (url.includes("/api/scores/historical/")) {
        return new Response("[]", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      streamAttempt += 1;
      streamCursors.push(new Headers(init?.headers).get("Last-Event-ID"));
      if (streamAttempt === 2) controller.abort();
      return streamAttempt === 1
        ? openSseResponse(
            `id: cursor:51\nevent: score\ndata: ${JSON.stringify({ Action: "shot" })}\n\n`,
            () => {
              readerCancelCount += 1;
            },
          )
        : new Response("", {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
    });
    const source = createTxlineRawScoreSource({
      advanceCursor: async () => false,
      client: createTxlineAuthenticatedClient({
        apiToken: "fixture-activated-server-token",
        fetchImpl,
      }),
      fixtureIds: ["18257865"],
      loadCursor: async () => loadedCursors.shift() ?? null,
      onRawRecord: vi.fn(),
      onState: (state) => states.push(state),
      onWarning: (warning) => warnings.push(warning),
      random: () => 0,
      sleep: async () => undefined,
    });

    await source.run(controller.signal);

    expect(streamCursors).toEqual(["cursor:49", "cursor:external"]);
    expect(readerCancelCount).toBe(1);
    expect(states).toContainEqual({ attempt: 1, state: "connecting" });
    expect(warnings).toContainEqual(
      expect.objectContaining({
        code: "cursor_conflict",
        message: expect.stringContaining("cursor:51"),
      }),
    );
  });

  it("surfaces reconciliation transport failures and never claims live", async () => {
    const controller = new AbortController();
    const warnings: Array<{ code: string; message: string }> = [];
    const states: string[] = [];
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/guest/start")) return authResponse();
      return new Response(null, { status: 502 });
    });
    const source = createTxlineRawScoreSource({
      advanceCursor: vi.fn(),
      client: createTxlineAuthenticatedClient({
        apiToken: "fixture-activated-server-token",
        fetchImpl,
      }),
      fixtureIds: ["18257865"],
      loadCursor: async () => null,
      onRawRecord: vi.fn(),
      onState: ({ state }) => states.push(state),
      onWarning: (warning) => warnings.push(warning),
      random: () => 0,
      sleep: async () => controller.abort(),
    });

    await source.run(controller.signal);

    expect(states).toContain("reconciling");
    expect(states).not.toContain("live");
    expect(states.indexOf("error")).toBeLessThan(
      states.indexOf("reconnecting"),
    );
    expect(states).toContain("reconnecting");
    expect(warnings).toEqual([
      expect.objectContaining({
        code: "transport_error",
        message: expect.stringContaining("502"),
      }),
    ]);
  });

  it("rejects a 200 non-SSE live response before claiming live and cancels its body", async () => {
    const controller = new AbortController();
    const states: string[] = [];
    const warnings: Array<{ code: string; message: string }> = [];
    let cancellationCount = 0;
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/guest/start")) return authResponse();
      if (url.includes("/api/scores/historical/")) {
        return new Response("[]", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancellationCount += 1;
          },
          start(streamController) {
            streamController.enqueue(
              new TextEncoder().encode(
                `id: wrong-media\nevent: score\ndata: ${JSON.stringify({ Action: "shot" })}\n\n`,
              ),
            );
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    const source = createTxlineRawScoreSource({
      advanceCursor: async () => false,
      client: createTxlineAuthenticatedClient({
        apiToken: "fixture-activated-server-token",
        fetchImpl,
      }),
      fixtureIds: ["18257865"],
      loadCursor: async () => null,
      onRawRecord: vi.fn(),
      onState: ({ state }) => states.push(state),
      onWarning: (warning) => warnings.push(warning),
      random: () => 0,
      sleep: async () => controller.abort(),
    });

    await source.run(controller.signal);

    expect(cancellationCount).toBe(1);
    expect(states).not.toContain("live");
    expect(states.indexOf("error")).toBeLessThan(
      states.indexOf("reconnecting"),
    );
    expect(warnings).toContainEqual(
      expect.objectContaining({
        code: "transport_error",
        message: expect.stringContaining("text/event-stream"),
      }),
    );
  });

  it("quarantines malformed live SSE and continues with the next valid frame", async () => {
    const controller = new AbortController();
    const delivered: unknown[] = [];
    const cursorChanges: Array<{ expected: string | null; next: string }> = [];
    const warnings: Array<{ code: string; message: string }> = [];
    const states: string[] = [];
    const valid = { Action: "future_action", Seq: 901 };
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/guest/start")) return authResponse();
      if (url.includes("/api/scores/historical/")) {
        return new Response("[]", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        `id: cursor:bad\nevent: score\ndata: {not-json\n\nid: cursor:good\nevent: score\ndata: ${JSON.stringify(valid)}\n\n`,
        {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        },
      );
    });
    const source = createTxlineRawScoreSource({
      advanceCursor: async (expected, next) => {
        cursorChanges.push({ expected, next });
        if (next === "cursor:good") controller.abort();
        return true;
      },
      client: createTxlineAuthenticatedClient({
        apiToken: "fixture-activated-server-token",
        fetchImpl,
      }),
      fixtureIds: ["18257865"],
      loadCursor: async () => "cursor:before",
      onRawRecord: ({ payload }) => {
        delivered.push(payload);
      },
      onState: ({ state }) => states.push(state),
      onWarning: (warning) => warnings.push(warning),
      random: () => 0,
      sleep: async () => controller.abort(),
    });

    await source.run(controller.signal);

    expect(delivered).toEqual([valid]);
    expect(cursorChanges).toEqual([
      { expected: "cursor:before", next: "cursor:bad" },
      { expected: "cursor:bad", next: "cursor:good" },
    ]);
    expect(warnings).toEqual([
      expect.objectContaining({ code: "invalid_sse_json" }),
    ]);
    expect(states).toContain("live");
    expect(states).not.toContain("error");
  });

  it("quarantines malformed historical SSE without blocking later history or live", async () => {
    const controller = new AbortController();
    const delivered: unknown[] = [];
    const warnings: Array<{ code: string; message: string }> = [];
    const firstValid = { Action: "shot", FixtureId: 18_257_865 };
    const secondFixture = { Action: "corner", FixtureId: 18_257_739 };
    const liveValid = { Action: "substitution", FixtureId: 18_257_865 };
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/guest/start")) return authResponse();
      if (url.endsWith("/api/scores/historical/18257865")) {
        return new Response(
          `id: history:bad\nevent: score\ndata: {broken\n\nid: history:good\nevent: score\ndata: ${JSON.stringify(firstValid)}\n\n`,
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        );
      }
      if (url.endsWith("/api/scores/historical/18257739")) {
        return new Response(JSON.stringify([secondFixture]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        `id: live:good\nevent: score\ndata: ${JSON.stringify(liveValid)}\n\n`,
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );
    });
    const source = createTxlineRawScoreSource({
      advanceCursor: async () => {
        controller.abort();
        return true;
      },
      client: createTxlineAuthenticatedClient({
        apiToken: "fixture-activated-server-token",
        fetchImpl,
      }),
      fixtureIds: ["18257865", "18257739"],
      loadCursor: async () => null,
      onRawRecord: ({ payload }) => {
        delivered.push(payload);
      },
      onWarning: (warning) => warnings.push(warning),
      random: () => 0,
      sleep: async () => controller.abort(),
    });

    await source.run(controller.signal);

    expect(delivered).toEqual([firstValid, secondFixture, liveValid]);
    expect(warnings).toEqual([
      expect.objectContaining({ code: "invalid_sse_json" }),
    ]);
  });

  it("increases backoff across consecutive failures before a healthy live frame", async () => {
    const controller = new AbortController();
    const delays: number[] = [];
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/guest/start")) return authResponse();
      return new Response(null, { status: 502 });
    });
    const source = createTxlineRawScoreSource({
      advanceCursor: vi.fn(),
      client: createTxlineAuthenticatedClient({
        apiToken: "fixture-activated-server-token",
        fetchImpl,
      }),
      fixtureIds: ["18257865"],
      loadCursor: async () => null,
      onRawRecord: vi.fn(),
      random: () => 0.5,
      sleep: async (delayMs) => {
        delays.push(delayMs);
        if (delays.length === 3) controller.abort();
      },
    });

    await source.run(controller.signal);

    expect(delays).toEqual([250, 500, 1_000]);
  });

  it("resets backoff after a valid live frame is processed", async () => {
    const controller = new AbortController();
    const delays: number[] = [];
    let historyAttempt = 0;
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/guest/start")) return authResponse();
      if (url.includes("/api/scores/historical/")) {
        historyAttempt += 1;
        return historyAttempt === 1
          ? new Response(null, { status: 502 })
          : new Response("[]", {
              status: 200,
              headers: { "content-type": "application/json" },
            });
      }
      return new Response(
        `id: live:healthy\nevent: score\ndata: ${JSON.stringify({ Action: "shot" })}\n\n`,
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );
    });
    const source = createTxlineRawScoreSource({
      advanceCursor: async () => true,
      client: createTxlineAuthenticatedClient({
        apiToken: "fixture-activated-server-token",
        fetchImpl,
      }),
      fixtureIds: ["18257865"],
      loadCursor: async () => null,
      onRawRecord: vi.fn(),
      random: () => 0.5,
      sleep: async (delayMs) => {
        delays.push(delayMs);
        if (delays.length === 2) controller.abort();
      },
    });

    await source.run(controller.signal);

    expect(delays).toEqual([250, 250]);
  });

  it("exposes fatal 401 and 403 source states without reconnecting", async () => {
    for (const status of [401, 403] as const) {
      const states: string[] = [];
      let authCount = 0;
      const fetchImpl: typeof fetch = vi.fn(async (input) => {
        const url = String(input);
        if (url.endsWith("/auth/guest/start")) {
          authCount += 1;
          const jwt = `fixture-jwt-${authCount}`;
          return new Response(JSON.stringify({ token: jwt }), {
            status: 200,
          });
        }
        return new Response(null, { status });
      });
      const source = createTxlineRawScoreSource({
        advanceCursor: vi.fn(),
        client: createTxlineAuthenticatedClient({
          apiToken: "fixture-activated-server-token",
          fetchImpl,
        }),
        fixtureIds: ["18257865"],
        loadCursor: async () => null,
        onRawRecord: vi.fn(),
        onState: ({ state }) => states.push(state),
        sleep: async () => {
          throw new Error("auth failures must not reconnect");
        },
      });

      await expect(source.run(new AbortController().signal)).rejects.toEqual(
        expect.objectContaining({ status }),
      );
      expect(states).toContain(status === 401 ? "unauthorized" : "forbidden");
      expect(states).not.toContain("reconnecting");
      expect(states.at(-1)).toBe("stopped");
    }
  });

  it("shows a 401 renewal as authenticating without exposing credentials", async () => {
    const controller = new AbortController();
    const states: string[] = [];
    let authCount = 0;
    let historyCount = 0;
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/guest/start")) {
        authCount += 1;
        const jwt = `fixture-renewed-jwt-${authCount}`;
        return new Response(JSON.stringify({ token: jwt }), { status: 200 });
      }
      if (url.includes("/api/scores/historical/")) {
        historyCount += 1;
        return historyCount === 1
          ? new Response(null, { status: 401 })
          : new Response("[]", {
              status: 200,
              headers: { "content-type": "application/json" },
            });
      }
      return new Response(
        `id: cursor:renewed\nevent: score\ndata: ${JSON.stringify({ Action: "shot" })}\n\n`,
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );
    });
    const source = createTxlineRawScoreSource({
      advanceCursor: async () => {
        controller.abort();
        return true;
      },
      client: createTxlineAuthenticatedClient({
        apiToken: "fixture-activated-server-token",
        fetchImpl,
      }),
      fixtureIds: ["18257865"],
      loadCursor: async () => null,
      onRawRecord: vi.fn(),
      onState: ({ state }) => states.push(state),
    });

    await source.run(controller.signal);

    const authenticatingIndexes = states.flatMap((state, index) =>
      state === "authenticating" ? [index] : [],
    );
    expect(authenticatingIndexes).toHaveLength(2);
    expect(authenticatingIndexes[0]).toBeLessThan(
      states.indexOf("reconciling"),
    );
    expect(authenticatingIndexes[1]).toBeGreaterThan(
      states.indexOf("reconciling"),
    );
    expect(authenticatingIndexes[1]).toBeLessThan(states.indexOf("live"));
    expect(JSON.stringify(states)).not.toContain("jwt");
  });

  it("reuses a shared cached JWT without a fake authenticating state", async () => {
    const controller = new AbortController();
    const states: string[] = [];
    let authCount = 0;
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/guest/start")) {
        authCount += 1;
        return authResponse();
      }
      if (url.includes("/api/scores/historical/")) {
        return new Response("[]", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/scores/stream")) {
        return new Response(
          `id: cursor:cached\nevent: score\ndata: ${JSON.stringify({ Action: "shot" })}\n\n`,
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        );
      }
      return new Response("[]", { status: 200 });
    });
    const client = createTxlineAuthenticatedClient({
      apiToken: "fixture-activated-server-token",
      fetchImpl,
    });
    await client.get("/api/fixtures/snapshot?competitionId=72");
    const source = createTxlineRawScoreSource({
      advanceCursor: async () => {
        controller.abort();
        return true;
      },
      client,
      fixtureIds: ["18257865"],
      loadCursor: async () => null,
      onRawRecord: vi.fn(),
      onState: ({ state }) => states.push(state),
    });

    await source.run(controller.signal);

    expect(authCount).toBe(1);
    expect(states).not.toContain("authenticating");
    expect(states.indexOf("reconciling")).toBeLessThan(states.indexOf("live"));
  });
});
