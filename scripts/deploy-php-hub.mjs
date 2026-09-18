#!/usr/bin/env node
'use strict';

// Deploy del hub PHP a un hosting por FTPS (cPanel). Script privado, fuera del
// pack npm; se corre a mano cuando haga falta. Usa `curl` nativo (sin deps).
//
// Arma `php/dist` con scripts/build-php-hub.mjs (salvo --no-build) y sincroniza
// solo el codigo/estaticos. Los DATOS del server (.openbridge/app.json y
// .openbridge/data) NUNCA se tocan salvo que lo pidas con flags.
//
// Uso:
//   node scripts/deploy-php-hub.mjs [comando] [opciones]
//   npm run deploy:hub -- sync
//
// Comandos (sin comando = status):
//   status            diferencias local vs server + datos (no toca nada)
//   sync              sube nuevos, actualiza cambiados y borra obsoletos
//   push <archivo...>  sube SOLO los archivos indicados (relativos a php/dist)
//   backup            descarga app.json + data/** a backups/<host>/<fecha>/
//   restore <carpeta>  sube un backup local al server
//   reset             backup, wipe total y re-sube php/dist completo
//   prune             borra archivos remotos no gestionados (ej. un .zip viejo)
//   chmod             fija 0755 en .openbridge y .openbridge/data
//   init              primer deploy en un server vacio
//   help              esta ayuda
//
// Opciones:
//   --data            sync/restore: permite subir/sobrescribir .openbridge/app.json
//   --data-all        ademas incluye .openbridge/data/** (mensajes, sesiones, ...)
//   --prune           sync: borra ademas los archivos no gestionados
//   --keep-data       reset (default): restaura app.json + data del backup
//   --wipe-data       reset: deja .openbridge/data vacio (server limpio)
//   --no-backup       reset: no hace backup antes de borrar (peligroso)
//   --all, -a         backup: descarga el docroot completo, no solo los datos
//   --insecure, -k    no validar el certificado TLS (equivalente a DEPLOY_INSECURE)
//   --no-build        no corre scripts/build-php-hub.mjs
//   --host <h>        override de DEPLOY_HOST
//   --dry-run, -n     muestra el plan sin tocar el server
//   --yes, -y         no pide confirmacion en operaciones destructivas
//   --help, -h        ayuda
//
// Credenciales en `.deploy.env` (gitignored) o variables de entorno:
//   DEPLOY_PROTOCOL=ftps  DEPLOY_HOST=...  DEPLOY_PORT=21
//   DEPLOY_USER=...       DEPLOY_PASS=...
//   DEPLOY_REMOTE=/       DEPLOY_LOCAL=php/dist       DEPLOY_INSECURE=1

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(root, '.deploy.env');
const CACHE_DIR = path.join(root, '.deploy-cache');
const BACKUP_DIR = path.join(root, 'backups');

const APP_JSON = '.openbridge/app.json';
const DATA_DIR = '.openbridge/data';
const NEVER_TOUCH = new Set(['.ftpquota']);

function fail(msg) {
    console.error('\n  error: ' + msg);
    process.exit(1);
}

function posix(p) {
    return String(p).replace(/\\/g, '/');
}

export function shouldNeverTouch(rel) {
    return NEVER_TOUCH.has(posix(rel));
}

export function isDataPath(rel) {
    const r = posix(rel);
    return r === DATA_DIR || r.startsWith(DATA_DIR + '/');
}

export function isProtectedPath(rel) {
    const r = posix(rel);
    return r === APP_JSON || isDataPath(r);
}

// ¿Se sube/gestiona este archivo local? Los datos quedan afuera salvo flags.
export function includeFile(rel, o) {
    if (shouldNeverTouch(rel)) return false;
    const r = posix(rel);
    if (r === APP_JSON) return !!(o.data || o.dataAll);
    if (isDataPath(r)) return !!o.dataAll;
    return true;
}

// ¿Queda protegido frente a un borrado? Igual que includeFile pero para el
// manifiesto: lo que no se sube tampoco se borra.
export function isProtectedDelete(rel, o) {
    if (shouldNeverTouch(rel)) return true;
    const r = posix(rel);
    if (r === APP_JSON) return !(o.data || o.dataAll);
    if (isDataPath(r)) return !o.dataAll;
    return false;
}

