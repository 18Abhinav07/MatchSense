export interface MomentActivation {
  familyId: string;
  fixtureId: string;
  intentId: string;
  kind: "moment" | "test";
  momentIdentity: string;
  revision: number;
  route: string;
  url: string;
}

export interface PendingActivationStore {
  consume(): Promise<unknown>;
}

interface WorkerMessageTarget {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent<unknown>) => void,
  ): void;
}

export interface NotificationActivationOptions {
  onActivation(activation: MomentActivation): void;
  origin: string;
  pendingStore: PendingActivationStore;
  serviceWorker: WorkerMessageTarget;
}

const identifier = /^[A-Za-z0-9_:-]+$/u;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function parseActivationRecord(
  value: unknown,
  origin: string,
): MomentActivation | null {
  const input = record(value);
  if (
    !input ||
    typeof input.fixtureId !== "string" ||
    !identifier.test(input.fixtureId) ||
    input.fixtureId.length > 80 ||
    typeof input.familyId !== "string" ||
    !identifier.test(input.familyId) ||
    input.familyId.length > 240 ||
    typeof input.intentId !== "string" ||
    input.intentId.length < 1 ||
    input.intentId.length > 160 ||
    (input.kind !== "moment" && input.kind !== "test") ||
    typeof input.momentIdentity !== "string" ||
    !Number.isSafeInteger(input.revision) ||
    (input.revision as number) < 1 ||
    typeof input.route !== "string"
  ) {
    return null;
  }

  const revision = input.revision as number;
  const expectedIdentity = `${input.familyId}:${revision}`;
  if (input.momentIdentity !== expectedIdentity) return null;
  const expectedPath = `/matches/${encodeURIComponent(input.fixtureId)}/moments/${encodeURIComponent(expectedIdentity)}`;

  let target: URL;
  try {
    target = new URL(input.route, origin);
  } catch {
    return null;
  }
  if (
    target.origin !== origin ||
    target.search ||
    target.hash ||
    target.pathname !== expectedPath ||
    input.route !== expectedPath
  ) {
    return null;
  }

  return {
    familyId: input.familyId,
    fixtureId: input.fixtureId,
    intentId: input.intentId,
    kind: input.kind,
    momentIdentity: expectedIdentity,
    revision,
    route: expectedPath,
    url: expectedPath,
  };
}

/** Validates only routes that the PWA can safely open after a push tap. */
export function parseMomentActivation(
  value: unknown,
  origin: string,
): MomentActivation | null {
  const input = record(value);
  if (!input) return null;
  if (input.type === "matchsense:open-route") {
    return parseActivationRecord(input.activation, origin);
  }
  // The legacy shape is kept only so a worker and client updated in either
  // order still open the same canonical route during a rolling release.
  if (input.type === "matchsense:open-moment") {
    return parseActivationRecord(input, origin);
  }
  return null;
}

export async function consumePendingActivation(
  pendingStore: PendingActivationStore,
  origin: string,
) {
  try {
    return parseActivationRecord(await pendingStore.consume(), origin);
  } catch {
    return null;
  }
}

/**
 * Installs both paths exactly once: a warm service-worker message and the
 * one-shot durable record left by a cold notification click.
 */
export function installNotificationActivation(
  options: NotificationActivationOptions,
) {
  const seenIntents = new Set<string>();
  const accept = (activation: MomentActivation | null) => {
    if (!activation || seenIntents.has(activation.intentId)) return;
    seenIntents.add(activation.intentId);
    options.onActivation(activation);
  };
  const onMessage = (event: MessageEvent<unknown>) => {
    accept(parseMomentActivation(event.data, options.origin));
  };
  options.serviceWorker.addEventListener("message", onMessage);
  void consumePendingActivation(options.pendingStore, options.origin).then(
    accept,
  );

  return () => {
    options.serviceWorker.removeEventListener("message", onMessage);
  };
}
