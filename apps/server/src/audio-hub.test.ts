import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { createAudioHub } from "./audio-hub.js";

class WritableClient extends EventEmitter {
  readonly chunks: Buffer[] = [];
  destroyed = false;
  ended = false;
  end = vi.fn(() => {
    this.ended = true;
    this.emit("close");
  });
  write = vi.fn((bytes: Buffer) => {
    this.chunks.push(Buffer.from(bytes));
    return true;
  });
  destroy() {
    this.destroyed = true;
  }
}

function createTextAudioHub(options: Parameters<typeof createAudioHub>[0]) {
  return createAudioHub({
    ...options,
    createMediaChunks: (bytes) => {
      const chunks: Buffer[] = [];
      for (
        let offset = 0;
        offset < bytes.length;
        offset += options.silenceBytes.length
      ) {
        const source = bytes.subarray(
          offset,
          offset + options.silenceBytes.length,
        );
        chunks.push(
          source.length === options.silenceBytes.length
            ? Buffer.from(source)
            : Buffer.concat([
                source,
                options.silenceBytes.subarray(
                  0,
                  options.silenceBytes.length - source.length,
                ),
              ]),
        );
      }
      return chunks;
    },
  });
}

describe("continuous listening audio hub", () => {
  it("fans one idempotent event injection to active clients without replacing streams", () => {
    const hub = createTextAudioHub({
      cueBytes: Buffer.from("cue"),
      maxClientBacklogBytes: 12,
      silenceBytes: Buffer.from("silence"),
      writeIntervalMs: 1_000,
    });
    const client = new WritableClient();

    expect(hub.addClient("session-1", client)).toBe(true);
    expect(hub.inject("moment-1:1", ["session-1"])).toBe(true);
    expect(hub.inject("moment-1:1", ["session-1"])).toBe(false);
    expect(Buffer.concat(client.chunks).toString()).toContain("cue");
    expect(hub.status()).toMatchObject({ eventCount: 1, listenerCount: 1 });
  });

  it("paces generated commentary in silence-sized real-time chunks", () => {
    const hub = createTextAudioHub({
      cueBytes: Buffer.from("cue"),
      silenceBytes: Buffer.from("1234"),
      writeIntervalMs: 1_000,
    });
    const client = new WritableClient();
    hub.addClient("session-1", client);
    client.chunks.length = 0;

    expect(
      hub.inject(
        "moment-1:commentary",
        ["session-1"],
        Buffer.from("abcdefghij"),
      ),
    ).toBe(true);

    expect(client.chunks).toEqual([]);
    hub.writeSilence();
    hub.writeSilence();
    hub.writeSilence();
    hub.writeSilence();

    expect(client.chunks.map((chunk) => chunk.toString())).toEqual([
      "abcd",
      "efgh",
      "ij12",
      "1234",
    ]);
  });

  it("starts every attached stream with an audible connection cue", () => {
    const hub = createTextAudioHub({
      cueBytes: Buffer.from("cue"),
      silenceBytes: Buffer.from("silence"),
      writeIntervalMs: 1_000,
    });
    const client = new WritableClient();

    expect(hub.addClient("session-1", client)).toBe(true);

    expect(Buffer.concat(client.chunks).toString()).toBe("silencecue");
  });

  it("does not consume an event identity before its stream is attached", () => {
    const hub = createTextAudioHub({
      cueBytes: Buffer.from("cue"),
      silenceBytes: Buffer.from("silence"),
      writeIntervalMs: 1_000,
    });
    const client = new WritableClient();

    expect(hub.inject("moment-1:commentary", ["session-1"])).toBe(false);
    expect(hub.status().eventCount).toBe(0);
    hub.addClient("session-1", client);
    expect(hub.inject("moment-1:commentary", ["session-1"])).toBe(true);
    hub.writeSilence();
    expect(client.chunks.map((chunk) => chunk.toString())).toEqual([
      "silence",
      "cue",
      "cuesile",
    ]);
  });

  it("drops a blocked client before backlog can grow without bound", () => {
    const hub = createTextAudioHub({
      cueBytes: Buffer.from("12345678"),
      maxClientBacklogBytes: 8,
      silenceBytes: Buffer.from("silence"),
      writeIntervalMs: 1_000,
    });
    const client = new WritableClient();
    client.write.mockReturnValue(false);
    hub.addClient("session-1", client);

    hub.writeSilence();
    hub.writeSilence();

    expect(client.destroyed).toBe(true);
    expect(hub.status().listenerCount).toBe(0);
  });

  it("closes an explicitly removed client exactly once", () => {
    const hub = createTextAudioHub({
      cueBytes: Buffer.from("cue"),
      silenceBytes: Buffer.from("silence"),
      writeIntervalMs: 1_000,
    });
    const client = new WritableClient();
    hub.addClient("session-1", client);

    expect(hub.removeClient("session-1")).toBe(true);
    expect(hub.removeClient("session-1")).toBe(false);

    expect(client.end).toHaveBeenCalledOnce();
    expect(client.destroyed).toBe(false);
    expect(hub.status().listenerCount).toBe(0);
  });

  it("closes every active client when the hub stops", () => {
    const hub = createTextAudioHub({
      cueBytes: Buffer.from("cue"),
      silenceBytes: Buffer.from("silence"),
      writeIntervalMs: 1_000,
    });
    const first = new WritableClient();
    const second = new WritableClient();
    hub.addClient("session-1", first);
    hub.addClient("session-2", second);
    hub.start();

    expect(hub.stop()).toBe(true);
    expect(first.end).toHaveBeenCalledOnce();
    expect(second.end).toHaveBeenCalledOnce();
    expect(hub.status().listenerCount).toBe(0);
    expect(hub.stop()).toBe(false);
  });

  it("detaches a naturally closed client without closing it again", () => {
    const hub = createTextAudioHub({
      cueBytes: Buffer.from("cue"),
      silenceBytes: Buffer.from("silence"),
      writeIntervalMs: 1_000,
    });
    const client = new WritableClient();
    hub.addClient("session-1", client);

    client.emit("close");

    expect(client.end).not.toHaveBeenCalled();
    expect(client.destroyed).toBe(false);
    expect(hub.status().listenerCount).toBe(0);
  });

  it("keeps overlapping responses for one session independent during reconnect", () => {
    const hub = createTextAudioHub({
      cueBytes: Buffer.from("cue"),
      silenceBytes: Buffer.from("silence"),
      writeIntervalMs: 1_000,
    });
    const oldResponse = new WritableClient();
    const newResponse = new WritableClient();

    expect(hub.addClient("session-1", oldResponse)).toBe(true);
    expect(hub.addClient("session-1", newResponse)).toBe(true);
    expect(hub.status().listenerCount).toBe(2);

    oldResponse.emit("close");
    expect(hub.status().listenerCount).toBe(1);
    expect(hub.inject("moment-1:commentary", ["session-1"])).toBe(true);
    hub.writeSilence();

    expect(Buffer.concat(newResponse.chunks).toString()).toContain("cuesile");
    expect(Buffer.concat(oldResponse.chunks).toString()).not.toContain(
      "cuesile",
    );
  });

  it("closes every response attached to a deleted listening session", () => {
    const hub = createTextAudioHub({
      cueBytes: Buffer.from("cue"),
      silenceBytes: Buffer.from("silence"),
      writeIntervalMs: 1_000,
    });
    const first = new WritableClient();
    const second = new WritableClient();
    hub.addClient("session-1", first);
    hub.addClient("session-1", second);

    expect(hub.removeClient("session-1")).toBe(true);
    expect(first.end).toHaveBeenCalledOnce();
    expect(second.end).toHaveBeenCalledOnce();
    expect(hub.status().listenerCount).toBe(0);
  });
});
