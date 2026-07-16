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

describe("continuous listening audio hub", () => {
  it("fans one idempotent event injection to active clients without replacing streams", () => {
    const hub = createAudioHub({
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

  it("injects generated commentary bytes into the existing listener stream", () => {
    const hub = createAudioHub({
      cueBytes: Buffer.from("cue"),
      silenceBytes: Buffer.from("silence"),
      writeIntervalMs: 1_000,
    });
    const client = new WritableClient();
    hub.addClient("session-1", client);

    expect(
      hub.inject("moment-1:commentary", ["session-1"], Buffer.from("voice")),
    ).toBe(true);

    expect(Buffer.concat(client.chunks).toString()).toBe("silencevoice");
  });

  it("drops a blocked client before backlog can grow without bound", () => {
    const hub = createAudioHub({
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
    const hub = createAudioHub({
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
    const hub = createAudioHub({
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
    const hub = createAudioHub({
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
});
