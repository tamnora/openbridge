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
    processes: {
        enabled: true,
        allow: ['npm', 'node', 'npx', 'php', 'python', 'python3', 'composer', 'pnpm', 'yarn', 'bun', 'bunx'],
        maxGlobal: 3,
    },
};

const DEFAULT_APP = {
    port: 8799,
    host: '127.0.0.1',
    baseUrl: '',
    username: 'admin',       // legado (migra a users[0])
    password: null,          // legado (migra a users[0])
    users: [],               // [{ id, name, role, password, pv, created, disabled }]
    csrfSecret: '',
    bridgeToken: '',
    vapid: { publicKey: '', privateKey: '' },
    tunnel: { provider: 'tunnelmole', domain: '' },
};

const USER_ROLES = ['admin', 'user'];

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
    normalizeApp(data);
    return data;
}
function writeApp(cfg) {
    const out = { ...cfg };
    // Una vez migrado a `users`, no dejamos la contrasena legado suelta.
    if (Array.isArray(out.users) && out.users.length) {
        delete out.username;
        delete out.password;
    }
    writeJsonFile(paths.appConfigPath(), out);
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

// ---------------------------------------------------------------------------
// Usuarios (multiusuario con roles admin|user). El modelo viejo de un solo
// `username`+`password` se migra solo a `users[0]`.
// ---------------------------------------------------------------------------
function userValidName(name) {
    return typeof name === 'string' && /^[A-Za-z0-9._-]{1,32}$/.test(name);
}
function makeUser(name, password, role = 'user') {
    return {
        id: 'u_' + crypto.randomBytes(6).toString('hex'),
        name: String(name),
        role: USER_ROLES.includes(role) ? role : 'user',
        password: hashPassword(password),
        pv: 1,
        created: new Date().toISOString(),
        disabled: false,
    };
}
// Devuelve la lista de usuarios, sintetizando el admin legado si hace falta.
function userList(app) {
    if (app && Array.isArray(app.users) && app.users.length) return app.users;
    if (app && app.password && app.password.hash) {
        return [{
            id: 'u1',
            name: (typeof app.username === 'string' && app.username) ? app.username : 'admin',
            role: 'admin',
            password: app.password,
            pv: 1,
            created: '',
            disabled: false,
        }];
    }
    return [];
}
function normalizeApp(app) {
    if (!app || typeof app !== 'object') return app;
    if (!Array.isArray(app.users)) app.users = [];
    app.users = app.users.filter((u) => u && typeof u === 'object' && typeof u.name === 'string' && u.password);
    if (!app.users.length) {
        const migrated = userList(app);
        if (migrated.length) app.users = migrated;
    }
    return app;
}
function findUser(app, name) {
    const n = String(name || '').trim().toLowerCase();
    if (n === '') return null;
    return userList(app).find((u) => String(u.name).toLowerCase() === n) || null;
}
function userById(app, id) {
    return userList(app).find((u) => u.id === id) || null;
}
function verifyUserPassword(user, password) {
    return !!user && verifyPassword(password, user.password);
}
function adminCount(app) {
    return userList(app).filter((u) => u.role === 'admin' && !u.disabled).length;
}

// Claves VAPID (P-256) en el formato que espera web-push (base64url).
function genVapid() {
    const webpush = require('web-push');
    const keys = webpush.generateVAPIDKeys();
    return { publicKey: keys.publicKey, privateKey: keys.privateKey };
}

module.exports = {
    DEFAULT_BRIDGE, DEFAULT_APP, USER_ROLES,
    readBridge, writeBridge, readApp, writeApp,
    randomToken, hashPassword, verifyPassword, genVapid,
    userValidName, makeUser, userList, normalizeApp, findUser, userById, verifyUserPassword, adminCount,
    readJsonFile, writeJsonFile,
};
