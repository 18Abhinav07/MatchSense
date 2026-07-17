import { describe, expect, it, vi } from "vitest";

import {
  TxlineSseDecoder,
  adaptTxlineFixtureMetadata,
  createTxlineLiveScoreSource,
  createTxlineOrderedCanonicalizer,
  createTxlineReplaySource,
  decodeTxlineRecordBody,
  normalizeTxlineScoreUpdate,
  VERIFIED_TXLINE_DEVNET_ENDPOINTS,
} from "./live.js";

const receivedAt = "2026-07-16T05:32:09.616Z";

function goalUpdate(overrides: Record<string, unknown> = {}) {
  return {
    Action: "goal",
    Clock: { Running: true, Seconds: 3_455 },
    Confirmed: true,
    Data: { GoalType: "Shot", PlayerId: 907_005 },
    FixtureId: 18_237_038,
    Id: 551,
    Participant: 2,
    Score: {
      Participant1: { Total: { Corners: 3, YellowCards: 1 } },
      Participant2: {
        Total: { Corners: 1, Goals: 2, YellowCards: 1 },
      },
    },
    Seq: 620,
    StatusId: 4,
    Ts: 1_784_060_481_148,
    Type: "Soccer",
    ...overrides,
  };
}

const fixtureContext = {
  fixtureId: "18237038",
  participant1: { id: "1999", name: "France" },
  participant1IsHome: true,
  participant2: { id: "3021", name: "Spain" },
} as const;

describe("verified TxLINE payload boundary", () => {
  it("adapts only observed fixture metadata fields", () => {
    expect(
      adaptTxlineFixtureMetadata({
        Competition: "World Cup",
        FixtureGroup: "Semi-finals",
        FixtureId: 18_237_038,
        GameState: "scheduled",
        Participant1: "France",
        Participant1Id: 1_999,
        Participant1IsHome: true,
        Participant2: "Spain",
        Participant2Id: 3_021,
        StartTime: 1_784_055_600_000,
      }),
    ).toEqual({
      competition: "World Cup",
      fixtureGroup: "Semi-finals",
      fixtureId: "18237038",
      gameState: "scheduled",
      participant1: { id: "1999", name: "France" },
      participant1IsHome: true,
      participant2: { id: "3021", name: "Spain" },
      startTimeMs: 1_784_055_600_000,
    });
  });

  it("normalizes the observed goal shape without inventing an omitted Goals field", () => {
    const result = normalizeTxlineScoreUpdate(goalUpdate(), {
      delivery: "live",
      fixtureContext,
      provenance: "live_txline",
      receivedAt,
      sseEventId: "1784060481148/620",
    });

    expect(result).toMatchObject({
      kind: "supported",
      update: {
        action: "goal",
        actionId: "551",
        clockSeconds: 3_455,
        confirmed: true,
        fixtureId: "18237038",
        participant: 2,
        participantScore: { participant1: 0, participant2: 2 },
        participantStats: {
          participant1: {
            corners: 3,
            goals: 0,
            redCards: 0,
            yellowCards: 1,
          },
          participant2: {
            corners: 1,
            goals: 2,
            redCards: 0,
            yellowCards: 1,
          },
        },
        playerId: "907005",
        score: { away: 2, home: 0 },
        source: {
          observedSeq: "620",
          sseEventId: "1784060481148/620",
        },
      },
    });
  });

  it("normalizes the documented VAR decision fields without interpreting free text", () => {
    const result = normalizeTxlineScoreUpdate(
      goalUpdate({
        Action: "var_end",
        Confirmed: true,
        Data: { Outcome: "Overturned", ReviewType: "Goal" },
      }),
      {
        delivery: "live",
        fixtureContext,
        provenance: "live_txline",
        receivedAt,
        sseEventId: "1784060481148/621",
      },
    );

    expect(result).toMatchObject({
      kind: "supported",
      update: {
        action: "var_end",
        varOutcome: "overturned",
        varReviewType: "goal",
      },
    });
  });

  it("refuses to infer a goal score when participant totals are absent", () => {
    const result = normalizeTxlineScoreUpdate(
      goalUpdate({
        Score: {
          Participant1: {},
          Participant2: { Total: { Goals: 2 } },
        },
      }),
      {
        delivery: "live",
        fixtureContext,
        provenance: "live_txline",
        receivedAt,
        sseEventId: null,
      },
    );

    expect(result).toMatchObject({
      kind: "unsupported",
      warning: { code: "invalid_score_shape", fixtureId: "18237038" },
    });
  });
});

