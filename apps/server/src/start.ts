export interface ShutdownSignalSource {
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  once(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export function registerShutdownSignals(
  source: ShutdownSignalSource,
  close: () => Promise<void>,
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
    void close().catch(() => undefined);
  };

  source.once("SIGINT", shutdown);
  source.once("SIGTERM", shutdown);

  return unregister;
}
