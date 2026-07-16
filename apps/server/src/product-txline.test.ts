import { EventEmitter } from "node:events";

import type { FixtureStreamEvent } from "@matchsense/contracts";
import { createTxlineOrderedCanonicalizer } from "@matchsense/txline-adapter";
import { describe, expect, it } from "vitest";

import { createProductRuntime } from "./product-runtime.js";

class ListeningClient extends EventEmitter {
  readonly chunks: Buffer[] = [];
  write(bytes: Buffer) {
    this.chunks.push(Buffer.from(bytes));
    return true;
  }
  end() {
    this.emit("close");
  }
}

describe("TxLINE canonical source to product runtime", () => {
  it("turns one verified confirmed goal into the shared score, Moment, and listener cue", () => {
    const fixtureContext = {
      fixtureId: "18237038",
      participant1: { id: "1999", name: "France" },
      participant1IsHome: true,
      participant2: { id: "3021", name: "Spain" },
    } as const;
    const canonicalizer = createTxlineOrderedCanonicalizer({
      fixtureContexts: [fixtureContext],
    });
    const canonical = canonicalizer.accept(
      {
        Action: "goal",
        Clock: { Seconds: 3455 },
        Confirmed: true,
        Data: { PlayerId: 907005 },
        FixtureId: 18237038,
        Id: 551,
        Participant: 2,
        Score: {
          Participant1: { Total: { YellowCards: 1 } },
          Participant2: { Total: { Goals: 2 } },
        },
        Seq: 620,
        StatusId: 4,
        Ts: 1784060481148,
      },
      {
        delivery: "reconciliation",
        provenance: "live_txline",
        receivedAt: "2026-07-16T05:32:09.616Z",
        sseEventId: "1784060481148-620",
      },
    );
    expect(canonical.kind).toBe("accepted");
    if (canonical.kind !== "accepted") throw new Error("expected goal");

    const runtime = createProductRuntime({
      cueBytes: Buffer.from("goal-cue"),
      fixture: {
        awayTeam: "ESP",
        fixtureId: fixtureContext.fixtureId,
        homeTeam: "FRA",
        kickoffAt: "2026-07-14T15:00:00.000Z",
        participant1IsHome: true,
        provenance: "live_txline",
      },
      now: () => "2026-07-16T05:32:09.616Z",
      silenceBytes: Buffer.from("silence"),
      writeIntervalMs: 60_000,
    });
    const listener = runtime.createListeningSession("18237038", "FRA");
    const audio = new ListeningClient();
    runtime.attachListeningClient(listener!.id, audio);
    const events: FixtureStreamEvent[] = [];
    runtime.subscribeFixture("18237038", (event) => events.push(event));

    const accepted = runtime.acceptTxlineEvent(canonical.event);

    expect(accepted).toMatchObject({
      kind: "accepted",
      moment: { eventTeam: "ESP", minute: "—" },
      snapshot: {
        provenance: "live_txline",
        score: { away: 2, home: 0 },
        sourceLabel: "TXLINE · DEVNET SOURCE",
      },
    });
    expect(events.at(-1)).toMatchObject({
      event: "moment.created",
      moment: { eventTeam: "ESP" },
    });
    expect(Buffer.concat(audio.chunks).toString()).toContain("goal-cue");
    expect(runtime.acceptTxlineEvent(canonical.event).kind).toBe("duplicate");
    runtime.close();
  });

  it("publishes every accepted canonical action once for downstream fan products", () => {
    const runtime = createProductRuntime({
      cueBytes: Buffer.from("goal-cue"),
      fixture: {
        awayTeam: "ESP",
        fixtureId: "18237038",
        homeTeam: "FRA",
        kickoffAt: "2026-07-14T15:00:00.000Z",
        participant1IsHome: true,
        provenance: "live_txline",
      },
      now: () => "2026-07-16T05:32:09.616Z",
      silenceBytes: Buffer.from("silence"),
      writeIntervalMs: 60_000,
    });
    const actions: string[] = [];
    runtime.subscribeCanonicalEvent("18237038", (event) => {
      actions.push(event.action);
    });
    const finalEvent = {
      action: "game_finalised",
      actionId: "final-1",
      clockSeconds: 0,
      confirmed: true,
      delivery: "live",
      fixtureId: "18237038",
      participant: null,
      participantScore: { participant1: 2, participant2: 1 },
      participantStats: {
        participant1: {
          corners: 6,
          goals: 2,
          redCards: 0,
          yellowCards: 3,
        },
        participant2: {
          corners: 5,
          goals: 1,
          redCards: 1,
          yellowCards: 2,
        },
      },
      playerId: null,
      provenance: "live_txline",
      receivedAt: "2026-07-16T07:30:00.000Z",
      revision: 9,
      score: { away: 1, home: 2 },
      source: {
        actionId: "final-1",
        observedSeq: "900",
        payloadHash: "final-hash",
        sourceTimestampMs: 1_784_067_000_000,
        sseEventId: "900",
      },
      statusId: 100,
      supersedesRevision: null,
      varOutcome: null,
      varReviewType: null,
    } as const;

    expect(runtime.acceptTxlineEvent(finalEvent)).toMatchObject({
      kind: "accepted",
      moment: null,
    });
    expect(runtime.acceptTxlineEvent(finalEvent).kind).toBe("duplicate");
    expect(actions).toEqual(["game_finalised"]);
    runtime.close();
  });
});