describe("TxLINE SSE and historical response decoding", () => {
  it("decodes fragmented SSE frames and preserves id/event/data", () => {
    const decoder = new TxlineSseDecoder();
    expect(decoder.push('id: 619\nevent: score\ndata: {"Seq":619}\n')).toEqual(
      [],
    );
    expect(
      decoder.push(
        '\nid: 620\nevent: score\ndata: {"FixtureId":18237038,\ndata: "Seq":620}\n\n',
      ),
    ).toEqual([
      { data: '{"Seq":619}', event: "score", id: "619" },
      {
        data: '{"FixtureId":18237038,\n"Seq":620}',
        event: "score",
        id: "620",
      },
    ]);
  });

  it("accepts the observed SSE historical encoding and JSON arrays", () => {
    const sse = `id: 620\nevent: score\ndata: ${JSON.stringify(goalUpdate())}\n\n`;
    expect(decodeTxlineRecordBody(sse)).toEqual([goalUpdate()]);
    expect(decodeTxlineRecordBody(JSON.stringify([goalUpdate()]))).toEqual([
      goalUpdate(),
    ]);
  });
});

describe("ordered canonical source revisions", () => {
  it("deduplicates reconnect delivery, advances same-action revisions, and rejects regression", () => {
    const canonicalizer = createTxlineOrderedCanonicalizer({
      fixtureContexts: [fixtureContext],
    });
    const first = canonicalizer.accept(goalUpdate(), {
      delivery: "live",
      provenance: "live_txline",
      receivedAt,
      sseEventId: "620",
    });
    const duplicate = canonicalizer.accept(goalUpdate(), {
      delivery: "reconciliation",
      provenance: "live_txline",
      receivedAt,
      sseEventId: "620",
    });
    const correction = canonicalizer.accept(
      goalUpdate({ Confirmed: false, Seq: 621 }),
      {
        delivery: "live",
        provenance: "live_txline",
        receivedAt,
        sseEventId: "621",
      },
    );
    const regression = canonicalizer.accept(goalUpdate({ Id: 550, Seq: 619 }), {
      delivery: "reconciliation",
      provenance: "live_txline",
      receivedAt,
      sseEventId: "619",
    });

    expect(first).toMatchObject({
      event: { revision: 1, supersedesRevision: null },
      kind: "accepted",
    });
    expect(duplicate).toMatchObject({ kind: "duplicate" });
    expect(correction).toMatchObject({
      event: { revision: 2, supersedesRevision: 1 },
      kind: "accepted",
    });
    expect(regression).toMatchObject({
      kind: "out_of_order",
      warning: { code: "out_of_order_sequence", observedSeq: "619" },
    });
  });

  it("keeps an absent source sequence null instead of fabricating one", () => {
    const canonicalizer = createTxlineOrderedCanonicalizer({
      fixtureContexts: [fixtureContext],
    });
    const result = canonicalizer.accept(goalUpdate({ Seq: undefined }), {
      delivery: "live",
      provenance: "live_txline",
      receivedAt,
      sseEventId: null,
    });

    expect(result).toMatchObject({
      event: { revision: 1, source: { observedSeq: null } },
      kind: "accepted",
    });
  });
});

