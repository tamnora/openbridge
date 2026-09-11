'use strict';

/**
 * Casa portable de OpenBridge.
 *
 * Por defecto la casa es el directorio actual (donde corres `openbridge init`).
 * Se puede fijar otra con la variable de entorno OPENBRIDGE_HOME (o el alias
 * OPENCONEX_HOME) o con --dir en la CLI.
 *
 * Dentro de la casa viven:
 *   config.json   → configuracion del puente (la lee src/bridge/bridge.js)
 *   app.json      → configuracion de la app (password, token, VAPID, puerto)
 *   folders.json  → lista blanca de carpetas
 *   data/         → sesiones, mensajes, catalogos, registro de puentes, push
 *   logs/         → logs del server y del puente
 */

const fs = require('node:fs');
const path = require('node:path');

let overrideHome = null;

function setHome(dir) {
    overrideHome = dir ? path.resolve(dir) : null;
}

function home() {
    if (overrideHome) return overrideHome;
    const env = process.env.OPENBRIDGE_HOME || process.env.OPENCONEX_HOME;
    if (env) return path.resolve(env);
    return process.cwd();
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

function ensureDirs() {
    for (const d of [home(), dataDir(), logsDir()]) {
        try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* ya existe */ }
    }
}

function exists() {
    return fs.existsSync(configPath()) && fs.existsSync(appConfigPath());
}

module.exports = {
    setHome, home, p,
    configPath, appConfigPath, foldersPath, modePath, pidPath, bridgeLockPath,
    dataDir, logsDir, serverLogPath, bridgeLogPath,
    syncStatePath, procsStatePath,
    sessionsFile, catalogFile, bridgesFile, pushFile, messagesFile, bridgeCatalogFile,
    ensureDirs, exists,
};