export function parseArgs(argv) {
    const o = {
        cmd: null, positional: [], data: false, dataAll: false, prune: false,
        keepData: true, wipeData: false, noBackup: false, all: false,
        dryRun: false, yes: false, noBuild: false, insecure: false,
        host: null, help: false,
    };
    const commands = new Set(['status', 'sync', 'push', 'backup', 'restore', 'reset', 'prune', 'chmod', 'init', 'help']);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--data') o.data = true;
        else if (a === '--data-all') { o.data = true; o.dataAll = true; }
        else if (a === '--prune') o.prune = true;
        else if (a === '--keep-data') { o.keepData = true; o.wipeData = false; }
        else if (a === '--wipe-data') { o.wipeData = true; o.keepData = false; }
        else if (a === '--no-backup') o.noBackup = true;
        else if (a === '--all' || a === '-a') o.all = true;
        else if (a === '--dry-run' || a === '-n') o.dryRun = true;
        else if (a === '--yes' || a === '-y') o.yes = true;
        else if (a === '--no-build') o.noBuild = true;
        else if (a === '--insecure' || a === '-k') o.insecure = true;
        else if (a === '--host') o.host = argv[++i];
        else if (a === '--help' || a === '-h') o.help = true;
        else if (a.startsWith('-')) fail('opcion desconocida: ' + a);
        else if (!o.cmd && commands.has(a)) o.cmd = a;
        else o.positional.push(a);
    }
    if (o.help) o.cmd = 'help';
    return o;
}

export function parseList(text) {
    const out = [];
    for (const line of String(text || '').split(/\r?\n/)) {
        if (!line.trim()) continue;
        const m = /^([dl-])[rwxsStT-]{9}\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+(.+)$/.exec(line);
        if (!m) continue;
        const name = m[3].replace(/\s+->.*$/, '').trim();
        if (!name) continue;
        out.push({ type: m[1] === 'd' ? 'd' : 'f', size: +m[2], name });
    }
    return out;
}

export function remoteAbs(cfg, rel) {
    const base = ('/' + posix(cfg.remote || '').replace(/^\/+/, '')).replace(/\/+$/, '');
    const r = posix(rel || '').replace(/^\/+/, '').replace(/\/+$/, '');
    let p = base + (r ? '/' + r : '');
    if (!p.startsWith('/')) p = '/' + p;
    return p || '/';
}

export function diffManifest(local, manifest, o) {
    const added = [];
    const changed = [];
    const obsolete = [];
    const mgr = (manifest && manifest.files) || {};
    for (const [rel, info] of local) {
        const m = mgr[rel];
        if (!m) added.push(rel);
        else if (m.sha256 !== info.sha256) changed.push(rel);
    }
    for (const rel of Object.keys(mgr)) {
        if (!local.has(rel) && !isProtectedDelete(rel, o)) obsolete.push(rel);
    }
    added.sort();
    changed.sort();
    obsolete.sort();
    return { added, changed, obsolete };
}

export function loadEnvFile(file) {
    const out = {};
    if (!fs.existsSync(file)) return out;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const s = line.trim();
        if (!s || s.startsWith('#')) continue;
        const i = s.indexOf('=');
        if (i < 0) continue;
        const k = s.slice(0, i).trim();
        let v = s.slice(i + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.slice(1, -1);
        }
        out[k] = v;
    }
    return out;
}

function loadConfig(o) {
    const env = loadEnvFile(ENV_FILE);
    const pick = (k, def) => (process.env[k] !== undefined ? process.env[k] : (env[k] !== undefined ? env[k] : def));
    const protocol = String(pick('DEPLOY_PROTOCOL', 'ftps')).toLowerCase();
    return {
        protocol,
        host: String(o.host || pick('DEPLOY_HOST', '')),
        port: String(pick('DEPLOY_PORT', protocol === 'sftp' ? '22' : '21')),
        user: String(pick('DEPLOY_USER', '')),
        pass: String(pick('DEPLOY_PASS', '')),
        remote: String(pick('DEPLOY_REMOTE', '/')),
        local: path.resolve(root, String(pick('DEPLOY_LOCAL', 'php/dist'))),
        insecure: o.insecure || String(pick('DEPLOY_INSECURE', '1')) !== '0',
    };
}

function baseArgs(cfg) {
    const a = ['-sS', '--connect-timeout', '30', '--max-time', '1800'];
    if (cfg.insecure) a.push('-k');
    if (cfg.protocol === 'ftps') a.push('--ssl-reqd', '--ftp-ssl-control');
    a.push('-u', cfg.user + ':' + cfg.pass);
    return a;
}

