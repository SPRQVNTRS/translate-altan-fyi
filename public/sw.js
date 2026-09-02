// translate.altan.fyi service worker, hand-rolled. No Workbox. Modelled on
// openplate/public/sw.js.
//
// The shape is deliberately conservative. This app's whole reason to exist is
// telling you what a word means, and a cached answer is indistinguishable from
// a live one. So route data is NEVER cached: no `.data` request, no loader or
// action response, no `/api/*` call, and nothing carrying a query string. The
// worker caches the shell (the HTML that draws the chrome) and the built
// assets, and nothing else.
//
// Bump CACHE_VERSION whenever the shell routes change. An install that already
// ran an older shell keeps its old `pages-*` cache forever otherwise, because
// nothing ever re-adds a newly listed entry to it.
const CACHE_VERSION = 'v1';
const STATIC_CACHE = `static-${CACHE_VERSION}`;
const PAGES_CACHE = `pages-${CACHE_VERSION}`;

// The shell routes, precached on install so the app boots and navigates with
// no network. `/offline` is the fallback a failed navigation lands on.
const APP_SHELL = ['/', '/lists', '/history', '/settings', '/account', '/offline'];

// ---------------------------------------------------------------------------
// Install, precache the app shell (resiliently)
// ---------------------------------------------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil(precacheAppShell().then(() => self.skipWaiting()));
});

async function precacheAppShell() {
  const cache = await caches.open(PAGES_CACHE);
  // Per-URL and tolerant, not a single atomic `addAll`: a route that redirects
  // at install time or one transient network blip must not abort the whole
  // install. The runtime network-first handler backfills anything skipped here
  // on the first successful visit.
  await Promise.all(
    APP_SHELL.map(async (path) => {
      try {
        const response = await fetch(path, { credentials: 'same-origin' });
        if (response.ok && !response.redirected) {
          await cache.put(path, response);
        }
      } catch {
        // Offline or blocked during install, fill on first visit instead.
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Activate, purge caches from older versions, then take over open pages
// ---------------------------------------------------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((n) => (n.startsWith('static-') || n.startsWith('pages-')) && !n.includes(CACHE_VERSION))
            .map((n) => caches.delete(n)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// ---------------------------------------------------------------------------
// Fetch, per-request-type strategies, with route data bypassed entirely
// ---------------------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // A non-GET is a mutation. It always goes straight to the network.
  if (request.method !== 'GET') return;
  if (!request.url.startsWith('http')) return;

  const url = new URL(request.url);

  // Only same-origin GETs are cached. Anything external stays untouched.
  if (url.origin !== self.location.origin) return;

  // The whole no-stale-answers rule, in one guard. Route data, API calls and
  // any URL carrying a query string reach the network untouched, and are never
  // written to a cache.
  if (isUncacheable(url)) return;

  if (isStaticAsset(url, request)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // The `/offline` HTML fallback is for document navigations only, never for a
  // background fetch, which would otherwise receive a page where it expected
  // data.
  const fallback = request.mode === 'navigate' ? '/offline' : undefined;
  event.respondWith(networkFirst(request, PAGES_CACHE, fallback));
});

// ---------------------------------------------------------------------------
// Request classifiers
// ---------------------------------------------------------------------------

/**
 * Never cache: react-router's single-fetch route data (the `.data` suffix,
 * with or without a `_routes` search param), any `/api/` endpoint, and any URL
 * with a query string. A loader or action response is live data by definition,
 * and a query string means the URL names a specific answer rather than a
 * shell.
 */
function isUncacheable(url) {
  if (url.pathname.endsWith('.data')) return true;
  if (url.pathname.startsWith('/api/')) return true;
  if (url.search !== '') return true;
  return false;
}

function isStaticAsset(url, request) {
  return (
    request.destination === 'script' ||
    request.destination === 'style' ||
    request.destination === 'font' ||
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname.startsWith('/fonts/') ||
    /\.(js|css|woff2?|ttf|eot|png|svg|ico|webmanifest)$/i.test(url.pathname)
  );
}

// ---------------------------------------------------------------------------
// Caching strategies
// ---------------------------------------------------------------------------
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('', { status: 503, statusText: 'Offline' });
  }
}

async function networkFirst(request, cacheName, fallbackUrl) {
  try {
    const response = await fetch(request);
    // `!response.redirected` matters: caching a followed response would store
    // the destination's HTML under the requested path.
    if (response.ok && !response.redirected) {
      const cache = await caches.open(cacheName);
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;

    if (fallbackUrl) {
      const fallback = await caches.match(fallbackUrl);
      if (fallback) return fallback;
    }

    return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

// ---------------------------------------------------------------------------
// Messages, SKIP_WAITING (update flow) and CLEAR_CACHE
// ---------------------------------------------------------------------------
self.addEventListener('message', (event) => {
  const { data } = event;
  if (!data || !data.type) return;

  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (data.type === 'CLEAR_CACHE') {
    event.waitUntil(caches.keys().then((names) => Promise.all(names.map((n) => caches.delete(n)))));
  }
});
