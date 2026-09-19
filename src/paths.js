'use strict';

/**
 * Casa portable de OpenBridge.
 *
 * La "base" es el directorio que elegis (cwd, --dir o OPENBRIDGE_HOME). Todos
 * los archivos de OpenBridge viven dentro de `<base>/.openbridge`:
 *
 *   config.json   → configuracion del puente (la lee src/bridge/bridge.js)
 *   app.json      → configuracion de la app (password, token, VAPID, puerto)
 *   folders.json  → lista blanca de carpetas
 *   data/         → sesiones, mensajes, catalogos, registro de puentes, push
 *   logs/         → logs del server y del puente
 *
 * Si existe un layout viejo (config.json suelto en la base), migrate() lo mueve
 * automaticamente a `.openbridge/`.
 */

const fs = require('node:fs');
const path = require('node:path');

const DIR_NAME = '.openbridge';

let overrideBase = null;

function setBase(dir) {
    overrideBase = dir ? path.resolve(dir) : null;
}
// Alias historico: la CLI y los tests llaman setHome(dir) con la base.
function setHome(dir) { setBase(dir); }

function baseDir() {
    if (overrideBase) return overrideBase;
    const env = process.env.OPENBRIDGE_HOME || process.env.OPENCONEX_HOME;
    if (env) return path.resolve(env);
    return process.cwd();
}

function home() {
    const base = baseDir();
    // Evita anidar `.openbridge/.openbridge` si la base ya ES la carpeta de datos.
    if (path.basename(base) === DIR_NAME) return base;
    return path.join(base, DIR_NAME);
}

function p(...parts) {
    return path.join(home(), ...parts);
}

function configPath() { return p('config.json'); }
function appConfigPath() { return p('app.json'); }
function foldersPath() { return p('folders.json'); }
function modePath() { return p('mode.txt'); }
function pidPath() { return p('.openbridge.pid'); }
function bridgeLockPath() { return p('.bridge.pid'); }
function dataDir() { return p('data'); }
function logsDir() { return p('logs'); }
function serverLogPath() { return p('logs', 'server.log'); }
function bridgeLogPath() { return p('logs', 'bridge.log'); }
function syncStatePath() { return p('sync-state.json'); }
function procsStatePath() { return p('.procs.json'); }

function sessionsFile() { return p('data', 'sessions.json'); }
function catalogFile() { return p('data', 'catalog.json'); }
function bridgesFile() { return p('data', 'bridges.json'); }
function pushFile() { return p('data', 'push.json'); }
function messagesFile(id) { return p('data', 'messages-' + (parseInt(id, 10) || 0) + '.json'); }
function bridgeCatalogFile(id) {
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(id)) return catalogFile();
    return p('data', 'catalog-' + id.replace(/[^A-Za-z0-9._-]/g, '') + '.json');
}

// Indice liviano de sesiones de opencode (metadatos, sin historial).
function sessionIndexFile(id) {
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(id)) return p('data', 'index.json');
    return p('data', 'index-' + id.replace(/[^A-Za-z0-9._-]/g, '') + '.json');
}
// Resultado efimero de una lectura grande (historial por proxy); se borra al
// consumirse.
function fetchFile(id) { return p('data', 'fetch-' + (parseInt(id, 10) || 0) + '.json'); }
// Cola de mensajes salientes por puente (transitoria: se vacia al ejecutarse).
function queueFile(id) {
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(id)) return p('data', 'queue.json');
    return p('data', 'queue-' + id.replace(/[^A-Za-z0-9._-]/g, '') + '.json');
}
// Turno en curso (streaming) por puente; se limpia al terminar.
function inflightFile(id) {
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(id)) return p('data', 'inflight.json');
    return p('data', 'inflight-' + id.replace(/[^A-Za-z0-9._-]/g, '') + '.json');
}

// ---------------------------------------------------------------------------
// Migracion del layout viejo (archivos sueltos en la base) a `.openbridge/`
// ---------------------------------------------------------------------------
const LEGACY_FILES = [
    'config.json', 'app.json', 'folders.json', 'mode.txt',
    'sync-state.json', '.procs.json', '.openbridge.pid', '.bridge.pid', 'runtime.json',
];

function legacyDataDir(dir) {
    return fs.existsSync(path.join(dir, 'sessions.json'))
        || fs.existsSync(path.join(dir, 'catalog.json'))
        || fs.existsSync(path.join(dir, 'bridges.json'));
}
function legacyLogsDir(dir) {
    return fs.existsSync(path.join(dir, 'bridge.log'))
        || fs.existsSync(path.join(dir, 'server.log'));
}

function movePath(from, to) {
    try {
        fs.renameSync(from, to);
        return true;
    } catch (e) {
        try {
            fs.cpSync(from, to, { recursive: true });
            fs.rmSync(from, { recursive: true, force: true });
            return true;
        } catch (e2) {
            return false;
        }
    }
}

// Mueve el layout viejo a `.openbridge/`. Devuelve los nombres migrados (array;
// vacio si no habia nada que migrar). Solo toca data/ y logs/ si tienen marcas
// de OpenBridge, para no mover carpetas ajenas del usuario.
function migrate() {
    const base = baseDir();
    const target = home();
    if (fs.existsSync(target)) return [];
    if (!fs.existsSync(path.join(base, 'config.json'))) return [];

    const items = [];
    for (const n of LEGACY_FILES) {
        if (fs.existsSync(path.join(base, n))) items.push(n);
    }
    const dataSrc = path.join(base, 'data');
    if (fs.existsSync(dataSrc) && legacyDataDir(dataSrc)) items.push('data');
    const logsSrc = path.join(base, 'logs');
    if (fs.existsSync(logsSrc) && legacyLogsDir(logsSrc)) items.push('logs');
    if (!items.length) return [];

    try { fs.mkdirSync(target, { recursive: true }); } catch (e) { return []; }
    const moved = [];
    for (const n of items) {
        if (movePath(path.join(base, n), path.join(target, n))) moved.push(n);
    }
    return moved;
}

function ensureDirs() {
    migrate();
    for (const d of [home(), dataDir(), logsDir()]) {
        try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* ya existe */ }
    }
}

function exists() {
    return fs.existsSync(configPath()) && fs.existsSync(appConfigPath());
}

module.exports = {
    DIR_NAME,
    setBase, setHome, baseDir, home, p,
    configPath, appConfigPath, foldersPath, modePath, pidPath, bridgeLockPath,
    dataDir, logsDir, serverLogPath, bridgeLogPath,
    syncStatePath, procsStatePath,
    sessionsFile, catalogFile, bridgesFile, pushFile, messagesFile, bridgeCatalogFile,
    sessionIndexFile, fetchFile,
    queueFile, inflightFile,
    migrate, ensureDirs, exists,
};