function ftpUrl(cfg, abs, dir) {
    const scheme = cfg.protocol === 'sftp' ? 'sftp' : 'ftp';
    const port = cfg.port ? ':' + cfg.port : '';
    const enc = posix(abs).split('/').map((s) => (s ? encodeURIComponent(s) : s)).join('/');
    let u = scheme + '://' + cfg.host + port + (enc.startsWith('/') ? enc : '/' + enc);
    if (dir && !u.endsWith('/')) u += '/';
    return u;
}

function curl(cfg, args) {
    if (cfg.dryRun) return { ok: true, out: '' };
    const r = spawnSync('curl', [...baseArgs(cfg), ...args], { encoding: 'utf8' });
    if (r.error) return { ok: false, err: r.error.message };
    if (r.status !== 0) return { ok: false, err: (r.stderr || '').trim() || ('curl exit ' + r.status), out: r.stdout || '' };
    return { ok: true, out: r.stdout || '' };
}

function requireConn(cfg) {
    if (!cfg.host || !cfg.user || !cfg.pass) {
        fail('faltan credenciales. Completa `.deploy.env` (DEPLOY_HOST, DEPLOY_USER, DEPLOY_PASS) o usa variables de entorno.');
    }
}

function requireLocal(cfg) {
    if (!fs.existsSync(cfg.local)) {
        fail('no existe ' + path.relative(root, cfg.local) + '. Corre `node scripts/build-php-hub.mjs`.');
    }
}

function sha256File(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function localWalk(dir, o) {
    const files = new Map();
    (function rec(rel) {
        const abs = rel ? path.join(dir, rel) : dir;
        let names;
        try { names = fs.readdirSync(abs); } catch { return; }
        for (const name of names) {
            const childRel = rel ? rel + '/' + name : name;
            const full = path.join(abs, name);
            let st;
            try { st = fs.statSync(full); } catch { continue; }
            if (st.isDirectory()) rec(childRel);
            else if (st.isFile() && includeFile(childRel, o)) {
                files.set(childRel, { size: st.size, sha256: sha256File(full), abs: full });
            }
        }
    })('');
    return files;
}

function listDir(cfg, rel) {
    const url = ftpUrl(cfg, remoteAbs(cfg, rel), true);
    const r = curl(cfg, [url]);
    if (!r.ok) throw new Error(r.err);
    return parseList(r.out);
}

function remoteWalk(cfg, rel, opts) {
    opts = opts || {};
    const files = new Map();
    const dirs = new Set();
    (function rec(relDir) {
        let entries;
        try { entries = listDir(cfg, relDir); } catch { return; }
        for (const e of entries) {
            if (e.name === '.' || e.name === '..') continue;
            const childRel = relDir ? relDir + '/' + e.name : e.name;
            if (opts.skipData && isDataPath(childRel)) continue;
            if (e.type === 'd') {
                dirs.add(childRel);
                rec(childRel);
            } else {
                files.set(childRel, { size: e.size });
            }
        }
    })(rel || '');
    return { files, dirs };
}

function manifestPath(cfg) {
    const safe = String(cfg.host).replace(/[^A-Za-z0-9._-]/g, '_') || 'host';
    return path.join(CACHE_DIR, safe + '.json');
}

function readManifest(cfg) {
    const p = manifestPath(cfg);
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return { files: {} }; }
}

function writeManifest(cfg, files) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const out = {
        host: cfg.host,
        remote: cfg.remote,
        updated: new Date().toISOString(),
        files: {},
    };
    for (const rel of [...files.keys()].sort()) {
        out.files[rel] = { sha256: files.get(rel).sha256, size: files.get(rel).size };
    }
    fs.writeFileSync(manifestPath(cfg), JSON.stringify(out, null, 2) + '\n');
}

// Sube en trozos chicos a un nombre temporal, verifica el tamano y recien
// entonces renombra al destino final. El hosting aborta transferencias grandes
// con `451` y curl deja el destino en 0 bytes; asi el archivo bueno no se toca
// hasta tener el nuevo completo.
const CHUNK = 7000;

function remoteSize(cfg, rel) {
    const r = curl(cfg, ['-I', ftpUrl(cfg, remoteAbs(cfg, rel))]);
    if (!r.ok) return -1;
    const m = /Content-Length:\s*(\d+)/i.exec(r.out);
    return m ? +m[1] : -1;
}

function renameRemote(cfg, fromRel, toRel) {
    const rootUrl = ftpUrl(cfg, remoteAbs(cfg, ''), true);
    return curl(cfg, ['-Q', 'RNFR ' + remoteAbs(cfg, fromRel), '-Q', 'RNTO ' + remoteAbs(cfg, toRel), rootUrl]);
}

