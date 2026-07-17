import { describe, expect, it, vi } from "vitest";

import * as serverModule from "./index.js";
import * as workerModule from "./outbox-worker.js";
import type { OutboxWorkerRepository } from "./outbox-worker.js";

type ClaimInput = Parameters<OutboxWorkerRepository["claim"]>[0];

const message = {
  attemptCount: 1,
  availableAt: "2026-07-17T12:00:00.000Z",
  claimToken: "fixture-claim-one",
  createdAt: "2026-07-17T12:00:00.000Z",
  fixtureId: "fx-1",
  id: "outbox-1",
  idempotencyKey: "moment-1:1:foreground",
  lastError: null,
  lockedAt: "2026-07-17T12:00:01.000Z",
  lockedBy: "worker-1",
  mode: "demo" as const,
  payload: { momentId: "moment-1" },
  processedAt: null,
  topic: "moment.created",
};

function repository(
  options: {
    claim?: (input: ClaimInput) => Promise<readonly (typeof message)[]>;
    complete?: () => Promise<boolean>;
    hasReceipt?: () => Promise<boolean>;
    receipt?: () => Promise<boolean>;
    retry?: () => Promise<
      { kind: "dead_letter" } | { kind: "not_claimed" } | { kind: "retry" }
    >;
  } = {},
) {
  return {
    claim: vi.fn(options.claim ?? (async (_input: ClaimInput) => [message])),
    complete: vi.fn(options.complete ?? (async () => true)),
    hasConsumerReceipt: vi.fn(options.hasReceipt ?? (async () => false)),
    recordConsumerReceipt: vi.fn(options.receipt ?? (async () => true)),
    retryOrDeadLetter: vi.fn(
      options.retry ?? (async () => ({ kind: "retry" as const })),
    ),
  };
}

