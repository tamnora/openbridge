'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const paths = require('./paths');

const DEFAULT_BRIDGE = {
    apiUrl: '',
    apiUrlLocal: '',
    mode: 'remoto',
    apiToken: '',
    pollIntervalMs: 1500,
    command: 'opencode',
    opencodeTimeoutMs: 15 * 60 * 1000,
    logFile: 'logs/bridge.log',
    foldersFile: 'folders.json',
    workspace: '',
    allowCreateFolders: true,
    models: [],
    agents: ['build', 'plan'],
    bridgeId: '',
    bridgeName: '',
    processes: { enabled: true, allow: ['npm', 'node', 'npx'], maxGlobal: 3 },
};

const DEFAULT_APP = {
    port: 8799,
    host: '127.0.0.1',
    baseUrl: '',
    username: 'admin',
    password: null,          // { algo, salt, hash, keylen }
    csrfSecret: '',
    bridgeToken: '',
    vapid: { publicKey: '', privateKey: '' },
    tunnel: { provider: 'tunnelmole', domain: '' },
};

function readJsonFile(file, fallback) {
    try {
        const raw = fs.readFileSync(file, 'utf8');
        const data = JSON.parse(raw);
        return (data && typeof data === 'object') ? data : { ...fallback };
    } catch (e) {
        return { ...fallback };
    }
}

function writeJsonFile(file, data) {
    paths.ensureDirs();
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
}

function readBridge() {
    return { ...DEFAULT_BRIDGE, ...readJsonFile(paths.configPath(), DEFAULT_BRIDGE) };
}
function writeBridge(cfg) {
    writeJsonFile(paths.configPath(), cfg);
}
function readApp() {
    const data = { ...DEFAULT_APP, ...readJsonFile(paths.appConfigPath(), DEFAULT_APP) };
    data.vapid = { ...DEFAULT_APP.vapid, ...(data.vapid || {}) };
    data.tunnel = { ...DEFAULT_APP.tunnel, ...(data.tunnel || {}) };
    return data;
}
function writeApp(cfg) {
    writeJsonFile(paths.appConfigPath(), cfg);
}

function randomToken(bytes = 32) {
    return crypto.randomBytes(bytes).toString('base64url');
}

function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const keylen = 64;
    const hash = crypto.scryptSync(String(password), salt, keylen).toString('hex');
    return { algo: 'scrypt', salt, hash, keylen };
}

function verifyPassword(password, stored) {
    if (!stored || stored.algo !== 'scrypt' || !stored.salt || !stored.hash) return false;
    const keylen = parseInt(stored.keylen, 10) || 64;
    let calc;
    try {
        calc = crypto.scryptSync(String(password), stored.salt, keylen);
    } catch (e) {
        return false;
    }
    const expected = Buffer.from(stored.hash, 'hex');
    if (calc.length !== expected.length) return false;
    return crypto.timingSafeEqual(calc, expected);
}

// Claves VAPID (P-256) en el formato que espera web-push (base64url).
function genVapid() {
    const webpush = require('web-push');
    const keys = webpush.generateVAPIDKeys();
    return { publicKey: keys.publicKey, privateKey: keys.privateKey };
}

module.exports = {
    DEFAULT_BRIDGE, DEFAULT_APP,
    readBridge, writeBridge, readApp, writeApp,
    randomToken, hashPassword, verifyPassword, genVapid,
    readJsonFile, writeJsonFile,
};
