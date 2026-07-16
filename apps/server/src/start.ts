export interface ShutdownSignalSource {
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface ShutdownFailureTarget {
  setExitCode(code: number): unknown;
  writeError(message: string): unknown;
}

export function createShutdownFailureReporter(target: ShutdownFailureTarget) {
  return (_error: unknown) => {
    target.writeError("MatchSense server failed to close\n");
    target.setExitCode(1);
  };
}

export function registerShutdownSignals(
  source: ShutdownSignalSource,
  close: () => Promise<void>,
  reportFailure: (error: unknown) => void,
) {
  let closing = false;

  const unregister = () => {
    source.off("SIGINT", shutdown);
    source.off("SIGTERM", shutdown);
  };

  const shutdown = () => {
    if (closing) {
      return;
    }

    closing = true;
    unregister();
    void close().catch(reportFailure);
  };

  source.once("SIGINT", shutdown);
  source.once("SIGTERM", shutdown);

  return unregister;
}