describe("bounded outbox worker", () => {
  it("exports the worker factory from the server boundary", () => {
    expect(serverModule.createOutboxWorker).toBe(
      workerModule.createOutboxWorker,
    );
  });

  it("starts safely with no product handlers and claims nothing", async () => {
    const outbox = repository();
    const worker = workerModule.createOutboxWorker({
      consumer: "product",
      handlers: {},
      mode: "demo",
      outbox,
      workerId: "worker-1",
    });

    await expect(worker.runOnce()).resolves.toBe(0);
    worker.start();
    await worker.stop();
    expect(outbox.claim).not.toHaveBeenCalled();
  });

  it("uses one-row claims, one random process worker id, and a fresh token per claim", async () => {
    const firstOutbox = repository({ claim: async () => [] });
    const secondOutbox = repository({ claim: async () => [] });
    const firstWorker = workerModule.createOutboxWorker({
      consumer: "foreground",
      handlers: { "moment.created": async () => undefined },
      mode: "demo",
      outbox: firstOutbox,
    });
    const secondWorker = workerModule.createOutboxWorker({
      consumer: "foreground",
      handlers: { "moment.created": async () => undefined },
      mode: "live",
      outbox: secondOutbox,
    });

    await firstWorker.runOnce();
    await firstWorker.runOnce();
    await secondWorker.runOnce();

    const firstClaim = firstOutbox.claim.mock.calls[0]?.[0];
    const nextClaim = firstOutbox.claim.mock.calls[1]?.[0];
    const otherWorkerClaim = secondOutbox.claim.mock.calls[0]?.[0];
    if (!firstClaim || !nextClaim || !otherWorkerClaim) {
      throw new Error("Expected all outbox claim calls");
    }
    expect(firstClaim).toMatchObject({ limit: 1 });
    expect(firstClaim.workerId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(otherWorkerClaim.workerId).toBe(firstClaim.workerId);
    expect(nextClaim.claimToken).not.toBe(firstClaim.claimToken);
    expect(otherWorkerClaim.claimToken).not.toBe(firstClaim.claimToken);
  });

  it("records the consumer receipt after the handler and then completes", async () => {
    const order: string[] = [];
    const outbox = repository({
      complete: async () => {
        order.push("complete");
        return true;
      },
      receipt: async () => {
        order.push("receipt");
        return true;
      },
    });
    const handler = vi.fn(async () => {
      order.push("handler");
    });
    const worker = workerModule.createOutboxWorker({
      consumer: "foreground",
      handlers: { "moment.created": handler },
      mode: "demo",
      outbox,
      workerId: "worker-1",
    });

    await expect(worker.runOnce()).resolves.toBe(1);
    expect(order).toEqual(["handler", "receipt", "complete"]);
    expect(handler).toHaveBeenCalledExactlyOnceWith(
      message,
      expect.any(AbortSignal),
    );
    expect(outbox.retryOrDeadLetter).not.toHaveBeenCalled();
  });

  it("uses an existing receipt after a crash without repeating the handler", async () => {
    let receiptExists = false;
    let completeAttempts = 0;
    const outbox = repository({
      complete: async () => {
        completeAttempts += 1;
        if (completeAttempts === 1) throw new Error("process crashed");
        return true;
      },
      hasReceipt: async () => receiptExists,
      receipt: async () => {
        receiptExists = true;
        return true;
      },
    });
    const handler = vi.fn(async () => undefined);
    const worker = workerModule.createOutboxWorker({
      consumer: "foreground",
      handlers: { "moment.created": handler },
      mode: "demo",
      outbox,
      workerId: "worker-1",
    });

    await expect(worker.runOnce()).rejects.toThrow("process crashed");
    await expect(worker.runOnce()).resolves.toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(outbox.recordConsumerReceipt).toHaveBeenCalledTimes(1);
    expect(outbox.complete).toHaveBeenCalledTimes(2);
  });

  it("backs off a failed handler without writing a receipt", async () => {
    const outbox = repository();
    const handler = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    const worker = workerModule.createOutboxWorker({
      backoffBaseMs: 250,
      backoffMaxMs: 2_000,
      consumer: "foreground",
      handlers: { "moment.created": handler },
      maxAttempts: 3,
      mode: "demo",
      now: () => new Date("2026-07-17T12:00:00.000Z"),
      outbox,
      workerId: "worker-1",
    });

    await expect(worker.runOnce()).resolves.toBe(1);
    expect(outbox.retryOrDeadLetter).toHaveBeenCalledExactlyOnceWith({
      availableAt: "2026-07-17T12:00:00.250Z",
      claimToken: "fixture-claim-one",
      deadLetterId: "dead:demo:outbox-1",
      error: "provider unavailable",
      id: "outbox-1",
      maxAttempts: 3,
      mode: "demo",
      workerId: "worker-1",
    });
    expect(outbox.recordConsumerReceipt).not.toHaveBeenCalled();
    expect(outbox.complete).not.toHaveBeenCalled();
  });

  it("passes an exhausted message through the repository dead-letter path", async () => {
    const exhausted = { ...message, attemptCount: 4 };
    const outbox = repository({
      claim: async () => [exhausted],
      retry: async () => ({ kind: "dead_letter" }),
    });
    const worker = workerModule.createOutboxWorker({
      consumer: "foreground",
      handlers: {
        "moment.created": async () => {
          throw new Error("poison");
        },
      },
      maxAttempts: 4,
      mode: "demo",
      outbox,
      workerId: "worker-1",
    });

    await expect(worker.runOnce()).resolves.toBe(1);
    expect(outbox.retryOrDeadLetter).toHaveBeenCalledWith(
      expect.objectContaining({
        deadLetterId: "dead:demo:outbox-1",
        maxAttempts: 4,
      }),
    );
  });

  it("aborts a never-resolving handler and stops within a bounded interval", async () => {
    let markHandlerStarted: (() => void) | undefined;
    const handlerStarted = new Promise<void>((resolve) => {
      markHandlerStarted = resolve;
    });
    let handlerSignal: AbortSignal | undefined;
    let claimed = false;
    const outbox = repository({
      claim: async () => {
        if (claimed) return [];
        claimed = true;
        return [message];
      },
    });
    const worker = workerModule.createOutboxWorker({
      consumer: "foreground",
      handlerTimeoutMs: 20_000,
      handlers: {
        "moment.created": async (_message, signal) => {
          handlerSignal = signal;
          markHandlerStarted?.();
          await new Promise<void>(() => undefined);
        },
      },
      mode: "demo",
      outbox,
      pollIntervalMs: 60_000,
      workerId: "worker-1",
    });

    worker.start();
    await handlerStarted;
    const outcome = await Promise.race([
      worker.stop().then(() => "stopped" as const),
      new Promise<"timed-out">((resolve) => {
        setTimeout(() => resolve("timed-out"), 100);
      }),
    ]);
    expect(outcome).toBe("stopped");
    expect(handlerSignal?.aborted).toBe(true);
    expect(outbox.complete).not.toHaveBeenCalled();
  });
});