function uploadFile(cfg, rel, abs) {
    if (cfg.dryRun) return { ok: true };
    const size = fs.statSync(abs).size;
    const tmpRel = rel + '.deploytmp';
    const tmpLocal = path.join(os.tmpdir(), 'ob-deploy-' + process.pid + '.bin');
    deleteFile(cfg, tmpRel);

    const buf = fs.readFileSync(abs);
    let idx = 0;
    for (let off = 0; off < buf.length; off += CHUNK, idx++) {
        fs.writeFileSync(tmpLocal, buf.subarray(off, off + CHUNK));
        const args = idx === 0
            ? ['--ftp-create-dirs', '-T', tmpLocal, ftpUrl(cfg, remoteAbs(cfg, tmpRel))]
            : ['-a', '-T', tmpLocal, ftpUrl(cfg, remoteAbs(cfg, tmpRel))];
        let r;
        let tries = 0;
        do { r = curl(cfg, args); tries++; } while (!r.ok && tries < 5);
        if (!r.ok) {
            try { fs.rmSync(tmpLocal, { force: true }); } catch { /* noop */ }
            return { ok: false, err: r.err };
        }
    }
    if (buf.length === 0) {
        fs.writeFileSync(tmpLocal, '');
        const r = curl(cfg, ['--ftp-create-dirs', '-T', tmpLocal, ftpUrl(cfg, remoteAbs(cfg, tmpRel))]);
        if (!r.ok) return { ok: false, err: r.err };
    }
    try { fs.rmSync(tmpLocal, { force: true }); } catch { /* noop */ }

    const got = remoteSize(cfg, tmpRel);
    if (got !== size) return { ok: false, err: 'tamano remoto ' + got + ' != ' + size + ' (archivo intacto)' };
    const rn = renameRemote(cfg, tmpRel, rel);
    if (!rn.ok) return rn;
    return { ok: true };
}

function deleteFile(cfg, rel) {
    const rootUrl = ftpUrl(cfg, remoteAbs(cfg, ''), true);
    return curl(cfg, ['-Q', 'DELE ' + remoteAbs(cfg, rel), rootUrl]);
}

function removeDir(cfg, rel) {
    const rootUrl = ftpUrl(cfg, remoteAbs(cfg, ''), true);
    return curl(cfg, ['-Q', 'RMD ' + remoteAbs(cfg, rel), rootUrl]);
}

function ftpCommand(cfg, raw) {
    const rootUrl = ftpUrl(cfg, remoteAbs(cfg, ''), true);
    return curl(cfg, ['-Q', raw, rootUrl]);
}

function ensureRemoteDir(cfg, rel) {
    const parts = posix(rel).split('/').filter(Boolean);
    let acc = '';
    for (const p of parts) {
        acc = acc ? acc + '/' + p : p;
        ftpCommand(cfg, 'MKD ' + remoteAbs(cfg, acc));
    }
}

function ensureDataDir(cfg) {
    ensureRemoteDir(cfg, '.openbridge');
    ensureRemoteDir(cfg, DATA_DIR);
}

function chmodData(cfg) {
    ftpCommand(cfg, 'SITE CHMOD 0755 ' + remoteAbs(cfg, '.openbridge'));
    ftpCommand(cfg, 'SITE CHMOD 0755 ' + remoteAbs(cfg, DATA_DIR));
}

function build() {
    console.log('  > build php/dist');
    const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'build-php-hub.mjs')], { stdio: 'inherit' });
    if (r.status !== 0) fail('fallo scripts/build-php-hub.mjs');
}

function confirm(question) {
    if (!process.stdin.isTTY) fail('sin terminal interactiva: usa --yes para confirmar');
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question + ' [s/N] ', (a) => {
            rl.close();
            resolve(/^(s|si|y|yes)$/i.test(a.trim()));
        });
    });
}

function guardDestructive(o, what) {
    if (o.dryRun || o.yes) return Promise.resolve(true);
    return confirm('  ' + what + '?');
}

