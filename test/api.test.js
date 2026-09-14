'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const paths = require('../src/paths');
const config = require('../src/config');
const store = require('../src/store');
const web = require('../src/web/server');

function request(port, { method = 'GET', url = '/', headers = {}, body = '' } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path: url, headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

function addCookies(jar, res) {
    const raw = res.headers['set-cookie'] || [];
    for (const line of raw) {
        const pair = line.split(';')[0];
        const i = pair.indexOf('=');
        if (i < 0) continue;
        const k = pair.slice(0, i).trim();
        const v = decodeURIComponent(pair.slice(i + 1).trim());
        if (v === '') delete jar[k];
        else jar[k] = v;
    }
    return jar;
}
function cookieHeader(jar) {
    return Object.entries(jar).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('; ');
}
function decodeSession(token) {
    const payload = token.split('.')[0];
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

test('API: ping publico, login y endpoints protegidos', async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-api-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-api-ws-'));
    paths.setHome(home);
    paths.ensureDirs();
    const projPath = path.join(root, 'proj');
    fs.mkdirSync(projPath);

    const app = {
        port: 0,
        host: '127.0.0.1',
        baseUrl: 'http://127.0.0.1',
        users: [config.makeUser('admin', 'secreta', 'admin'), config.makeUser('bob', 'clave2', 'user')],
        csrfSecret: 'csrf-secret',
        bridgeToken: 'bridge-token',
        vapid: { publicKey: '', privateKey: '' },
        tunnel: { provider: 'none', domain: '' },
    };
    config.writeApp(app);
    await store.syncCatalog(
        [{ name: 'proj', path: projPath }],
        ['m/a'], root, true, ['build'], {}, [], {}, paths.catalogFile()
    );

    const server = web.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    t.after(() => {
        server.close();
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(root, { recursive: true, force: true });
    });

    const ping = await request(port, { url: '/api.php?action=ping' });
    assert.equal(ping.status, 200);
    assert.equal(JSON.parse(ping.body).ok, true);

    const unauth = await request(port, { url: '/api.php?action=sessions' });
    assert.equal(unauth.status, 401);

    const jar = {};
    const page = await request(port, { url: '/login.php' });
    addCookies(jar, page);
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)[1];
    assert.ok(csrf);

    const form = 'csrf=' + encodeURIComponent(csrf) + '&username=admin&password=secreta';
    const login = await request(port, {
        method: 'POST', url: '/login.php',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(jar), 'Content-Length': Buffer.byteLength(form) },
        body: form,
    });
    assert.equal(login.status, 302);
    addCookies(jar, login);
    assert.ok(jar.ob_session);

    const sessionCsrf = decodeSession(jar.ob_session).c;

    const boot = await request(port, { url: '/api.php?action=bootstrap', headers: { Cookie: cookieHeader(jar) } });
    assert.equal(boot.status, 200);
    assert.equal(JSON.parse(boot.body).ok, true);

    const noCsrf = await request(port, {
        method: 'POST', url: '/api.php?action=session_create',
        headers: { Cookie: cookieHeader(jar), 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder: 'proj', model: 'm/a', agent: 'build' }),
    });
    assert.equal(noCsrf.status, 403);

    const create = await request(port, {
        method: 'POST', url: '/api.php?action=session_create',
        headers: { Cookie: cookieHeader(jar), 'Content-Type': 'application/json', 'x-csrf': sessionCsrf },
        body: JSON.stringify({ folder: projPath, model: 'm/a', agent: 'build' }),
    });
    assert.equal(create.status, 200);
    const created = JSON.parse(create.body);
    assert.equal(created.ok, true);
    assert.equal(created.session.folder, projPath);
});

