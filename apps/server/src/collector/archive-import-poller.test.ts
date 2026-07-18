import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ArchiveImportRunResult,
  ArchiveImportRunner,
} from "./archive-import-runner.js";
import { createArchiveImportPoller } from "./archive-import-poller.js";

function deferred<Value>() {
  let reject!: (error: unknown) => void;
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("archive import poller", () => {
  it("serializes a failed run and retries on the next poll", async () => {
    vi.useFakeTimers();
    const firstAttempt = deferred<ArchiveImportRunResult>();
    let activeRuns = 0;
    let maxActiveRuns = 0;
    const runOnce = vi.fn<ArchiveImportRunner["runOnce"]>(async () => {
      activeRuns += 1;
      maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
      try {
        if (runOnce.mock.calls.length === 1) {
          return await firstAttempt.promise;
        }
        return { kind: "idle" };
      } finally {
        activeRuns -= 1;
      }
    });
    const runner: ArchiveImportRunner = { runOnce };
    const poller = createArchiveImportPoller({
      pollIntervalMs: 100,
      runner,
    });

    poller.start();
    expect(runOnce).toHaveBeenCalledOnce();

    firstAttempt.reject(new Error("temporary archive database failure"));
    await vi.advanceTimersByTimeAsync(100);

    expect(runOnce).toHaveBeenCalledTimes(2);
    expect(maxActiveRuns).toBe(1);

    await poller.stop();
  });

  it("aborts an in-flight run and waits for its release before stopping", async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    let signal: AbortSignal | undefined;
    const events: string[] = [];
    const runOnce = vi.fn<ArchiveImportRunner["runOnce"]>(
      async (_now, shutdownSignal) => {
        signal = shutdownSignal;
        started.resolve();
        await new Promise<void>((resolve) => {
          shutdownSignal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        events.push("aborted");
        await release.promise;
        events.push("released");
        return { kind: "idle" };
      },
    );
    const poller = createArchiveImportPoller({
      pollIntervalMs: 100,
      runner: { runOnce },
    });

    poller.start();
    await started.promise;

    const stopping = poller.stop();
    expect(signal?.aborted).toBe(true);
    await Promise.resolve();
    expect(events).toEqual(["aborted"]);

    release.resolve();
    await stopping;
    expect(events).toEqual(["aborted", "released"]);
  });
});
