// Onde? service worker: makes the game installable and opens fast.
// Same-origin files: network first (so updates arrive at once), cache as backup.
// Libraries and fonts from CDNs: served from cache, refreshed in the background.
// Imagery, maps and APIs are never cached here.
const CACHE = 'onde-v12';
const SHELL = ['./', 'index.html', 'style.css?v=12', 'js/app.js?v=12', 'js/street.js?v=12', 'js/seeds.js?v=12', 'js/config.js?v=12', 'js/leaderboard.js?v=12', 'js/duel.js?v=12', 'js/party.js?v=12',
  'data/coverage.json?v=12', 'data/fallback.json', 'manifest.webmanifest', 'icons/icon-192.png'];
const CDN = /^https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match('./'))));
  } else if (CDN.test(req.url)) {
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req);
      const fresh = fetch(req).then((res) => { if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || fresh;
    }));
  }
});