test('API: roles - user puede chatear pero no borrar ni correr procesos', async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-api-role-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-api-role-ws-'));
    paths.setHome(home);
    paths.ensureDirs();
    const projPath = path.join(root, 'proj');
    fs.mkdirSync(projPath);

    const app = {
        port: 0,
        host: '127.0.0.1',
        baseUrl: 'http://127.0.0.1',
        users: [config.makeUser('admin', 'secreta', 'admin'), config.makeUser('bob', 'clave2', 'user')],
        csrfSecret: 'csrf-secret',
        bridgeToken: 'bridge-token',
        vapid: { publicKey: '', privateKey: '' },
        tunnel: { provider: 'none', domain: '' },
    };
    config.writeApp(app);
    await store.syncCatalog(
        [{ name: 'proj', path: projPath }],
        ['m/a'], root, true, ['build'], {}, [], {}, paths.catalogFile()
    );

    const server = web.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    t.after(() => {
        server.close();
        fs.rmSync(home, { recursive: true, force: true });
        fs.rmSync(root, { recursive: true, force: true });
    });

    async function loginAs(user, pass) {
        const jar = {};
        const page = await request(port, { url: '/login.php' });
        addCookies(jar, page);
        const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)[1];
        const form = 'csrf=' + encodeURIComponent(csrf) + '&username=' + encodeURIComponent(user) + '&password=' + encodeURIComponent(pass);
        const login = await request(port, {
            method: 'POST', url: '/login.php',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(jar), 'Content-Length': Buffer.byteLength(form) },
            body: form,
        });
        assert.equal(login.status, 302);
        addCookies(jar, login);
        return { jar, csrf: decodeSession(jar.ob_session).c };
    }

    // Login invalido: mismo mensaje, sin filtrar si el usuario existe.
    const pageBad = await request(port, { url: '/login.php' });
    const jarBad = addCookies({}, pageBad);
    const csrfBad = /name="csrf" value="([^"]+)"/.exec(pageBad.body)[1];
    const badForm = 'csrf=' + encodeURIComponent(csrfBad) + '&username=nadie&password=x';
    const bad = await request(port, {
        method: 'POST', url: '/login.php',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(jarBad), 'Content-Length': Buffer.byteLength(badForm) },
        body: badForm,
    });
    assert.match(bad.body, /Usuario o contrasena incorrectos/);

    const bob = await loginAs('bob', 'clave2');

    const create = await request(port, {
        method: 'POST', url: '/api.php?action=session_create',
        headers: { Cookie: cookieHeader(bob.jar), 'Content-Type': 'application/json', 'x-csrf': bob.csrf },
        body: JSON.stringify({ folder: projPath, model: 'm/a', agent: 'build' }),
    });
    const created = JSON.parse(create.body);
    assert.equal(created.ok, true);

    // Enviar mensaje: permitido para user.
    const send = await request(port, {
        method: 'POST', url: '/api.php?action=send',
        headers: { Cookie: cookieHeader(bob.jar), 'Content-Type': 'application/json', 'x-csrf': bob.csrf },
        body: JSON.stringify({ session: created.session.id, text: 'hola' }),
    });
    assert.equal(JSON.parse(send.body).ok, true);

    // Borrar sesion: solo admin.
    const del = await request(port, {
        method: 'POST', url: '/api.php?action=session_delete',
        headers: { Cookie: cookieHeader(bob.jar), 'Content-Type': 'application/json', 'x-csrf': bob.csrf },
        body: JSON.stringify({ id: created.session.id }),
    });
    assert.equal(del.status, 403);

    // Correr un proceso: solo admin.
    const proc = await request(port, {
        method: 'POST', url: '/api.php?action=run_oc',
        headers: { Cookie: cookieHeader(bob.jar), 'Content-Type': 'application/json', 'x-csrf': bob.csrf },
        body: JSON.stringify({ cmd: 'proc_start', args: [projPath, 'npm run dev'] }),
    });
    assert.equal(proc.status, 403);

    // Listar archivos (lectura): permitido.
    const fsList = await request(port, {
        method: 'POST', url: '/api.php?action=run_oc',
        headers: { Cookie: cookieHeader(bob.jar), 'Content-Type': 'application/json', 'x-csrf': bob.csrf },
        body: JSON.stringify({ cmd: 'fs_list', args: [''] }),
    });
    assert.equal(fsList.status, 200);
    assert.equal(JSON.parse(fsList.body).ok, true);
});

test('API: instalacion legada (username/password) migra y loguea', async (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-api-legacy-'));
    paths.setHome(home);
    paths.ensureDirs();

    const app = {
        port: 0,
        host: '127.0.0.1',
        baseUrl: 'http://127.0.0.1',
        username: 'admin',
        password: config.hashPassword('secreta'),
        csrfSecret: 'csrf-secret',
        bridgeToken: 'bridge-token',
        vapid: { publicKey: '', privateKey: '' },
        tunnel: { provider: 'none', domain: '' },
    };
    const server = web.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    t.after(() => {
        server.close();
        fs.rmSync(home, { recursive: true, force: true });
    });

    const jar = {};
    const page = await request(port, { url: '/login.php' });
    addCookies(jar, page);
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)[1];
    const form = 'csrf=' + encodeURIComponent(csrf) + '&username=admin&password=secreta';
    const login = await request(port, {
        method: 'POST', url: '/login.php',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(jar), 'Content-Length': Buffer.byteLength(form) },
        body: form,
    });
    assert.equal(login.status, 302);
    addCookies(jar, login);
    assert.ok(jar.ob_session);
    assert.equal(decodeSession(jar.ob_session).u, 'u1');

    const boot = await request(port, { url: '/api.php?action=bootstrap', headers: { Cookie: cookieHeader(jar) } });
    assert.equal(JSON.parse(boot.body).ok, true);
});
