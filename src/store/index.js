'use strict';

/**
 * Capa de datos (port de app/lib.php): sesiones, mensajes, catalogo por puente,
 * registro de puentes, workspace y busqueda. Mantiene EXACTAMENTE el mismo
 * esquema JSON que la version PHP, para poder migrar datos entre ambas.
 */

const fs = require('node:fs/promises');
const fssync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const paths = require('../paths');
const jsonfile = require('./jsonfile');

const STALE_PROCESSING_SECONDS = 600;

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
function nowIso() { return new Date().toISOString(); }
function md5(s) { return crypto.createHash('md5').update(String(s)).digest('hex'); }
function mbSubstr(s, start, len) {
    const arr = Array.from(String(s == null ? '' : s));
    return len === undefined ? arr.slice(start).join('') : arr.slice(start, start + len).join('');
}
function clone(v) { return structuredClone(v); }
function normFolder(f) {
    return String(f || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

// ---------------------------------------------------------------------------
// Sesiones
// ---------------------------------------------------------------------------
const SESSIONS_DEFAULT = () => ({ sessions: [], nextId: 1 });

function sessionsUpdate(fn) {
    return jsonfile.update(paths.sessionsFile(), SESSIONS_DEFAULT(), fn);
}
async function sessionsRead() {
    return jsonfile.readJson(paths.sessionsFile(), SESSIONS_DEFAULT());
}
function findSessionRef(data, id) {
    for (const sess of (data.sessions || [])) {
        if (parseInt(sess.id, 10) === parseInt(id, 10)) return sess;
    }
    return null;
}
async function getSession(id) {
    const data = await sessionsRead();
    return findSessionRef(data, id);
}

function bridgeValidId(id) {
    return typeof id === 'string' && id !== '' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(id);
}
function sessionBridge(sess) {
    const b = sess && typeof sess.bridge === 'string' ? sess.bridge : '';
    return bridgeValidId(b) ? b : '';
}

async function addSession(name, folder, model, agent = 'build', opencodeSession = null, bridge = '') {
    let id = null;
    await sessionsUpdate((data) => {
        id = data.nextId;
        data.nextId = id + 1;
        const sess = {
            id,
            name: name !== '' ? name : 'Chat ' + id,
            folder: String(folder || ''),
            model: String(model || ''),
            agent: String(agent || 'build'),
            created_ts: nowIso(),
            last_ts: nowIso(),
            opencode_session: opencodeSession,
        };
        if (bridgeValidId(bridge)) sess.bridge = bridge;
        data.sessions.push(sess);
    });
    await touchFile(paths.messagesFile(id));
    return id;
}

async function updateSession(id, folder, model, opencodeSession = null) {
    let ok = false;
    await sessionsUpdate((data) => {
        const idx = data.sessions.findIndex((s) => parseInt(s.id, 10) === parseInt(id, 10));
        if (idx < 0) return false;
        if (typeof folder === 'string') data.sessions[idx].folder = folder;
        if (typeof model === 'string') data.sessions[idx].model = model;
        if (typeof opencodeSession === 'string') data.sessions[idx].opencode_session = opencodeSession;
        data.sessions[idx].last_ts = nowIso();
        ok = true;
    });
    return ok;
}

async function touchSession(id) {
    await sessionsUpdate((data) => {
        const idx = data.sessions.findIndex((s) => parseInt(s.id, 10) === parseInt(id, 10));
        if (idx < 0) return false;
        data.sessions[idx].last_ts = nowIso();
    });
}

async function sessionRename(id, name) {
    const clean = String(name || '').trim();
    if (clean === '') return false;
    let ok = false;
    await sessionsUpdate((data) => {
        const idx = data.sessions.findIndex((s) => parseInt(s.id, 10) === parseInt(id, 10));
        if (idx < 0) return false;
        data.sessions[idx].name = mbSubstr(clean, 0, 60);
        data.sessions[idx].last_ts = nowIso();
        ok = true;
    });
    return ok;
}

function sessionHasDefaultName(sess) {
    const name = sess && typeof sess.name === 'string' ? sess.name : '';
    return name === '' || /^Chat \d+$/.test(name);
}

// Titulo placeholder que opencode genera solo: no sirve para pisar un nombre
// util del hub en un sync forzado.
function sessionNamePlaceholder(name) {
    const n = String(name || '').trim();
    return n === '' || /^Chat \d+$/.test(n) || /^New session - /.test(n);
}

function sessionTitleFromPrompt(text) {
    let t = String(text || '').replace(/\s+/gu, ' ').trim();
    if (t === '') return '';
    const max = 48;
    if (Array.from(t).length > max) {
        let cut = mbSubstr(t, 0, max);
        const sp = cut.lastIndexOf(' ');
        if (sp > 20) cut = cut.slice(0, sp);
        t = cut.replace(/[ \t.,:;-]+$/, '') + '\u2026';
    }
    return t;
}

async function deleteSession(id) {
    await sessionsUpdate((data) => {
        data.sessions = data.sessions.filter((s) => parseInt(s.id, 10) !== parseInt(id, 10));
    });
    try { await fs.unlink(paths.messagesFile(id)); } catch (e) { /* no estaba */ }
}

// Texto canonico para deduplicar mensajes importados de opencode. opencode
// guarda el mensaje del usuario entre comillas dobles y, si hubo un adjunto, le
// antepone el detalle del archivo ("Called the Read tool ..."). El hub guarda
// solo el texto que tipeo el usuario, asi que normalizamos para que la
// "adopcion" por texto lo reconozca y no lo duplique.
function sessionDedupeText(role, text) {
    let s = String(text == null ? '' : text).trim();
    if (role === 'user') {
        if (s.indexOf('Called the Read tool with the following input:') === 0) {
            const marker = 'read successfully';
            const mi = s.toLowerCase().lastIndexOf(marker);
            if (mi >= 0) s = s.slice(mi + marker.length).trim();
        }
        if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') s = s.slice(1, -1).trim();
    }
    return s;
}

// Importa (merge idempotente) una sesion de opencode. Mismo esquema que PHP.
async function sessionImport(ocSession, name, folder, model, agent, updatedTs, messages, tokens = 0, cost = 0, bridge = '', rename = false) {
    const oc = String(ocSession || '').trim();
    if (oc === '') return { ok: false, error: 'opencode_session requerido' };
    const file = paths.bridgeCatalogFile(bridge);
    folder = String(folder || '');
    if (folder !== '' && (await folderPathInCatalog(folder, file)) === null) {
        const base = path.basename(folder.replace(/\\/g, '/').replace(/\/+$/, ''));
        await catalogModify(file, (cat) => {
            if (!Array.isArray(cat.folders)) cat.folders = [];
            if (cat.folders.some((f) => f && f.path === folder)) return;
            cat.folders.push({ name: mbSubstr(base, 0, 60), path: mbSubstr(folder, 0, 500) });
        });
    }
    const cat = await catalogRead(file);
    const modelOk = model !== '' && modelInCatalogObj(cat, model);
    const agentOk = agent !== '' && agentInCatalogObj(cat, agent);

    let sid = null, created = false;
    await sessionsUpdate((sdata) => {
        let idx = sdata.sessions.findIndex((s) => s.opencode_session && String(s.opencode_session) === oc);
        if (idx < 0) {
            const id = sdata.nextId;
            sdata.nextId = id + 1;
            const ts = (updatedTs && !isNaN(Date.parse(updatedTs))) ? updatedTs : nowIso();
            const sess = {
                id,
                name: name !== '' ? name : 'Opencode ' + oc.slice(0, 8),
                folder,
                model: modelOk ? model : '',
                agent: agentOk ? agent : 'build',
                created_ts: ts,
                last_ts: ts,
                opencode_session: oc,
                importada: true,
            };
            if (bridgeValidId(bridge)) sess.bridge = bridge;
            sdata.sessions.push(sess);
            idx = sdata.sessions.length - 1;
            created = true;
        } else {
            const s = sdata.sessions[idx];
            if (rename) {
                if (name !== '' && !sessionNamePlaceholder(name)) s.name = mbSubstr(name, 0, 60);
            } else if (sessionHasDefaultName(s) && name !== '') {
                s.name = mbSubstr(name, 0, 60);
            }
            if (folder !== '' && String(s.folder || '') !== folder) s.folder = folder;
            s.importada = true;
            if (bridgeValidId(bridge) && sessionBridge(s) === '') s.bridge = bridge;
        }
        const s = sdata.sessions[idx];
        if (tokens > 0) s.tokens = tokens;
        if (cost > 0) s.cost = Math.round(cost * 10000) / 10000;
        sid = parseInt(s.id, 10);
    });

    let added = 0;
    await jsonfile.update(paths.messagesFile(sid), { messages: [], nextId: 1 }, (data) => {
        const known = {};
        const knownOc = {};
        const byText = {};
        data.messages.forEach((m, i) => {
            const role = String(m.role || '');
            const dtext = sessionDedupeText(role, m.text || '');
            known[role + '|' + String(m.ts || '') + '|' + md5(mbSubstr(dtext, 0, 400))] = true;
            const ocId = String(m.oc_msg || '').trim();
            if (ocId !== '') knownOc[ocId] = true;
            else byText[role + '|' + md5(mbSubstr(dtext, 0, 400))] = i;
        });
        for (const m of (Array.isArray(messages) ? messages : [])) {
            if (!m || typeof m !== 'object') continue;
            const role = String(m.role || '');
            if (role !== 'user' && role !== 'assistant') continue;
            let text = String(m.text || '').trim();
            if (text === '') continue;
            if (Array.from(text).length > 50000) text = mbSubstr(text, 0, 50000);
            let ts = String(m.ts || '');
            if (ts === '' || isNaN(Date.parse(ts))) ts = nowIso();
            const ocMsg = String(m.oc_msg || '').trim();
            const dtext = sessionDedupeText(role, text);
            // Identidad de opencode: si ya esta, es el mismo mensaje.
            if (ocMsg !== '' && knownOc[ocMsg]) continue;
            const key = role + '|' + ts + '|' + md5(mbSubstr(dtext, 0, 400));
            if (known[key]) continue;
            // Adopcion: llego de opencode (con oc_msg) y existe uno de la web
            // con el mismo rol+texto y sin id. Se le asigna el id.
            if (ocMsg !== '') {
                const tk = role + '|' + md5(mbSubstr(dtext, 0, 400));
                if (byText[tk] !== undefined) {
                    data.messages[byText[tk]].oc_msg = ocMsg;
                    knownOc[ocMsg] = true;
                    known[key] = true;
                    delete byText[tk];
                    continue;
                }
            }
            // Respuesta del agente partida en varios mensajes de opencode (uno
            // por paso/tool): el hub guarda la respuesta combinada. Si esta
            // parte ya esta contenida en un mensaje del agente, no duplicar.
            if (role === 'assistant' && dtext.length >= 40) {
                const contained = data.messages.some((e) => {
                    if (e.role !== 'assistant') return false;
                    const et = sessionDedupeText('assistant', e.text);
                    return et.length > dtext.length && et.indexOf(dtext) >= 0;
                });
                if (contained) {
                    known[key] = true;
                    if (ocMsg !== '') knownOc[ocMsg] = true;
                    continue;
                }
            }
            known[key] = true;
            if (ocMsg !== '') knownOc[ocMsg] = true;
            const id = data.nextId;
            data.nextId = id + 1;
            const msg = { id, role, text, ts, status: 'done' };
            if (ocMsg !== '') msg.oc_msg = ocMsg;
            const reasoning = String(m.reasoning || '').trim();
            if (reasoning !== '') msg.reasoning = Array.from(reasoning).length > 50000 ? mbSubstr(reasoning, 0, 50000) : reasoning;
            if (m.agent) msg.agent = mbSubstr(String(m.agent), 0, 40);
            data.messages.push(msg);
            added++;
        }
    });
    const mdata = await messagesRead(sid);
    const last = mdata.messages[mdata.messages.length - 1];
    if (last && last.ts) {
        await sessionsUpdate((sdata) => {
            const idx = sdata.sessions.findIndex((s) => s.opencode_session && String(s.opencode_session) === oc);
            if (idx < 0) return false;
            if (Date.parse(last.ts) > Date.parse(sdata.sessions[idx].last_ts || 0)) {
                sdata.sessions[idx].last_ts = last.ts;
            }
        });
    }
    return { ok: true, session_id: sid, created, added };
}

// Refresca tokens/costo (y carpeta real) de una sesion ya vinculada.
async function sessionTokens(ocSession, tokens, cost, folder = '', bridge = '') {
    const oc = String(ocSession || '').trim();
    if (oc === '') return;
    const file = paths.bridgeCatalogFile(bridge);
    folder = String(folder || '');
    if (folder !== '' && (await folderPathInCatalog(folder, file)) === null) {
        const base = path.basename(folder.replace(/\\/g, '/').replace(/\/+$/, ''));
        await catalogModify(file, (cat) => {
            if (!Array.isArray(cat.folders)) cat.folders = [];
            if (cat.folders.some((f) => f && f.path === folder)) return;
            cat.folders.push({ name: mbSubstr(base, 0, 60), path: mbSubstr(folder, 0, 500) });
        });
    }
    await sessionsUpdate((sdata) => {
        const s = sdata.sessions.find((x) => x.opencode_session && String(x.opencode_session) === oc);
        if (!s) return false;
        if (tokens > 0) s.tokens = tokens;
        if (cost > 0) s.cost = Math.round(cost * 10000) / 10000;
        if (folder !== '' && String(s.folder || '') !== folder) s.folder = folder;
        if (bridgeValidId(bridge) && sessionBridge(s) === '') s.bridge = bridge;
    });
}

// Reconciliacion de bajas: el puente informa que sesiones de opencode ve
// (`known`) y en que carpetas escaneo (`folders`). Se borran en el hub solo las
// sesiones importadas de ESE puente, cuya carpeta fue escaneada y cuyo
// opencode_session ya no existe en la PC. Las que quedan fuera del workspace
// (carpeta no escaneada) se conservan.
async function sessionReconcile(known, folders, bridge) {
    if (!bridgeValidId(bridge)) return { ok: true, deleted: 0 };
    const knownSet = new Set((Array.isArray(known) ? known : []).map((x) => String(x)));
    const folderSet = new Set((Array.isArray(folders) ? folders : []).map((f) => normFolder(f)));
    if (!folderSet.size) return { ok: true, deleted: 0 };
    const toDelete = [];
    await sessionsUpdate((sdata) => {
        const keep = [];
        for (const s of (sdata.sessions || [])) {
            const oc = s.opencode_session ? String(s.opencode_session) : '';
            const orphan = sessionBridge(s) === bridge && s.importada === true && oc !== ''
                && !knownSet.has(oc) && folderSet.has(normFolder(s.folder));
            if (orphan) { toDelete.push(parseInt(s.id, 10)); continue; }
            keep.push(s);
        }
        sdata.sessions = keep;
    });
    for (const id of toDelete) {
        try { await fs.unlink(paths.messagesFile(id)); } catch (e) { /* no estaba */ }
    }
    return { ok: true, deleted: toDelete.length };
}

// ---------------------------------------------------------------------------
// Mensajes
// ---------------------------------------------------------------------------
function messagesUpdate(sid, fn) {
    return jsonfile.update(paths.messagesFile(sid), { messages: [], nextId: 1 }, fn);
}
function messagesRead(sid) {
    return jsonfile.readJson(paths.messagesFile(sid), { messages: [], nextId: 1 });
}
function messagesHealStaleStreaming(data, cutoff) {
    let changed = false;
    if (!data || !Array.isArray(data.messages)) return false;
    for (const msg of data.messages) {
        if ((msg.role || '') !== 'assistant') continue;
        if ((msg.status || '') !== 'streaming') continue;
        if (Date.parse(msg.ts || 0) >= cutoff) continue;
        msg.status = 'done';
        msg.canceled = true;
        changed = true;
    }
    return changed;
}
async function addMessage(sid, role, text, status = 'pending', extra = {}) {
    let id = null;
    await messagesUpdate(sid, (data) => {
        id = data.nextId;
        data.nextId = id + 1;
        const msg = { id, role, text, ts: nowIso(), status };
        for (const k of Object.keys(extra || {})) {
            if (['id', 'role', 'text', 'ts', 'status', 'draft_for'].includes(k)) continue;
            msg[k] = extra[k];
        }
        data.messages.push(msg);
    });
    await touchSession(sid);
    return id;
}
function messageAgentOf(data, userId, fallback = '') {
    for (const msg of (data.messages || [])) {
        if (parseInt(msg.id, 10) === parseInt(userId, 10)) {
            const a = typeof msg.agent === 'string' ? msg.agent : '';
            return a !== '' ? a : fallback;
        }
    }
    return fallback;
}

// ---------------------------------------------------------------------------
// Catalogo (por puente)
// ---------------------------------------------------------------------------
function catalogDefault() {
    return {
        folders: [],
        models: [],
        favorites: [],
        default_model: '',
        models_full: {},
        models_ctx: {},
        vision: [],
        workspace: '',
        allow_create_folders: false,
        agents: ['build', 'plan'],
        synced_ts: null,
        last_online_ts: null,
        busy_session: null,
        busy_since: null,
        requests: [],
        nextRequestId: 1,
    };
}
async function catalogRead(file) {
    const data = await jsonfile.readJson(file || paths.catalogFile(), {});
    const def = catalogDefault();
    for (const k of Object.keys(def)) if (data[k] === undefined) data[k] = def[k];
    return data;
}
function catalogModify(file, fn) {
    return jsonfile.update(file || paths.catalogFile(), catalogDefault(), async (data) => {
        const def = catalogDefault();
        for (const k of Object.keys(def)) if (data[k] === undefined) data[k] = def[k];
        return fn(data);
    });
}
function catalogVersion(cat) {
    const sig = { ...cat };
    for (const k of ['last_online_ts', 'busy_session', 'busy_since', 'requests', 'commands', 'nextRequestId', 'nextCommandId']) {
        delete sig[k];
    }
    return md5(JSON.stringify(sig));
}
async function syncCatalog(folders, models, workspace, allowCreateFolder, agents, modelsFull, vision, modelsCtx, file) {
    const fresh = catalogDefault();
    fresh.folders = Array.isArray(folders) ? folders : [];
    fresh.models = Array.isArray(models) ? models : [];
    fresh.models_full = (modelsFull && typeof modelsFull === 'object') ? modelsFull : {};
    fresh.models_ctx = (modelsCtx && typeof modelsCtx === 'object') ? modelsCtx : {};
    fresh.vision = Array.isArray(vision) ? vision : [];
    fresh.workspace = String(workspace || '');
    fresh.allow_create_folders = !!allowCreateFolder;
    fresh.agents = (Array.isArray(agents) ? agents : []).filter((a) => typeof a === 'string');
    fresh.synced_ts = nowIso();
    await catalogModify(file, (cat) => {
        const keep = {};
        for (const k of ['commands', 'requests', 'nextCommandId', 'nextRequestId', 'favorites', 'default_model']) {
            if (cat[k] !== undefined) keep[k] = cat[k];
        }
        for (const k of Object.keys(cat)) delete cat[k];
        Object.assign(cat, fresh, keep);
    });
    return true;
}
function validFolderName(name) {
    return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9 _\-.()]{1,49}$/.test(name);
}
// Favoritos + modelo predeterminado (los gestiona la web desde el hub).
async function catalogSetModels(favorites, defaultModel, file) {
    const favs = (Array.isArray(favorites) ? favorites : [])
        .filter((m) => typeof m === 'string' && m.trim() !== '')
        .map((m) => mbSubstr(m.trim(), 0, 160))
        .slice(0, 400);
    await catalogModify(file, (cat) => {
        cat.favorites = favs;
        const def = String(defaultModel || '').trim();
        cat.default_model = (def !== '' && favs.includes(def)) ? def : (favs[0] || '');
    });
    return true;
}
async function catalogAddRequest(name, file) {
    let id = 0;
    await catalogModify(file, (cat) => {
        id = cat.nextRequestId;
        cat.nextRequestId = id + 1;
        if (!Array.isArray(cat.requests)) cat.requests = [];
        cat.requests.push({ id, name: mbSubstr(String(name).trim(), 0, 50), status: 'pending', error: '', ts: nowIso() });
    });
    return id;
}
async function catalogClaimRequests(file) {
    const out = [];
    await catalogModify(file, (cat) => {
        if (!cat.allow_create_folders || !Array.isArray(cat.requests)) return;
        for (const r of cat.requests) {
            if (r.status === 'pending') {
                r.status = 'processing';
                out.push({ id: parseInt(r.id, 10), name: r.name });
            }
        }
    });
    return out;
}
async function catalogFinishRequest(id, ok, folder, error, file) {
    await catalogModify(file, (cat) => {
        if (!Array.isArray(cat.requests)) return;
        for (const r of cat.requests) {
            if (parseInt(r.id, 10) !== parseInt(id, 10)) continue;
            r.status = ok ? 'done' : 'error';
            r.error = String(error || '');
            r.ts = nowIso();
            if (ok && folder && folder.name && folder.path) {
                if (!Array.isArray(cat.folders)) cat.folders = [];
                if (!cat.folders.some((f) => f && f.path === folder.path)) {
                    cat.folders.push({ name: folder.name, path: folder.path });
                }
            }
        }
    });
}
async function folderPathInCatalog(folder, file) {
    const cat = await catalogRead(file);
    for (const f of (cat.folders || [])) {
        if (f && typeof f === 'object' && f.path === folder) return f.path;
        if (typeof f === 'string' && f === folder) return f;
    }
    return null;
}
function modelInCatalogObj(cat, model) {
    if ((cat.models || []).includes(model)) return true;
    for (const prov of Object.keys(cat.models_full || {})) {
        const list = cat.models_full[prov];
        if (Array.isArray(list) && list.includes(model)) return true;
    }
    return false;
}
async function modelInCatalog(model, file) {
    return modelInCatalogObj(await catalogRead(file), model);
}
// Ventana de contexto del modelo (0 si no se conoce).
function modelContextObj(cat, model) {
    const v = (cat.models_ctx || {})[model];
    return (typeof v === 'number' && v > 0) ? v : 0;
}
async function modelContext(model, file) {
    return modelContextObj(await catalogRead(file), model);
}
function agentInCatalogObj(cat, agent) {
    return (cat.agents || []).includes(agent);
}
async function agentInCatalog(agent, file) {
    return agentInCatalogObj(await catalogRead(file), agent);
}

// ---------------------------------------------------------------------------
// Registro de puentes
// ---------------------------------------------------------------------------
const BRIDGES_DEFAULT = () => ({ version: 1, bridges: {} });
function bridgesUpdate(fn) {
    return jsonfile.update(paths.bridgesFile(), BRIDGES_DEFAULT(), (reg) => {
        if (!reg.bridges || typeof reg.bridges !== 'object') reg.bridges = {};
        return fn(reg);
    });
}
async function bridgesMap() {
    const data = await jsonfile.readJson(paths.bridgesFile(), BRIDGES_DEFAULT());
    return (data && data.bridges && typeof data.bridges === 'object') ? data.bridges : {};
}
async function bridgeRegistryUpsert(id, name, busy = null, busySession = 0) {
    if (typeof id !== 'string' || (id !== '' && !bridgeValidId(id))) return false;
    if (id === '') {
        const map = await bridgesMap();
        const hasReal = Object.keys(map).some((k) => k !== '');
        if (hasReal) return false;
        if (name === '') name = 'Puente';
    }
    await bridgesUpdate((reg) => {
        if (!reg.bridges[id] || typeof reg.bridges[id] !== 'object') reg.bridges[id] = { id };
        const e = reg.bridges[id];
        if (name !== '') e.name = name;
        e.last_online_ts = nowIso();
        if (busy !== null) {
            const bs = parseInt(busySession, 10) || 0;
            if (busy && bs > 0) { e.busy_session = bs; e.busy_since = nowIso(); }
            else { e.busy_session = null; e.busy_since = null; }
        }
    });
    return true;
}
async function bridgeRegistryGet(id) {
    const map = await bridgesMap();
    const e = map[id];
    return (e && typeof e === 'object') ? e : null;
}
async function bridgeOnlineLive(id) {
    const e = await bridgeRegistryGet(id);
    if (!e) return false;
    const ts = e.last_online_ts || '';
    if (ts === '') return false;
    return (Date.now() - Date.parse(ts)) <= 120000;
}
async function bridgeBusySession(id) {
    const e = await bridgeRegistryGet(id);
    if (!e) return null;
    const sid = parseInt(e.busy_session, 10) || 0;
    const ts = e.busy_since || '';
    if (sid <= 0 || ts === '') return null;
    if ((Date.now() - Date.parse(ts)) > 120000) return null;
    return sid;
}
async function bridgesSummary() {
    const map = await bridgesMap();
    const out = [];
    for (const id of Object.keys(map)) {
        const e = map[id] || {};
        out.push({
            id,
            name: (e.name && e.name !== '') ? e.name : (id === '' ? 'Puente' : id),
            online: await bridgeOnlineLive(id),
            busy_session: await bridgeBusySession(id),
        });
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
}
async function soleBridgeId() {
    const map = await bridgesMap();
    const keys = Object.keys(map);
    return keys.length === 1 ? keys[0] : '';
}
async function bridgeLiveOverlay(cat, id) {
    const e = await bridgeRegistryGet(id);
    if (!e) return cat;
    const out = { ...cat };
    out.last_online_ts = e.last_online_ts || '';
    out.busy_session = e.busy_session ? parseInt(e.busy_session, 10) : null;
    out.busy_since = e.busy_since || null;
    return out;
}
async function adoptSessionsToBridge(id) {
    if (!bridgeValidId(id)) return;
    await sessionsUpdate((data) => {
        let changed = false;
        for (const s of data.sessions) {
            if (sessionBridge(s) === '') { s.bridge = id; changed = true; }
        }
        if (!changed) return false;
    });
}
async function bridgeRegisterFirst(id, name) {
    if (!bridgeValidId(id)) return false;
    const map = await bridgesMap();
    if (map[id]) return false;
    const keys = Object.keys(map);
    const onlyLegacy = keys.length === 1 && Object.prototype.hasOwnProperty.call(map, '');
    if (keys.length > 0 && !onlyLegacy) return false;
    const file = paths.bridgeCatalogFile(id);
    if (!fssync.existsSync(file) && fssync.existsSync(paths.catalogFile())) {
        try { fssync.copyFileSync(paths.catalogFile(), file); } catch (e) { /* nada */ }
    }
    await adoptSessionsToBridge(id);
    await bridgesUpdate((reg) => {
        if (Object.prototype.hasOwnProperty.call(reg.bridges, '')) delete reg.bridges[''];
        if (!reg.bridges[id] || typeof reg.bridges[id] !== 'object') reg.bridges[id] = { id };
        reg.bridges[id].name = name;
        reg.bridges[id].last_online_ts = nowIso();
    });
    return true;
}
async function bridgeCanClaimSession(id, sess) {
    const owner = sessionBridge(sess);
    if (owner !== '') return owner === id;
    if (!bridgeValidId(id)) return true;
    const folder = sess.folder || '';
    if (folder === '') return true;
    const cat = await catalogRead(paths.bridgeCatalogFile(id));
    for (const f of (cat.folders || [])) {
        if (f && typeof f === 'object' && f.path === folder) return true;
        if (typeof f === 'string' && f === folder) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Listado de sesiones con estado (working/waiting)
// ---------------------------------------------------------------------------
async function sessionsListFull() {
    const data = await sessionsRead();
    const cutoff = Date.now() - STALE_PROCESSING_SECONDS * 1000;
    const out = [];
    for (const sess of data.sessions) {
        const owner = sessionBridge(sess);
        const busyId = await bridgeBusySession(owner);
        const live = await bridgeOnlineLive(owner);
        let prev = '', prevRole = '';
        let prevTs = sess.last_ts || sess.created_ts;
        let hasPending = false, hasProcessing = false, hasStreaming = false;
        const mdata = await messagesRead(sess.id);
        let changed = false;
        for (const msg of (mdata.messages || [])) {
            const role = msg.role || '';
            const status = msg.status || '';
            if (role === 'assistant') {
                if (status === 'streaming') {
                    if (Date.parse(msg.ts || 0) < cutoff) {
                        msg.status = 'done';
                        msg.canceled = true;
                        changed = true;
                    } else {
                        hasStreaming = true;
                    }
                }
            } else if (role === 'user') {
                if (status === 'processing') {
                    if (Date.parse(msg.ts || 0) >= cutoff) hasProcessing = true;
                } else if (status === 'pending') {
                    hasPending = true;
                }
            }
            prev = msg.text || '';
            prevRole = role;
            prevTs = msg.ts || prevTs;
        }
        if (changed) await jsonfile.writeAtomic(paths.messagesFile(sess.id), mdata);
        let state;
        if (busyId !== null) {
            state = parseInt(sess.id, 10) === busyId ? 'working' : ((hasPending || hasProcessing) ? 'waiting' : '');
        } else {
            state = (live && (hasStreaming || hasProcessing)) ? 'working' : (hasPending ? 'waiting' : '');
        }
        out.push({
            ...sess,
            state,
            preview: mbSubstr(prev, 0, 120),
            preview_role: prevRole,
            last_ts: prevTs,
        });
    }
    out.sort((a, b) => String(b.last_ts || '').localeCompare(String(a.last_ts || '')));
    return out;
}

// ---------------------------------------------------------------------------
// Comandos (cola por puente)
// ---------------------------------------------------------------------------
function pruneCommands(cat, keep = 60) {
    if (!Array.isArray(cat.commands)) return cat;
    const finished = [];
    cat.commands.forEach((c, i) => { if (c.status === 'done' || c.status === 'error') finished.push(i); });
    const excess = finished.length - keep;
    if (excess <= 0) return cat;
    const drop = new Set(finished.slice(0, excess));
    cat.commands = cat.commands.filter((c, i) => !drop.has(i));
    return cat;
}
async function enqueueCommand(name, args, file) {
    let id = 0;
    await catalogModify(file, (cat) => {
        id = parseInt(cat.nextCommandId, 10) || 1;
        cat.nextCommandId = id + 1;
        if (!Array.isArray(cat.commands)) cat.commands = [];
        cat.commands.push({ id, name: String(name), args: (args || []).map(String), status: 'pending', result: null, error: '', ts: nowIso() });
        pruneCommands(cat);
    });
    return id;
}
async function claimCommands(file) {
    const out = [];
    await catalogModify(file, (cat) => {
        if (!Array.isArray(cat.commands)) return;
        for (const c of cat.commands) {
            if (c.status === 'pending') {
                c.status = 'processing';
                out.push({ id: parseInt(c.id, 10), name: c.name, args: c.args || [] });
            }
        }
        pruneCommands(cat);
    });
    return out;
}
async function finishCommand(id, ok, text, error, file) {
    let found = false;
    await catalogModify(file, (cat) => {
        if (!Array.isArray(cat.commands)) return;
        for (const c of cat.commands) {
            if (parseInt(c.id, 10) === parseInt(id, 10)) {
                c.status = ok ? 'done' : 'error';
                c.result = String(text);
                c.error = String(error || '');
                c.finished_ts = nowIso();
                found = true;
                break;
            }
        }
        if (found) pruneCommands(cat);
    });
    return found;
}
async function pollPeekWork(cutoff, bridge) {
    const data = await jsonfile.readJson(paths.queueFile(bridge), { items: [] });
    const items = Array.isArray(data.items) ? data.items : [];
    if (items.some((it) => it.status === 'pending'
        || (it.status === 'processing' && Date.parse(it.ts || 0) < cutoff))) return true;
    const cat = await catalogRead(paths.bridgeCatalogFile(bridge));
    if (cat.allow_create_folders && (cat.requests || []).some((r) => r.status === 'pending')) return true;
    if ((cat.commands || []).some((c) => c.status === 'pending')) return true;
    return false;
}

// ---------------------------------------------------------------------------
// Workspace (explorador de archivos)
// ---------------------------------------------------------------------------
async function catalogWorkspaceRoot(file) {
    const cat = await catalogRead(file);
    return cat.workspace ? String(cat.workspace) : '';
}
async function safeJoinWorkspace(rel, maxDepth = 4, file) {
    const root = await catalogWorkspaceRoot(file);
    if (root === '') return null;
    let rootReal;
    try { rootReal = await fs.realpath(root); } catch (e) { return null; }
    let stat;
    try { stat = await fs.stat(rootReal); } catch (e) { return null; }
    if (!stat.isDirectory()) return null;
    let r = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (r === '' || r === '.') return rootReal;
    const parts = r.split('/').filter((x) => x !== '' && x !== '.' && x !== '..');
    if (parts.length > maxDepth) return null;
    const candidate = path.join(rootReal, ...parts);
    let real;
    try { real = await fs.realpath(candidate); } catch (e) { return null; }
    const rootNorm = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
    if (real !== rootReal && !real.startsWith(rootNorm)) return null;
    return real;
}
function fileTooBig(size, max = 524288) { return size > max; }
async function readTextFile(abs, max = 524288) {
    let st;
    try { st = await fs.stat(abs); } catch (e) { return null; }
    if (!st.isFile() || st.size > max) return null;
    const buf = await fs.readFile(abs);
    if (buf.length === 0) return '';
    const sample = buf.subarray(0, Math.min(4096, buf.length));
    let nonPrintable = 0;
    for (const b of sample) {
        if (b === 0 || (b < 32 && b !== 9 && b !== 10 && b !== 13)) nonPrintable++;
    }
    if (nonPrintable / Math.max(1, sample.length) > 0.3) return null;
    return buf.toString('utf8');
}
function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (Math.round(n / 1024 * 10) / 10) + ' KB';
    if (n < 1024 * 1024 * 1024) return (Math.round(n / (1024 * 1024) * 10) / 10) + ' MB';
    return (Math.round(n / (1024 * 1024 * 1024) * 10) / 10) + ' GB';
}
function workspaceSkipName(name) {
    if (!name || name[0] === '.') return true;
    return ['node_modules', 'dist', 'build', '.next', '.cache', '.venv', '__pycache__', 'vendor', 'target', 'Pods', '.gradle', '.idea', '.vscode'].includes(name);
}
async function workspaceListEntries(base, absRoot) {
    const rootNorm = absRoot.endsWith(path.sep) ? absRoot : absRoot + path.sep;
    let items;
    try { items = await fs.readdir(base, { withFileTypes: true }); } catch (e) { return []; }
    const dirs = [], files = [];
    for (const it of items) {
        if (workspaceSkipName(it.name)) continue;
        const full = path.join(base, it.name);
        let st;
        try { st = await fs.lstat(full); } catch (e) { continue; }
        if (st.isSymbolicLink()) {
            let real;
            try { real = await fs.realpath(full); } catch (e) { continue; }
            if (!real.startsWith(rootNorm) && real !== absRoot) continue;
            let rst;
            try { rst = await fs.stat(real); } catch (e) { continue; }
            if (rst.isDirectory()) dirs.push({ name: it.name, type: 'dir', size: null, mtime: null });
            continue;
        }
        if (st.isDirectory()) {
            dirs.push({ name: it.name, type: 'dir', size: null, mtime: null });
        } else if (st.isFile()) {
            files.push({ name: it.name, type: 'file', size: st.size, mtime: Math.floor(st.mtimeMs / 1000) });
        }
    }
    const cmp = (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    dirs.sort(cmp);
    files.sort(cmp);
    return dirs.concat(files);
}
async function workspaceList(rel, file) {
    const root = await catalogWorkspaceRoot(file);
    let absRoot;
    try { absRoot = await fs.realpath(root); } catch (e) { return null; }
    let base;
    if (rel === '' || rel === '.') base = absRoot;
    else base = await safeJoinWorkspace(rel, 8, file);
    if (!base) return null;
    let st;
    try { st = await fs.stat(base); } catch (e) { return null; }
    if (!st.isDirectory()) return null;
    const entries = await workspaceListEntries(base, absRoot);
    const relOut = base === absRoot ? '' : base.slice(absRoot.length).replace(/\\/g, '/').replace(/^\/+/, '');
    return { path: relOut, entries };
}

// ---------------------------------------------------------------------------
// Busqueda
// ---------------------------------------------------------------------------
async function searchIndexBuild(query, maxSnippets = 3) {
    const q = String(query || '').trim();
    if (q === '' || Array.from(q).length < 2) return [];
    const needle = q.toLowerCase();
    const out = [];
    const sdata = await sessionsRead();
    const sessions = {};
    for (const s of sdata.sessions) sessions[parseInt(s.id, 10)] = s;
    let entries;
    try { entries = await fs.readdir(paths.dataDir()); } catch (e) { return []; }
    for (const f of entries) {
        const m = /^messages-(\d+)\.json$/.exec(f);
        if (!m) continue;
        const sid = parseInt(m[1], 10);
        const data = await jsonfile.readJson(path.join(paths.dataDir(), f), { messages: [] });
        const matches = [];
        let count = 0;
        for (const msg of (data.messages || [])) {
            const text = String(msg.text || '');
            if (text === '') continue;
            const hay = text.toLowerCase();
            let pos = 0;
            while ((pos = hay.indexOf(needle, pos)) >= 0) {
                count++;
                if (matches.length < maxSnippets) {
                    const start = Math.max(0, pos - 40);
                    let snippet = mbSubstr(text, start, 140);
                    if (start > 0) snippet = '\u2026' + snippet;
                    matches.push({ mid: parseInt(msg.id, 10) || 0, role: msg.role || '', snippet });
                }
                pos += needle.length;
            }
        }
        if (count > 0) {
            out.push({ session_id: sid, name: sessions[sid] ? sessions[sid].name : ('Chat ' + sid), count, matches });
        }
    }
    return out;
}

// ---------------------------------------------------------------------------
// Temas
// ---------------------------------------------------------------------------
function themesIndex() {
    const file = path.join(__dirname, '..', 'web', 'assets', 'themes', 'index.json');
    const fallback = [
        { slug: 'terminal', label: 'Terminal', sw: ['#0a0d12', '#3fb950'] },
        { slug: 'default', label: 'Oscuro', sw: ['#0f172a', '#0ea5e9'] },
    ];
    try {
        const data = JSON.parse(fssync.readFileSync(file, 'utf8'));
        if (!data || !Array.isArray(data.themes)) return fallback;
        const list = [];
        for (const t of data.themes) {
            if (!t || typeof t.slug !== 'string' || !/^[a-z\-]{1,40}$/.test(t.slug)) continue;
            const entry = { slug: t.slug, label: typeof t.label === 'string' ? t.label : t.slug };
            if (Array.isArray(t.sw) && t.sw.length === 2) entry.sw = [t.sw[0], t.sw[1]];
            list.push(entry);
        }
        return list.length ? list : fallback;
    } catch (e) {
        return fallback;
    }
}
function themesKnown() {
    return themesIndex().map((t) => t.slug);
}

// ---------------------------------------------------------------------------
// Lista de sesiones opencode (chats vinculados)
// ---------------------------------------------------------------------------
async function ocSessionsList() {
    const data = await sessionsRead();
    const found = [];
    for (const sess of data.sessions) {
        const oc = sess.opencode_session || null;
        found.push({
            session_id: parseInt(sess.id, 10),
            name: sess.name || ('Chat ' + sess.id),
            folder: sess.folder || '',
            model: sess.model || '',
            agent: sess.agent || 'build',
            opencode_session: oc,
            has_opencode: !!oc,
        });
    }
    return found;
}

// ---------------------------------------------------------------------------
async function touchFile(file) {
    try { await fs.writeFile(file, '', { flag: 'a' }); } catch (e) { /* nada */ }
}

// Limpia los .tmp huerfanos de `data/` (escrituras cortadas por un crash).
async function purgeTmpData() {
    try { return await jsonfile.purgeTmpDir(paths.dataDir()); } catch (e) { return 0; }
}

// ---------------------------------------------------------------------------
// Indice de sesiones (proxy): metadatos que manda el puente, sin historial.
// ---------------------------------------------------------------------------
async function sessionIndexSync(bridge, sessions) {
    const list = (Array.isArray(sessions) ? sessions : [])
        .filter((s) => s && typeof s === 'object' && /^ses_[A-Za-z0-9]{4,64}$/.test(String(s.id || '')))
        .map((s) => ({
            id: String(s.id),
            title: mbSubstr(String(s.title || ''), 0, 120),
            folder: mbSubstr(String(s.folder || ''), 0, 500),
            updated: String(s.updated || ''),
        }))
        .slice(0, 5000);
    await jsonfile.writeAtomic(paths.sessionIndexFile(bridge), { sessions: list, ts: nowIso() });
    // Alta/actualizacion de las sesiones de opencode en el registro del hub
    // (metadatos, sin historial) para que aparezcan en el sidebar.
    await sessionsUpdate((sdata) => {
        for (const it of list) {
            const found = sdata.sessions.find((s) => s.opencode_session && String(s.opencode_session) === it.id);
            if (found) {
                if (it.title && !sessionNamePlaceholder(it.title)) found.name = it.title;
                if (it.folder && String(found.folder || '') !== it.folder) found.folder = it.folder;
                found.importada = true;
                if (bridgeValidId(bridge) && sessionBridge(found) === '') found.bridge = bridge;
            } else {
                const id = sdata.nextId;
                sdata.nextId = id + 1;
                const sess = {
                    id,
                    name: it.title || ('Opencode ' + it.id.slice(0, 8)),
                    folder: it.folder,
                    model: '',
                    agent: 'build',
                    created_ts: nowIso(),
                    last_ts: nowIso(),
                    opencode_session: it.id,
                    importada: true,
                };
                if (bridgeValidId(bridge)) sess.bridge = bridge;
                sdata.sessions.push(sess);
            }
        }
    });
    return list.length;
}
async function sessionIndexList(bridge) {
    const data = await jsonfile.readJson(paths.sessionIndexFile(bridge), { sessions: [] });
    return Array.isArray(data.sessions) ? data.sessions : [];
}

// Resultado efimero de una lectura grande (historial): la web lo toma una vez.
async function historyReady(id, payload) {
    await jsonfile.writeAtomic(paths.fetchFile(id), payload && typeof payload === 'object' ? payload : {});
}
async function historyTake(id) {
    const file = paths.fetchFile(id);
    const data = await jsonfile.readJson(file, null);
    try { await fs.unlink(file); } catch (e) { /* no estaba */ }
    return data;
}

// ---------------------------------------------------------------------------
// Cola de salida (transitoria) e inflight (turno en curso). El hub no guarda
// historial: la conversacion vive en opencode y se sirve por proxy.
// ---------------------------------------------------------------------------
async function queueAdd(bridge, item) {
    let id = 0;
    await jsonfile.update(paths.queueFile(bridge), { items: [], nextId: 1 }, (data) => {
        if (!Array.isArray(data.items)) data.items = [];
        id = data.nextId || 1;
        data.nextId = id + 1;
        data.items.push(Object.assign({ id, status: 'pending', ts: nowIso() }, item || {}));
        if (data.items.length > 500) data.items = data.items.slice(-500);
    });
    return id;
}
async function queueClaim(bridge, cutoffMs) {
    const out = [];
    await jsonfile.update(paths.queueFile(bridge), { items: [], nextId: 1 }, (data) => {
        if (!Array.isArray(data.items)) return;
        const now = Date.now();
        const keep = [];
        for (const it of data.items) {
            if (it.cancel_requested && it.status === 'pending') continue; // cancelado antes de arrancar
            const stale = it.status === 'processing' && it.ts && (now - Date.parse(it.ts) > (cutoffMs || 0));
            if (it.status === 'pending' || stale) {
                it.status = 'processing';
                it.ts = nowIso();
                out.push(it);
            }
            keep.push(it);
        }
        data.items = keep;
    });
    return out;
}
async function queueRemove(bridge, id) {
    await jsonfile.update(paths.queueFile(bridge), { items: [], nextId: 1 }, (data) => {
        if (Array.isArray(data.items)) data.items = data.items.filter((it) => parseInt(it.id, 10) !== parseInt(id, 10));
    });
}
async function queueCancel(bridge, id) {
    await jsonfile.update(paths.queueFile(bridge), { items: [], nextId: 1 }, (data) => {
        if (!Array.isArray(data.items)) return;
        for (const it of data.items) if (parseInt(it.id, 10) === parseInt(id, 10)) it.cancel_requested = true;
    });
}
async function queueForSession(bridge, sessionId) {
    const data = await jsonfile.readJson(paths.queueFile(bridge), { items: [] });
    const sid = parseInt(sessionId, 10);
    return (Array.isArray(data.items) ? data.items : []).filter((it) => parseInt(it.session, 10) === sid);
}
async function inflightSet(bridge, payload) {
    await jsonfile.writeAtomic(paths.inflightFile(bridge), payload && typeof payload === 'object' ? payload : {});
}
async function inflightGet(bridge) {
    const data = await jsonfile.readJson(paths.inflightFile(bridge), null);
    return data && typeof data === 'object' ? data : null;
}
async function inflightClear(bridge) {
    try { await fs.unlink(paths.inflightFile(bridge)); } catch (e) { /* no estaba */ }
}

module.exports = {
    STALE_PROCESSING_SECONDS,
    nowIso, md5, mbSubstr, normFolder,
    // sesiones
    sessionsRead, sessionsUpdate, findSessionRef, getSession, addSession, updateSession,
    touchSession, sessionRename, sessionHasDefaultName, sessionTitleFromPrompt, deleteSession,
    sessionImport, sessionTokens, sessionReconcile, sessionsListFull, sessionBridge, bridgeValidId,
    // mensajes
    messagesRead, messagesUpdate, messagesHealStaleStreaming, addMessage, messageAgentOf,
    // catalogo
    catalogDefault, catalogRead, catalogModify, catalogVersion, syncCatalog,
    validFolderName, catalogSetModels, catalogAddRequest, catalogClaimRequests, catalogFinishRequest,
    folderPathInCatalog, modelInCatalog, agentInCatalog, catalogWorkspaceRoot,
    modelContext, modelContextObj,
    // puentes
    bridgesMap, bridgeRegistryUpsert, bridgeRegistryGet, bridgeOnlineLive, bridgeBusySession,
    bridgesSummary, soleBridgeId, bridgeLiveOverlay, adoptSessionsToBridge, bridgeRegisterFirst,
    bridgeCanClaimSession,
    // comandos
    enqueueCommand, claimCommands, finishCommand, pruneCommands, pollPeekWork,
    // workspace
    safeJoinWorkspace, readTextFile, fileTooBig, fmtSize, workspaceList, workspaceListEntries,
    // busqueda / temas / opencode
    searchIndexBuild, themesIndex, themesKnown, ocSessionsList,
    sessionIndexSync, sessionIndexList, historyReady, historyTake,
    queueAdd, queueClaim, queueRemove, queueCancel, queueForSession,
    inflightSet, inflightGet, inflightClear,
    purgeTmpData,
};
