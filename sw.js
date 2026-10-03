/* Apex Convoy -- offline support service worker.

   Two independent caches:
   - SHELL_CACHE: the app itself (index.html), so the UI still opens with no
     signal. Network-first: always tries to fetch the latest version first,
     and only falls back to the cached copy if that fails.
   - TILE_CACHE: map tiles from tile.openstreetmap.org. Stale-while-revalidate:
     serves an already-cached tile instantly (so panning a previously-seen
     area works offline), while quietly re-fetching in the background to
     keep it fresh for next time. Capped at MAX_TILES entries so this can't
     grow without bound on a phone with limited storage; oldest-cached tiles
     are evicted first once the cap is hit (a simple approximation of LRU,
     not a true one -- the Cache API doesn't track last-read time).

   Bump SHELL_CACHE's version suffix whenever you want to force every
   client to drop old app-shell files on their next visit. Leave TILE_CACHE
   alone across normal updates -- there's no reason to throw away someone's
   already-downloaded map tiles just because the app code changed; bump it
   only if you need to force a one-time full tile-cache reset.
*/
const SHELL_CACHE = 'apex-convoy-shell-v1';
const TILE_CACHE = 'apex-convoy-tiles-v1';
const TILE_HOSTS = ['tile.openstreetmap.org'];

// Testability hook only: ?maxTiles=N on the registration URL overrides the cap, so
// a test can verify eviction without downloading thousands of real tiles first.
// The app's real registration call never adds this parameter, so production always
// uses the default.
const MAX_TILES = Number(new URL(self.location.href).searchParams.get('maxTiles')) || 2000;

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(SHELL_CACHE).then(c => c.add('./')).catch(() => {}));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== SHELL_CACHE && k !== TILE_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (TILE_HOSTS.includes(url.hostname)) { e.respondWith(tileStaleWhileRevalidate(e.request)); return; }
  if (url.origin === self.location.origin) { e.respondWith(shellNetworkFirst(e.request)); }
});

async function shellNetworkFirst(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(req);
    return hit || new Response('Offline and nothing cached yet for this page.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

async function tileStaleWhileRevalidate(req) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(req);
  const refresh = fetch(req).then(res => {
    if (res && res.ok) { cache.put(req, res.clone()); trimTileCache(cache); }
    return res;
  }).catch(() => null);
  if (hit) { refresh; return hit; } // refresh in the background, answer instantly from cache
  const res = await refresh;
  return res || new Response('', { status: 504 });
}

let trimming = false;
async function trimTileCache(cache) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    if (keys.length > MAX_TILES) {
      const excess = keys.length - MAX_TILES;
      for (let i = 0; i < excess; i++) await cache.delete(keys[i]);
    }
  } finally { trimming = false; }
}
