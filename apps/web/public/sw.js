importScripts("/push-notification.js");

const CACHE = "matchsense-shell-v3";
const SHELL = [
  "/",
  "/manifest.webmanifest",
  "/icons/matchsense-icon.svg",
  "/icons/matchsense-maskable.svg",
  "/push-notification.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  const { pathname } = url;

  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    pathname.startsWith("/api/") ||
    pathname.endsWith("stream.mp3")
  ) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match("/").then((response) => response || Response.error()),
      ),
    );
    return;
  }

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
        const existing = windows.find(
          (client) => new URL(client.url).origin === self.location.origin,
        );
        if (!existing) {
          return self.clients.openWindow(route.url);
        }
        if (route.momentIdentity) {
          existing.postMessage({
            fixtureId: route.fixtureId,
            momentId: route.momentId,
            momentIdentity: route.momentIdentity,
            revision: route.revision,
            type: "matchsense:open-moment",
            url: route.url,
          });
        }
        return existing.focus();
      }),
  );
});
