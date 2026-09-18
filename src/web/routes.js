'use strict';

/**
 * Router de la app (port de app/api.php). Mantiene el mismo contrato JSON y
 * las mismas rutas (?action=...) que la version PHP, para que app.js y
 * bridge.js funcionen sin cambios.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const auth = require('../auth');
const config = require('../config');
const store = require('../store');
const paths = require('../paths');
const push = require('../push');
const jsonfile = require('../store/jsonfile');

const TEMPLATES = path.join(__dirname, 'templates');
const APP_VERSION = require('../../package.json').version;

// Hash dummy para igualar el costo de scrypt cuando el usuario no existe (evita
// filtrar si un nombre esta registrado por diferencias de tiempo).
const DUMMY_HASH = { algo: 'scrypt', salt: '00000000000000000000000000000000', hash: '00'.repeat(64), keylen: 64 };

// Acciones que solo puede hacer un admin.
const ADMIN_ONLY_ACTIONS = new Set(['session_delete']);
// Comandos del puente que mutan algo (procesos, tuneles, revertir).
const OC_MUTATING = new Set(['proc_start', 'proc_stop', 'tunnel_start', 'tunnel_stop', 'git_checkout', 'session_sync_all']);

async function renderTpl(name, vars) {
    const tpl = await fsp.readFile(path.join(TEMPLATES, name), 'utf8');
    return tpl.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (
        Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m
    ));
}

function pickTheme(req, query, known) {
    const cookies = auth.parseCookies(req.headers.cookie);
    const fromUrl = String(query.get('theme') || '').replace(/[^a-z-]/g, '').toLowerCase();
    const fromCookie = String(cookies['ob_theme'] || cookies['ocx_theme'] || '').replace(/[^a-z-]/g, '').toLowerCase();
    if (fromUrl && known.includes(fromUrl)) return fromUrl;
    if (fromCookie && known.includes(fromCookie)) return fromCookie;
    return 'terminal';
}

// ---------------------------------------------------------------------------
// Paginas
// ---------------------------------------------------------------------------
async function handleIndex({ app, req, res }) {
    const logged = auth.readSession(app, req);
    res.writeHead(302, { Location: logged ? 'chat.php' : 'login.php' });
    res.end();
}

async function handleLogout({ app, req, res }) {
    auth.endSession(req, res);
    res.writeHead(302, { Location: 'login.php' });
    res.end();
}

async function loginCsrf(req, res) {
    const cookies = auth.parseCookies(req.headers.cookie);
    let csrf = cookies['ob_csrf'];
    if (!csrf) {
        csrf = crypto.randomBytes(16).toString('hex');
        res.setHeader('Set-Cookie', auth.serializeCookie('ob_csrf', csrf, req, 3600));
    }
    return csrf;
}

// Ultimo usuario logueado (para prellenar el campo en el login).
function lastUser(req) {
    const cookies = auth.parseCookies(req.headers.cookie);
    return String(cookies['ob_lastuser'] || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 32);
}

async function handleLoginPage({ app, req, res, query }) {
    if (auth.readSession(app, req)) {
        res.writeHead(302, { Location: 'chat.php' });
        return res.end();
    }
    const known = store.themesKnown();
    const csrf = await loginCsrf(req, res);
    const html = await renderTpl('login.html', {
        THEME: pickTheme(req, query, known),
        THEMES_JSON: JSON.stringify(store.themesIndex()),
        ERROR_BLOCK: '',
        CSRF: csrf,
        USER_PREFILL: lastUser(req),
    });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(html);
}

async function handleLogin({ app, req, res, query, form }) {
    const cookies = auth.parseCookies(req.headers.cookie);
    const csrfOk = form.csrf && cookies['ob_csrf'] && auth.safeEqual(form.csrf, cookies['ob_csrf']);
    const known = store.themesKnown();
    const renderError = async (msg) => {
        const csrf = await loginCsrf(req, res);
        const html = await renderTpl('login.html', {
            THEME: pickTheme(req, query, known),
            THEMES_JSON: JSON.stringify(store.themesIndex()),
            ERROR_BLOCK: '<div class="error">\u26a0 ' + msg.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) + '</div>',
            CSRF: csrf,
            USER_PREFILL: lastUser(req) || String(form.username || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 32),
        });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(html);
    };
    if (!csrfOk) return renderError('Sesion expirada, recarga la pagina.');
    const username = String(form.username || '').trim();
    const locked = auth.loginLockRemaining(req, username);
    if (locked > 0) {
        const mins = Math.max(1, Math.ceil(locked / 60));
        return renderError('Demasiados intentos fallidos. Proba de nuevo en ' + mins + ' min.');
    }
    const password = String(form.password || '');
    const user = config.findUser(app, username);
    const passOk = config.verifyUserPassword(user, password);
    if (!user) config.verifyPassword(password, DUMMY_HASH); // mismo costo si no existe
    if (user && !user.disabled && passOk) {
        auth.loginClear(req, username);
        auth.startSession(app, req, res, user);
        const prev = res.getHeader('Set-Cookie');
        const jar = Array.isArray(prev) ? prev.slice() : (prev ? [prev] : []);
        jar.push(auth.serializeCookie('ob_lastuser', user.name, req, 60 * 60 * 24 * 365));
        res.setHeader('Set-Cookie', jar);
        res.writeHead(302, { Location: 'chat.php' });
        return res.end();
    }
    auth.loginRecordFailure(req, username);
    return renderError('Usuario o contrasena incorrectos.');
}

async function handleChat({ app, req, res, query }) {
    if (!auth.readSession(app, req)) auth.rememberAutoLogin(app, req, res);
    const session = auth.readSession(app, req);
    if (!session) {
        res.writeHead(302, { Location: 'login.php' });
        return res.end();
    }
    const known = store.themesKnown();
    const initial = parseInt(query.get('session') || '0', 10) || 0;
    let ver = '0';
    try { ver = String(Math.floor((await fsp.stat(path.join(__dirname, 'assets', 'app.js'))).mtimeMs)); } catch (e) { /* nada */ }
    const html = await renderTpl('chat.html', {
        THEME: pickTheme(req, query, known),
        CSRF: session.c,
        USER_NAME: session.name,
        USER_ROLE: session.role,
        INITIAL_SESSION: initial > 0 ? String(initial) : 'null',
        THEMES_JSON: JSON.stringify(store.themesIndex()),
        SSE_DISABLED: 'false',
        PUSH_ENABLED: push.pushEnabled(app) ? 'true' : 'false',
        PUSH_KEY: push.publicKeyBase64url(app),
        APPJS_VER: encodeURIComponent(ver),
        APP_VERSION,
    });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(html);
}

