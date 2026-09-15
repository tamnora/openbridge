'use strict';

/**
 * E2E del hub PHP (php/app) contra un `php -S` local.
 *
 * Cubre: login con la plantilla compartida, bootstrap con `features.pairing`,
 * emparejamiento por codigo (start/approve/poll), token por PC y aislamiento
 * entre usuarios (cada uno ve solo sus PCs; el admin ve todas).
 *
 * Se saltea si no hay `php` en el PATH (p. ej. en CI sin PHP).
 */

const test = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'php', 'dist');

function phpAvailable() {
    try {
        const r = spawnSync('php', ['-v'], { encoding: 'utf8', windowsHide: true });
        return !r.error && /PHP/.test(String(r.stdout || ''));
    } catch (e) {
        return false;
    }
}

function scryptHash(password, saltHex) {
    const keylen = 64;
    const hash = crypto.scryptSync(password, saltHex, keylen).toString('hex');
    return { algo: 'scrypt', salt: saltHex, hash, keylen };
}

function freePort() {
    return new Promise((resolve) => {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => {
            const port = s.address().port;
            s.close(() => resolve(port));
        });
    });
}

function b64urlDecode(s) {
    return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

async function waitForServer(base) {
    for (let i = 0; i < 60; i++) {
        try {
            const r = await fetch(base + '/api.php?action=ping');
            if (r.ok) return;
        } catch (e) { /* aun no */ }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('el server php no respondio');
}

const hasPhp = phpAvailable();

test('hub PHP: login, pairing y aislamiento por usuario', { skip: hasPhp ? false : 'php no esta en el PATH' }, async (t) => {
    // Build del hub si falta (necesitamos dist/templates para login.php).
    if (!fs.existsSync(path.join(DIST, 'templates', 'login.html'))) {
        execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-php-hub.mjs')], { stdio: 'ignore' });
    }

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-php-'));
    const obHome = path.join(home, '.openbridge');
    fs.mkdirSync(path.join(obHome, 'data'), { recursive: true });
    const app = {
        port: 8799,
        host: '127.0.0.1',
        baseUrl: 'http://127.0.0.1',
        users: [
            { id: 'u_admin', name: 'admin', role: 'admin', password: scryptHash('clave-admin', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), pv: 1, created: '', disabled: false },
            { id: 'u_bob', name: 'bob', role: 'user', password: scryptHash('clave-bob', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'), pv: 1, created: '', disabled: false },
        ],
        csrfSecret: 'test-secret-0123456789',
        bridgeToken: 'token-global-legacy',
        vapid: { publicKey: '', privateKey: '' },
        tunnel: { provider: 'none', domain: '' },
    };
    fs.writeFileSync(path.join(obHome, 'app.json'), JSON.stringify(app, null, 2));

    const port = await freePort();
    const base = 'http://127.0.0.1:' + port;
    const server = spawn('php', ['-S', '127.0.0.1:' + port, '-t', DIST], {
        env: { ...process.env, OPENBRIDGE_HOME: home },
        stdio: 'ignore',
        windowsHide: true,
    });
    t.after(() => { try { server.kill(); } catch (e) { /* nada */ } });
    await waitForServer(base);

    async function login(name, password) {
        const page = await fetch(base + '/login.php');
        const html = await page.text();
        const m = html.match(/name="csrf" value="([^"]+)"/);
        assert.ok(m, 'login.php debe incluir el token csrf');
        const csrfCookie = ((page.headers.get('set-cookie') || '').match(/ob_csrf=([^;]+)/) || [])[1];
        const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
        if (csrfCookie) headers.Cookie = 'ob_csrf=' + csrfCookie;
        const res = await fetch(base + '/login.php', {
            method: 'POST',
            headers,
            body: new URLSearchParams({ csrf: m[1], username: name, password, keep: 'on' }).toString(),
            redirect: 'manual',
        });
        const cookie = ((res.headers.get('set-cookie') || '').match(/ob_session=([^;]+)/) || [])[1];
        assert.ok(cookie, 'login debe devolver ob_session');
        const payload = JSON.parse(b64urlDecode(cookie.split('.')[0]));
        return { cookie: 'ob_session=' + cookie, csrf: payload.c };
    }

    async function api(action, { method = 'GET', body, cookie, csrf, token } = {}) {
        const headers = {};
        if (cookie) headers.Cookie = cookie;
        if (csrf) headers['X-CSRF'] = csrf;
        if (token) headers['X-Bridge-Token'] = token;
        let payload;
        if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
            payload = JSON.stringify(body);
        }
        const res = await fetch(base + '/api.php?action=' + action, { method, headers, body: payload });
        let json = null;
        try { json = await res.json(); } catch (e) { /* nada */ }
        return { status: res.status, json };
    }

    const ping = await api('ping');
    assert.equal(ping.status, 200);
    assert.equal(ping.json.ok, true);

    const admin = await login('admin', 'clave-admin');
    const boot = await api('bootstrap', { cookie: admin.cookie });
    assert.equal(boot.json.ok, true);
    assert.equal(boot.json.features.pairing, true);
    assert.equal(boot.json.bridges.length, 0);

    // Pairing: start (publico) -> approve (admin) -> poll (publico).
    const start = await api('bridge_pair_start', { method: 'POST', body: { bridge_id: 'pc1', bridge_name: 'PC 1' } });
    assert.equal(start.json.ok, true);
    assert.match(start.json.user_code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    const approve = await api('bridge_pair_approve', { method: 'POST', body: { user_code: start.json.user_code }, cookie: admin.cookie, csrf: admin.csrf });
    assert.equal(approve.json.ok, true);
    const poll = await api('bridge_pair_poll', { method: 'POST', body: { device_code: start.json.device_code } });
    assert.equal(poll.json.status, 'approved');
    assert.ok(poll.json.bridge_token, 'el poll debe devolver el token del puente');

    const adminBridges = await api('bridges', { cookie: admin.cookie });
    assert.deepEqual(adminBridges.json.bridges.map((b) => b.id), ['pc1']);

    // bob no ve la PC del admin ni puede pedir su catalogo.
    const bob = await login('bob', 'clave-bob');
    const bobBridges = await api('bridges', { cookie: bob.cookie });
    assert.equal(bobBridges.json.bridges.length, 0);
    const bobForbidden = await api('catalog&bridge=pc1', { cookie: bob.cookie });
    assert.equal(bobForbidden.status, 403);

    // El puente emparejado sincroniza con su token propio (X-Bridge-Token).
    const syncRes = await fetch(base + '/api.php?action=sync_catalog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Bridge-Token': poll.json.bridge_token, 'X-Bridge-Id': 'pc1' },
        body: JSON.stringify({ folders: [{ name: 'demo', path: 'C:/demo' }], models: ['p/m'], models_full: { p: ['p/m'] }, workspace: 'C:/demo', allowCreateFolders: false, agents: ['build', 'plan'], vision: [], models_ctx: { 'p/m': 200000 } }),
    });
    const syncJson = await syncRes.json();
    assert.equal(syncJson.ok, true);

    // El catalogo de pc1 quedo con models_ctx (formato de OpenBridge).
    const cat = await api('catalog&bridge=pc1', { cookie: admin.cookie });
    assert.equal(cat.json.ok, true);
    assert.equal(cat.json.catalog.models_ctx['p/m'], 200000);

    // Import: dedupe por oc_msg y adopcion del mensaje optimista de la web.
    const impBody = (messages) => ({ opencode_session: 'ses_test0001', folder: 'C:/demo', name: 'Chat', messages });
    const imp1 = await api('session_import', { method: 'POST', token: poll.json.bridge_token, body: impBody([{ role: 'assistant', text: 'hola', ts: '2026-01-01T00:00:00Z', oc_msg: 'msg_a1' }]) });
    assert.equal(imp1.json.ok, true);
    assert.equal(imp1.json.added, 1);
    const sid = imp1.json.session_id;
    const imp2 = await api('session_import', { method: 'POST', token: poll.json.bridge_token, body: impBody([{ role: 'assistant', text: 'hola', ts: '2026-01-01T00:00:05Z', oc_msg: 'msg_a1' }]) });
    assert.equal(imp2.json.added, 0);
    const sent = await api('send', { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { session: sid, text: 'dale' } });
    assert.equal(sent.json.ok, true);
    const imp3 = await api('session_import', { method: 'POST', token: poll.json.bridge_token, body: impBody([{ role: 'user', text: 'dale', ts: '2026-01-01T00:01:00Z', oc_msg: 'msg_u1' }]) });
    assert.equal(imp3.json.added, 0);
    const hist = await api('history&session=' + sid, { cookie: admin.cookie });
    assert.equal(hist.json.ok, true);
    const userMsgs = hist.json.messages.filter((m) => m.role === 'user');
    assert.equal(userMsgs.length, 1);
    assert.equal(userMsgs[0].oc_msg, 'msg_u1');
});
