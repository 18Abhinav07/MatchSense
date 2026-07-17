import { randomUUID } from "node:crypto";

import type {
  OutboxRecord,
  OutboxRepository,
  PersistenceMode,
} from "@matchsense/db";

export type OutboxHandler = (
  message: OutboxRecord,
  signal: AbortSignal,
) => Promise<void>;

export type OutboxWorkerRepository = Pick<
  OutboxRepository,
  | "claim"
  | "complete"
  | "hasConsumerReceipt"
  | "recordConsumerReceipt"
  | "retryOrDeadLetter"
>;

export interface OutboxWorker {
  runOnce(): Promise<number>;
  start(): void;
  stop(): Promise<void>;
}

export interface CreateOutboxWorkerOptions {
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  batchSize?: number;
  consumer: string;
  handlerTimeoutMs?: number;
  handlers: Readonly<Record<string, OutboxHandler>>;
  lockTimeoutMs?: number;
  maxAttempts?: number;
  mode: PersistenceMode;
  now?: () => Date;
  outbox: OutboxWorkerRepository;
  pollIntervalMs?: number;
  workerId?: string;
}

const processWorkerId = randomUUID();

class OutboxWorkerStoppingError extends Error {
  constructor() {
    super("Outbox worker is stopping");
    this.name = "OutboxWorkerStoppingError";
  }
}

class OutboxHandlerTimeoutError extends Error {
  constructor() {
    super("Outbox handler timed out");
    this.name = "OutboxHandlerTimeoutError";
  }
}

function positiveInteger(value: number, label: string, maximum: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function failureMessage(error: unknown) {
  if (!(error instanceof Error) || error.message.length === 0) {
    return "Outbox handler failed";
  }
  return error.message.slice(0, 4_000);
}

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export function createOutboxWorker(
  options: CreateOutboxWorkerOptions,
): OutboxWorker {
  const backoffBaseMs = positiveInteger(
    options.backoffBaseMs ?? 500,
    "Outbox backoff base",
    60_000,
  );
  const backoffMaxMs = positiveInteger(
    options.backoffMaxMs ?? 60_000,
    "Outbox backoff maximum",
    3_600_000,
  );
  if (backoffMaxMs < backoffBaseMs) {
    throw new Error("Outbox backoff maximum is invalid");
  }
  const batchSize = positiveInteger(
    options.batchSize ?? 1,
    "Outbox batch size",
    100,
  );
  const lockTimeoutMs = positiveInteger(
    options.lockTimeoutMs ?? 30_000,
    "Outbox lock timeout",
    3_600_000,
  );
  const handlerTimeoutMs = positiveInteger(
    options.handlerTimeoutMs ?? Math.min(20_000, lockTimeoutMs - 1),
    "Outbox handler timeout",
    3_600_000,
  );
  if (handlerTimeoutMs >= lockTimeoutMs) {
    throw new Error("Outbox handler timeout must be shorter than its lock");
  }
  const maxAttempts = positiveInteger(
    options.maxAttempts ?? 5,
    "Outbox max attempts",
    100,
  );
  const pollIntervalMs = positiveInteger(
    options.pollIntervalMs ?? 1_000,
    "Outbox poll interval",
    300_000,
  );
  const now = options.now ?? (() => new Date());
  const handlers = new Map(Object.entries(options.handlers));
  const topics = [...handlers.keys()].sort();
  const workerId = options.workerId ?? processWorkerId;
  let controller: AbortController | null = null;
  let loopTask: Promise<void> | null = null;
  const activeHandlers = new Set<AbortController>();

  const runHandler = async (
    handler: OutboxHandler,
    message: OutboxRecord,
  ): Promise<void> => {
    const handlerController = new AbortController();
    activeHandlers.add(handlerController);
    let rejectOnAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectOnAbort = () => {
        const reason = handlerController.signal.reason;
        reject(
          reason instanceof Error
            ? reason
            : new Error("Outbox handler aborted"),
        );
      };
      handlerController.signal.addEventListener("abort", rejectOnAbort, {
        once: true,
      });
    });
    const timeout = setTimeout(() => {
      handlerController.abort(new OutboxHandlerTimeoutError());
    }, handlerTimeoutMs);
    const handlerTask = Promise.resolve().then(() =>
      handler(message, handlerController.signal),
    );
    void handlerTask.catch(() => undefined);
    try {
      await Promise.race([handlerTask, aborted]);
    } finally {
      clearTimeout(timeout);
      if (rejectOnAbort) {
        handlerController.signal.removeEventListener("abort", rejectOnAbort);
      }
      activeHandlers.delete(handlerController);
    }
  };

  const processMessage = async (message: OutboxRecord) => {
    const claimToken = message.claimToken;
    if (!claimToken)
      throw new Error("Outbox message has no active claim token");
    const receiptKey = {
      consumer: options.consumer,
      mode: message.mode,
      outboxId: message.id,
    };
    if (await options.outbox.hasConsumerReceipt(receiptKey)) {
      const completed = await options.outbox.complete({
        claimToken,
        id: message.id,
        mode: message.mode,
        workerId,
      });
      if (!completed) throw new Error("Outbox claim was lost");
      return;
    }

    const handler = handlers.get(message.topic);
    if (!handler) return;
    try {
      await runHandler(handler, message);
    } catch (error) {
      if (error instanceof OutboxWorkerStoppingError) return;
      const exponent = Math.max(0, message.attemptCount - 1);
      const delay = Math.min(
        backoffMaxMs,
        backoffBaseMs * 2 ** Math.min(exponent, 30),
      );
      await options.outbox.retryOrDeadLetter({
        availableAt: new Date(now().getTime() + delay).toISOString(),
        claimToken,
        deadLetterId: `dead:${message.mode}:${message.id}`,
        error: failureMessage(error),
        id: message.id,
        maxAttempts,
        mode: message.mode,
        workerId,
      });
      return;
    }

    await options.outbox.recordConsumerReceipt(receiptKey);
    const completed = await options.outbox.complete({
      claimToken,
      id: message.id,
      mode: message.mode,
      workerId,
    });
    if (!completed) throw new Error("Outbox claim was lost");
  };

  const runOnce = async () => {
    if (topics.length === 0) return 0;
    const messages = await options.outbox.claim({
      claimToken: randomUUID(),
      limit: batchSize,
      lockTimeoutMs,
      mode: options.mode,
      topics,
      workerId,
    });
    for (const message of messages) {
      await processMessage(message);
    }
    return messages.length;
  };

  return {
    runOnce,
    start: () => {
      if (loopTask) return;
      controller = new AbortController();
      const signal = controller.signal;
      loopTask = (async () => {
        while (!signal.aborted) {
          try {
            await runOnce();
          } catch {
            // A later poll can reclaim the message after the bounded lock expires.
          }
          if (!signal.aborted) await waitFor(pollIntervalMs, signal);
        }
      })();
    },
    stop: async () => {
      controller?.abort();
      for (const handlerController of activeHandlers) {
        handlerController.abort(new OutboxWorkerStoppingError());
      }
      await loopTask;
      controller = null;
      loopTask = null;
    },
  };
}
