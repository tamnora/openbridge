'use strict';

const test = require('node:test');
const assert = require('node:assert');

const auth = require('../src/auth');

function fakeReq(headers = {}) {
    return { headers, socket: { remoteAddress: '127.0.0.1' } };
}
function fakeRes() {
    return {
        statusCode: 200,
        headers: {},
        setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
        end() {},
    };
}
function nowSec() { return Math.floor(Date.now() / 1000); }

test('sesion firmada: valida, rechaza firma alterada y expirada', () => {
    const app = { username: 'admin', csrfSecret: 'secreto' };
    const token = auth.makeSession(app, 'admin', 'csrf123', nowSec() + 60);
    const s = auth.readSession(app, fakeReq({ cookie: 'ob_session=' + encodeURIComponent(token) }));
    assert.equal(s.u, 'admin');
    assert.equal(s.c, 'csrf123');

    const bad = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    assert.equal(auth.readSession(app, fakeReq({ cookie: 'ob_session=' + encodeURIComponent(bad) })), null);

    const expired = auth.makeSession(app, 'admin', 'x', nowSec() - 1);
    assert.equal(auth.readSession(app, fakeReq({ cookie: 'ob_session=' + encodeURIComponent(expired) })), null);

    const other = auth.makeSession(app, 'otro', 'x', nowSec() + 60);
    assert.equal(auth.readSession(app, fakeReq({ cookie: 'ob_session=' + encodeURIComponent(other) })), null);
});

test('requireCsrf: acepta el token de la sesion y rechaza distinto/ausente', () => {
    const app = { username: 'admin', csrfSecret: 'secreto' };
    const token = auth.makeSession(app, 'admin', 'abc', nowSec() + 60);
    const req = fakeReq({ cookie: 'ob_session=' + encodeURIComponent(token), 'x-csrf': 'abc' });
    assert.ok(auth.requireCsrf(app, req, fakeRes()));

    const wrong = fakeReq({ cookie: 'ob_session=' + encodeURIComponent(token), 'x-csrf': 'zzz' });
    assert.equal(auth.requireCsrf(app, wrong, fakeRes()), null);

    const missing = fakeReq({ cookie: 'ob_session=' + encodeURIComponent(token) });
    assert.equal(auth.requireCsrf(app, missing, fakeRes()), null);
});

test('cookie: HttpOnly y Secure solo detras de https', () => {
    const plain = auth.serializeCookie('x', 'v', fakeReq(), 60);
    assert.match(plain, /HttpOnly/);
    assert.doesNotMatch(plain, /Secure/);
    const secure = auth.serializeCookie('x', 'v', fakeReq({ 'x-forwarded-proto': 'https' }), 60);
    assert.match(secure, /Secure/);
});

test('cookie: no confia en X-Forwarded-Proto fuera de loopback', () => {
    // Cliente directo por la red: el header no debe forzar Secure.
    const remote = { headers: { 'x-forwarded-proto': 'https' }, socket: { remoteAddress: '10.0.0.5' } };
    assert.doesNotMatch(auth.serializeCookie('x', 'v', remote, 60), /Secure/);
    // TLS real siempre es seguro.
    const tls = { headers: {}, socket: { remoteAddress: '10.0.0.5', encrypted: true } };
    assert.match(auth.serializeCookie('x', 'v', tls, 60), /Secure/);
    // Cadena de proxies: se toma el primer valor.
    assert.match(auth.serializeCookie('x', 'v', fakeReq({ 'x-forwarded-proto': 'https, http' }), 60), /Secure/);
});

test('token del puente: header y query, y comparacion segura', () => {
    const app = { bridgeToken: 'tok-123' };
    assert.equal(auth.checkBridgeToken(app, fakeReq({ 'x-bridge-token': 'tok-123' })), true);
    assert.equal(auth.checkBridgeToken(app, fakeReq({ 'x-bridge-token': 'nope' })), false);
    assert.equal(auth.checkBridgeToken(app, { headers: {}, url: '/api.php?token=tok-123' }), true);
});

test('rate limit de login: bloquea a los 5 fallos y se limpia al exito', () => {
    const req = fakeReq();
    assert.equal(auth.loginLockRemaining(req), 0);
    for (let i = 0; i < 5; i++) auth.loginRecordFailure(req);
    assert.ok(auth.loginLockRemaining(req) > 0);
    auth.loginClear(req);
    assert.equal(auth.loginLockRemaining(req), 0);
});
