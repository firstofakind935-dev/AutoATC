// Lets the displays page install as an app and open instantly: the page's own files are cached,
// everything under api/ (the live cockpit stream) always goes to the network.
const CACHE = 'autoatc-displays-v1';
const SHELL = ['displays.html', 'displays.js', 'displays.css', 'displays-manifest.json', 'displays-icon-192.png', 'displays-icon-512.png', 'icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.includes('/api/') || !SHELL.some((f) => url.pathname.endsWith(f))) return;
  // Network first so updates show up; the cache covers a dropped connection.
  e.respondWith(fetch(e.request).then((res) => {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copy));
    return res;
  }).catch(() => caches.match(e.request)));
});
