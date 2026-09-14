'use strict';

/**
 * Autenticacion web: cookie de sesion firmada (stateless), CSRF, "mantener
 * sesion" y token del puente. Sin dependencias externas.
 */

const crypto = require('node:crypto');
const config = require('./config');

const SESSION_COOKIE = 'ob_session';
const REMEMBER_COOKIE = 'ob_remember';
const REMEMBER_DAYS = 30;

function b64url(buf) {
    return Buffer.from(buf).toString('base64url');
}
function sign(data, secret) {
    return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}
function safeEqual(a, b) {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

function parseCookies(header) {
    const out = {};
    const raw = String(header || '');
    for (const part of raw.split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        const k = part.slice(0, i).trim();
        const v = part.slice(i + 1).trim();
        if (k) out[k] = decodeURIComponent(v);
    }
    return out;
}

// Detras del tunel el server recibe los pedidos desde loopback (el tunel corre
// en la misma maquina y reenvia a 127.0.0.1). Solo en ese caso confiamos en
// X-Forwarded-Proto: un cliente que llegara directo por la red no puede forzar
// el flag Secure de la cookie. Sin info de socket (tests), se confia.
function isSecure(req) {
    if (req.socket && req.socket.encrypted) return true;
    const remote = req.socket && req.socket.remoteAddress;
    const loopback = !remote || remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    if (!loopback) return false;
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    return proto === 'https';
}

function serializeCookie(name, value, req, maxAge) {
    const parts = [name + '=' + encodeURIComponent(value), 'Path=/', 'HttpOnly', 'SameSite=Lax'];
    if (isSecure(req)) parts.push('Secure');
    if (typeof maxAge === 'number') parts.push('Max-Age=' + maxAge);
    return parts.join('; ');
}

// ---------------------------------------------------------------------------
// Sesion (ligada al id del usuario; el rol se lee siempre del server)
// ---------------------------------------------------------------------------
function makeSession(app, user, csrf, exp) {
    const payload = b64url(JSON.stringify({ u: user.id, pv: parseInt(user.pv, 10) || 1, c: csrf, e: exp }));
    return payload + '.' + sign(payload, app.csrfSecret);
}
function readSession(app, req) {
    const cookies = parseCookies(req.headers.cookie);
    const raw = cookies[SESSION_COOKIE];
    if (!raw) return null;
    const dot = raw.lastIndexOf('.');
    if (dot < 0) return null;
    const payload = raw.slice(0, dot);
    const sig = raw.slice(dot + 1);
    if (!safeEqual(sign(payload, app.csrfSecret), sig)) return null;
    let data;
    try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (e) { return null; }
    if (!data || typeof data.e !== 'number' || data.e < Math.floor(Date.now() / 1000)) return null;
    const user = config.userById(app, data.u);
    if (!user || user.disabled) return null;
    if ((parseInt(user.pv, 10) || 1) !== (parseInt(data.pv, 10) || 1)) return null;
    return { id: user.id, name: user.name, role: user.role, u: user.id, c: data.c, e: data.e };
}
function currentCsrf(app, req) {
    const s = readSession(app, req);
    return s ? s.c : '';
}
function requireLogin(app, req, res) {
    const s = readSession(app, req);
    if (!s) { json(res, 401, { ok: false, error: 'No autorizado' }); return null; }
    return s;
}
// Exige que el usuario tenga uno de los roles indicados.
function requireRole(app, req, res, roles) {
    const s = readSession(app, req);
    if (!s) { json(res, 401, { ok: false, error: 'No autorizado' }); return null; }
    const allowed = Array.isArray(roles) ? roles : [roles];
    if (!allowed.includes(s.role)) { json(res, 403, { ok: false, error: 'Permiso insuficiente' }); return null; }
    return s;
}
function requireCsrf(app, req, res) {
    const s = readSession(app, req);
    const given = String(req.headers['x-csrf'] || '').trim();
    if (!s || given === '' || !safeEqual(s.c, given)) {
        json(res, 403, { ok: false, error: 'Sesion expirada, recarga la pagina.' });
        return null;
    }
    return s;
}

function startSession(app, req, res, user) {
    const csrf = crypto.randomBytes(16).toString('hex');
    const exp = Math.floor(Date.now() / 1000) + REMEMBER_DAYS * 86400;
    const token = makeSession(app, user, csrf, exp);
    res.setHeader('Set-Cookie', [
        serializeCookie(SESSION_COOKIE, token, req, REMEMBER_DAYS * 86400),
        serializeCookie(REMEMBER_COOKIE, makeRemember(app, user), req, REMEMBER_DAYS * 86400),
    ]);
    return csrf;
}
function endSession(req, res) {
    res.setHeader('Set-Cookie', [
        serializeCookie(SESSION_COOKIE, '', req, 0),
        serializeCookie(REMEMBER_COOKIE, '', req, 0),
    ]);
}

function makeRemember(app, user) {
    const exp = Math.floor(Date.now() / 1000) + REMEMBER_DAYS * 86400;
    const payload = user.id + '|' + exp + '|' + (parseInt(user.pv, 10) || 1);
    return b64url(payload) + '.' + sign(payload, app.csrfSecret);
}
// Re-autentica desde la cookie remember si la sesion se perdio.
function rememberAutoLogin(app, req, res) {
    if (readSession(app, req)) return false;
    const cookies = parseCookies(req.headers.cookie);
    const raw = cookies[REMEMBER_COOKIE];
    if (!raw) return false;
    const dot = raw.lastIndexOf('.');
    if (dot < 0) return false;
    const payload = raw.slice(0, dot);
    const sig = raw.slice(dot + 1);
    let plain;
    try { plain = Buffer.from(payload, 'base64url').toString('utf8'); } catch (e) { return false; }
    const parts = plain.split('|');
    if (parts.length !== 3) return false;
    const [uid, exp, pv] = parts;
    if (!/^\d+$/.test(exp) || parseInt(exp, 10) < Math.floor(Date.now() / 1000)) return false;
    if (!safeEqual(sign(payload, app.csrfSecret), sig)) return false;
    const user = config.userById(app, uid);
    if (!user || user.disabled || (parseInt(user.pv, 10) || 1) !== (parseInt(pv, 10) || 1)) return false;
    startSession(app, req, res, user);
    return true;
}

// ---------------------------------------------------------------------------
// Rate limit / lockout de login (en memoria: el server es un solo proceso)
// ---------------------------------------------------------------------------
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const loginAttempts = new Map();

function clientKey(req, user) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ip = xff || (req.socket && req.socket.remoteAddress) || 'desconocido';
    return String(ip) + '|' + String(user || '').trim().toLowerCase();
}
function pruneLoginAttempts(now) {
    for (const [key, st] of loginAttempts) {
        if (!st.lockUntil && now - st.first > LOGIN_WINDOW_MS) loginAttempts.delete(key);
    }
}
// Segundos restantes de bloqueo (0 = puede intentar).
function loginLockRemaining(req, user) {
    const now = Date.now();
    pruneLoginAttempts(now);
    const st = loginAttempts.get(clientKey(req, user));
    if (!st || !st.lockUntil) return 0;
    const left = st.lockUntil - now;
    return left > 0 ? Math.ceil(left / 1000) : 0;
}
function loginRecordFailure(req, user) {
    const now = Date.now();
    const key = clientKey(req, user);
    let st = loginAttempts.get(key);
    if (!st || (!st.lockUntil && now - st.first > LOGIN_WINDOW_MS)) st = { count: 0, first: now, lockUntil: 0 };
    st.count++;
    if (st.count >= LOGIN_MAX_ATTEMPTS) st.lockUntil = now + LOGIN_LOCK_MS;
    loginAttempts.set(key, st);
}
function loginClear(req, user) {
    loginAttempts.delete(clientKey(req, user));
}

// ---------------------------------------------------------------------------
// Token del puente
// ---------------------------------------------------------------------------
function checkBridgeToken(app, req) {
    let given = String(req.headers['x-bridge-token'] || '').trim();
    if (given === '') {
        try {
            const u = new URL(req.url, 'http://localhost');
            given = String(u.searchParams.get('token') || '').trim();
        } catch (e) { /* nada */ }
    }
    if (given === '' || !app.bridgeToken) return false;
    return safeEqual(app.bridgeToken, given);
}

function json(res, code, data) {
    res.statusCode = code;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(data));
}

module.exports = {
    SESSION_COOKIE, REMEMBER_COOKIE,
    parseCookies, serializeCookie, isSecure,
    makeSession, readSession, currentCsrf, requireLogin, requireRole, requireCsrf,
    startSession, endSession, rememberAutoLogin,
    loginLockRemaining, loginRecordFailure, loginClear,
    checkBridgeToken, safeEqual, json,
};
