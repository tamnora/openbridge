/*
 * Service Worker mínimo de "openbridge".
 * Estrategia: network-first. Nunca cachea api.php (debe devolver datos frescos).
 * El resto de recursos se cachean para que la PWA funcione rápido, pero si hay
 * red se prefiere la versión del servidor.
 */
'use strict';

const CACHE = 'openbridge-v4';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    if (url.origin !== location.origin) return;
    if (url.pathname.endsWith('/api.php')) return;

    // Navegación: siempre a la red y sin mirar el cache HTTP del navegador
    // (evita mezclar un chat.php viejo con un app.js nuevo).
    const opts = req.mode === 'navigate' ? { cache: 'reload' } : {};

    event.respondWith(
        fetch(req, opts).then((res) => {
            if (res && res.status === 200) {
                const copy = res.clone();
                caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
            }
            return res;
        }).catch(() =>
            caches.match(req).then((hit) => {
                if (hit) return hit;
                if (url.pathname.endsWith('/')) return caches.match('./chat.php');
                return Response.error();
            })
        )
    );
});

// Aviso push: muestra la notificacion del sistema. El payload viaja cifrado
// (RFC 8291) y es un JSON { title, body, url }.
self.addEventListener('push', (event) => {
    let data = {};
    try {
        if (event.data) data = event.data.json();
    } catch (e) { /* payload ilegible: se muestra un aviso generico */ }
    const title = data.title || 'openbridge';
    const options = {
        body: data.body || '',
        icon: new URL('./icons/icon-192x192.png', self.registration.scope).href,
        badge: new URL('./icons/icon-192x192.png', self.registration.scope).href,
        data: { url: data.url || self.registration.scope },
        vibrate: [100, 60, 100],
    };
    event.waitUntil(self.registration.showNotification(title, options));
});

// Tocar la notificacion abre (o enfoca) el chat indicado.
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = (event.notification.data && event.notification.data.url) || self.registration.scope;
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
            for (const client of list) {
                if ('focus' in client) {
                    client.navigate(url).catch(() => {});
                    return client.focus();
                }
            }
            return self.clients.openWindow(url);
        })
    );
});

// Si el navegador renueva la suscripcion, la pagina vuelve a reportarla en el
// proximo arranque (la app re-sincroniza cuando el permiso ya esta concedido).