// ---------------------------------------------------------------------------
// Helpers de puente
// ---------------------------------------------------------------------------
function headerBridge(req) {
    const h = String(req.headers['x-bridge-id'] || '').trim();
    return store.bridgeValidId(h) ? h : '';
}
function reqBridge(req, query) {
    const h = headerBridge(req);
    if (h) return h;
    const q = String(query.get('bridge') || '').trim();
    return store.bridgeValidId(q) ? q : '';
}
function headerBridgeName(req) {
    const h = String(req.headers['x-bridge-name'] || '').trim();
    return h.replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 40);
}
async function webBridge(req, query) {
    const b = reqBridge(req, query);
    if (b) return b;
    return await store.soleBridgeId();
}
function bodyBridge(req, query, body) {
    const b = body && typeof body.bridge === 'string' ? body.bridge : '';
    if (store.bridgeValidId(b)) return b;
    return null; // lo resuelve webBridge
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
const OC_ALLOWED = {
    models: [],
    session_list: [],
    session_info: ['arg'],
    opencode_version: [],
    mcp_list: [],
    fs_list: ['path'],
    fs_read: ['path'],
    git_status: ['path'],
    git_diff: ['path'],
    git_checkout: ['path', 'path'],
    tunnel_start: ['arg'],
    tunnel_stop: ['arg'],
    tunnel_list: [],
    proc_start: ['path', 'cmd'],
    proc_stop: ['arg'],
    proc_list: [],
    proc_log: ['arg', 'arg'],
    proc_detect: ['path'],
    port_free: ['arg'],
    session_sync: ['arg', 'path'],
    session_sync_all: [],
};

function ocArgValido(tipo, valor) {
    const a = String(valor);
    if (tipo === 'path') return Array.from(a).length <= 300 && !a.includes('..') && !/[\x00-\x1f\x7f]/.test(a);
    if (tipo === 'cmd') return Array.from(a).length <= 200 && /^[\p{L}\p{N} _\-.:@/+=]{1,200}$/u.test(a);
    return /^[A-Za-z0-9_\-./]{1,80}$/.test(a);
}

function imageOk(img) {
    return /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(img);
}

async function handleApi(ctx) {
    const { app, req, res, method, query, body } = ctx;
    const action = String(query.get('action') || '');
    const ok = (data, code = 200) => auth.json(res, code, data);

    if (action === 'ping') return ok({ ok: true, now: store.nowIso() });

    switch (action) {
        case 'catalog': {
            if (!auth.requireLogin(app, req, res)) return;
            const bridge = await webBridge(req, query);
            const file = paths.bridgeCatalogFile(bridge);
            const cat = await store.catalogRead(file);
            const ver = store.catalogVersion(cat);
            const v = String(query.get('v') || '');
            const live = await store.bridgesSummary();
            const overlay = await store.bridgeLiveOverlay(cat, bridge);
            if (v !== '' && v === ver) {
                return ok({ ok: true, changed: false, cat_ver: ver, bridge, bridges: live, online_ts: overlay.last_online_ts || '' });
            }
            return ok({ ok: true, changed: true, catalog: overlay, cat_ver: ver, bridge, bridges: live, online_ts: overlay.last_online_ts || '' });
        }
        case 'bootstrap': {
            if (!auth.requireLogin(app, req, res)) return;
            const bridge = await webBridge(req, query);
            const file = paths.bridgeCatalogFile(bridge);
            const cat = await store.catalogRead(file);
            const ver = store.catalogVersion(cat);
            const v = String(query.get('v') || '');
            const changed = !(v !== '' && v === ver);
            const overlay = await store.bridgeLiveOverlay(cat, bridge);
            const out = {
                ok: true,
                changed,
                cat_ver: ver,
                bridge,
                bridges: await store.bridgesSummary(),
                sessions: await store.sessionsListFull(),
                online_ts: overlay.last_online_ts || '',
            };
            if (changed) out.catalog = overlay;
            return ok(out);
        }
        case 'sessions': {
            if (!auth.requireLogin(app, req, res)) return;
            return ok({ ok: true, sessions: await store.sessionsListFull() });
        }
        case 'session_create': {
            if (!auth.requireLogin(app, req, res)) return;
            if (!auth.requireCsrf(app, req, res)) return;
            const name = String(body.name || '').trim();
            const folder = String(body.folder || '');
            const model = String(body.model || '');
            const agent = String(body.agent || 'build');
            const bridge = bodyBridge(req, query, body) || await webBridge(req, query);
            const file = paths.bridgeCatalogFile(bridge);
            if (folder === '' || (await store.folderPathInCatalog(folder, file)) === null) return ok({ ok: false, error: 'Carpeta no disponible' }, 400);
            if (model === '' || !(await store.modelInCatalog(model, file))) return ok({ ok: false, error: 'Modelo no disponible' }, 400);
            if (!(await store.agentInCatalog(agent, file))) return ok({ ok: false, error: 'Agente no disponible' }, 400);
            if (Array.from(name).length > 60) return ok({ ok: false, error: 'Nombre demasiado largo' }, 400);
            const id = await store.addSession(name, folder, model, agent, null, bridge);
            return ok({ ok: true, session: await store.getSession(id) });
        }
        case 'session_delete': {
            const s = auth.requireCsrf(app, req, res);
            if (!s) return;
            if (s.role !== 'admin') return ok({ ok: false, error: 'Permiso insuficiente' }, 403);
            const id = parseInt(body.id, 10) || 0;
            if (id <= 0) return ok({ ok: false, error: 'id invalido' }, 400);
            await store.deleteSession(id);
            return ok({ ok: true });
        }
        case 'session_update': {
            if (!auth.requireLogin(app, req, res)) return;
            if (!auth.requireCsrf(app, req, res)) return;
            const id = parseInt(body.id, 10) || 0;
            const sess = id > 0 ? await store.getSession(id) : null;
            if (!sess) return ok({ ok: false, error: 'Sesion no encontrada' }, 404);
            const file = paths.bridgeCatalogFile(store.sessionBridge(sess));
            const model = String(body.model || '').trim();
            const agent = String(body.agent || '').trim();
            if (model === '' && agent === '') return ok({ ok: false, error: 'Nada que cambiar' }, 400);
            if (model !== '' && !(await store.modelInCatalog(model, file))) return ok({ ok: false, error: 'Modelo no disponible' }, 400);
            if (agent !== '' && !(await store.agentInCatalog(agent, file))) return ok({ ok: false, error: 'Agente no disponible' }, 400);
            let updated = null;
            await store.sessionsUpdate((sdata) => {
                const i = sdata.sessions.findIndex((s) => parseInt(s.id, 10) === id);
                if (i < 0) return false;
                if (model !== '') sdata.sessions[i].model = model;
                if (agent !== '') sdata.sessions[i].agent = agent;
                sdata.sessions[i].last_ts = store.nowIso();
                updated = sdata.sessions[i];
            });
            return ok({ ok: true, session: updated });
        }
        case 'history': {
            if (!auth.requireLogin(app, req, res)) return;
            const sid = parseInt(query.get('session') || '0', 10) || 0;
            const sess = sid > 0 ? await store.getSession(sid) : null;
            if (!sess) return ok({ ok: false, error: 'Sesion no encontrada' }, 404);
            const data = await store.messagesRead(sid);
            if (store.messagesHealStaleStreaming(data, Date.now() - store.STALE_PROCESSING_SECONDS * 1000)) {
                await jsonfile.writeAtomic(paths.messagesFile(sid), data);
            }
            const since = parseInt(query.get('since') || '0', 10) || 0;
            const sinceTs = String(query.get('ts') || '');
            let msgs = data.messages;
            if (since > 0) {
                const tsCut = sinceTs ? Date.parse(sinceTs) : 0;
                msgs = msgs.filter((m) => parseInt(m.id, 10) > since
                    || m.status === 'streaming'
                    || (m.answered_ts && tsCut > 0 && Date.parse(m.answered_ts) > tsCut));
            }
            return ok({ ok: true, session: sess, messages: msgs });
        }
        case 'cancel': {
            if (!auth.requireLogin(app, req, res)) return;
            if (!auth.requireCsrf(app, req, res)) return;
            const sid = parseInt(body.session, 10) || 0;
            if (sid <= 0 || !(await store.getSession(sid))) return ok({ ok: false, error: 'Sesion no encontrada' }, 404);
            let marked = 0;
            await store.messagesUpdate(sid, (data) => {
                for (const msg of data.messages) {
                    if (msg.role !== 'user') continue;
                    if (msg.status === 'pending') { msg.status = 'canceled'; msg.canceled_ts = store.nowIso(); marked++; }
                    else if (msg.status === 'processing' && !msg.cancel_requested) { msg.cancel_requested = true; marked++; }
                }
                if (!marked) return false;
            });
            if (!marked) return ok({ ok: false, error: 'No hay nada en curso para cancelar' }, 400);
            return ok({ ok: true, marked });
        }
        case 'cancel_status': {
            if (!auth.checkBridgeToken(app, req)) return ok({ ok: false, error: 'Token invalido' }, 401);
            const sid = parseInt(body.session_id, 10) || 0;
            if (sid <= 0) return ok({ ok: false, error: 'session_id requerido' }, 400);
            const data = await store.messagesRead(sid);
            for (const msg of data.messages) {
                if (msg.role === 'user' && msg.cancel_requested) {
                    return ok({ ok: true, cancel: true, user_id: parseInt(msg.id, 10) });
                }
            }
            return ok({ ok: true, cancel: false });
        }
        case 'send': {
            const s = auth.requireCsrf(app, req, res);
            if (!s) return;
            const sid = parseInt(body.session, 10) || 0;
            const sess = sid > 0 ? await store.getSession(sid) : null;
            if (!sess) return ok({ ok: false, error: 'Sesion no encontrada' }, 404);
            const text = String(body.text || '').trim();
            const img = String(body.image || '').trim();
            if (img !== '') {
                if (!imageOk(img)) return ok({ ok: false, error: 'Imagen invalida' }, 400);
                if (img.length * 3 / 4 > 4 * 1024 * 1024) return ok({ ok: false, error: 'Imagen demasiado grande (max 4 MB)' }, 400);
            }
            if (text === '' && img === '') return ok({ ok: false, error: 'Mensaje vacio' }, 400);
            if (Array.from(text).length > 10000) return ok({ ok: false, error: 'Mensaje demasiado largo' }, 400);
            const extra = { agent: String(sess.agent || 'build'), author: s.name };
            if (img !== '') extra.img = img;
            const id = await store.addMessage(sid, 'user', text, 'pending', extra);
            if (store.sessionHasDefaultName(sess)) {
                const t = store.sessionTitleFromPrompt(text);
                if (t !== '') await store.sessionRename(sid, t);
            }
            return ok({ ok: true, id });
        }
        case 'sync_catalog': {
            if (!auth.checkBridgeToken(app, req)) return ok({ ok: false, error: 'Token invalido' }, 401);
            const bridge = reqBridge(req, query);
            const name = headerBridgeName(req);
            await store.bridgeRegisterFirst(bridge, name);
            await store.bridgeRegistryUpsert(bridge, name);
            const file = paths.bridgeCatalogFile(bridge);
            const folders = [];
            for (const f of (Array.isArray(body.folders) ? body.folders : [])) {
                if (f && typeof f === 'object' && f.name !== undefined && f.path !== undefined) {
                    folders.push({ name: store.mbSubstr(String(f.name), 0, 60), path: store.mbSubstr(String(f.path), 0, 500) });
                } else if (typeof f === 'string') {
                    folders.push({ name: store.mbSubstr(f, 0, 60), path: store.mbSubstr(f, 0, 500) });
                }
            }
            const models = (Array.isArray(body.models) ? body.models : [])
                .filter((m) => typeof m === 'string' && m.trim() !== '').map((m) => store.mbSubstr(m.trim(), 0, 120));
            const modelsFull = {};
            if (body.models_full && typeof body.models_full === 'object') {
                let count = 0;
                for (const prov of Object.keys(body.models_full)) {
                    if (count >= 80) break;
                    const list = body.models_full[prov];
                    if (typeof prov !== 'string' || prov === '' || !Array.isArray(list)) continue;
                    const clean = list.filter((m) => typeof m === 'string' && m.trim() !== '')
                        .map((m) => store.mbSubstr(m.trim(), 0, 160)).slice(0, 800);
                    if (clean.length) { modelsFull[store.mbSubstr(prov, 0, 60)] = clean; count++; }
                }
            }
            const workspace = String(body.workspace || '').trim();
            const allowCreate = !!body.allowCreateFolders;
            const agents = (Array.isArray(body.agents) ? body.agents : [])
                .filter((a) => typeof a === 'string' && a.trim() !== '').map((a) => store.mbSubstr(a.trim(), 0, 40)).slice(0, 20);
            const vision = [...new Set((Array.isArray(body.vision) ? body.vision : [])
                .filter((m) => typeof m === 'string' && m.trim() !== '').map((m) => store.mbSubstr(m.trim(), 0, 160)))].slice(0, 800);
            const modelsCtx = {};
            if (body.models_ctx && typeof body.models_ctx === 'object') {
                let count = 0;
                for (const key of Object.keys(body.models_ctx)) {
                    if (count >= 2000) break;
                    if (typeof key !== 'string' || key.trim() === '') continue;
                    const v = parseInt(body.models_ctx[key], 10);
                    if (!(v > 0)) continue;
                    modelsCtx[store.mbSubstr(key.trim(), 0, 160)] = v;
                    count++;
                }
            }
            await store.syncCatalog(folders.slice(0, 200), models.slice(0, 400), workspace, allowCreate, agents, modelsFull, vision, modelsCtx, file);
            return ok({ ok: true, folders: folders.length, models: models.length, models_full: Object.keys(modelsFull).length, agents: agents.length });
        }
        case 'session_import': {
            if (!auth.checkBridgeToken(app, req)) return ok({ ok: false, error: 'Token invalido' }, 401);
            const bridge = reqBridge(req, query);
            const oc = String(body.opencode_session || '').trim();
            if (!/^ses_[A-Za-z0-9]{4,64}$/.test(oc)) return ok({ ok: false, error: 'opencode_session invalido' }, 400);
            const name = store.mbSubstr(String(body.name || '').trim(), 0, 60);
            const folder = store.mbSubstr(String(body.folder || '').trim(), 0, 500);
            const model = String(body.model || '').trim();
            const agent = String(body.agent || 'build').trim();
            const updated = String(body.updated || '').trim();
            let msgs = Array.isArray(body.messages) ? body.messages : [];
            if (msgs.length > 400) msgs = msgs.slice(-400);
            const tokens = Math.max(0, parseInt(body.tokens, 10) || 0);
            const cost = Math.max(0, parseFloat(body.cost) || 0);
            const rename = !!body.rename;
            const result = await store.sessionImport(oc, name, folder, model, agent, updated, msgs, tokens, cost, bridge, rename);
            if (!result.ok) return ok(result, 400);
            return ok(result);
        }
        case 'session_reconcile': {
            if (!auth.checkBridgeToken(app, req)) return ok({ ok: false, error: 'Token invalido' }, 401);
            const bridge = reqBridge(req, query);
            const known = Array.isArray(body.known)
                ? body.known.map((x) => String(x)).filter((x) => /^ses_[A-Za-z0-9]{4,64}$/.test(x)).slice(0, 20000)
                : [];
            const folders = Array.isArray(body.folders)
                ? body.folders.map((f) => store.mbSubstr(String(f), 0, 500)).slice(0, 2000)
                : [];
            const result = await store.sessionReconcile(known, folders, bridge);
            return ok(result);
        }
        case 'session_tokens': {
            if (!auth.checkBridgeToken(app, req)) return ok({ ok: false, error: 'Token invalido' }, 401);
            const bridge = reqBridge(req, query);
            const oc = String(body.opencode_session || '').trim();
            if (!/^ses_[A-Za-z0-9]{4,64}$/.test(oc)) return ok({ ok: false, error: 'opencode_session invalido' }, 400);
            let folder = String(body.folder || '').trim();
            if (folder !== '' && Array.from(folder).length > 500) folder = '';
            await store.sessionTokens(oc, Math.max(0, parseInt(body.tokens, 10) || 0), Math.max(0, parseFloat(body.cost) || 0), folder, bridge);
            return ok({ ok: true });
        }
        case 'request_folder': {
            if (!auth.requireLogin(app, req, res)) return;
            if (!auth.requireCsrf(app, req, res)) return;
            const bridge = bodyBridge(req, query, body) || await webBridge(req, query);
            const file = paths.bridgeCatalogFile(bridge);
            const cat = await store.catalogRead(file);
            if (!cat.allow_create_folders) return ok({ ok: false, error: 'La creacion de carpetas esta desactivada' }, 403);
            if (cat.workspace === '') return ok({ ok: false, error: 'El puente no definio un espacio de trabajo' }, 400);
            const name = String(body.name || '').trim();
            if (!store.validFolderName(name)) return ok({ ok: false, error: 'Nombre invalido (solo letras, numeros, espacios, - _ . () y 3-50 caracteres)' }, 400);
            const id = await store.catalogAddRequest(name, file);
            return ok({ ok: true, request: { id, name } });
        }
        case 'push_subscribe': {
            if (!auth.requireLogin(app, req, res)) return;
            if (!auth.requireCsrf(app, req, res)) return;
            const endpoint = String(body.endpoint || '').trim();
            const p256dh = String(body.p256dh || '').trim();
            const authKey = String(body.auth || '').trim();
            const ua = store.mbSubstr(String(body.ua || '').trim(), 0, 120);
            if (endpoint === '' || p256dh === '' || authKey === '') return ok({ ok: false, error: 'Faltan datos de la suscripcion' }, 400);
            if (!push.pushEnabled(app)) return ok({ ok: false, error: 'Los avisos push estan desactivados en el servidor' }, 400);
            let host = '';
            try { host = new URL(endpoint).hostname; } catch (e) { host = ''; }
            if (!/^https:\/\//.test(endpoint) || !pushHostAllowed(host)) return ok({ ok: false, error: 'Suscripcion no valida' }, 400);
            await push.pushStore(endpoint, p256dh, authKey, ua);
            return ok({ ok: true });
        }
        case 'push_unsubscribe': {
            if (!auth.requireLogin(app, req, res)) return;
            if (!auth.requireCsrf(app, req, res)) return;
            const endpoint = String(body.endpoint || '').trim();
            if (endpoint !== '') await push.pushRemove(endpoint);
            return ok({ ok: true });
        }
        case 'heartbeat': {
            if (!auth.checkBridgeToken(app, req)) return ok({ ok: false, error: 'Token invalido' }, 401);
            const bridge = reqBridge(req, query);
            const name = headerBridgeName(req);
            let busy = null, busySession = 0;
            if (Object.prototype.hasOwnProperty.call(body, 'busy')) {
                busy = !!body.busy;
                busySession = body.busy ? (parseInt(body.busy_session, 10) || 0) : 0;
            }
            await store.bridgeRegisterFirst(bridge, name);
            await store.bridgeRegistryUpsert(bridge, name, busy, busySession);
            return ok({ ok: true });
        }
        case 'poll': {
            if (!auth.checkBridgeToken(app, req)) return ok({ ok: false, error: 'Token invalido' }, 401);
            const bridge = reqBridge(req, query);
            const file = paths.bridgeCatalogFile(bridge);
            await store.bridgeRegistryUpsert(bridge, headerBridgeName(req));
            const cutoff = Date.now() - store.STALE_PROCESSING_SECONDS * 1000;
            const lite = !!(body.lite || query.get('lite'));
            let waitMax = 5;
            const rw = body.waitMax !== undefined ? body.waitMax : query.get('waitMax');
            if (rw !== undefined && rw !== null && rw !== '') waitMax = Math.max(1, Math.min(20, parseInt(rw, 10) || 5));
            if (!lite && (body.wait || query.get('wait'))) {
                const started = Date.now();
                while (!(await store.pollPeekWork(cutoff, bridge))) {
                    await sleep(500);
                    if (Date.now() - started >= waitMax * 1000) break;
                    if (res.writableEnded) return;
                }
            }
            const claimed = [];
            const knownOc = [];
            if (!lite) {
                const sdata = await store.sessionsRead();
                const adopted = [];
                for (const sess of sdata.sessions) {
                    if (!(await store.bridgeCanClaimSession(bridge, sess))) continue;
                    const mdata = await store.messagesRead(sess.id);
                    let changed = false;
                    for (const msg of mdata.messages) {
                        if (msg.role !== 'user') continue;
                        const pending = msg.status === 'pending';
                        const processing = msg.status === 'processing' && Date.parse(msg.ts || 0) < cutoff;
                        if (!(pending || processing)) continue;
                        if (msg.cancel_requested) {
                            msg.status = 'canceled';
                            msg.canceled_ts = store.nowIso();
                            delete msg.cancel_requested;
                            changed = true;
                            continue;
                        }
                        msg.status = 'processing';
                        msg.ts = store.nowIso();
                        changed = true;
                        if (bridge !== '' && store.sessionBridge(sess) === '') {
                            sess.bridge = bridge;
                            if (!adopted.includes(parseInt(sess.id, 10))) adopted.push(parseInt(sess.id, 10));
                        }
                        claimed.push({
                            session_id: parseInt(sess.id, 10),
                            id: parseInt(msg.id, 10),
                            text: msg.text,
                            img: msg.img !== undefined ? String(msg.img) : null,
                            opencode_session: sess.opencode_session || null,
                            session: {
                                id: parseInt(sess.id, 10),
                                name: sess.name,
                                folder: sess.folder || '',
                                model: sess.model || '',
                                agent: sess.agent || 'build',
                            },
                        });
                    }
                    if (changed) await jsonfile.writeAtomic(paths.messagesFile(sess.id), mdata);
                }
                if (adopted.length) {
                    await store.sessionsUpdate((sd) => {
                        for (const s of sd.sessions) {
                            if (adopted.includes(parseInt(s.id, 10)) && store.sessionBridge(s) === '') s.bridge = bridge;
                        }
                    });
                }
                const fresh = await store.sessionsRead();
                for (const s of fresh.sessions) {
                    if (!s.opencode_session || s.importada) continue;
                    const owner = store.sessionBridge(s);
                    if (owner === '' || owner === bridge) knownOc.push(String(s.opencode_session));
                }
            }
            const foldersToCreate = lite ? [] : await store.catalogClaimRequests(file);
            const commands = await store.claimCommands(file);
            return ok({ ok: true, messages: claimed, folders: foldersToCreate, commands, known_oc: knownOc });
        }
        case 'folder_done': {
            if (!auth.checkBridgeToken(app, req)) return ok({ ok: false, error: 'Token invalido' }, 401);
            const file = paths.bridgeCatalogFile(reqBridge(req, query));
            const id = parseInt(body.id, 10) || 0;
            if (id <= 0) return ok({ ok: false, error: 'id invalido' }, 400);
            const folder = body.folder && typeof body.folder === 'object'
                ? { name: store.mbSubstr(String(body.folder.name || ''), 0, 60), path: store.mbSubstr(String(body.folder.path || ''), 0, 500) }
                : null;
            await store.catalogFinishRequest(id, !!body.ok, folder, String(body.error || '').trim(), file);
            return ok({ ok: true });
        }
        case 'command_done':
        case 'fs_result':
        case 'proc_result': {
            if (!auth.checkBridgeToken(app, req)) return ok({ ok: false, error: 'Token invalido' }, 401);
            const file = paths.bridgeCatalogFile(reqBridge(req, query));
            const id = parseInt(body.id, 10) || 0;
            if (id <= 0) return ok({ ok: false, error: 'id invalido' }, 400);
            let text = String(body.text || '');
            const max = action === 'command_done' ? 8000 : (action === 'fs_result' ? 700000 : 100000);
            if (Array.from(text).length > max) text = store.mbSubstr(text, 0, max);
            await store.finishCommand(id, !!body.ok, text, String(body.error || ''), file);
            return ok({ ok: true });
        }
        case 'respond_partial': {
            if (!auth.checkBridgeToken(app, req)) return ok({ ok: false, error: 'Token invalido' }, 401);
            const sid = parseInt(body.session_id, 10) || 0;
            const userId = parseInt(body.user_id, 10) || 0;
            const text = String(body.text || '').trim();
            const reasoning = String(body.reasoning || '').trim();
            const ocMsg = String(body.oc_msg || '').trim();
            if (sid <= 0 || userId <= 0) return ok({ ok: false, error: 'session_id y user_id son obligatorios' }, 400);
            if (Array.from(text).length > 50000 || Array.from(reasoning).length > 50000) return ok({ ok: false, error: 'Respuesta demasiado larga' }, 400);
            if (text === '' && reasoning === '') return ok({ ok: false, error: 'Nada para publicar' }, 400);
            await store.messagesUpdate(sid, (data) => {
                let draftIdx = -1;
                for (let i = 0; i < data.messages.length; i++) {
                    const m = data.messages[i];
                    if (m.role === 'assistant' && m.draft_for && parseInt(m.draft_for, 10) === userId) { draftIdx = i; break; }
                }
                if (draftIdx >= 0) {
                    data.messages[draftIdx].text = text;
                    if (reasoning !== '') data.messages[draftIdx].reasoning = reasoning;
                    if (ocMsg !== '') data.messages[draftIdx].oc_msg = ocMsg;
                    data.messages[draftIdx].ts = store.nowIso();
                } else {
                    const aid = data.nextId;
                    data.nextId = aid + 1;
                    const draft = {
                        id: aid, role: 'assistant', text, ts: store.nowIso(), status: 'streaming',
                        draft_for: userId, agent: store.messageAgentOf(data, userId),
                    };
                    if (reasoning !== '') draft.reasoning = reasoning;
                    if (ocMsg !== '') draft.oc_msg = ocMsg;
                    data.messages.push(draft);
                }
            });
            return ok({ ok: true });
        }
        case 'respond': {
            if (!auth.checkBridgeToken(app, req)) return ok({ ok: false, error: 'Token invalido' }, 401);
            const sid = parseInt(body.session_id, 10) || 0;
            const userId = parseInt(body.user_id, 10) || 0;
            const text = String(body.text || '').trim();
            if (sid <= 0 || userId <= 0 || text === '') return ok({ ok: false, error: 'session_id, user_id y text son obligatorios' }, 400);
            if (Array.from(text).length > 50000) return ok({ ok: false, error: 'Respuesta demasiado larga' }, 400);
            const exists = await store.getSession(sid);
            if (!exists) return ok({ ok: false, error: 'Sesion no encontrada' }, 404);
            const oc = body.opencode_session ? String(body.opencode_session).trim() : '';
            const reasoning = String(body.reasoning || '').trim();
            const ocMsg = String(body.oc_msg || '').trim();
            const clearSession = !!body.clear_session;
            const canceled = !!body.canceled;
            await store.sessionsUpdate((sd) => {
                const i = sd.sessions.findIndex((s) => parseInt(s.id, 10) === sid);
                if (i < 0) return false;
                if (clearSession) sd.sessions[i].opencode_session = null;
                else if (oc !== '' && (sd.sessions[i].opencode_session || null) !== oc) {
                    const taken = sd.sessions.some((s2, j) => j !== i && s2.opencode_session && String(s2.opencode_session) === oc);
                    if (!taken) sd.sessions[i].opencode_session = oc;
                }
                sd.sessions[i].last_ts = store.nowIso();
            });
            const sdata = await store.sessionsRead();
            const sess = sdata.sessions.find((s) => parseInt(s.id, 10) === sid);
            let aid = null;
            const found = await store.messagesUpdate(sid, (data) => {
                let msgFound = false;
                let author = '';
                for (const msg of data.messages) {
                    if (parseInt(msg.id, 10) === userId) {
                        msg.status = 'done';
                        msg.answered_ts = store.nowIso();
                        delete msg.cancel_requested;
                        if (typeof msg.author === 'string') author = msg.author;
                        msgFound = true;
                        break;
                    }
                }
                if (!msgFound) return false;
                let draftIdx = -1;
                for (let i = 0; i < data.messages.length; i++) {
                    const m = data.messages[i];
                    if (m.role === 'assistant' && m.draft_for && parseInt(m.draft_for, 10) === userId) { draftIdx = i; break; }
                }
                if (draftIdx >= 0) {
                    const m = data.messages[draftIdx];
                    aid = parseInt(m.id, 10);
                    m.text = text;
                    m.status = 'done';
                    m.answered_ts = store.nowIso();
                    m.ts = store.nowIso();
                    if (reasoning !== '') m.reasoning = reasoning; else delete m.reasoning;
                    if (ocMsg !== '') m.oc_msg = ocMsg;
                    if (canceled) m.canceled = true; else delete m.canceled;
                    if (!m.agent) m.agent = store.messageAgentOf(data, userId, (sess && sess.agent) || '');
                    if (author && !m.author) m.author = author;
                    delete m.draft_for;
                } else {
                    aid = data.nextId;
                    data.nextId = aid + 1;
                    const nm = { id: aid, role: 'assistant', text, ts: store.nowIso(), status: 'done', agent: store.messageAgentOf(data, userId, (sess && sess.agent) || '') };
                    if (reasoning !== '') nm.reasoning = reasoning;
                    if (ocMsg !== '') nm.oc_msg = ocMsg;
                    if (canceled) nm.canceled = true;
                    if (author) nm.author = author;
                    data.messages.push(nm);
                }
            });
            if (found === false) return ok({ ok: false, error: 'Mensaje no encontrado' }, 404);
            push.pushSend(app, (canceled ? '\u23f9 ' : '') + 'IA respondio \u00b7 ' + ((sess && sess.name) || 'chat'), store.mbSubstr(text, 0, 200) + (Array.from(text).length > 200 ? '.' : ''), 'chat.php?session=' + sid).catch(() => {});
            return ok({ ok: true, id: aid });
        }
        case 'browse': {
            if (!auth.requireLogin(app, req, res)) return;
            const file = paths.bridgeCatalogFile(await webBridge(req, query));
            const ws = await store.catalogWorkspaceRoot(file);
            if (ws === '') return ok({ ok: false, error: 'El puente no ha definido un workspace' }, 400);
            const rel = String(query.get('path') || '');
            const result = await store.workspaceList(rel, file);
            if (result === null) return ok({ ok: false, error: 'Ruta invalida o fuera del workspace' }, 400);
            return ok({ ok: true, workspace: ws, path: result.path, entries: result.entries });
        }
        case 'read_file': {
            if (!auth.requireLogin(app, req, res)) return;
            const file = paths.bridgeCatalogFile(await webBridge(req, query));
            const rel = String(query.get('path') || '');
            const abs = await store.safeJoinWorkspace(rel, 4, file);
            if (!abs) return ok({ ok: false, error: 'Archivo no encontrado' }, 404);
            let st;
            try { st = await fsp.stat(abs); } catch (e) { return ok({ ok: false, error: 'Archivo no encontrado' }, 404); }
            if (!st.isFile()) return ok({ ok: false, error: 'Archivo no encontrado' }, 404);
            const size = st.size;
            const ext = path.extname(abs).toLowerCase().replace(/^\./, '');
            const mimes = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif' };
            if (mimes[ext]) {
                if (size <= 0 || size > 6 * 1024 * 1024) return ok({ ok: false, error: 'Imagen demasiado grande (>6 MB) para previsualizar' }, 400);
                const bin = await fsp.readFile(abs);
                return ok({ ok: true, path: rel, size, mtime: Math.floor(st.mtimeMs / 1000), kind: 'image', mime: mimes[ext], url: 'data:' + mimes[ext] + ';base64,' + bin.toString('base64') });
            }
            const content = await store.readTextFile(abs);
            if (content === null) return ok({ ok: false, error: 'Binario o demasiado grande (>512 KB)' }, 400);
            return ok({ ok: true, path: rel, size, mtime: Math.floor(st.mtimeMs / 1000), kind: 'text', content });
        }
        case 'run_oc': {
            const s = auth.requireCsrf(app, req, res);
            if (!s) return;
            const bridge = bodyBridge(req, query, body) || await webBridge(req, query);
            const file = paths.bridgeCatalogFile(bridge);
            const cmd = String(body.cmd || '').toLowerCase().replace(/[^a-z_]/g, '');
            const args = Array.isArray(body.args) ? body.args : [];
            if (!Object.prototype.hasOwnProperty.call(OC_ALLOWED, cmd)) return ok({ ok: false, error: 'Comando no permitido' }, 400);
            if (OC_MUTATING.has(cmd) && s.role !== 'admin') return ok({ ok: false, error: 'Permiso insuficiente' }, 403);
            const spec = OC_ALLOWED[cmd];
            const cleanArgs = [];
            for (let i = 0; i < args.length; i++) {
                const tipo = spec[i] || 'arg';
                if (ocArgValido(tipo, args[i])) cleanArgs.push(String(args[i]));
            }
            if (spec.length && cleanArgs.length !== Math.min(args.length, spec.length)) return ok({ ok: false, error: 'Argumento invalido' }, 400);
            const id = await store.enqueueCommand(cmd, cleanArgs, file);
            return ok({ ok: true, id });
        }
        case 'oc_command_status': {
            if (!auth.requireLogin(app, req, res)) return;
            const id = parseInt(query.get('id') || '0', 10) || 0;
            const file = paths.bridgeCatalogFile(await webBridge(req, query));
            const cat = await store.catalogRead(file);
            for (const c of (cat.commands || [])) {
                if (parseInt(c.id, 10) === id) {
                    return ok({ ok: true, status: c.status, result: c.result !== undefined ? c.result : null, error: c.error || '' });
                }
            }
            return ok({ ok: false, error: 'no existe' }, 404);
        }
        case 'oc_sessions': {
            if (!auth.requireLogin(app, req, res)) return;
            return ok({ ok: true, sessions: await store.ocSessionsList() });
        }
        case 'oc_session_attach': {
            if (!auth.requireLogin(app, req, res)) return;
            if (!auth.requireCsrf(app, req, res)) return;
            const oc = String(body.opencode_session || '').trim();
            const name = String(body.name || '').trim();
            const folder = String(body.folder || '');
            const model = String(body.model || '');
            const agent = String(body.agent || 'build');
            const bridge = bodyBridge(req, query, body) || await webBridge(req, query);
            const file = paths.bridgeCatalogFile(bridge);
            if (oc === '') return ok({ ok: false, error: 'opencode_session requerido' }, 400);
            if (folder !== '' && (await store.folderPathInCatalog(folder, file)) === null) return ok({ ok: false, error: 'Carpeta no disponible' }, 400);
            if (model !== '' && !(await store.modelInCatalog(model, file))) return ok({ ok: false, error: 'Modelo no disponible' }, 400);
            if (agent !== '' && !(await store.agentInCatalog(agent, file))) return ok({ ok: false, error: 'Agente no disponible' }, 400);
            const id = await store.addSession(name !== '' ? name : 'Opencode ' + oc.slice(0, 8), folder, model, agent, oc, bridge);
            return ok({ ok: true, session: await store.getSession(id) });
        }
        case 'search_index': {
            if (!auth.requireLogin(app, req, res)) return;
            const q = String(query.get('q') || '');
            return ok({ ok: true, results: await store.searchIndexBuild(q) });
        }
        case 'stream': {
            if (!auth.requireLogin(app, req, res)) return;
            return handleStream({ app, req, res });
        }
        default:
            return ok({ ok: false, error: 'Accion no valida' }, 400);
    }
}

function pushHostAllowed(host) {
    const fixed = ['fcm.googleapis.com', 'android.googleapis.com', 'push.services.mozilla.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'];
    if (fixed.includes(host)) return true;
    const h = String(host).toLowerCase();
    return ['.notify.windows.com', '.googleapis.com', '.mozilla.com'].some((s) => h.endsWith(s));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function handleStream({ app, req, res }) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    const send = (event, data) => {
        if (res.writableEnded) return;
        res.write('event: ' + event + '\n');
        res.write('data: ' + JSON.stringify(data) + '\n\n');
    };
    send('hello', { now: store.nowIso() });
    const started = Date.now();
    let lastRegRaw = '', lastBusySig = '', lastSessionsSig = '', lastMsgScanSec = 0, lastMsgMaxTs = 0, lastNotify = 0, loop = 0;
    const lastCatSigs = {};
    let timer = null;
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    req.on('close', stop);
    timer = setInterval(async () => {
        if (res.writableEnded) { stop(); return; }
        if (Date.now() - started >= 25000) { send('bye', { ts: store.nowIso() }); stop(); res.end(); return; }
        try {
            let regRaw = '';
            try { regRaw = await fsp.readFile(paths.bridgesFile(), 'utf8'); } catch (e) { /* aun no */ }
            if (regRaw !== lastRegRaw) {
                lastRegRaw = regRaw;
                let reg = null;
                try { reg = JSON.parse(regRaw); } catch (e) { /* nada */ }
                if (reg && reg.bridges && Object.keys(reg.bridges).length) {
                    const sum = await store.bridgesSummary();
                    const busySig = store.md5(sum.map((b) => b.id + '=' + (b.busy_session || '')).join('|'));
                    send('online', { ts: store.nowIso(), bridges: sum });
                    if (busySig !== lastBusySig) { lastBusySig = busySig; send('sessions_changed', { ts: store.nowIso(), busy: true }); }
                }
            }
            let files = [];
            try { files = await fsp.readdir(paths.dataDir()); } catch (e) { /* nada */ }
            for (const f of files) {
                if (!/^catalog.*\.json$/.test(f)) continue;
                const full = path.join(paths.dataDir(), f);
                let raw = '';
                try { raw = await fsp.readFile(full, 'utf8'); } catch (e) { continue; }
                const sig = store.md5(raw);
                const id = f === 'catalog.json' ? '' : f.replace(/^catalog-/, '').replace(/\.json$/, '');
                if (!(full in lastCatSigs)) { lastCatSigs[full] = sig; continue; }
                if (lastCatSigs[full] !== sig) { lastCatSigs[full] = sig; send('catalog', { bridge: id }); }
            }
            let sraw = '';
            try { sraw = await fsp.readFile(paths.sessionsFile(), 'utf8'); } catch (e) { /* nada */ }
            const ssig = store.md5(sraw);
            if (ssig !== lastSessionsSig) { lastSessionsSig = ssig; send('sessions_changed', { ts: store.nowIso() }); }
            const nowSec = Math.floor(Date.now() / 1000);
            if (nowSec !== lastMsgScanSec) {
                lastMsgScanSec = nowSec;
                let maxTs = 0;
                for (const f of files) {
                    if (!/^messages-.*\.json$/.test(f)) continue;
                    try {
                        const st = await fsp.stat(path.join(paths.dataDir(), f));
                        if (st.mtimeMs > maxTs) maxTs = st.mtimeMs;
                    } catch (e) { /* nada */ }
                }
                if (maxTs !== lastMsgMaxTs) {
                    lastMsgMaxTs = maxTs;
                    if (nowSec - lastNotify >= 2) { lastNotify = nowSec; send('sessions_changed', { ts: store.nowIso(), msgs: true }); }
                }
            }
        } catch (e) { /* el stream sigue */ }
        if ((++loop % 10) === 0) send('ping', { ts: store.nowIso() });
    }, 500);
}

module.exports = {
    handleApi, handleChat, handleLogin, handleLoginPage, handleLogout, handleIndex,
};
