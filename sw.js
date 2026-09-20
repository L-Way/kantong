/* Service worker Kantong.
   - Halaman (index.html): jaringan dulu, jatuh ke salinan tersimpan kalau offline atau koneksi lambat (>4 detik),
     jadi kamu selalu dapat versi terbaru saat online dan tetap bisa membuka Kantong tanpa internet.
   - Ikon & berkas statis: pakai salinan tersimpan, diperbarui diam-diam di belakang.
   - Font Google: disimpan supaya tampilan tetap sama saat offline.
   - Pustaka Supabase (cdn.jsdelivr.net): disimpan juga, supaya sinkron akun tetap bisa dimulai saat offline.
   Data keuanganmu TIDAK lewat sini: permintaan ke Supabase (*.supabase.co) sengaja tidak disentuh service worker.
   Tiap kali mengganti index.html/ikon, naikkan VERSION supaya pengguna diberi tahu ada versi baru. */
const VERSION = '2026.09.20-5';
const SHELL = 'kantong-shell-' + VERSION;
const FONTS = 'kantong-fonts-v1';
const LIB = 'kantong-lib-v1';
const PRECACHE = [
  './', './index.html', './manifest.webmanifest', './config.js', './sync.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png', './icons/favicon-32.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k.startsWith('kantong-shell-') && k !== SHELL) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.mode === 'navigate') { e.respondWith(navigate(req)); return; }
  if (url.origin === location.origin) { e.respondWith(sameOrigin(req)); return; }
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') { e.respondWith(fonts(url)); return; }
  if (url.hostname === 'cdn.jsdelivr.net' && url.pathname.indexOf('/npm/@supabase/supabase-js') === 0) { e.respondWith(lib(req)); return; }
});

function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, err => { clearTimeout(t); reject(err); });
  });
}

async function navigate(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await withTimeout(fetch(req), 4000);
    if (res && res.ok) cache.put('./index.html', res.clone());
    return res;
  } catch (err) {
    return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
  }
}

async function sameOrigin(req) {
  const cache = await caches.open(SHELL);
  const cached = await cache.match(req, { ignoreSearch: true });
  const net = fetch(req).then(res => { if (res && res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
  return cached || (await net) || Response.error();
}

async function fonts(url) {
  const cache = await caches.open(FONTS);
  const cached = await cache.match(url.href);
  const net = fetch(url.href, { mode: 'cors', credentials: 'omit' })
    .then(res => { if (res.ok) cache.put(url.href, res.clone()); return res; })
    .catch(() => null);
  return cached || (await net) || Response.error();
}

async function lib(req) {
  const cache = await caches.open(LIB);
  const cached = await cache.match(req.url);
  const net = fetch(req).then(res => { if (res && res.ok) cache.put(req.url, res.clone()); return res; }).catch(() => null);
  return cached || (await net) || Response.error();
}
