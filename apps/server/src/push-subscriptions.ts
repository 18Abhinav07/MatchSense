import { randomUUID } from "node:crypto";

import { z } from "zod";

const base64Url = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/u);

const pushSubscriptionSchema = z
  .object({
    endpoint: z.string().min(1).max(4_096),
    expirationTime: z.number().finite().nonnegative().nullable(),
    keys: z
      .object({
        auth: base64Url,
        p256dh: base64Url,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    let endpoint: URL;
    try {
      endpoint = new URL(value.endpoint);
    } catch {
      context.addIssue({ code: "custom", message: "Invalid endpoint URL" });
      return;
    }
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username !== "" ||
      endpoint.password !== ""
    ) {
      context.addIssue({ code: "custom", message: "Unsafe endpoint URL" });
    }
    const auth = decodeCanonicalBase64Url(value.keys.auth);
    const p256dh = decodeCanonicalBase64Url(value.keys.p256dh);
    if (!auth || auth.byteLength !== 16) {
      context.addIssue({ code: "custom", message: "Invalid auth key" });
    }
    if (!p256dh || p256dh.byteLength !== 65 || p256dh[0] !== 4) {
      context.addIssue({ code: "custom", message: "Invalid p256dh key" });
    }
  });

function decodeCanonicalBase64Url(value: string) {
  try {
    const bytes = Buffer.from(value, "base64url");
    return bytes.toString("base64url") === value ? bytes : null;
  } catch {
    return null;
  }
}

export interface SerializedPushSubscription {
  endpoint: string;
  expirationTime: number | null;
  keys: { auth: string; p256dh: string };
}

export interface PushSubscriptionRegistration {
  createdAt: string;
  id: string;
  subscription: SerializedPushSubscription;
  updatedAt: string;
}

export class PushSubscriptionExpiredError extends Error {
  constructor() {
    super("Push subscription has expired");
    this.name = "PushSubscriptionExpiredError";
  }
}

export function parsePushSubscription(
  input: unknown,
): SerializedPushSubscription {
  const parsed = pushSubscriptionSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error("Push subscription is invalid");
  }
  return cloneSubscription(parsed.data);
}

function cloneSubscription(
  subscription: SerializedPushSubscription,
): SerializedPushSubscription {
  return {
    endpoint: subscription.endpoint,
    expirationTime: subscription.expirationTime,
    keys: { ...subscription.keys },
  };
}

function cloneRegistration(
  registration: PushSubscriptionRegistration,
): PushSubscriptionRegistration {
  return {
    ...registration,
    subscription: cloneSubscription(registration.subscription),
  };
}

export class InMemoryPushSubscriptionStore {
  readonly #byEndpoint = new Map<string, string>();
  readonly #byId = new Map<string, PushSubscriptionRegistration>();
  readonly #id: () => string;
  readonly #now: () => number;

  constructor(options: { id?: () => string; now?: () => number } = {}) {
    this.#id = options.id ?? randomUUID;
    this.#now = options.now ?? Date.now;
  }

  upsert(input: unknown): PushSubscriptionRegistration {
    const subscription = parsePushSubscription(input);
    const now = this.#now();
    if (
      subscription.expirationTime !== null &&
      subscription.expirationTime <= now
    ) {
      throw new PushSubscriptionExpiredError();
    }
    this.#prune(now);
    const existingId = this.#byEndpoint.get(subscription.endpoint);
    const existing = existingId ? this.#byId.get(existingId) : undefined;
    const timestamp = new Date(now).toISOString();
    const registration: PushSubscriptionRegistration = {
      createdAt: existing?.createdAt ?? timestamp,
      id: existing?.id ?? this.#id(),
      subscription,
      updatedAt: timestamp,
    };
    this.#byId.set(registration.id, registration);
    this.#byEndpoint.set(subscription.endpoint, registration.id);
    return cloneRegistration(registration);
  }

  get(id: string): PushSubscriptionRegistration | null {
    this.#prune(this.#now());
    const registration = this.#byId.get(id);
    return registration ? cloneRegistration(registration) : null;
  }

  list(): PushSubscriptionRegistration[] {
    this.#prune(this.#now());
    return [...this.#byId.values()].map(cloneRegistration);
  }

  remove(id: string): boolean {
    const registration = this.#byId.get(id);
    if (!registration) return false;
    this.#byId.delete(id);
    this.#byEndpoint.delete(registration.subscription.endpoint);
    return true;
  }

  #prune(now: number) {
    for (const [id, registration] of this.#byId) {
      const expiry = registration.subscription.expirationTime;
      if (expiry !== null && expiry <= now) {
        this.remove(id);
      }
    }
  }
}
