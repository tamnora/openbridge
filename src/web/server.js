'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const auth = require('../auth');
const routes = require('./routes');
const log = require('../log');

const ASSETS = path.join(__dirname, 'assets');

const MIME = {
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
};

function contentTypeFor(file) {
    return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

async function readBody(req, limit = 24 * 1024 * 1024) {
    return new Promise((resolve) => {
        const chunks = [];
        let len = 0;
        req.on('data', (c) => {
            len += c.length;
            if (len > limit) { req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', () => resolve(Buffer.alloc(0)));
    });
}

function parseForm(buf) {
    const out = {};
    for (const part of buf.toString('utf8').split('&')) {
        if (!part) continue;
        const i = part.indexOf('=');
        const k = decodeURIComponent((i < 0 ? part : part.slice(0, i)).replace(/\+/g, ' '));
        const v = decodeURIComponent((i < 0 ? '' : part.slice(i + 1)).replace(/\+/g, ' '));
        out[k] = v;
    }
    return out;
}

async function serveStatic(res, rel) {
    const safe = path.normalize('/' + rel).replace(/^(\.\.[/\\])+/, '');
    const full = path.join(ASSETS, safe);
    if (!full.startsWith(ASSETS)) return false;
    try {
        const st = await fsp.stat(full);
        if (!st.isFile()) return false;
        res.writeHead(200, { 'Content-Type': contentTypeFor(full), 'Cache-Control': 'no-cache' });
        fs.createReadStream(full).pipe(res);
        return true;
    } catch (e) {
        return false;
    }
}

function securityHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
}

async function handle(app, req, res) {
    securityHeaders(res);
    const u = new URL(req.url, 'http://localhost');
    const pathname = u.pathname;
    const method = req.method || 'GET';
    const query = u.searchParams;

    if (pathname === '/api.php' || pathname === '/api') {
        const bodyBuf = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
        let body = {};
        if (bodyBuf.length) {
            try { body = JSON.parse(bodyBuf.toString('utf8')); } catch (e) { body = {}; }
        }
        return routes.handleApi({ app, req, res, method, query, body, bodyBuf });
    }
    if (pathname === '/login.php' || pathname === '/login') {
        if (method === 'POST') {
            const form = parseForm(await readBody(req));
            return routes.handleLogin({ app, req, res, query, form });
        }
        return routes.handleLoginPage({ app, req, res, query });
    }
    if (pathname === '/logout.php' || pathname === '/logout') {
        return routes.handleLogout({ app, req, res });
    }
    if (pathname === '/chat.php' || pathname === '/chat' || pathname === '/') {
        return routes.handleChat({ app, req, res, query });
    }
    if (pathname === '/index.php' || pathname === '/index') {
        return routes.handleIndex({ app, req, res });
    }
    if (pathname === '/app.js' || pathname === '/sw.js' || pathname === '/manifest.webmanifest'
        || pathname.startsWith('/themes/') || pathname.startsWith('/icons/')) {
        if (await serveStatic(res, pathname)) return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
}

function createServer(app) {
    const server = http.createServer((req, res) => {
        const started = Date.now();
        res.on('finish', () => {
            if (res.statusCode >= 400) {
                log.warn('[web] ' + req.method + ' ' + req.url + ' -> ' + res.statusCode + ' (' + (Date.now() - started) + ' ms)');
            }
        });
        handle(app, req, res).catch((e) => {
            try { auth.json(res, 500, { ok: false, error: 'error interno' }); } catch (e2) { /* nada */ }
            log.error('[web]', (e && e.stack) || e);
        });
    });
    return server;
}

module.exports = { createServer };