function stamp() {
    return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function shortList(arr, n) {
    n = n || 12;
    const head = arr.slice(0, n).map((x) => '      ' + x).join('\n');
    const rest = arr.length > n ? '\n      ... (+' + (arr.length - n) + ')' : '';
    return head + rest;
}

function backup(cfg, o, scopeAll) {
    const dest = path.join(BACKUP_DIR, String(cfg.host).replace(/[^A-Za-z0-9._-]/g, '_'), stamp());
    const remote = scopeAll
        ? remoteWalk(cfg, '', { skipData: false })
        : remoteWalk(cfg, '.openbridge', { skipData: false });
    let count = 0;
    const failed = [];
    for (const rel of [...remote.files.keys()].sort()) {
        if (!scopeAll && !(posix(rel) === APP_JSON || isDataPath(rel))) continue;
        const localFile = path.join(dest, rel);
        fs.mkdirSync(path.dirname(localFile), { recursive: true });
        const r = curl(cfg, ['--create-dirs', '-o', localFile, ftpUrl(cfg, remoteAbs(cfg, rel))]);
        if (r.ok) count++;
        else failed.push(rel + ' (' + r.err + ')');
    }
    if (!o.dryRun) {
        fs.mkdirSync(dest, { recursive: true });
        fs.writeFileSync(path.join(dest, 'backup-meta.json'), JSON.stringify({
            host: cfg.host, remote: cfg.remote, date: new Date().toISOString(),
            scope: scopeAll ? 'all' : 'data', files: count,
        }, null, 2) + '\n');
    }
    return { dest, count, failed };
}

function collectLocal(cfg, o) {
    return localWalk(cfg.local, o);
}

async function cmdStatus(cfg, o) {
    requireConn(cfg);
    const local = collectLocal(cfg, o);
    const manifest = readManifest(cfg);
    const { added, changed, obsolete } = diffManifest(local, manifest, o);
    const remote = remoteWalk(cfg, '', { skipData: !o.dataAll });
    const missing = [...local.keys()].filter((rel) => !remote.files.has(rel));
    const desync = [...local.keys()].filter((rel) => {
        const r = remote.files.get(rel);
        return r && r.size !== local.get(rel).size;
    });
    const remoteOnly = [...remote.files.keys()].filter((rel) => (
        !local.has(rel) && !isProtectedDelete(rel, o) && !shouldNeverTouch(rel)
    ));

    console.log('\n  OpenBridge deploy — status');
    console.log('  host   : ' + cfg.protocol + '://' + cfg.host + ':' + cfg.port + cfg.remote);
    console.log('  local  : ' + path.relative(root, cfg.local) + '  (' + local.size + ' archivos gestionados)');
    console.log('');
    console.log('  nuevos      (' + added.length + '):' + (added.length ? '\n' + shortList(added) : ' ninguno'));
    console.log('  cambiados   (' + changed.length + '):' + (changed.length ? '\n' + shortList(changed) : ' ninguno'));
    console.log('  faltan srv  (' + missing.length + '):' + (missing.length ? '\n' + shortList(missing) : ' ninguno'));
    console.log('  distinto sz (' + desync.length + '):' + (desync.length ? '\n' + shortList(desync) : ' ninguno'));
    console.log('  obsoletos   (' + obsolete.length + '):' + (obsolete.length ? '\n' + shortList(obsolete) : ' ninguno'));
    console.log('  ajenos srv  (' + remoteOnly.length + '):' + (remoteOnly.length ? '\n' + shortList(remoteOnly) : ' ninguno'));
    console.log('\n  datos: .openbridge/app.json y .openbridge/data protegidos' + (o.dataAll ? ' (--data-all: se incluyen)' : o.data ? ' (--data: app.json incluido)' : ''));
    console.log('');
    return 0;
}

async function cmdSync(cfg, o) {
    requireConn(cfg);
    requireLocal(cfg);
    if (!o.noBuild) build();
    const local = collectLocal(cfg, o);
    const manifest = readManifest(cfg);
    const { added, changed, obsolete } = diffManifest(local, manifest, o);
    const todo = [...added, ...changed];
    console.log('\n  OpenBridge deploy — sync');
    console.log('  subir ' + todo.length + ' (' + added.length + ' nuevos, ' + changed.length + ' cambiados), borrar ' + obsolete.length + (o.prune ? ', prune activo' : ''));
    if (o.dryRun) {
        if (todo.length) console.log(shortList(todo));
        if (obsolete.length) console.log('    - ' + obsolete.join('\n    - '));
        console.log('\n  dry-run: nada se subio.\n');
        return 0;
    }
    const errors = [];
    const failed = new Set();
    let up = 0;
    for (const rel of todo) {
        process.stdout.write('    ^ ' + rel + '\n');
        const r = uploadFile(cfg, rel, local.get(rel).abs);
        if (r.ok) up++;
        else { errors.push(rel + ': ' + r.err); failed.add(rel); }
    }
    let del = 0;
    for (const rel of obsolete) {
        process.stdout.write('    x ' + rel + '\n');
        const r = deleteFile(cfg, rel);
        if (r.ok) del++;
        else errors.push(rel + ': ' + r.err);
    }
    if (o.prune) {
        const remote = remoteWalk(cfg, '', { skipData: !o.dataAll });
        const remoteOnly = [...remote.files.keys()].filter((rel) => (
            !local.has(rel) && !isProtectedDelete(rel, o) && !shouldNeverTouch(rel)
        ));
        for (const rel of remoteOnly) {
            process.stdout.write('    prune ' + rel + '\n');
            const r = deleteFile(cfg, rel);
            if (r.ok) del++;
            else errors.push(rel + ': ' + r.err);
        }
    }
    ensureRemoteDir(cfg, DATA_DIR);
    chmodData(cfg);
    const done = new Map([...local].filter(([rel]) => !failed.has(rel)));
    writeManifest(cfg, done);
    console.log('\n  subidos ' + up + ', borrados ' + del + ', errores ' + errors.length + ' (manifiesto actualizado)\n');
    if (errors.length) {
        console.error('  ' + errors.join('\n  '));
        return 1;
    }
    return 0;
}

function normRel(cfg, input) {
    let r = posix(input);
    const dist = posix(path.relative(root, cfg.local));
    if (dist && r.startsWith(dist + '/')) r = r.slice(dist.length + 1);
    return r.replace(/^\/+/, '');
}

// Sube SOLO los archivos indicados (relativos a php/dist). Ideal para probar un
// cambio puntual sin tocar el resto del deploy.
async function cmdPush(cfg, o) {
    requireConn(cfg);
    requireLocal(cfg);
    if (!o.positional.length) {
        fail('push necesita al menos un archivo relativo a php/dist (ej: push templates/chat.html).');
    }
    if (!o.noBuild) build();
    const rels = [...new Set(o.positional.map((p) => normRel(cfg, p)))];
    const local = collectLocal(cfg, o);
    console.log('\n  OpenBridge deploy — push');
    console.log('  archivos: ' + rels.join(', '));
    if (o.dryRun) {
        for (const rel of rels) console.log('    ^ ' + rel);
        console.log('\n  dry-run: nada se subio.\n');
        return 0;
    }
    const errors = [];
    const okRels = [];
    for (const rel of rels) {
        const abs = path.join(cfg.local, rel);
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) { errors.push(rel + ': no existe en ' + path.relative(root, cfg.local)); continue; }
        if (!includeFile(rel, o)) { errors.push(rel + ': protegido (usa --data/--data-all)'); continue; }
        process.stdout.write('    ^ ' + rel + '\n');
        const r = uploadFile(cfg, rel, abs);
        if (r.ok) okRels.push(rel);
        else errors.push(rel + ': ' + r.err);
    }
    const manifest = readManifest(cfg);
    const merged = new Map(Object.entries(manifest.files || {}));
    for (const rel of okRels) {
        const info = local.get(rel);
        merged.set(rel, info
            ? { sha256: info.sha256, size: info.size }
            : { sha256: sha256File(path.join(cfg.local, rel)), size: fs.statSync(path.join(cfg.local, rel)).size });
    }
    writeManifest(cfg, merged);
    console.log('\n  subidos ' + okRels.length + ', errores ' + errors.length + '\n');
    if (errors.length) { console.error('  ' + errors.join('\n  ')); return 1; }
    return 0;
}

