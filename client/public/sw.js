const CACHE_NAME = "vibepulse-v1";
const API_CACHE = "vibepulse-api-v1";
const API_MAX_AGE_MS = 5 * 60 * 1000;
const NETWORK_TIMEOUT_MS = 10000;

const STATIC_ASSETS = [
  "/offline.html",
  "/favicon.png",
  "/pwa-icon-192.png",
  "/pwa-icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME && key !== API_CACHE)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

function timeoutPromise(ms) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error("timeout")), ms)
  );
}

async function getFromApiCache(request) {
  const cache = await caches.open(API_CACHE);
  const cached = await cache.match(request);
  if (!cached) return null;
  const timestamp = cached.headers.get("x-sw-cached-at");
  if (timestamp && Date.now() - parseInt(timestamp) > API_MAX_AGE_MS) {
    await cache.delete(request);
    return null;
  }
  return cached;
}

async function putInApiCache(request, response) {
  const cache = await caches.open(API_CACHE);
  const body = await response.arrayBuffer();
  const headers = new Headers(response.headers);
  headers.set("x-sw-cached-at", Date.now().toString());
  const cachedResponse = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  await cache.put(request, cachedResponse);
}

async function networkFirstWithTimeout(request) {
  try {
    const controller = new AbortController();
    const response = await Promise.race([
      fetch(request, { signal: controller.signal }),
      timeoutPromise(NETWORK_TIMEOUT_MS).catch(() => {
        controller.abort();
        return null;
      }),
    ]);

    if (response && response.ok) {
      putInApiCache(request, response.clone()).catch(() => {});
      return response;
    }

    if (response) return response;

    const cached = await getFromApiCache(request);
    return cached || new Response(JSON.stringify({ error: "Offline" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const cached = await getFromApiCache(request);
    return cached || new Response(JSON.stringify({ error: "Offline" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  const networkFetch = fetch(request)
    .then((response) => {
      if (response.ok) {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    networkFetch.catch(() => {});
    return cached;
  }

  const networkResponse = await networkFetch;
  return networkResponse || new Response("Offline", { status: 503 });
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (event.request.method !== "GET") return;

  if (
    url.pathname.startsWith("/api/auth") ||
    url.pathname.startsWith("/api/stripe") ||
    url.pathname.startsWith("/api/webhooks")
  ) {
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(networkFirstWithTimeout(event.request));
    return;
  }

  if (
    url.origin === "https://fonts.googleapis.com" ||
    url.origin === "https://fonts.gstatic.com"
  ) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(event.request).then(
          (cached) =>
            cached ||
            fetch(event.request).then((response) => {
              cache.put(event.request, response.clone()).catch(() => {});
              return response;
            })
        )
      )
    );
    return;
  }

  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request).catch(() => caches.match("/offline.html"))
    );
    return;
  }

  event.respondWith(staleWhileRevalidate(event.request));
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
