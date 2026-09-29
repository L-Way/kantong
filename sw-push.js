/* Kantong: penerima notifikasi push (Web Push).
   Didaftarkan oleh index.html di scope tersendiri ('_push/'), jadi TIDAK mengganggu sw.js milik aplikasi.
   Letakkan file ini di folder yang sama dengan index.html. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Kantong', {
    body: d.body || '',
    tag: d.tag || 'kantong',
    renotify: true,
    data: { a: d.a || '' }
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const a = (e.notification.data && e.notification.data.a) || '';
  const root = self.registration.scope.replace(/_push\/$/, '');
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = list.find((c) => c.url.indexOf(root) === 0);
    if (open) {
      try { open.postMessage({ kt: 'go', a }); } catch (_) {}
      return open.focus();
    }
    return self.clients.openWindow(root + (a ? '?a=' + encodeURIComponent(a) : ''));
  })());
});