async function cmdBackup(cfg, o) {
    requireConn(cfg);
    if (o.dryRun) {
        console.log('\n  OpenBridge deploy — backup (dry-run)');
        console.log('  destino: backups/' + cfg.host.replace(/[^A-Za-z0-9._-]/g, '_') + '/<fecha>/');
        console.log('  alcance: ' + (o.all ? 'docroot completo' : '.openbridge/app.json + .openbridge/data/**') + '\n');
        return 0;
    }
    const res = backup(cfg, o, o.all);
    console.log('\n  OpenBridge deploy — backup');
    console.log('  ' + res.count + ' archivos -> ' + path.relative(root, res.dest));
    if (res.failed.length) {
        console.error('  fallos:\n  ' + res.failed.join('\n  '));
        return 1;
    }
    console.log('');
    return 0;
}

function walkBackupFiles(dir) {
    const files = [];
    (function rec(rel) {
        const abs = rel ? path.join(dir, rel) : dir;
        for (const name of fs.readdirSync(abs)) {
            const childRel = rel ? rel + '/' + name : name;
            const full = path.join(abs, name);
            const st = fs.statSync(full);
            if (st.isDirectory()) rec(childRel);
            else if (st.isFile() && name !== 'backup-meta.json') files.push(childRel);
        }
    })('');
    return files.sort();
}

