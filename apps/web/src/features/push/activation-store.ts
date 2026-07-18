import type { PendingActivationStore } from "../../notification-activation.js";

export const ACTIVATION_DATABASE = "matchsense-push-activation-v1";
export const ACTIVATION_STORE = "pending-activations";

export interface StoredPendingActivation {
  activation: unknown;
  createdAt: number;
  expiresAt: number;
  intentId: string;
}

interface ActivationStoreOptions {
  indexedDb?: IDBFactory | null | undefined;
  now?: (() => number) | undefined;
}

function isStoredPendingActivation(
  value: unknown,
): value is StoredPendingActivation {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredPendingActivation>;
  return (
    typeof candidate.intentId === "string" &&
    Number.isSafeInteger(candidate.createdAt) &&
    Number.isSafeInteger(candidate.expiresAt) &&
    "activation" in candidate
  );
}

export function selectPendingActivation(
  records: readonly StoredPendingActivation[],
  now: number,
) {
  return (
    records
      .filter((record) => record.expiresAt > now)
      .sort((left, right) => right.createdAt - left.createdAt)[0] ?? null
  );
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB failed"));
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

function openActivationDatabase(indexedDb: IDBFactory) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDb.open(ACTIVATION_DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(ACTIVATION_STORE)) {
        request.result.createObjectStore(ACTIVATION_STORE, {
          keyPath: "intentId",
        });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not open activation storage"));
  });
}

/**
 * The service worker writes records before a cold open. This page-side store
 * consumes (and deletes) exactly one unexpired record, so an old alert cannot
 * route a later launch.
 */
export function createPendingActivationStore(
  options: ActivationStoreOptions = {},
): PendingActivationStore {
  const indexedDb =
    options.indexedDb ?? (typeof indexedDB === "undefined" ? null : indexedDB);
  const now = options.now ?? Date.now;

  return {
    async consume() {
      if (!indexedDb) return null;
      let database: IDBDatabase | null = null;
      try {
        database = await openActivationDatabase(indexedDb);
        const transaction = database.transaction(ACTIVATION_STORE, "readwrite");
        const completion = transactionDone(transaction);
        const store = transaction.objectStore(ACTIVATION_STORE);
        const records = (await requestResult(store.getAll())).filter(
          isStoredPendingActivation,
        );
        const selected = selectPendingActivation(records, now());
        for (const record of records) {
          if (
            record.expiresAt <= now() ||
            record.intentId === selected?.intentId
          ) {
            store.delete(record.intentId);
          }
        }
        await completion;
        return selected?.activation ?? null;
      } catch {
        return null;
      } finally {
        database?.close();
      }
    },
  };
}
