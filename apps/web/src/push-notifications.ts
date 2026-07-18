export interface SerializedPushSubscription {
  endpoint: string;
  expirationTime: number | null;
  keys: { auth: string; p256dh: string };
}

export interface MomentPushInput {
  body: string;
  familyId?: string;
  fixtureId: string;
  momentId: string;
  occurredAt: string;
  revision: number;
  title: string;
}

/** Matches the factual server payload used by the service-worker contract. */
export interface PushPayloadV1 extends MomentPushInput {
  familyId: string;
  identity: string;
  intentId: string;
  kind: "moment" | "test";
  route: string;
  schemaVersion: 1;
  tag: string;
  type: "matchsense.moment";
}

interface NotificationPermissionAdapter {
  readonly permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
}

export interface BrowserPushDependencies {
  fetch: typeof fetch;
  notification: NotificationPermissionAdapter | null;
  serviceWorkerReady: Promise<ServiceWorkerRegistration> | null;
}

interface ServiceWorkerNotificationOptions extends NotificationOptions {
  renotify: boolean;
  timestamp: number;
}

function defaultDependencies(): BrowserPushDependencies {
  const supportsNotifications = "Notification" in globalThis;
  const supportsServiceWorkers =
    "navigator" in globalThis && "serviceWorker" in navigator;
  return {
    fetch: globalThis.fetch.bind(globalThis),
    notification: supportsNotifications
      ? {
          get permission() {
            return Notification.permission;
          },
          requestPermission: () => Notification.requestPermission(),
        }
      : null,
    serviceWorkerReady: supportsServiceWorkers
      ? navigator.serviceWorker.ready
      : null,
  };
}

function csrfHeaders() {
  if (typeof document === "undefined") return {};
  const entry = document.cookie
    .split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith("matchsense_csrf="));
  const token = entry?.slice("matchsense_csrf=".length);
  return token ? { "x-matchsense-csrf": decodeURIComponent(token) } : {};
}

function bytesToBase64Url(value: ArrayBuffer) {
  let binary = "";
  for (const byte of new Uint8Array(value)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlToBytes(value: string) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error("Application server key is invalid");
  }
  const padded = `${value}${"=".repeat((4 - (value.length % 4)) % 4)}`;
  let binary: string;
  try {
    binary = atob(padded.replaceAll("-", "+").replaceAll("_", "/"));
  } catch {
    throw new Error("Application server key is invalid");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.byteLength !== 65 || bytes[0] !== 4) {
    throw new Error("Application server key is invalid");
  }
  return bytes;
}

export function serializePushSubscription(
  subscription: PushSubscription,
): SerializedPushSubscription {
  const json = subscription.toJSON();
  const auth = json.keys?.auth ?? subscription.getKey("auth");
  const p256dh = json.keys?.p256dh ?? subscription.getKey("p256dh");
  if (!auth || !p256dh) {
    throw new Error("Push subscription encryption keys are unavailable");
  }
  return {
    endpoint: subscription.endpoint,
    expirationTime: subscription.expirationTime ?? null,
    keys: {
      auth: typeof auth === "string" ? auth : bytesToBase64Url(auth),
      p256dh: typeof p256dh === "string" ? p256dh : bytesToBase64Url(p256dh),
    },
  };
}

export async function enableMomentPush(options: {
  applicationServerKey: string;
  dependencies?: BrowserPushDependencies;
}) {
  const dependencies = options.dependencies ?? defaultDependencies();
  if (!dependencies.notification || !dependencies.serviceWorkerReady) {
    throw new Error("Push notifications are not supported on this device");
  }
  const permission =
    dependencies.notification.permission === "default"
      ? await dependencies.notification.requestPermission()
      : dependencies.notification.permission;
  if (permission !== "granted") {
    throw new Error("Notification permission was denied");
  }
  const registration = await dependencies.serviceWorkerReady;
  if (!("pushManager" in registration)) {
    throw new Error("Push notifications are not supported on this device");
  }
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      applicationServerKey: base64UrlToBytes(options.applicationServerKey),
      userVisibleOnly: true,
    }));
  const serialized = serializePushSubscription(subscription);
  const response = await dependencies.fetch("/api/v1/push/subscriptions", {
    body: JSON.stringify({ subscription: serialized }),
    headers: { "Content-Type": "application/json", ...csrfHeaders() },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error("MatchSense could not save this notification subscription");
  }
  const result = (await response.json()) as { id?: unknown };
  if (typeof result.id !== "string" || result.id.length === 0) {
    throw new Error("MatchSense returned an invalid notification registration");
  }
  return { id: result.id, subscription: serialized };
}

export function momentDeepLink(input: MomentPushInput) {
  const identity = `${input.familyId ?? input.momentId}:${input.revision}`;
  return `/matches/${encodeURIComponent(input.fixtureId)}/moments/${encodeURIComponent(identity)}`;
}

export function momentNotificationOptions(
  input: MomentPushInput,
): ServiceWorkerNotificationOptions {
  const familyId = input.familyId ?? input.momentId;
  const identity = `${familyId}:${input.revision}`;
  const route = momentDeepLink({ ...input, familyId });
  return {
    body: input.body,
    data: {
      familyId,
      fixtureId: input.fixtureId,
      identity,
      intentId: `preview_${input.fixtureId}_${familyId}_${input.revision}`,
      kind: "test",
      momentIdentity: identity,
      revision: input.revision,
      route,
      url: route,
    },
    icon: "/icons/matchsense-icon.svg",
    renotify: true,
    tag: `matchsense:preview:${input.fixtureId}:${familyId}`,
    timestamp: Date.parse(input.occurredAt),
  };
}

export async function showLocalMomentNotification(
  input: MomentPushInput,
  registration?: ServiceWorkerRegistration,
) {
  const activeRegistration =
    registration ?? (await navigator.serviceWorker.ready);
  await activeRegistration.showNotification(
    input.title,
    momentNotificationOptions(input),
  );
}

export async function triggerTestMomentPush(
  registrationId: string,
  input: MomentPushInput,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher(
    `/api/v1/push/subscriptions/${encodeURIComponent(registrationId)}/test`,
    {
      body: JSON.stringify(input),
      headers: { "Content-Type": "application/json", ...csrfHeaders() },
      method: "POST",
    },
  );
  if (!response.ok) {
    throw new Error("MatchSense could not deliver the test notification");
  }
}
