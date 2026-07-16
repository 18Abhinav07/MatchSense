import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { registerShutdownSignals } from "./start.js";

describe("registerShutdownSignals", () => {
  it("closes once on SIGINT or SIGTERM and can unregister cleanly", async () => {
    const source = new EventEmitter();
    const close = vi.fn(async () => undefined);
    const unregister = registerShutdownSignals(source, close);

    source.emit("SIGTERM");
    source.emit("SIGINT");
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));

    unregister();
    expect(source.listenerCount("SIGINT")).toBe(0);
    expect(source.listenerCount("SIGTERM")).toBe(0);
  });
});
