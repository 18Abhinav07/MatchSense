import { EventEmitter } from "node:events";

import { createCommentaryPipeline } from "@matchsense/commentary";
import type { FixtureStreamEvent } from "@matchsense/contracts";
import { describe, expect, it, vi } from "vitest";

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

describe("canonical Moment to shared commentary", () => {
  it("prepares once, fans one generated call to every listener, and publishes its transcript", async () => {
    const pipeline = createCommentaryPipeline({
      env: {},
      fetchImpl: vi.fn(),
      now: () => new Date("2026-07-16T12:00:03.000Z"),
    });
    const generate = vi.spyOn(pipeline, "generate");
    const transcodeCommentary = vi
      .fn<(wav: Buffer) => Promise<Buffer>>()
      .mockResolvedValue(Buffer.from("shared-voice"));
    const runtime = createProductRuntime({
      commentaryPipeline: pipeline,
      cueBytes: Buffer.from("goal-cue"),
      now: () => "2026-07-16T12:00:00.000Z",
      silenceBytes: Buffer.from("silence"),
      transcodeCommentary,
      writeIntervalMs: 60_000,
    });
    const argListener = runtime.createListeningSession("arg-fra-demo", "ARG");
    const fraListener = runtime.createListeningSession("arg-fra-demo", "FRA");
    expect(argListener).not.toBeNull();
    expect(fraListener).not.toBeNull();
    const first = new ListeningClient();
    const second = new ListeningClient();
    runtime.attachListeningClient(argListener!.id, first);
    runtime.attachListeningClient(fraListener!.id, second);
    const events: FixtureStreamEvent[] = [];
    runtime.subscribeFixture("arg-fra-demo", (event) => events.push(event));

    await runtime.waitForCommentary();
    expect(generate).toHaveBeenCalledOnce();
    expect(transcodeCommentary).toHaveBeenCalledOnce();

    const replay = runtime.createReplaySession("arg-fra-demo");
    runtime.commandReplay(replay.id, {
      listeningSessionId: argListener!.id,
      marker: "goal",
      type: "advance_to_marker",
    });
    await runtime.waitForCommentary();

    expect(generate).toHaveBeenCalledOnce();
    expect(Buffer.concat(first.chunks).toString()).toContain("shared-voice");
    expect(Buffer.concat(second.chunks).toString()).toContain("shared-voice");
    expect(events.at(-1)).toMatchObject({
      commentary: {
        language: "en",
        momentIdentity: "arg-fra-demo:score:1-0:1",
        provider: "deterministic",
        text: expect.stringContaining("Argentina lead France 1–0"),
      },
      event: "commentary.ready",
    });
    runtime.close();
  });
});
