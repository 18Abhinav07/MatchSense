import type { ArchiveImportRunner } from "./archive-import-runner.js";

export interface ArchiveImportPoller {
  start(): void;
  stop(): Promise<void>;
}

export interface ArchiveImportPollerOptions {
  now?: () => Date;
  onError?: (error: unknown) => void;
  pollIntervalMs?: number;
  runner: ArchiveImportRunner;
}

function pollInterval(value: number | undefined) {
  const interval = value ?? 1_000;
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > 300_000) {
    throw new Error("Archive import poll interval is invalid");
  }
  return interval;
}

function idleDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Runs the durable archive-import queue in one serial loop. A failed poll is
 * isolated to that poll; stopping aborts the runner's fetch signal and awaits
 * the runner's own fenced lease release before returning to the worker.
 */
export function createArchiveImportPoller(
  options: ArchiveImportPollerOptions,
): ArchiveImportPoller {
  const interval = pollInterval(options.pollIntervalMs);
  const now = options.now ?? (() => new Date());
  let controller: AbortController | null = null;
  let loop: Promise<void> | null = null;

  const clearCurrent = (
    currentController: AbortController,
    currentLoop: Promise<void>,
  ) => {
    if (loop === currentLoop) loop = null;
    if (controller === currentController) controller = null;
  };

  return {
    start() {
      if (loop) return;
      const currentController = new AbortController();
      const signal = currentController.signal;
      controller = currentController;
      const currentLoop = (async () => {
        while (!signal.aborted) {
          try {
            await options.runner.runOnce(now(), signal);
          } catch (error) {
            try {
              options.onError?.(error);
            } catch {
              // An observability callback must not terminate durable polling.
            }
          }
          if (!signal.aborted) await idleDelay(interval, signal);
        }
      })();
      loop = currentLoop;
      void currentLoop.then(
        () => clearCurrent(currentController, currentLoop),
        () => clearCurrent(currentController, currentLoop),
      );
    },
    async stop() {
      const currentLoop = loop;
      controller?.abort(new Error("Archive import poller is stopping"));
      if (currentLoop) await currentLoop;
    },
  };
}