async function cmdRestore(cfg, o) {
    requireConn(cfg);
    const folder = o.positional[0];
    if (!folder) fail('restore necesita la carpeta del backup: deploy-php-hub.mjs restore backups/<host>/<fecha>');
    const src = path.resolve(root, folder);
    if (!fs.existsSync(src)) fail('no existe la carpeta ' + folder);
    let files;
    try { files = walkBackupFiles(src); } catch (e) { fail('no pude leer el backup: ' + e.message); }
    console.log('\n  OpenBridge deploy — restore');
    console.log('  ' + files.length + ' archivos desde ' + folder);
    if (o.dryRun) { console.log(shortList(files)); console.log('\n  dry-run: nada se subio.\n'); return 0; }
    const ok = await guardDestructive(o, 'Restaurar ' + files.length + ' archivos en ' + cfg.host);
    if (!ok) fail('cancelado por el usuario.');
    let up = 0;
    const errors = [];
    for (const rel of files) {
        process.stdout.write('    ^ ' + rel + '\n');
        const r = uploadFile(cfg, rel, path.join(src, rel));
        if (r.ok) up++;
        else errors.push(rel + ': ' + r.err);
    }
    ensureDataDir(cfg);
    chmodData(cfg);
    console.log('\n  restaurados ' + up + ', errores ' + errors.length + '\n');
    if (errors.length) { console.error('  ' + errors.join('\n  ')); return 1; }
    return 0;
}

async function cmdReset(cfg, o) {
    requireConn(cfg);
    requireLocal(cfg);
    if (!o.noBuild) build();
    const local = collectLocal(cfg, { data: true, dataAll: true });
    console.log('\n  OpenBridge deploy — reset');
    console.log('  wipe total de ' + cfg.remote + ' + re-sube ' + local.size + ' archivos');
    console.log('  datos: ' + (o.wipeData ? 'SE BORRAN (--wipe-data)' : 'se conservan (backup + restore)'));

    let backupRes = null;
    if (!o.noBackup && !o.dryRun) {
        backupRes = backup(cfg, o, false);
        console.log('  backup: ' + backupRes.count + ' archivos -> ' + path.relative(root, backupRes.dest));
    } else if (!o.noBackup && o.dryRun) {
        console.log('  backup: (dry-run)');
    } else {
        console.log('  backup: OMITIDO (--no-backup)');
    }

    if (o.dryRun) {
        console.log('\n  dry-run: plan de reset listo; no se toco el server.\n');
        return 0;
    }
    const ok = await guardDestructive(o, 'Borrar TODO el docroot y re-subir php/dist');
    if (!ok) fail('cancelado por el usuario.');

    const remote = remoteWalk(cfg, '', { skipData: false });
    const errors = [];
    let del = 0;
    for (const rel of remote.files.keys()) {
        if (shouldNeverTouch(rel)) continue;
        const r = deleteFile(cfg, rel);
        if (r.ok) del++;
        else errors.push(rel + ': ' + r.err);
    }
    const dirs = [...remote.dirs].sort((a, b) => b.split('/').length - a.split('/').length);
    for (const rel of dirs) {
        if (shouldNeverTouch(rel)) continue;
        removeDir(cfg, rel);
    }
    let up = 0;
    const failed = new Set();
    for (const rel of [...local.keys()].sort()) {
        process.stdout.write('    ^ ' + rel + '\n');
        const r = uploadFile(cfg, rel, local.get(rel).abs);
        if (r.ok) up++;
        else { errors.push(rel + ': ' + r.err); failed.add(rel); }
    }
    if (o.keepData && backupRes) {
        const files = walkBackupFiles(backupRes.dest);
        for (const rel of files) {
            const r = uploadFile(cfg, rel, path.join(backupRes.dest, rel));
            if (r.ok) up++;
            else errors.push(rel + ': ' + r.err);
        }
    }
    ensureDataDir(cfg);
    chmodData(cfg);
    writeManifest(cfg, new Map([...local].filter(([rel]) => !failed.has(rel))));
    console.log('\n  borrados ' + del + ', subidos ' + up + ', errores ' + errors.length + '\n');
    if (errors.length) { console.error('  ' + errors.join('\n  ')); return 1; }
    return 0;
}

