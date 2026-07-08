// Pathy service worker: app-shell caching (fast start + offline shell),
// Web Push notifications, notification clicks, and push-subscription
// self-healing. Push payloads contain only metadata the server already
// knows (conversation id, sender ref) — never message text, which the
// server does not have in plaintext.

const VERSION = 'v7';
const STATIC_CACHE = `pathy-static-${VERSION}`;
const SHELL = [
  '/',
  '/css/app.css',
  '/js/app.js',
  '/js/api.js',
  '/js/store.js',
  '/shared/crypto.js',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-mono-96.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    await cache.addAll(SHELL).catch(() => {}); // icons may not exist yet in dev
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== STATIC_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

// ------------------------------------------------------------------ fetch

async function networkFirst(req) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const fresh = await fetch(req);
    if (fresh.ok) cache.put(req, fresh.clone());
    return fresh;
  } catch {
    return (await cache.match(req)) || (await cache.match('/')) || Response.error();
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(req);
  const refresh = fetch(req).then((fresh) => {
    if (fresh.ok) cache.put(req, fresh.clone());
    return fresh;
  }).catch(() => null);
  return cached || (await refresh) || Response.error();
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // never intercept live data — the app is online/E2E by design
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/botapi/')
    || url.pathname === '/ws' || url.pathname === '/healthz') return;
  if (e.request.mode === 'navigate') e.respondWith(networkFirst(e.request));
  else e.respondWith(staleWhileRevalidate(e.request));
});

// ------------------------------------------------------------------- push

self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    let data = {};
    try { data = e.data ? e.data.json() : {}; } catch { /* opaque push */ }
    // If Pathy is focused on this device, the page handles the message
    // itself — skip the system notification (Chrome allows this).
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some((w) => w.focused && w.visibilityState === 'visible')) return;
    const from = String(data.from || '').replace(/^[ub]:/, '');
    const title = data.convName
      ? `${from || 'New message'} — ${data.convName}`
      : (from ? `New message from ${from}` : 'New message');
    await self.registration.showNotification(title, {
      body: 'Encrypted message — open Pathy to read it',
      tag: `pathy-${data.convId ?? 'msg'}`,
      icon: '/icon-192.png',       // Android can't render SVG here
      badge: '/icon-mono-96.png',  // monochrome status-bar badge
      data: { convId: data.convId ?? null },
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const convId = e.notification.data?.convId ?? null;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.length > 0) {
      await wins[0].focus().catch(() => {});
      wins[0].postMessage({ type: 'open-conv', convId });
    } else {
      await self.clients.openWindow('/');
    }
  })());
});

// Push services rotate subscriptions; without this handler notifications
// silently die until the user happens to reopen the app. The session token
// is mirrored into IndexedDB by the page (see api.js) so the worker can
// re-register the new subscription on its own.
function idbGetToken() {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open('pathy-sw', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => {
        const db = req.result;
        try {
          const get = db.transaction('kv', 'readonly').objectStore('kv').get('token');
          get.onsuccess = () => { resolve(get.result || null); db.close(); };
          get.onerror = () => { resolve(null); db.close(); };
        } catch { resolve(null); db.close(); }
      };
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

const b64uToBytes = (s) => {
  const b64 = s.replaceAll('-', '+').replaceAll('_', '/');
  return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
};

self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    const token = await idbGetToken();
    if (!token) return;
    let key = e.oldSubscription?.options?.applicationServerKey || null;
    if (!key) {
      const r = await fetch('/api/push/vapid').then((res) => res.json()).catch(() => null);
      if (!r?.key) return;
      key = b64uToBytes(r.key);
    }
    const sub = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    });
    const j = sub.toJSON();
    await fetch('/api/me/push-subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ endpoint: j.endpoint, keys: j.keys }),
    });
  })());
});
