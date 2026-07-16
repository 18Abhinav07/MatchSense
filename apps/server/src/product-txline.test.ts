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
});
