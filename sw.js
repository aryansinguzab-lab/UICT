/* ═══════════════════════════════════════════════════════════════
   UIICT Campus Navigator — Service Worker
   Strategy:
     • App shell (HTML, CSS, JS, fonts) → Cache First
     • Map tiles (OpenStreetMap / satellite) → Stale-While-Revalidate
     • Everything else → Network First with cache fallback
   ═══════════════════════════════════════════════════════════════ */

const APP_VERSION   = 'v1.0.0';
const SHELL_CACHE   = `uict-shell-${APP_VERSION}`;
const TILES_CACHE   = `uict-tiles-${APP_VERSION}`;
const RUNTIME_CACHE = `uict-runtime-${APP_VERSION}`;

/* Max number of tile images to keep cached (tiles can be large) */
const TILE_CACHE_LIMIT = 500;

/* Resources to pre-cache on install — the app shell */
const SHELL_ASSETS = [
  './index.html',
  './manifest.json',
  /* Leaflet CSS & JS from CDN — cached on install so map works offline */
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  /* Google Fonts — cached for offline use */
  'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Outfit:wght@300;400;500;600&display=swap',
];

/* ── INSTALL — pre-cache the app shell ───────────────────────── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => {
        console.log('[SW] Pre-caching app shell…');
        /* addAll fails if any request fails; use individual adds to be resilient */
        return Promise.allSettled(
          SHELL_ASSETS.map(url =>
            cache.add(url).catch(err =>
              console.warn(`[SW] Could not pre-cache: ${url}`, err)
            )
          )
        );
      })
      .then(() => {
        console.log('[SW] Install complete — skipping waiting');
        return self.skipWaiting();
      })
  );
});

/* ── ACTIVATE — clean up old caches ──────────────────────────── */
self.addEventListener('activate', event => {
  const currentCaches = [SHELL_CACHE, TILES_CACHE, RUNTIME_CACHE];
  event.waitUntil(
    caches.keys()
      .then(cacheNames =>
        Promise.all(
          cacheNames
            .filter(name => !currentCaches.includes(name))
            .map(name => {
              console.log(`[SW] Deleting old cache: ${name}`);
              return caches.delete(name);
            })
        )
      )
      .then(() => {
        console.log('[SW] Activated — claiming clients');
        return self.clients.claim();
      })
  );
});

/* ── FETCH — routing logic ───────────────────────────────────── */
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  /* Skip non-GET and chrome-extension requests */
  if (request.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;

  /* ── Map Tiles: Stale-While-Revalidate ──────────────────────
     Tile URLs from OpenStreetMap, Esri satellite, CartoDB, etc.
     Serve cached tile instantly, refresh in background.          */
  if (isTileRequest(url)) {
    event.respondWith(tileStrategy(request));
    return;
  }

  /* ── App Shell: Cache First ─────────────────────────────────
     The HTML file, Leaflet, fonts — serve from cache, fallback
     to network if not cached yet.                               */
  if (isShellAsset(url)) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }

  /* ── Everything Else: Network First ─────────────────────────
     Try network, fall back to cache, last resort: offline page.  */
  event.respondWith(networkFirst(request, RUNTIME_CACHE));
});

/* ── STRATEGY: Cache First ───────────────────────────────────── */
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return offlineFallback(request);
  }
}

/* ── STRATEGY: Network First ─────────────────────────────────── */
async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || offlineFallback(request);
  }
}

/* ── STRATEGY: Stale-While-Revalidate (for tiles) ────────────── */
async function tileStrategy(request) {
  const cache  = await caches.open(TILES_CACHE);
  const cached = await cache.match(request);

  /* Kick off background refresh regardless */
  const networkFetch = fetch(request)
    .then(async response => {
      if (response.ok) {
        await cache.put(request, response.clone());
        await trimTileCache(cache);
      }
      return response;
    })
    .catch(() => null);

  /* Return cached tile immediately if we have it */
  return cached || networkFetch;
}

/* ── TILE CACHE TRIMMING — keep storage bounded ──────────────── */
async function trimTileCache(cache) {
  const keys = await cache.keys();
  if (keys.length > TILE_CACHE_LIMIT) {
    /* Delete oldest entries first */
    const toDelete = keys.slice(0, keys.length - TILE_CACHE_LIMIT);
    await Promise.all(toDelete.map(k => cache.delete(k)));
  }
}

/* ── OFFLINE FALLBACK ─────────────────────────────────────────── */
function offlineFallback(request) {
  /* For navigation requests, try returning the cached HTML */
  if (request.destination === 'document') {
    return caches.match('./index.html');
  }
  /* For tiles, return a transparent 1×1 PNG */
  if (isTileRequest(new URL(request.url))) {
    return new Response(
      atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),
      { headers: { 'Content-Type': 'image/png' } }
    );
  }
  return new Response('Offline — content not cached', {
    status: 503,
    headers: { 'Content-Type': 'text/plain' }
  });
}

/* ── HELPERS ──────────────────────────────────────────────────── */
function isTileRequest(url) {
  return (
    url.hostname.includes('tile.openstreetmap.org')     ||
    url.hostname.includes('arcgisonline.com')            ||
    url.hostname.includes('basemaps.cartocdn.com')       ||
    url.hostname.includes('tiles.stadiamaps.com')        ||
    url.hostname.includes('mt0.google.com')              ||
    url.hostname.includes('mt1.google.com')              ||
    url.hostname.includes('server.arcgisonline.com')     ||
    /* Generic tile path patterns */
    /\/\d+\/\d+\/\d+\.(png|jpg|jpeg|webp)/.test(url.pathname)
  );
}

function isShellAsset(url) {
  return (
    SHELL_ASSETS.some(asset => url.href === asset || url.pathname.endsWith('index.html')) ||
    url.hostname.includes('fonts.googleapis.com')  ||
    url.hostname.includes('fonts.gstatic.com')     ||
    url.hostname.includes('cdnjs.cloudflare.com')
  );
}

/* ── BACKGROUND SYNC (future-proofing) ───────────────────────── */
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'GET_VERSION') {
    event.ports[0].postMessage({ version: APP_VERSION });
  }
});
