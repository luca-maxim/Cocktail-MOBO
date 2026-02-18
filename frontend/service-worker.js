/* Cocktail MOBO – Service Worker (cache-first for static assets) */

const CACHE_NAME = "cocktail-mobo-v2";
const STATIC_ASSETS = ["/", "/index.html", "/style.css", "/app.js", "/manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Let cross-origin requests (CDNs such as Plotly, Google Fonts) bypass the SW
  // entirely. Trying to cache opaque cross-origin responses causes silent failures.
  if (url.origin !== self.location.origin) return;

  // Pass same-origin API calls straight to the network (never cache)
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Cache-first for same-origin static assets
  event.respondWith(
    caches.match(event.request).then(
      (cached) => cached || fetch(event.request).then((response) => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      })
    )
  );
});
