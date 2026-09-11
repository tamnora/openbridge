'use strict';

/**
 * Avisos Web Push (VAPID + cifrado RFC 8291/8188). Usa la libreria `web-push`
 * para el envio; las suscripciones viven en data/push.json (mismo esquema que
 * la version PHP: endpoint + p256dh + auth).
 */

const paths = require('./paths');
const jsonfile = require('./store/jsonfile');

const PUSH_DEFAULT = () => ({ subscriptions: [] });

function pushEnabled(app) {
    return !!(app && app.vapid && app.vapid.publicKey && app.vapid.privateKey);
}
function publicKeyBase64url(app) {
    return pushEnabled(app) ? app.vapid.publicKey : '';
}

async function pushRead() {
    const data = await jsonfile.readJson(paths.pushFile(), PUSH_DEFAULT());
    if (!Array.isArray(data.subscriptions)) data.subscriptions = [];
    return data;
}
async function pushStore(endpoint, p256dh, auth, ua = '') {
    await jsonfile.update(paths.pushFile(), PUSH_DEFAULT(), (data) => {
        if (!Array.isArray(data.subscriptions)) data.subscriptions = [];
        const found = data.subscriptions.find((s) => s.endpoint === endpoint);
        if (found) {
            found.p256dh = p256dh;
            found.auth = auth;
            found.ua = ua;
            found.ts = new Date().toISOString();
        } else {
            data.subscriptions.push({ endpoint, p256dh, auth, ua, ts: new Date().toISOString() });
        }
    });
}
async function pushRemove(endpoint) {
    await jsonfile.update(paths.pushFile(), PUSH_DEFAULT(), (data) => {
        data.subscriptions = (data.subscriptions || []).filter((s) => s.endpoint !== endpoint);
    });
}

// Envia el aviso a todas las suscripciones. Devuelve cuantas se pudieron enviar.
async function pushSend(app, title, body, clickPath = 'chat.php') {
    if (!pushEnabled(app)) return 0;
    let webpush;
    try { webpush = require('web-push'); } catch (e) { return 0; }
    const url = (app.baseUrl || 'http://localhost') + '/' + String(clickPath || 'chat.php');
    const payload = JSON.stringify({ title, body, url, ts: new Date().toISOString() });
    if (Buffer.byteLength(payload) > 3500) return 0;
    try {
        webpush.setVapidDetails(app.baseUrl || 'http://localhost', app.vapid.publicKey, app.vapid.privateKey);
    } catch (e) {
        return 0;
    }
    const data = await pushRead();
    let sent = 0;
    const dead = [];
    for (const sub of data.subscriptions) {
        const endpoint = sub.endpoint || '';
        if (!/^https:\/\//.test(endpoint)) continue;
        try {
            await webpush.sendNotification(
                { endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
                payload,
                { TTL: 86400 }
            );
            sent++;
        } catch (e) {
            const code = e && e.statusCode;
            if (code === 404 || code === 410) dead.push(endpoint);
        }
    }
    if (dead.length) {
        await jsonfile.update(paths.pushFile(), PUSH_DEFAULT(), (d) => {
            d.subscriptions = (d.subscriptions || []).filter((s) => !dead.includes(s.endpoint));
        });
    }
    return sent;
}

module.exports = { pushEnabled, publicKeyBase64url, pushRead, pushStore, pushRemove, pushSend };