async function cmdPrune(cfg, o) {
    requireConn(cfg);
    requireLocal(cfg);
    const local = collectLocal(cfg, o);
    const remote = remoteWalk(cfg, '', { skipData: !o.dataAll });
    const remoteOnly = [...remote.files.keys()].filter((rel) => (
        !local.has(rel) && !isProtectedDelete(rel, o) && !shouldNeverTouch(rel)
    ));
    console.log('\n  OpenBridge deploy — prune');
    console.log('  ajenos al deploy (' + remoteOnly.length + '):' + (remoteOnly.length ? '\n' + shortList(remoteOnly) : ' ninguno'));
    if (!remoteOnly.length) { console.log(''); return 0; }
    if (o.dryRun) { console.log('\n  dry-run: nada se borro.\n'); return 0; }
    const ok = await guardDestructive(o, 'Borrar ' + remoteOnly.length + ' archivos ajenos en el server');
    if (!ok) fail('cancelado por el usuario.');
    let del = 0;
    const errors = [];
    for (const rel of remoteOnly) {
        process.stdout.write('    x ' + rel + '\n');
        const r = deleteFile(cfg, rel);
        if (r.ok) del++;
        else errors.push(rel + ': ' + r.err);
    }
    console.log('\n  borrados ' + del + ', errores ' + errors.length + '\n');
    if (errors.length) { console.error('  ' + errors.join('\n  ')); return 1; }
    return 0;
}

async function cmdChmod(cfg, o) {
    requireConn(cfg);
    if (o.dryRun) { console.log('\n  chmod: .openbridge y .openbridge/data -> 0755 (dry-run)\n'); return 0; }
    ensureDataDir(cfg);
    chmodData(cfg);
    console.log('\n  permisos: .openbridge y .openbridge/data -> 0755\n');
    return 0;
}

async function cmdInit(cfg, o) {
    requireConn(cfg);
    requireLocal(cfg);
    if (!o.noBuild) build();
    const local = collectLocal(cfg, { data: true, dataAll: true });
    if (!o.dryRun) {
        let entries = [];
        try { entries = listDir(cfg, ''); } catch { /* server vacio o sin acceso */ }
        const deployed = entries.some((e) => e.name === 'api.php');
        if (deployed && !o.yes) {
            const ok = await guardDestructive(o, 'El server ya tiene el hub. Subir app.json encima');
            if (!ok) fail('cancelado. Usa `sync` para actualizar sin tocar datos.');
        }
    }
    console.log('\n  OpenBridge deploy — init');
    console.log('  ' + local.size + ' archivos (incluye app.json y data)');
    if (o.dryRun) { console.log(shortList([...local.keys()])); console.log('\n  dry-run: nada se subio.\n'); return 0; }
    let up = 0;
    const errors = [];
    const failed = new Set();
    for (const rel of [...local.keys()].sort()) {
        process.stdout.write('    ^ ' + rel + '\n');
        const r = uploadFile(cfg, rel, local.get(rel).abs);
        if (r.ok) up++;
        else { errors.push(rel + ': ' + r.err); failed.add(rel); }
    }
    ensureDataDir(cfg);
    chmodData(cfg);
    writeManifest(cfg, new Map([...local].filter(([rel]) => !failed.has(rel))));
    console.log('\n  subidos ' + up + ', errores ' + errors.length + '\n');
    if (errors.length) { console.error('  ' + errors.join('\n  ')); return 1; }
    return 0;
}

function usage() {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
        .split('\n').filter((l) => l.startsWith('//')).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}

async function main() {
    const o = parseArgs(process.argv.slice(2));
    if (o.cmd === 'help') { usage(); return 0; }
    if (!o.cmd) o.cmd = 'status';
    const cfg = loadConfig(o);
    cfg.dryRun = o.dryRun;
    const commands = {
        status: cmdStatus, sync: cmdSync, push: cmdPush, backup: cmdBackup,
        restore: cmdRestore, reset: cmdReset, prune: cmdPrune, chmod: cmdChmod, init: cmdInit,
    };
    const fn = commands[o.cmd];
    if (!fn) fail('comando desconocido: ' + o.cmd);
    const code = await fn(cfg, o);
    process.exit(code || 0);
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
    main().catch((e) => fail(e && e.message ? e.message : String(e)));
}