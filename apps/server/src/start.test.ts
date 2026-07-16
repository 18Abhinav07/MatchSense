import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import * as shutdown from "./start.js";

describe("registerShutdownSignals", () => {
  it("closes once on SIGINT or SIGTERM and can unregister cleanly", async () => {
    const source = new EventEmitter();
    const close = vi.fn(async () => undefined);
    const reportFailure = vi.fn();
    const unregister = shutdown.registerShutdownSignals(
      source,
      close,
      reportFailure,
    );

    source.emit("SIGTERM");
    source.emit("SIGINT");
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));

    unregister();
    expect(source.listenerCount("SIGINT")).toBe(0);
    expect(source.listenerCount("SIGTERM")).toBe(0);
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it("reports a close rejection exactly once", async () => {
    const source = new EventEmitter();
    const closeFailure = new Error("private close details");
    const close = vi.fn(async () => Promise.reject(closeFailure));
    const reportFailure = vi.fn();
    shutdown.registerShutdownSignals(source, close, reportFailure);

    source.emit("SIGINT");
    source.emit("SIGTERM");

    await vi.waitFor(() =>
      expect(reportFailure).toHaveBeenCalledExactlyOnceWith(closeFailure),
    );
    expect(close).toHaveBeenCalledTimes(1);
    expect(source.listenerCount("SIGINT")).toBe(0);
    expect(source.listenerCount("SIGTERM")).toBe(0);
  });

  it("creates a generic production failure reporter without leaking the error", () => {
    const reporterFactory =
      "createShutdownFailureReporter" in shutdown
        ? shutdown.createShutdownFailureReporter
        : undefined;
    expect(reporterFactory).toBeTypeOf("function");

    if (!reporterFactory) {
      return;
    }

    const writeError = vi.fn();
    const setExitCode = vi.fn();
    const reportFailure = reporterFactory({ setExitCode, writeError });
    reportFailure(new Error("postgresql://internal-sensitive-value"));

    expect(writeError).toHaveBeenCalledExactlyOnceWith(
      "MatchSense server failed to close\n",
    );
    expect(writeError.mock.calls.flat().join(" ")).not.toContain("sensitive");
    expect(setExitCode).toHaveBeenCalledExactlyOnceWith(1);
  });
});
