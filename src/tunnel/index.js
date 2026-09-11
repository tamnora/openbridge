'use strict';

/**
 * Tuneles publicos. Proveedores soportados:
 *   - tunnelmole  (gratis, sin cuenta; URL aleatoria)   -> `npx tunnelmole <puerto>`
 *   - ngrok       (requiere cuenta + authtoken; admite dominio fijo) -> `ngrok http`
 *   - cloudflare  (gratis, quick tunnel; URL aleatoria) -> `cloudflared tunnel --url`
 *
 * La interfaz es generica: startTunnel(port, provider, opts) -> { url, provider, pid, stop }.
 */

const { spawn } = require('node:child_process');

function firstUrl(urls, scheme) {
    const list = [...new Set(urls)];
    return list.find((u) => u.startsWith(scheme)) || '';
}

function parseTunnelmoleUrls(text) {
    const urls = String(text).match(/https?:\/\/[a-z0-9-]+\.tunnelmole\.net/gi) || [];
    return { https: firstUrl(urls, 'https'), http: firstUrl(urls, 'http:') };
}

function parseNgrokUrls(text) {
    const urls = String(text).match(/https?:\/\/[a-z0-9-]+\.ngrok(?:-free)?\.(?:app|io|dev)/gi) || [];
    return { https: firstUrl(urls, 'https'), http: firstUrl(urls, 'http:') };
}

function parseCloudflaredUrls(text) {
    const urls = String(text).match(/https?:\/\/[a-z0-9-]+\.trycloudflare\.com/gi) || [];
    return { https: firstUrl(urls, 'https'), http: firstUrl(urls, 'http:') };
}

function killTree(child) {
    if (!child || child.killed) return;
    const pid = child.pid;
    try {
        if (process.platform === 'win32' && pid) {
            spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
        } else {
            if (pid) { try { process.kill(-pid, 'SIGTERM'); } catch (e) { /* sin grupo */ } }
            try { child.kill('SIGTERM'); } catch (e) { /* ya murio */ }
        }
    } catch (e) { /* ya murio */ }
}

// Lanza un binario y resuelve cuando el parseador encuentra una URL.
function spawnTunnel(bin, args, opts = {}) {
    const log = opts.log || (() => {});
    const parse = opts.parse || (() => ({ https: '', http: '' }));
    const timeoutMs = opts.timeoutMs || 90000;
    const label = opts.label || bin;
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawn(bin, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
                shell: process.platform === 'win32',
                detached: process.platform !== 'win32',
            });
        } catch (e) {
            reject(new Error('no se pudo iniciar ' + label + ': ' + e.message));
            return;
        }
        let buf = '';
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            killTree(child);
            reject(new Error(label + ' no devolvio URL (' + Math.round(timeoutMs / 1000) + ' s). Instalalo o proba otro proveedor.'));
        }, timeoutMs);
        const feed = (d) => {
            buf += String(d);
            if (opts.verbose) process.stdout.write(String(d));
            const urls = parse(buf);
            if (urls.https || urls.http) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                const url = urls.https || urls.http;
                log(label + ': ' + url + ' -> localhost:' + opts.port);
                resolve({ url, provider: opts.provider, pid: child.pid, stop: () => killTree(child) });
            }
        };
        child.stdout.on('data', feed);
        child.stderr.on('data', feed);
        child.on('error', (e) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new Error(label + ': ' + e.message));
        });
        child.on('exit', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new Error(label + ' termino (codigo ' + code + ')' + (buf ? ': ' + buf.slice(0, 200).trim() : '')));
        });
    });
}

function startTunnelmole(port, opts = {}) {
    return spawnTunnel('npx', ['--yes', 'tunnelmole', String(port)], {
        ...opts, port, provider: 'tunnelmole', label: 'tunnelmole', parse: parseTunnelmoleUrls,
    });
}

function startNgrok(port, opts = {}) {
    const args = ['http', String(port), '--log', 'stdout', '--log-format', 'json'];
    if (opts.domain) args.push('--domain=' + opts.domain);
    return spawnTunnel('ngrok', args, {
        ...opts, port, provider: 'ngrok', label: 'ngrok', parse: parseNgrokUrls,
    });
}

function startCloudflared(port, opts = {}) {
    const args = ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:' + port];
    return spawnTunnel('cloudflared', args, {
        ...opts, port, provider: 'cloudflare', label: 'cloudflared', parse: parseCloudflaredUrls,
    });
}

/**
 * Arranca el tunel segun el proveedor. Devuelve { url, provider, pid, stop }.
 * provider 'none' no abre nada.
 */
async function startTunnel(port, provider = 'tunnelmole', opts = {}) {
    const p = String(provider || 'tunnelmole').toLowerCase();
    if (p === 'none' || p === 'off' || p === '') return { url: '', provider: 'none', pid: 0, stop: () => {} };
    if (p === 'tunnelmole' || p === 'tmole') return startTunnelmole(port, opts);
    if (p === 'ngrok') return startNgrok(port, opts);
    if (p === 'cloudflare' || p === 'cloudflared') return startCloudflared(port, opts);
    throw new Error('proveedor de tunel no soportado: ' + provider);
}

module.exports = {
    startTunnel, startTunnelmole, startNgrok, startCloudflared,
    parseTunnelmoleUrls, parseNgrokUrls, parseCloudflaredUrls,
};
