'use strict';

/*
 * Umbra service worker — makes the game installable and able to open offline.
 *
 * It caches the app shell (HTML/CSS/JS + Leaflet) so the game launches with no
 * network. Live gameplay still needs the network (WebSocket + map tiles); only
 * the shell is cached. Map tiles are deliberately NOT cached (they're huge and
 * change by location).
 */

const CACHE = 'umbra-shell-v1';

// Local shell — must cache for the app to open offline.
const CORE = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable.png',
  'apple-touch-icon.png',
];

// Third-party assets — cache if we can, but never fail the install over them.
// (They also get cached on first use by the fetch handler below.)
const EXTRA = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(CORE); // required
    await Promise.allSettled(EXTRA.map((u) => c.add(u))); // best-effort
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never cache map tiles — let them hit the network.
  if (url.hostname.endsWith('tile.openstreetmap.org')) return;

  // Navigation requests: serve the cached shell so the app opens offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(() => caches.match('index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  // Everything else (own assets + Leaflet CDN): cache-first, then network,
  // and refresh the cache in the background.
  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok && (url.origin === self.location.origin || url.hostname === 'unpkg.com')) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
