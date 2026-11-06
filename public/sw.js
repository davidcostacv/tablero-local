// sw.js — service worker: permite abrir la app sin conexión, pero nunca sirve una carcasa vieja si hay red.
// Reglas: navegaciones e index.html → red primero (caché solo como respaldo); /api → red primero (la última lista
// de elementos como respaldo, con `offline: true` para que la página avise); iconos/manifest → caché primero.
// Al cambiar CACHE se borran las cachés anteriores (activate) y el nuevo worker toma el control enseguida.
const CACHE = 'tablero-v3';
const SHELL = ['/', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png', '/vendor/tabler/tabler.min.css'];
const offline = () => new Response(JSON.stringify({ error: 'sin conexión', offline: true }), { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const put = (req, res) => caches.open(CACHE).then((c) => c.put(req, res)).catch(() => {});

self.addEventListener('install', (e) => {
  // Si algún recurso falla no se bloquea la instalación: la caché se completa con el uso.
  e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });

// Red primero; si responde bien se guarda una copia (clonada ANTES de entregarla, para no chocar con la lectura de la página).
function networkFirst(req, fallback) {
  return fetch(req).then((r) => { if (r.ok) put(req, r.clone()); return r; })
    .catch(() => caches.match(req).then((c) => (c ? markOffline(c) : fallback())));
}
// La copia guardada sale con una cabecera para que la página avise "servidor caído" aunque muestre datos.
function markOffline(c) { const h = new Headers(c.headers); h.set('X-Tablero-Offline', '1'); return new Response(c.body, { status: c.status, statusText: c.statusText, headers: h }); }
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/login' || url.pathname === '/qr' || url.pathname === '/sw.js') return;
  if (url.pathname.startsWith('/api/')) {
    // Solo /api/items se guarda como respaldo sin conexión; el resto devuelve 503 "sin conexión".
    if (url.pathname === '/api/items') { e.respondWith(networkFirst(req, offline)); return; }
    e.respondWith(fetch(req).catch(offline));
    return;
  }
  if (req.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    // La carcasa siempre fresca cuando hay red; sin red, la última copia (la página mostrará el aviso de servidor caído).
    e.respondWith(networkFirst(new Request('/', { cache: 'no-cache' }), () => caches.match('/').then((c) => c || new Response('<!doctype html><meta charset="utf-8"><title>Sin conexión</title><p style="font:16px system-ui;padding:32px">No se puede conectar con el servidor del tablero. Arráncalo con <code>start-dashboard.cmd</code> y recarga.</p>', { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }))));
    return;
  }
  // iconos y manifest: caché primero y se refrescan en segundo plano
  e.respondWith(caches.match(req).then((cached) => { const net = fetch(req).then((r) => { if (r.ok) put(req, r.clone()); return r; }).catch(() => cached); return cached || net; }));
});
