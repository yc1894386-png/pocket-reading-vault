const CACHE_NAME = "vellum-v-step6-pwa-20260630";
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest"
];

const STATIC_EXTENSIONS = /\.(?:css|js|webmanifest|png|jpg|jpeg|gif|svg|ico|woff2?)$/i;
const API_PATH_PATTERN = /(?:^|\/)(?:api|cloud)(?:\/|$)/i;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .catch(() => undefined)
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

function isCacheSafeRequest(request) {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.protocol === "http:" && self.location.protocol !== "http:") return false;
  if (API_PATH_PATTERN.test(url.pathname)) return false;
  return true;
}

function networkFirst(request, fallbackUrl) {
  return fetch(request)
    .then((response) => {
      if (response && response.ok && isCacheSafeRequest(request)) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => undefined);
      }
      return response;
    })
    .catch(() => caches.match(request).then((cached) => cached || (fallbackUrl ? caches.match(fallbackUrl) : undefined)));
}

function staleWhileRevalidate(request) {
  return caches.match(request).then((cached) => {
    const refresh = fetch(request).then((response) => {
      if (response && response.ok && isCacheSafeRequest(request)) {
        caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone())).catch(() => undefined);
      }
      return response;
    });
    return cached || refresh;
  });
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (!isCacheSafeRequest(request)) return;

  const url = new URL(request.url);
  if (request.mode === "navigate" || url.pathname.endsWith("/index.html")) {
    event.respondWith(networkFirst(request, "./index.html"));
    return;
  }

  if (["/app.js", "/styles.css", "/sw.js", "/manifest.webmanifest"].some((path) => url.pathname.endsWith(path))) {
    event.respondWith(networkFirst(request));
    return;
  }

  if (STATIC_EXTENSIONS.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});
