// Offline-first service worker: precache the app shell + model files, then serve cache-first.
const CACHE = 'mamaguard-v18';
const ASSETS = ['./', 'index.html', 'styles.css', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
  ...['app', 'config', 'util', 'validate', 'model', 'risk', 'ble', 'sim', 'store', 'referral', 'chart', 'ctg', 'modeltab', 'bg', 'heart3d', 'auth', 'voice', 'i18n'].map(n => `js/${n}.js`),
  'js/model_artifact.json', 'js/ctg_model.json', 'js/ctg_metrics.json', 'js/ctg_presets.json'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request).then(res => {
    if (res.ok && new URL(e.request.url).origin === location.origin) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return res;
  }).catch(() => e.request.mode === 'navigate' ? caches.match('index.html') : Response.error())));
});
