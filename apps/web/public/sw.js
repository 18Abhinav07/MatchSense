importScripts("/push-notification.js");

const CACHE = "matchsense-shell-v4";
const ACTIVATION_DATABASE = "matchsense-push-activation-v1";
const ACTIVATION_STORE = "pending-activations";
const ACTIVATION_TTL_MS = 90_000;
const SHELL = [
  "/",
  "/manifest.webmanifest",
  "/icons/matchsense-icon.svg",
  "/icons/matchsense-maskable.svg",
  "/push-notification.js",
];

function requestHeader(request, name) {
  return request.headers && typeof request.headers.get === "function"
    ? request.headers.get(name)
    : null;
}

function shouldBypassCache(request, url) {
  const accept = requestHeader(request, "accept") || "";
  const range = requestHeader(request, "range");
  return (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname.endsWith(".mp3") ||
    accept.includes("text/event-stream") ||
    accept.startsWith("audio/") ||
    Boolean(range)
  );
}

function shouldCacheStatic(url) {
  return (
    SHELL.includes(url.pathname) ||
    url.pathname.startsWith("/assets/") ||
    /\.(?:css|ico|js|json|png|svg|webp|woff2?)$/u.test(url.pathname)
  );
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error || new Error("Activation write failed"));
    transaction.onabort = () =>
      reject(transaction.error || new Error("Activation write aborted"));
  });
}

function openActivationDatabase() {
  const factory =
    self.indexedDB || (typeof indexedDB === "undefined" ? null : indexedDB);
  if (!factory) return Promise.reject(new Error("IndexedDB is unavailable"));
  return new Promise((resolve, reject) => {
    const request = factory.open(ACTIVATION_DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(ACTIVATION_STORE)) {
        request.result.createObjectStore(ACTIVATION_STORE, {
          keyPath: "intentId",
        });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("Activation storage unavailable"));
  });
}

function activationRecord(route) {
  if (
    !route ||
    typeof route.intentId !== "string" ||
    typeof route.fixtureId !== "string" ||
    typeof route.familyId !== "string" ||
    typeof route.momentIdentity !== "string" ||
    typeof route.revision !== "number" ||
    (route.kind !== "moment" && route.kind !== "test") ||
    typeof route.url !== "string"
  ) {
    return null;
  }
  const createdAt = Date.now();
  return {
    activation: {
      familyId: route.familyId,
      fixtureId: route.fixtureId,
      intentId: route.intentId,
      kind: route.kind,
      momentIdentity: route.momentIdentity,
      revision: route.revision,
      route: route.url,
    },
    createdAt,
    expiresAt: createdAt + ACTIVATION_TTL_MS,
    intentId: route.intentId,
  };
}

async function persistWithIndexedDb(route) {
  const record = activationRecord(route);
  if (!record) return;
  const database = await openActivationDatabase();
  try {
    const transaction = database.transaction(ACTIVATION_STORE, "readwrite");
    const completion = transactionDone(transaction);
    transaction.objectStore(ACTIVATION_STORE).put(record);
    await completion;
  } finally {
    database.close();
  }
}

function persistPendingActivation(route) {
  // The injection seam is only reachable in a worker test realm. Production
  // persists through IndexedDB, shared with the PWA bootstrap store.
  if (
    self.MatchSenseActivationStore &&
    typeof self.MatchSenseActivationStore.persist === "function"
  ) {
    return self.MatchSenseActivationStore.persist(route);
  }
  return persistWithIndexedDb(route);
}

function routeMessage(route) {
  return {
    activation: {
      familyId: route.familyId,
      fixtureId: route.fixtureId,
      intentId: route.intentId,
      kind: route.kind,
      momentIdentity: route.momentIdentity,
      revision: route.revision,
      route: route.url,
    },
    type: "matchsense:open-route",
  };
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) => key.startsWith("matchsense-shell-") && key !== CACHE,
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (shouldBypassCache(request, url)) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match("/").then((response) => response || Response.error()),
      ),
    );
    return;
  }
  if (!shouldCacheStatic(url)) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (!response.ok) return response;
        const copy = response.clone();
        void caches.open(CACHE).then((cache) => cache.put(request, copy));
        return response;
      });
    }),
  );
});

self.addEventListener("push", (event) => {
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    payload = null;
  }
  const presentation = self.MatchSensePush.notificationFor(payload);
  event.waitUntil(
    self.registration.showNotification(
      presentation.title,
      presentation.options,
    ),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const route = self.MatchSensePush.routeFromNotificationData(
    event.notification.data,
  );
  event.waitUntil(
    self.clients
      .matchAll({ includeUncontrolled: true, type: "window" })
      .then(async (windows) => {
        const existing = windows.find((client) => {
          try {
            return new URL(client.url).origin === self.location.origin;
          } catch {
            return false;
          }
        });
        if (existing) {
          if (route.intentId) existing.postMessage(routeMessage(route));
          return existing.focus();
        }
        if (route.intentId) {
          await persistPendingActivation(route).catch(() => undefined);
        }
        return self.clients.openWindow(route.url);
      }),
  );
});
