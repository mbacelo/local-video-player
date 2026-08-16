/**
 * Service worker: makes the app shell available offline and installable.
 *
 * Only the shell (HTML, CSS, JS, icons) is cached. Video bytes are never
 * touched -- they are read from disk through FileSystemFileHandle and served as
 * blob: URLs, which never reach this fetch handler.
 *
 * Bump CACHE_VERSION whenever a shell file changes; the old cache is dropped on
 * activate and clients are told to reload.
 */

const CACHE_VERSION = 'v1';
const CACHE_NAME = `local-video-player-${CACHE_VERSION}`;

const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/styles.css',
  'js/ui.js',
  'js/db.js',
  'js/library.js',
  'js/player.js',
  'js/progress.js',
  'js/pwa.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // addAll is all-or-nothing; a single 404 would leave the app with no
      // cache at all, so failures are tolerated per-file.
      Promise.all(
        SHELL.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => {})
        )
      )
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      );
      await self.clients.claim();
    })()
  );
});

// Lets the page apply an update without the user closing every tab first.
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: network first, so a deployed update is picked up immediately,
  // with the cached shell as the offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('index.html', copy));
          return response;
        })
        .catch(async () => {
          const cache = await caches.open(CACHE_NAME);
          return (await cache.match('index.html')) ?? (await cache.match('./'));
        })
    );
    return;
  }

  // Everything else: cache first for instant starts, refreshed in the
  // background so the next load gets the newer file.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);

      const network = fetch(request)
        .then((response) => {
          if (response.ok && response.type === 'basic') {
            cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => null);

      return cached ?? (await network) ?? Response.error();
    })()
  );
});
