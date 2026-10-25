/* sw.js -- retired in b2026-10-19.1.
   Removes the old offline app cache (which kept serving an outdated index.html)
   and unregisters itself. Offline route maps (More -> Save map offline) are kept. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== 'apex-tiles-v1').map((k) => caches.delete(k)));
    await self.registration.unregister();
  })());
});
