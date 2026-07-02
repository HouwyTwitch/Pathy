// Pathy service worker: Web Push notifications + notification clicks.
// No fetch handler on purpose — the app itself stays fully online/E2E; the
// worker exists so notifications work in the installed (Android) app and
// arrive even when Pathy is closed. Push payloads contain only metadata the
// server already knows (conversation id, sender ref) — never message text,
// which the server does not have in plaintext.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { /* opaque push */ }
  const from = String(data.from || '').replace(/^[ub]:/, '');
  const title = data.convName
    ? `${from || 'New message'} — ${data.convName}`
    : (from ? `New message from ${from}` : 'New message');
  e.waitUntil(self.registration.showNotification(title, {
    body: 'Encrypted message — open Pathy to read it',
    tag: `pathy-${data.convId ?? 'msg'}`,
    icon: '/icon.svg',
    badge: '/icon.svg',
    data: { convId: data.convId ?? null },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const convId = e.notification.data?.convId ?? null;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.length > 0) {
      await wins[0].focus();
      wins[0].postMessage({ type: 'open-conv', convId });
    } else {
      await self.clients.openWindow('/');
    }
  })());
});
