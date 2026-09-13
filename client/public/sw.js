const CACHE_NAME = "vibepulse-v2";
const API_CACHE = "vibepulse-api-v2";
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

// ============================================================
// OFFLINE SOS QUEUE — Background Sync progressive enhancement.
// The real safety net is the page's own online-event flush
// (client/src/lib/sosQueue.ts + SafetyTriggersProvider), which works
// everywhere including iOS/Safari (neither of which supports Background
// Sync at all). This handler is a bonus for browsers that DO support it
// (mainly Android Chrome): it can flush a queued SOS even if the page
// itself isn't open. Plain JS, no ES module import — a service worker
// can't easily import client/src/lib/sosQueue.ts, so the minimal
// IndexedDB open/getAll/delete logic is duplicated here against the
// exact same DB/store name.
const SOS_DB_NAME = "vibepulse-sos";
const SOS_STORE_NAME = "pending";

function openSosDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(SOS_DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(SOS_STORE_NAME)) {
        req.result.createObjectStore(SOS_STORE_NAME, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getAllSosEntries(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SOS_STORE_NAME, "readonly");
    const req = tx.objectStore(SOS_STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function deleteSosEntry(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SOS_STORE_NAME, "readwrite");
    tx.objectStore(SOS_STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getCsrfTokenForSw() {
  // Double-submit cookie CSRF (server/security.ts) — the cookie is
  // httpOnly:false specifically so it can be read here. cookieStore is
  // only available in the same Chromium browsers that support Background
  // Sync in the first place, so this pairing is consistent.
  if (!("cookieStore" in self)) return null;
  const cookie = await self.cookieStore.get("csrf-token");
  return cookie ? cookie.value : null;
}

async function flushSOSQueueFromSW() {
  const db = await openSosDb();
  const entries = await getAllSosEntries(db);
  let flushed = 0;
  const csrfToken = await getCsrfTokenForSw();

  for (const entry of entries) {
    try {
      const res = await fetch("/api/safety/sos", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
        },
        body: JSON.stringify(entry.payload),
      });
      if (res.ok) {
        await deleteSosEntry(db, entry.id);
        flushed++;
      }
    } catch {
      // stays queued, page's online-listener tier will retry too
    }
  }

  if (flushed > 0) {
    const allClients = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of allClients) {
      client.postMessage({ type: "sos-flushed", count: flushed });
    }
  }
}

self.addEventListener("sync", (event) => {
  if (event.tag === "sos-queue") {
    event.waitUntil(flushSOSQueueFromSW());
  }
});

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: "VibePulse", body: event.data.text(), url: "/" };
  }

  const title = payload.title || "VibePulse";
  const options = {
    body: payload.body || "",
    icon: payload.icon || "/pwa-icon-192.png",
    badge: payload.badge || "/favicon.png",
    tag: payload.tag || "vibepulse-notification",
    data: { url: payload.url || "/" },
    renotify: true,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      return clients.openWindow(targetUrl);
    })
  );
});
