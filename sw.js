/* Service worker de Flota Hajali
   - La app (index.html) se pide primero a la red para recibir actualizaciones; sin señal usa la copia guardada.
   - Librerías e íconos se sirven desde la copia guardada.
   - Las llamadas a Apps Script nunca se guardan: siempre van a la red. */
const VERSION = 'flota-hajali-v2';
const BASE = ['./', './index.html', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './apple-touch-icon.png', './favicon-32.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(BASE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (/script\.google(usercontent)?\.com$/.test(url.hostname)) return; // datos: siempre red

  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(r => {
      const copia = r.clone(); caches.open(VERSION).then(c => c.put('./index.html', copia)); return r;
    }).catch(() => caches.match('./index.html')));
    return;
  }

  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {
    if (r && (r.ok || r.type === 'opaque')) { const copia = r.clone(); caches.open(VERSION).then(c => c.put(req, copia)); }
    return r;
  })));
});