describe("live source lifecycle", () => {
  it("renews a 401 guest JWT, reconciles before live, resumes by Last-Event-ID, and suppresses duplicates", async () => {
    const calls: Array<{ headers: Headers; url: string }> = [];
    const states: string[] = [];
    const events: Array<{ revision: number; observedSeq: string | null }> = [];
    const controller = new AbortController();
    let guestAttempt = 0;
    let historicalAttempt = 0;
    let streamAttempt = 0;

    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ headers, url });

      if (url.endsWith("/auth/guest/start")) {
        guestAttempt += 1;
        return new Response(JSON.stringify({ token: `jwt-${guestAttempt}` }), {
          status: 200,
        });
      }
      if (url.endsWith("/api/scores/historical/18237038")) {
        historicalAttempt += 1;
        const seq = historicalAttempt === 1 ? 619 : 620;
        return new Response(
          `id: ${seq}\nevent: score\ndata: ${JSON.stringify(goalUpdate({ Id: 550 + seq - 619, Seq: seq }))}\n\n`,
          { status: 200 },
        );
      }
      if (url.endsWith("/api/scores/stream")) {
        streamAttempt += 1;
        if (streamAttempt === 1) return new Response(null, { status: 401 });
        const seq = streamAttempt === 2 ? 620 : 621;
        return new Response(
          `id: cursor-${seq}\nevent: score\ndata: ${JSON.stringify(goalUpdate({ Id: 550 + seq - 619, Seq: seq }))}\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const source = createTxlineLiveScoreSource({
      apiToken: "fixture-activated-token",
      fetchImpl,
      fixtures: [fixtureContext],
      onEvent(event) {
        events.push({
          observedSeq: event.source.observedSeq,
          revision: event.revision,
        });
        if (event.source.observedSeq === "621") controller.abort();
      },
      onState(state) {
        states.push(state.state);
      },
      random: () => 0,
      sleep: async () => undefined,
    });

    await source.run(controller.signal);

    expect(events).toEqual([
      { observedSeq: "619", revision: 1 },
      { observedSeq: "620", revision: 2 },
      { observedSeq: "621", revision: 3 },
    ]);
    expect(states.indexOf("reconciling")).toBeLessThan(states.indexOf("live"));
    expect(guestAttempt).toBe(2);
    expect(streamAttempt).toBe(3);
    expect(
      calls.find(
        ({ headers, url }) =>
          url.endsWith("/api/scores/stream") &&
          headers.get("Last-Event-ID") === "cursor-620",
      ),
    ).toBeTruthy();
    expect(
      calls
        .filter(({ url }) => url.includes("/api/scores/"))
        .every(
          ({ headers }) =>
            headers.get("X-Api-Token") === "fixture-activated-token" &&
            headers.get("Authorization")?.startsWith("Bearer jwt-") === true,
        ),
    ).toBe(true);
    expect(VERIFIED_TXLINE_DEVNET_ENDPOINTS.origin).toBe(
      "https://txline-dev.txodds.com",
    );
  });

  it("opens the 403 circuit without reconnecting", async () => {
    const states: string[] = [];
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/auth/guest/start")) {
        return new Response(JSON.stringify({ token: "fixture-jwt" }), {
          status: 200,
        });
      }
      return new Response(null, { status: 403 });
    });
    const source = createTxlineLiveScoreSource({
      apiToken: "fixture-activated-token",
      fetchImpl,
      fixtures: [fixtureContext],
      onEvent: vi.fn(),
      onState: (state) => states.push(state.state),
      sleep: async () => {
        throw new Error("403 must not retry");
      },
    });

    await expect(
      source.run(new AbortController().signal),
    ).rejects.toMatchObject({ name: "TxlineHttpError", status: 403 });
    expect(states).toContain("forbidden");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("explicit replay fallback", () => {
  it("uses the same ordered canonicalizer without making a network request", async () => {
    const events: Array<{ provenance: string; revision: number }> = [];
    const source = createTxlineReplaySource({
      fixtures: [fixtureContext],
      onEvent: (event) => {
        events.push({
          provenance: event.provenance,
          revision: event.revision,
        });
      },
      provenance: "synthetic_txline_shaped",
      records: [
        {
          payload: goalUpdate(),
          receivedAt,
          sseEventId: "replay-620",
        },
      ],
    });

    await source.run(new AbortController().signal);

    expect(events).toEqual([
      { provenance: "synthetic_txline_shaped", revision: 1 },
    ]);
  });
});
