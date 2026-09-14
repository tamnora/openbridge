"use strict";

// Migracion de claves viejas `ocx_*` a `ob_*` (una sola vez, antes de leer nada).
(function () {
    try {
        var keys = [];
        for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            if (k && k.indexOf('ocx_') === 0) keys.push(k);
        }
        for (var j = 0; j < keys.length; j++) {
            var nk = 'ob_' + keys[j].slice(4);
            if (localStorage.getItem(nk) === null) localStorage.setItem(nk, localStorage.getItem(keys[j]));
            localStorage.removeItem(keys[j]);
        }
    } catch (e) { /* almacenamiento no disponible */ }
})();

var CFG = window.APP_CONFIG || {};
var CSRF = CFG.csrf || '';
var INITIAL_SESSION = typeof CFG.initialSession === 'number' ? CFG.initialSession : null;
var IS_ADMIN = String(CFG.userRole || 'user') === 'admin';
function isAdmin() { return IS_ADMIN; }

var els = {
    body: document.body,
    scrim: document.getElementById('scrim'),
    btnBurger: document.getElementById('btnBurger'),
    btnBack: document.getElementById('btnBack'),
    sidebar: document.getElementById('sidebar'),
    sideButtons: document.querySelectorAll('#sidebar .utilities button'),
    sessionTree: document.getElementById('sessionTree'),
    sideSearch: document.getElementById('sideSearch'),
    bridgeBar: document.getElementById('bridgeBar'),
    btnNewSession: document.getElementById('btnNewSession'),
    bridgeDot: document.getElementById('bridgeDot'),
    bridgeStatusText: document.getElementById('bridgeStatusText'),
    envBadge: null,
    hTitle: document.getElementById('hTitle'),
    hSub: document.getElementById('hSub'),
    home: document.getElementById('home'),
    chat: document.getElementById('chat'),
    messages: document.getElementById('messages'),
    sendForm: document.getElementById('sendForm'),
    input: document.getElementById('input'),
    sendBtn: document.getElementById('sendBtn'),
    btnImg: document.getElementById('btnImg'),
    btnMic: document.getElementById('btnMic'),
    btnTpl: document.getElementById('btnTpl'),
    tplPanel: document.getElementById('tplPanel'),
    imgInput: document.getElementById('imgInput'),
    imgPreview: document.getElementById('imgPreview'),
    imgThumb: document.getElementById('imgThumb'),
    imgRemove: document.getElementById('imgRemove'),
    imgMeta: document.getElementById('imgMeta'),
    jumpBtn: document.getElementById('jumpBtn'),
    procrow: document.getElementById('procrow'),
    composeOpen: document.getElementById('composeOpen'),
    slashPanel: document.getElementById('slashPanel'),
    cardMenu: document.getElementById('cardMenu'),
    offline: document.getElementById('offline'),
    btnCmds: document.getElementById('btnCmds'),
    cmdsPanel: document.getElementById('cmdsPanel'),
    btnPush: document.getElementById('btnPush'),
    btnSkin: document.getElementById('btnSkin'),
    skinPanel: document.getElementById('skinPanel'),
    viewProcs: document.getElementById('viewProcs'),
    viewChanges: document.getElementById('viewChanges'),
    viewMcp: document.getElementById('viewMcp'),
    themeColor: document.getElementById('themeColor'),
    themeLink: document.getElementById('themeStylesheet'),
    statusbar: document.getElementById('statusbar'),
    sbDot: document.getElementById('sbDot'),
    sbMode: document.getElementById('sbMode'),
    sbModel: document.getElementById('sbModel'),
    sbExtra: document.getElementById('sbExtra'),
    fabNew: document.getElementById('fabNew'),
    modelOverlay: document.getElementById('modelOverlay'),
    mTitle: document.getElementById('mTitle'),
    mSearch: document.getElementById('mSearch'),
    mWarn: document.getElementById('mWarn'),
    fModel2: document.getElementById('fModel2'),
    fAgent2: document.getElementById('fAgent2'),
    btnModelCancel: document.getElementById('btnModelCancel'),
    btnModelSave: document.getElementById('btnModelSave'),
    viewFiles: document.getElementById('viewFiles'),
    viewSessions: document.getElementById('viewSessions'),
    viewSearch: document.getElementById('viewSearch'),
    viewHistory: document.getElementById('viewHistory'),
    viewPreview: document.getElementById('viewPreview'),
    brandHome: document.getElementById('brandHome'),
    btnSbHide: document.getElementById('btnSbHide'),
    sbReveal: document.getElementById('sbReveal'),
    overlay: document.getElementById('overlay'),
    fMsg: document.getElementById('fMsg'),
    fFolder: document.getElementById('fFolder'),
    fModelSearch: document.getElementById('fModelSearch'),
    fFolderCreate: document.getElementById('fFolderCreate'),
    fNewFolder: document.getElementById('fNewFolder'),
    btnNewFolder: document.getElementById('btnNewFolder'),
    fNewFolderMsg: document.getElementById('fNewFolderMsg'),
    fModel: document.getElementById('fModel'),
    fAgent: document.getElementById('fAgent'),
    fWarn: document.getElementById('fWarn'),
    btnSave: document.getElementById('btnSave'),
    btnCancel: document.getElementById('btnCancel'),
};

// Marca visual del usuario actual (admin en color de acento).
(function () {
    var ub = document.getElementById('userBadge');
    if (ub) ub.classList.toggle('admin', IS_ADMIN);
})();

var ONLINE_MAX_AGE_MS = 60000;
var PROC_TIMEOUT_MS = 45000;
var POLL_BASE_MS = 4000;   // refresco pasivo (sin nada pendiente)
var POLL_FAST_MS = 2200;   // refresco mientras hay un mensaje esperando respuesta
var CMDS = [
    { cmd: '/new', desc: 'Empezar conversación nueva' },
    { cmd: '/compact', desc: 'Liberar contexto' },
    { cmd: '/models', desc: 'Proveedores y búsqueda de modelos' },
    { cmd: '/agents', desc: 'Listar agentes disponibles' },
    { cmd: '/mcp', desc: 'Servidores MCP de opencode' },
    { cmd: '/folders', desc: 'Carpetas del workspace' },
    { cmd: '/workspace', desc: 'Mostrar el espacio de trabajo' },
    { cmd: '/status', desc: 'Estado del puente' },
    { cmd: '/help', desc: 'Todos los comandos' },
];

// ---------------------------------------------------------------------------
// Caché local (localStorage): pintado instantáneo con los últimos datos.
// ---------------------------------------------------------------------------
function lsGet(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; }
}
function lsSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
}

var state = {
    view: 'home',
    currentId: null,
    currentSession: null,
    catalog: null,
    catVer: '',
    bridges: [],          // resumen de puentes registrados [{id,name,online,busy_session}]
    activeBridge: '',     // puente seleccionado en el sidebar (id)
    isSending: false,
    pendingImage: null,
    messages: [],
    procTimer: null,
    online: true,
    theme: (CFG.theme || 'terminal'),
    themes: (Array.isArray(CFG.themes) && CFG.themes.length
        ? CFG.themes
        : [{ slug: 'terminal', label: 'Terminal', sw: ['#0a0d12', '#3fb950'] }]),
    sse: null,
    sseBackoff: 1000,
    pendingSessions: new Set(),
    sessions: [],
    sessionCount: 0,
    openProjects: null,   // Set de rutas de carpeta expandidas
    sideQuery: '',
    focusFolder: '',   // proyecto activo en el sidebar (destacado)
    focusFlash: null,  // proyecto a expandir+resaltar (se consume en renderHome)
    histFolder: null,  // proyecto abierto en la vista historial
    histLabel: '',
    histQuery: '',
    prevView: null,  // vista desde la que se abrió el chat (para el botón atrás)
    lastFolder: '',
    renderSid: null,
    lastDay: '',
    sideSig: null,
    procSince: 0,
    filesPath: '',
    filesEntries: [],
    filesCache: {},
    fileView: null,
    searchHits: [],
    tunnels: null,
    previewPort: '',
    proc: null,   // estado del proceso de la sesión (procStart), ver procState
};

// Puente activo y lista conocida se restauran antes de pintar (caché local).
state.activeBridge = loadStoredBridge();
var _cachedBridges = lsGet('ob_bridges');
if (Array.isArray(_cachedBridges) && _cachedBridges.length) state.bridges = _cachedBridges;

// Estado del panel "procesos" de la sesión activa (dev servers en la PC).
var procState = {
    open: false,
    id: null,          // id del proceso en el puente
    offset: 0,         // cursor del log ya mostrado
    log: '',           // log acumulado (recortado a ~280 KB)
    logRendered: 0,
    logDropped: false,
    running: false,
    exitCode: null,
    exitErr: '',
    input: '',         // última línea de comando (se conserva al re-render)
    detectedPort: '',  // puerto detectado en la salida (para el túnel)
    portConflict: null, // puerto en uso detectado por EADDRINUSE en el log
};

function esc(t) {
    var d = document.createElement('div');
    d.textContent = t;
    return d.innerHTML;
}

// ---------------------------------------------------------------------------
// Entorno: LOCAL (127.0.0.1 / localhost / LAN) vs REMOTO (hosting público)
// ---------------------------------------------------------------------------
function isLocalHost() {
    try {
        var h = location.hostname || '';
        if (h === '' || h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]') return true;
        return /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
    } catch (e) { return false; }
}

// ---------------------------------------------------------------------------
// Statusbar estilo TUI
// ---------------------------------------------------------------------------
function updateStatusbar() {
    if (!els.sbDot) return;
    var on = bridgeOnline();
    els.sbDot.className = 'dot ' + (on ? 'on' : 'off');
    var local = isLocalHost();
    els.sbMode.textContent = local ? 'local' : 'conectado';
    els.sbMode.className = 'seg mode' + (local ? '' : ' remoto');
    var s = state.currentSession;
    if (s) {
        els.sbModel.textContent = (s.model || 'sin modelo') + ' · ' + (s.agent || 'build');
        els.sbModel.title = 'Cambiar modelo / agente de “' + (s.name || 'chat') + '”';
    } else if (state.catalog && state.catalog.workspace) {
        els.sbModel.textContent = shortPath(state.catalog.workspace);
        els.sbModel.title = 'workspace del puente';
    } else {
        els.sbModel.textContent = 'sin workspace';
        els.sbModel.title = '';
    }
    var extra = (state.sessionCount === 1 ? '1 chat' : state.sessionCount + ' chats');
    var info = activeBridgeInfo();
    if (info && bridgeList().length >= 2) {
        extra = (info.name || info.id) + ' · ' + extra;
    }
    if (state.currentId !== null && state.currentSession) {
        extra = '· ' + extra;
        var tokTxt = sessionTokensLabel(state.currentSession);
        if (tokTxt) {
            var pct = sessionTokensPct(state.currentSession);
            extra += ' · ' + tokTxt + ' tokens' + (pct ? ' (' + pct + ')' : '');
        }
        var cost = fmtCost(state.currentSession.cost);
        if (cost) extra += ' · ' + cost;
    }
    var totalCost = 0;
    for (var ci = 0; ci < state.sessions.length; ci++) totalCost += Number(state.sessions[ci].cost) || 0;
    var totalTxt = fmtCost(totalCost);
    if (totalTxt) extra += ' · ' + totalTxt + ' total';
    els.sbExtra.textContent = extra;
}

// ---------------------------------------------------------------------------
// Skins (la lista vive en themes/index.json, inyectada por chat.php)
// ---------------------------------------------------------------------------
function themeKnown(s) {
    for (var i = 0; i < state.themes.length; i++) {
        if (state.themes[i].slug === s) return true;
    }
    return false;
}

function applyTheme(slug, opts) {
    var s = String(slug || 'terminal');
    if (!themeKnown(s)) s = 'terminal';
    state.theme = s;
    els.body.setAttribute('data-theme', s);
    var href = 'themes/' + s + '.css';
    if (els.themeLink.getAttribute('href') !== href) {
        els.themeLink.setAttribute('href', href);
    }
    try {
        var bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
        if (bg) els.themeColor.setAttribute('content', bg);
    } catch (e) {}
    if (!opts || opts.persist !== false) {
        try {
            document.cookie = 'ob_theme=' + encodeURIComponent(s) + ';path=/;max-age=' + (60 * 60 * 24 * 365) + ';SameSite=Lax';
            localStorage.setItem('ob_theme', s);
        } catch (e) {}
    }
    renderSkinPanel();
}

function renderSkinPanel() {
    var list = state.themes;
    var html = '<h4>tema</h4>';
    for (var i = 0; i < list.length; i++) {
        var t = list[i];
        var sw = t.sw || ['#0a0d12', '#3fb950'];
        var active = t.slug === state.theme ? ' active' : '';
        html += '<div class="item' + active + '" data-theme="' + esc(t.slug) + '" style="--swatch-a:' + sw[0] + ';--swatch-b:' + sw[1] + '">'
            + '<span class="sw"></span><span>' + esc(t.label || t.slug) + '</span></div>';
    }
    els.skinPanel.innerHTML = html;
}

function toggleSkinPanel() {
    if (!els.skinPanel.innerHTML) renderSkinPanel();
    var open = els.skinPanel.classList.contains('open');
    if (open) {
        els.skinPanel.classList.remove('open');
    } else {
        els.cmdsPanel.classList.remove('open');
        renderSkinPanel();
        els.skinPanel.classList.add('open');
    }
}

els.btnSkin.addEventListener('click', function (e) {
    e.stopPropagation();
    toggleSkinPanel();
});

els.skinPanel.addEventListener('click', function (e) {
    var item = e.target.closest('.item');
    if (!item) return;
    applyTheme(item.getAttribute('data-theme'));
});

// ---------------------------------------------------------------------------
// Puentes (computadoras) y estado en vivo
// ---------------------------------------------------------------------------
function activeBridgeId() { return state.activeBridge || ''; }
function bridgeList() { return Array.isArray(state.bridges) ? state.bridges : []; }
function bridgeInfo(id) {
    var l = bridgeList();
    for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i];
    return null;
}
function activeBridgeInfo() { return bridgeInfo(activeBridgeId()); }

// El catálogo/estado se guardan por puente activo (cada PC tiene el suyo).
function catalogKey() {
    var id = activeBridgeId();
    return id ? 'ob_catalog_' + id : 'ob_catalog';
}
function catalogVerKey() {
    return catalogKey() + '_ver';
}
function loadStoredBridge() {
    try { return localStorage.getItem('ob_bridge') || ''; } catch (e) { return ''; }
}
function storeBridge(id) {
    try { localStorage.setItem('ob_bridge', id || ''); } catch (e) {}
}

// Sesiones visibles: solo las del puente activo cuando hay varios puentes.
// Con uno solo (o cero) se muestran todas (incluye legacy sin dueño).
function filterSessions(list) {
    var n = bridgeList().length;
    if (n <= 1) return list || [];
    var id = activeBridgeId();
    var out = [];
    for (var i = 0; i < list.length; i++) {
        var o = list[i].bridge || '';
        if (o === id) out.push(list[i]);
    }
    return out;
}

// Dibuja el selector de puente en el sidebar (solo si hay más de una PC).
function renderBridgeBar() {
    if (!els.bridgeBar) return;
    var list = bridgeList();
    if (list.length < 2) {
        els.bridgeBar.classList.remove('show');
        els.bridgeBar.innerHTML = '';
        return;
    }
    var cur = activeBridgeId();
    var html = '';
    for (var i = 0; i < list.length; i++) {
        var b = list[i];
        var on = b.id === cur ? ' on' : '';
        var dot = b.online ? 'bdot on' : 'bdot';
        html += '<button type="button" class="bb' + on + '" data-bridge="' + esc(b.id) + '" title="'
            + esc(b.name) + (b.online ? ' · en línea' : ' · apagado') + '">'
            + '<span class="' + dot + '"></span>'
            + '<span class="bname">' + esc(b.name || b.id || 'puente') + '</span>'
            + (b.busy_session ? '<span class="bbusy" title="trabajando ahora…">●</span>' : '')
            + '</button>';
    }
    els.bridgeBar.innerHTML = html;
    els.bridgeBar.classList.add('show');
}

// Aplica la lista de puentes conocidos (sin cambiar el activo; eso lo decide
// applyBootPayload / switchActiveBridge para no mezclar catálogos).
function applyBridges(list) {
    state.bridges = Array.isArray(list) ? list : [];
    try { localStorage.setItem('ob_bridges', JSON.stringify(state.bridges)); } catch (e) {}
    renderBridgeBar();
}

// Cambio de puente activo (selector del usuario o al abrir un chat de otra PC).
// Se bajan catálogo + sesiones del puente elegido.
function switchActiveBridge(id) {
    id = id || '';
    if (id === activeBridgeId()) { renderBridgeBar(); return; }
    state.activeBridge = id;
    storeBridge(id);
    state.catalog = null;
    state.catVer = '';
    if (state.view === 'chat' || state.view === 'history') goHome();
    renderBridgeBar();
    applyOnlineUI();
    refreshBridgeData();
}

// Baja catálogo (fresco) + sesiones del puente activo.
async function refreshBridgeData() {
    var data = await api('api.php?action=bootstrap');
    applyBootPayload(data);
}

// Aplica la respuesta de bootstrap (o de un refresh tras cambio de puente).
function applyBootPayload(data) {
    if (!data || !data.ok) return;
    var newB = Array.isArray(data.bridges) ? data.bridges : null;
    if (newB && newB.length) {
        // El puente activo guardado puede no existir (o ser el legacy '' tras
        // registrar el primer puente real): hay que pedir con el id correcto.
        var cur = activeBridgeId();
        var found = false;
        for (var i = 0; i < newB.length; i++) {
            if (newB[i].id === cur) { found = true; break; }
        }
        if (!found) {
            state.activeBridge = newB[0].id;
            storeBridge(state.activeBridge);
            state.catalog = null;
            state.catVer = '';
            applyBridges(newB);
            refreshBridgeData();
            return;
        }
    }
    if (newB) applyBridges(newB);
    if (data.catalog) {
        state.catalog = data.catalog;
        state.catVer = data.cat_ver || '';
        lsSet(catalogKey(), state.catalog);
        lsSet(catalogVerKey(), state.catVer);
        fillSelects();
    } else if (data.cat_ver) {
        state.catVer = data.cat_ver;
    }
    if (data.online_ts && state.catalog) {
        state.catalog.last_online_ts = data.online_ts;
    }
    var sessions = data.sessions || [];
    lsSet('ob_sessions', sessions);
    renderHome(sessions);
    applyOnlineUI();
}

if (els.bridgeBar) {
    els.bridgeBar.addEventListener('click', function (e) {
        var b = e.target.closest('.bb');
        if (!b) return;
        var id = b.getAttribute('data-bridge') || '';
        document.body.classList.remove('sidebar-open');
        switchActiveBridge(id);
    });
}

// ---------------------------------------------------------------------------
// Online/offline (basado en el puente activo)
// ---------------------------------------------------------------------------
function bridgeOnline() {
    var list = bridgeList();
    if (list.length) {
        var info = activeBridgeInfo();
        return !!(info && info.online);
    }
    var t = state.catalog && state.catalog.last_online_ts;
    if (!t) return true;
    var age = Date.now() - new Date(t).getTime();
    return isFinite(age) && age < ONLINE_MAX_AGE_MS;
}

function activeOnlineTs() {
    var t = state.catalog && state.catalog.last_online_ts;
    if (t) {
        var age = Date.now() - new Date(t).getTime();
        if (isFinite(age) && age < ONLINE_MAX_AGE_MS) return t;
    }
    return '';
}

function applyOnlineUI() {
    var on = bridgeOnline();
    state.online = on;
    els.offline.style.display = on ? 'none' : '';
    if (els.input) els.input.disabled = !on;
    if (els.sendBtn) els.sendBtn.disabled = !on;
    if (els.input) els.input.placeholder = on
        ? 'escribí un mensaje…'
        : 'puente apagado: no se pueden enviar mensajes';
    renderBridgeBar();
    if (els.bridgeDot && els.bridgeStatusText) {
        els.bridgeDot.className = 'dot ' + (on ? 'on' : 'off');
        var lastTs = activeOnlineTs();
        var info = activeBridgeInfo();
        var label = (info && info.name) ? info.name : 'puente';
        if (on && lastTs) {
            var d = new Date(lastTs);
            els.bridgeStatusText.textContent = label + ': en línea (' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ')';
        } else if (on) {
            els.bridgeStatusText.textContent = label + ': en línea';
        } else if (lastTs) {
            els.bridgeStatusText.textContent = label + ': apagado';
        } else {
            els.bridgeStatusText.textContent = label + ': desconocido';
        }
    }
    updateStatusbar();
}

// ---------------------------------------------------------------------------
// Panel de comandos
// ---------------------------------------------------------------------------
function renderCmds() {
    var html = '<h4>comandos</h4>';
    for (var i = 0; i < CMDS.length; i++) {
        html += '<div class="item" data-cmd="' + esc(CMDS[i].cmd) + '"><b>' + esc(CMDS[i].cmd) + '</b>'
            + '<span>' + esc(CMDS[i].desc) + '</span></div>';
    }
    els.cmdsPanel.innerHTML = html;
}

function toggleCmds() {
    if (!els.cmdsPanel.innerHTML) renderCmds();
    var open = els.cmdsPanel.classList.contains('open');
    if (open) {
        els.cmdsPanel.classList.remove('open');
    } else {
        els.skinPanel.classList.remove('open');
        renderCmds();
        els.cmdsPanel.classList.add('open');
    }
}

els.btnCmds.addEventListener('click', function (e) {
    e.stopPropagation();
    toggleCmds();
});

els.cmdsPanel.addEventListener('click', function (e) {
    var item = e.target.closest('.item');
    if (!item) return;
    var val = item.dataset.cmd;
    els.input.value = val + ' ';
    els.input.focus();
    els.cmdsPanel.classList.remove('open');
});

document.addEventListener('click', function (e) {
    if (els.cmdsPanel.classList.contains('open') && !e.target.closest('#cmdsPanel') && e.target !== els.btnCmds) {
        els.cmdsPanel.classList.remove('open');
    }
    if (els.skinPanel.classList.contains('open') && !e.target.closest('#skinPanel') && e.target !== els.btnSkin) {
        els.skinPanel.classList.remove('open');
    }
    // El panel de procesos NO se cierra con clic afuera: es un visor de log
    // que debe quedar abierto mientras mirás el chat (a diferencia de los
    // menús transitorios). Solo lo cierran su botón × y el toggle ▶.
    if (els.cardMenu.classList.contains('open') && !e.target.closest('#cardMenu') && !e.target.closest('.kebab')) {
        els.cardMenu.classList.remove('open');
    }
});

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
function timeStr(iso) {
    try {
        var d = new Date(iso);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' · ' + d.toLocaleDateString();
    } catch (e) { return ''; }
}

function timeShort(iso) {
    try {
        var d = new Date(iso);
        var now = new Date();
        if (d.toDateString() === now.toDateString()) {
            return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
        return d.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
    } catch (e) { return ''; }
}

function timeOnly(iso) {
    try {
        return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) { return ''; }
}

function dayKey(iso) {
    var d = new Date(iso);
    if (!isFinite(d.getTime())) return '';
    return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
}

function dayLabel(iso) {
    var d = new Date(iso);
    if (!isFinite(d.getTime())) return '';
    var now = new Date();
    var start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var t = d.getTime();
    if (t >= start) return 'hoy';
    if (t >= start - 86400000) return 'ayer';
    return d.toLocaleDateString();
}

function dateBucket(iso) {
    var d = new Date(iso);
    if (!isFinite(d.getTime())) return 'antes';
    var now = new Date();
    var start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var t = d.getTime();
    if (t >= start) return 'hoy';
    if (t >= start - 86400000) return 'ayer';
    if (t >= start - 6 * 86400000) return 'esta semana';
    if (t >= start - 29 * 86400000) return 'este mes';
    return 'antes';
}

// ---------------------------------------------------------------------------
// Toast estilo TUI (reemplaza el feedback silencioso del subtítulo del header)
// ---------------------------------------------------------------------------
var toastTimer = null;
function toast(msg, kind) {
    var t = document.getElementById('toast');
    if (!t) {
        t = document.createElement('div');
        t.id = 'toast';
        document.body.appendChild(t);
    }
    t.textContent = '❯ ' + msg;
    t.className = 'show' + (kind === 'error' ? ' error' : kind === 'ok' ? ' ok' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = ''; }, 2600);
}

function copyText(text, label) {
    function done() { toast(label || 'copiado', 'ok'); }
    function fallback() {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try {
            document.execCommand('copy');
            done();
        } catch (e) { toast('no se pudo copiar', 'error'); }
        ta.parentNode.removeChild(ta);
    }
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done, fallback);
    } else {
        fallback();
    }
}

function api(path, opts) {
    var settings = opts || {};
    // Cada request lleva el puente activo (la PC que se está mirando).
    if (typeof path === 'string' && path.indexOf('api.php') === 0 && path.indexOf('bridge=') < 0) {
        path += (path.indexOf('?') >= 0 ? '&' : '?') + 'bridge=' + encodeURIComponent(activeBridgeId());
    }
    settings.headers = Object.assign({}, settings.headers, { 'X-Bridge-Id': activeBridgeId() });
    settings.cache = 'no-store';
    return fetch(path, settings)
        .then(function (res) {
            if (!res.ok) return { ok: false, error: 'http ' + res.status };
            return res.json().catch(function () { return { ok: false, error: 'parse' }; });
        })
        .catch(function () { return { ok: false, error: 'network' }; });
}

function apiCsrf(method, body) {
    var b = body || {};
    if (!('bridge' in b)) b.bridge = activeBridgeId();
    return {
        method: method,
        headers: { 'Content-Type': 'application/json', 'X-CSRF': CSRF, 'X-Bridge-Id': activeBridgeId() },
        body: JSON.stringify(b),
    };
}

function shortPath(p) {
    if (!p) return 'sin carpeta';
    var parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
    return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : p;
}

function baseName(p) {
    if (!p) return '';
    var parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : p;
}

// ---------------------------------------------------------------------------
// Agrupación de sesiones por proyecto (carpeta de trabajo)
// ---------------------------------------------------------------------------
function projectLabel(folderPath) {
    if (!folderPath) return 'sin proyecto';
    var c = state.catalog;
    if (c && Array.isArray(c.folders)) {
        for (var i = 0; i < c.folders.length; i++) {
            if (c.folders[i].path === folderPath) return c.folders[i].name;
        }
    }
    return baseName(folderPath) || folderPath;
}

function loadOpenProjects() {
    if (state.openProjects) return state.openProjects;
    var stored = null;
    try { stored = JSON.parse(localStorage.getItem('ob_openProjects') || 'null'); } catch (e) {}
    state.openProjects = (stored && typeof stored === 'object') ? stored : null;
    return state.openProjects;
}

function saveOpenProjects() {
    try { localStorage.setItem('ob_openProjects', JSON.stringify(state.openProjects || {})); } catch (e) {}
}

function isProjectOpen(folderPath, sessions) {
    var opens = loadOpenProjects();
    if (opens && Object.prototype.hasOwnProperty.call(opens, folderPath)) {
        return !!opens[folderPath];
    }
    // Por defecto: abierto si contiene la sesión activa o es el más reciente.
    if (state.currentId !== null && sessions) {
        for (var i = 0; i < sessions.length; i++) {
            if (sessions[i].id === state.currentId) return true;
        }
    }
    return false;
}

function setProjectOpen(folderPath, open) {
    var opens = loadOpenProjects();
    if (!opens) opens = {};
    opens[folderPath] = !!open;
    state.openProjects = opens;
    saveOpenProjects();
}

// Agrupa la lista (ordenada por last_ts desc) en {order:[folder], groups:{folder:{label,sessions,latestTs}}}
function groupSessions(list, query) {
    var q = String(query || '').trim().toLowerCase();
    var groups = {};
    var order = [];
    for (var i = 0; i < list.length; i++) {
        var s = list[i];
        if (state.pendingSessions.has(s.id)) continue;
        if (q) {
            var hay = ((s.name || '') + ' ' + (s.preview || '') + ' ' + (s.model || '')).toLowerCase();
            if (hay.indexOf(q) < 0 && projectLabel(s.folder).toLowerCase().indexOf(q) < 0) continue;
        }
        var key = s.folder || '';
        if (!groups[key]) {
            groups[key] = { folder: key, label: projectLabel(key), sessions: [], latestTs: s.last_ts || '' };
            order.push(key);
        }
        groups[key].sessions.push(s);
    }
    return { order: order, groups: groups };
}

// ---------------------------------------------------------------------------
// Sidebar: árbol de proyectos y sesiones
// ---------------------------------------------------------------------------
// Tokens abreviados: 940 · 12,3k · 11,2M
function fmtTokens(n) {
    n = Math.round(Number(n) || 0);
    if (n >= 1000000) return (Math.round(n / 100000) / 10).toString().replace('.', ',') + 'M';
    if (n >= 1000) return (Math.round(n / 100) / 10).toString().replace('.', ',') + 'k';
    return String(n);
}

// Costo acumulado (USD) con precision segun magnitud ('' si no hay dato).
function fmtCost(n) {
    var v = Number(n) || 0;
    if (v <= 0) return '';
    var s = v >= 1 ? v.toFixed(2) : (v >= 0.01 ? v.toFixed(3) : v.toFixed(4));
    return '$' + s.replace('.', ',');
}

// Ventana de contexto del modelo segun el catalogo (0 si no se conoce).
function modelContext(model) {
    var c = state.catalog || {};
    var map = (c.models_ctx && typeof c.models_ctx === 'object') ? c.models_ctx : {};
    var v = map[model];
    return (typeof v === 'number' && v > 0) ? v : 0;
}

// Etiqueta "consumidos/capacidad" en texto plano ('' si no hay datos).
function sessionTokensLabel(s) {
    var tok = Math.round(Number(s.tokens) || 0);
    var ctx = modelContext(s.model);
    if (!tok && !ctx) return '';
    return fmtTokens(tok) + (ctx ? '/' + fmtTokens(ctx) : '');
}
function sessionTokensTitle(s) {
    var tok = Math.round(Number(s.tokens) || 0);
    var ctx = modelContext(s.model);
    var cost = fmtCost(s.cost);
    return tok + ' tokens' + (ctx ? ' de ' + ctx + ' de contexto' : '') + (cost ? ' · ' + cost + ' acumulado' : '');
}

// Porcentaje de contexto consumido ('' si no hay datos).
function sessionTokensPct(s) {
    var tok = Math.round(Number(s.tokens) || 0);
    var ctx = modelContext(s.model);
    if (!tok || !ctx) return '';
    return Math.min(100, Math.round((tok / ctx) * 100)) + '%';
}

// Etiqueta "consumidos / capacidad" de la sesion.
function sessionTokensHtml(s) {
    var label = sessionTokensLabel(s);
    if (!label) return '';
    return '<span class="stok" title="' + sessionTokensTitle(s) + '">' + label + '</span>';
}

// Costo acumulado de la sesion ('' si no hay dato).
function sessionCostHtml(s) {
    var cost = fmtCost(s.cost);
    if (!cost) return '';
    return '<span class="scost" title="' + sessionTokensTitle(s) + '">' + cost + '</span>';
}

// Subtitulo del encabezado: proyecto · modelo · agente · tokens/contexto · costo.
function sessionSubtitle(s) {
    var txt = projectLabel(s.folder) + ' · ' + (s.model || 'sin modelo') + ' · ' + (s.agent || 'build');
    var label = sessionTokensLabel(s);
    if (label) {
        var pct = sessionTokensPct(s);
        txt += ' · ' + label + ' tokens' + (pct ? ' (' + pct + ')' : '');
    }
    var cost = fmtCost(s.cost);
    if (cost) txt += ' · ' + cost;
    return txt;
}

// Actividad agregada de un grupo de sesiones: 'working' / 'waiting' / ''.
function groupActivity(list) {
    var working = false;
    var waiting = false;
    for (var i = 0; i < list.length; i++) {
        if (list[i].state === 'working') working = true;
        else if (list[i].state === 'waiting') waiting = true;
    }
    return working ? 'working' : (waiting ? 'waiting' : '');
}

function sessionItemHtml(s, withFolder) {
    var active = s.id === state.currentId ? ' active' : '';
    var pen = s.state === 'working' ? '<span class="sbusy" title="trabajando ahora…"></span>'
        : (s.state === 'waiting' ? '<span class="spen" title="esperando respuesta"></span>' : '');
    var nameHtml = state.sideQuery ? highlightText(s.name || '', state.sideQuery) : esc(s.name);
    return '<button type="button" class="sitem' + active + '" data-sid="' + s.id + '">'
        + '<span class="sname">' + nameHtml + '</span>'
        + (withFolder ? '<span class="sfolder">' + esc(projectLabel(s.folder)) + '</span>' : '')
        + pen
        + sessionTokensHtml(s)
        + sessionCostHtml(s)
        + '<span class="stime">' + esc(timeShort(s.last_ts)) + '</span>'
        + '</button>';
}

function totalCount(g) {
    var t = 0;
    for (var k = 0; k < g.order.length; k++) t += g.groups[g.order[k]].sessions.length;
    return t;
}

// Huella de la lista: si nada cambió (poll cada pocos segundos) no se
// reconstruye el árbol y el scroll del sidebar queda intacto.
function sideSig() {
    var p = [state.sideQuery, state.focusFolder, state.currentId, state.catVer, state.pendingSessions.size, state.sessions.length];
    for (var i = 0; i < state.sessions.length; i++) {
        var s = state.sessions[i];
        p.push(s.id + ':' + (s.state || '') + ':' + (s.preview_role || '') + ':' + (s.tokens || 0) + ':' + (s.last_ts || '') + ':' + (s.name || ''));
    }
    return p.join('|');
}

function renderSidebar() {
    if (!els.sessionTree) return;
    var sig = sideSig();
    if (sig === state.sideSig) return;
    state.sideSig = sig;
    var q = String(state.sideQuery || '').trim().toLowerCase();
    // Lista SOLO de proyectos, ordenados por actividad reciente (última sesión).
    var projects = [];
    var byKey = {};
    for (var i = 0; i < state.sessions.length; i++) {
        var s = state.sessions[i];
        if (state.pendingSessions.has(s.id)) continue;
        var key = s.folder || '';
        var label = projectLabel(key) || '(sin proyecto)';
        if (q && label.toLowerCase().indexOf(q) < 0) continue;
        if (!byKey[key]) {
            byKey[key] = { folder: key, label: label, sessions: [], latestTs: s.last_ts || '' };
            projects.push(byKey[key]);
        }
        var grp = byKey[key];
        grp.sessions.push(s);
        if ((s.last_ts || '') > grp.latestTs) grp.latestTs = s.last_ts;
    }
    projects.sort(function (a, b) {
        return String(b.latestTs).localeCompare(String(a.latestTs));
    });

    var html = '';
    if (!projects.length) {
        html = '<div class="tree-empty">' + (q ? 'sin proyectos para “' + esc(state.sideQuery) + '”' : 'no hay proyectos todavía') + '</div>';
    } else {
        for (var p = 0; p < projects.length; p++) {
            var pr = projects[p];
            var act = groupActivity(pr.sessions);
            var actHtml = act === 'working' ? '<span class="sbusy" title="trabajando…"></span>'
                : (act === 'waiting' ? '<span class="sdot" title="esperando respuesta"></span>' : '');
            var active = pr.folder === state.focusFolder ? ' active' : '';
            var showAdd = pr.folder !== '';
            html += '<div class="prow' + active + '" data-folder="' + esc(pr.folder) + '">'
                + '<button type="button" class="proj-head" data-folder="' + esc(pr.folder) + '" title="Ver chats de ' + esc(pr.label) + '">'
                + '<span class="chev">▸</span>'
                + '<span class="pname">' + esc(pr.label) + '</span>'
                + actHtml
                + '<span class="pcount">' + pr.sessions.length + '</span>'
                + '</button>'
                + (showAdd ? '<button type="button" class="padd" data-add="' + esc(pr.folder) + '" title="nueva sesión en ' + esc(pr.label) + '">+</button>' : '')
                + '</div>';
        }
    }

    var stv = els.sessionTree.scrollTop;
    els.sessionTree.innerHTML = html;
    els.sessionTree.scrollTop = stv;
}

// Un solo listener con delegación: los proyectos se re-renderizan sin re-bindear.
els.sessionTree.addEventListener('click', function (e) {
    var add = e.target.closest('.padd');
    if (add) {
        e.stopPropagation();
        document.body.classList.remove('sidebar-open');
        openModal(add.getAttribute('data-add') || '');
        return;
    }
    var go = e.target.closest('.proj-head[data-folder]');
    if (go) {
        e.stopPropagation();
        document.body.classList.remove('sidebar-open');
        focusProject(go.getAttribute('data-folder'));
        return;
    }
});

if (els.sideSearch) {
    var sideSearchDebounce = null;
    els.sideSearch.addEventListener('input', function () {
        clearTimeout(sideSearchDebounce);
        var v = els.sideSearch.value;
        sideSearchDebounce = setTimeout(function () {
            state.sideQuery = v;
            renderSidebar();
        }, 160);
    });
}

// ---------------------------------------------------------------------------
// Router de vistas
// ---------------------------------------------------------------------------
function showView(name) {
    state.view = name;
    document.body.classList.remove('sidebar-open');
    if (els.composeOpen) els.composeOpen.classList.toggle('show', name === 'chat');
    if (name !== 'chat') composeCloseSheet();
    els.home.style.display = 'none';
    els.chat.style.display = 'none';
    els.viewFiles.style.display = 'none';
    els.viewSessions.style.display = 'none';
    els.viewSearch.style.display = 'none';
    els.viewHistory.style.display = 'none';
    els.viewPreview.style.display = 'none';
    els.viewProcs.style.display = 'none';
    els.viewChanges.style.display = 'none';
    els.viewMcp.style.display = 'none';

    if (name !== 'procs') stopProcView();

    if (name === 'home') {
        els.home.style.display = '';
        els.btnBack.style.display = 'none';
        els.sendForm.style.display = 'none';
        els.btnCmds.style.display = 'none';
        els.hTitle.textContent = 'OpenBridge';
        els.hSub.textContent = state.subtitle || 'cargando…';
        try { history.replaceState(null, '', 'chat.php'); } catch (e) {}
    } else if (name === 'chat') {
        els.chat.style.display = 'flex';
        els.btnBack.style.display = '';
        els.sendForm.style.display = '';
        els.btnCmds.style.display = '';
        autoGrow();
    } else if (name === 'files') {
        els.viewFiles.style.display = '';
        els.btnBack.style.display = 'none';
        els.sendForm.style.display = 'none';
        els.btnCmds.style.display = 'none';
        els.hTitle.textContent = 'archivos';
        els.hSub.textContent = 'workspace del puente';
        loadFiles(state.filesPath);
    } else if (name === 'sessions') {
        els.viewSessions.style.display = '';
        els.btnBack.style.display = 'none';
        els.sendForm.style.display = 'none';
        els.btnCmds.style.display = 'none';
        els.hTitle.textContent = 'sesiones opencode';
        els.hSub.textContent = 'vinculadas a tus chats';
        renderSessionsView();
    } else if (name === 'search') {
        els.viewSearch.style.display = '';
        els.btnBack.style.display = 'none';
        els.sendForm.style.display = 'none';
        els.btnCmds.style.display = 'none';
        els.hTitle.textContent = 'buscar';
        els.hSub.textContent = 'en todos tus chats';
        renderSearchView();
    } else if (name === 'history') {
        els.viewHistory.style.display = '';
        els.btnBack.style.display = '';
        els.sendForm.style.display = 'none';
        els.btnCmds.style.display = 'none';
        els.hTitle.textContent = 'historial';
        els.hSub.textContent = state.histLabel || 'de un proyecto';
        renderHistory();
    } else if (name === 'preview') {
        els.viewPreview.style.display = '';
        els.btnBack.style.display = 'none';
        els.sendForm.style.display = 'none';
        els.btnCmds.style.display = 'none';
        els.hTitle.textContent = 'vista previa';
        els.hSub.textContent = 'túneles del proyecto';
        renderPreviewView();
    } else if (name === 'procs') {
        els.viewProcs.style.display = '';
        els.btnBack.style.display = 'none';
        els.sendForm.style.display = 'none';
        els.btnCmds.style.display = 'none';
        els.hTitle.textContent = 'procesos';
        var pf = sessionProcFolder();
        els.hSub.textContent = pf ? projectLabel(pf) : 'de la sesión abierta';
        enterProcsView();
    } else if (name === 'changes') {
        els.viewChanges.style.display = '';
        els.btnBack.style.display = 'none';
        els.sendForm.style.display = 'none';
        els.btnCmds.style.display = 'none';
        renderChangesView();
    } else if (name === 'mcp') {
        els.viewMcp.style.display = '';
        els.btnBack.style.display = 'none';
        els.sendForm.style.display = 'none';
        els.btnCmds.style.display = 'none';
        renderMcpView();
    }

    if (els.fabNew) els.fabNew.classList.toggle('show', name === 'home');

    for (var i = 0; i < els.sideButtons.length; i++) {
        var b = els.sideButtons[i];
        var v = b.getAttribute('data-view');
        b.classList.toggle('active', v === name);
    }
    updateStatusbar();
}

for (var sb = 0; sb < els.sideButtons.length; sb++) {
    (function (btn) {
        btn.addEventListener('click', function () {
            var v = btn.getAttribute('data-view');
            if (!v) return;
            if (v === 'home') goHome();
            else if (v === 'chat' && state.currentId) showView('chat');
            else showView(v);
            document.body.classList.remove('sidebar-open');
        });
    })(els.sideButtons[sb]);
}

els.btnBurger.addEventListener('click', function () {
    document.body.classList.toggle('sidebar-open');
});
els.scrim.addEventListener('click', function () {
    composeCloseSheet();
    document.body.classList.remove('sidebar-open');
});

// ---------------------------------------------------------------------------
// Hoja de escritura (móvil): la barra de envío emerge desde abajo como modal.
// En escritorio todo queda como siempre (la hoja solo existe < 1024px).
// ---------------------------------------------------------------------------
function isMobileView() {
    return window.matchMedia('(max-width: 1023px)').matches;
}
function composeOpenSheet() {
    if (!els.sendForm || state.view !== 'chat') return;
    if (els.imgPreview && els.imgPreview.parentNode !== els.sendForm) {
        els.sendForm.insertBefore(els.imgPreview, els.slashPanel);
    }
    els.sendForm.classList.add('open');
    document.body.classList.add('compose-open');
    setTimeout(function () { try { els.input.focus(); } catch (e) {} }, 180);
}
function composeCloseSheet() {
    if (!els.sendForm) return;
    voiceStop();
    tplClose();
    els.sendForm.classList.remove('open');
    document.body.classList.remove('compose-open');
    if (els.imgPreview && els.imgPreview.parentNode === els.sendForm && els.composeOpen) {
        els.chat.insertBefore(els.imgPreview, els.composeOpen);
    }
}
if (els.composeOpen) els.composeOpen.addEventListener('click', composeOpenSheet);
var composeCloseEl = els.sendForm.querySelector('.shead');
if (composeCloseEl) composeCloseEl.addEventListener('click', composeCloseSheet);

// ---------------------------------------------------------------------------
// Sidebar: logo → inicio, ajuste de ancho y ocultar (desktop) / cerrar drawer (móvil)
// ---------------------------------------------------------------------------
function sbHidden() {
    try { return localStorage.getItem('ob_sbHidden') === '1'; } catch (e) { return false; }
}
function setSbHidden(hidden) {
    try { localStorage.setItem('ob_sbHidden', hidden ? '1' : '0'); } catch (e) {}
    document.body.classList.toggle('sb-hide', hidden);
}
function sbWidth() {
    try {
        var w = parseInt(localStorage.getItem('ob_sbW'), 10);
        if (w >= 200 && w <= 480) return w;
    } catch (e) {}
    return 264;
}
function setSbWidth(w) {
    try { localStorage.setItem('ob_sbW', String(w)); } catch (e) {}
    document.documentElement.style.setProperty('--sb-w', w + 'px');
}

if (els.brandHome) {
    els.brandHome.addEventListener('click', function (e) {
        if (e.target.closest('.sbhide')) return;
        document.body.classList.remove('sidebar-open');
        goHome();
    });
}
if (els.btnSbHide) {
    els.btnSbHide.addEventListener('click', function (e) {
        e.stopPropagation();
        if (window.innerWidth < 1024) {
            // En móvil el botón « cierra el drawer (se reabre con la burger).
            document.body.classList.remove('sidebar-open');
            return;
        }
        setSbHidden(true);
    });
}
if (els.sbReveal) {
    els.sbReveal.addEventListener('click', function () {
        setSbHidden(false);
    });
}
var sbResizer = document.getElementById('sbResizer');
if (sbResizer) {
    sbResizer.addEventListener('pointerdown', function (e) {
        if (window.innerWidth < 1024) return;
        e.preventDefault();
        sbResizer.setPointerCapture(e.pointerId);
        sbResizer.classList.add('dragging');
        document.body.style.userSelect = 'none';
        var move = function (ev) {
            setSbWidth(Math.max(200, Math.min(480, ev.clientX)));
        };
        var up = function () {
            sbResizer.classList.remove('dragging');
            document.body.style.userSelect = '';
            sbResizer.removeEventListener('pointermove', move);
            sbResizer.removeEventListener('pointerup', up);
        };
        sbResizer.addEventListener('pointermove', move);
        sbResizer.addEventListener('pointerup', up);
    });
    sbResizer.addEventListener('dblclick', function () { setSbWidth(264); });
}
if (window.innerWidth >= 1024) {
    document.body.classList.toggle('sb-hide', sbHidden());
    document.documentElement.style.setProperty('--sb-w', sbWidth() + 'px');
}

// ---------------------------------------------------------------------------
// Home: sesiones agrupadas por proyecto
// ---------------------------------------------------------------------------
function renderHome(sessions) {
    // Con varios puentes, solo se muestran las sesiones del puente activo.
    var list = filterSessions(sessions || state.sessions || []);
    state.sessions = list;
    state.sessionCount = list.length;
    var on = bridgeOnline();
    var lastTs = activeOnlineTs();
    var whoInfo = activeBridgeInfo();
    var whoLabel = (whoInfo && bridgeList().length >= 2) ? (whoInfo.name || whoInfo.id) : 'puente';
    var statusHtml;
    if (on && lastTs) {
        statusHtml = '<span class="bridge-status"><span class="dot"></span>' + esc(whoLabel) + ' en línea</span>';
    } else if (lastTs) {
        statusHtml = '<span class="bridge-status off"><span class="dot"></span>' + esc(whoLabel) + ' apagado</span>';
    } else {
        statusHtml = '<span class="bridge-status off"><span class="dot"></span>esperando puente…</span>';
    }

    var html = '<div class="hero">'
        + '<h1>sesiones</h1>'
        + '<p>' + statusHtml + ' · ' + (list.length === 1 ? '1 chat' : list.length + ' chats') + '</p>'
        + '</div>'
        + '<button class="newbtn">+ nueva sesión</button>';

    var g = groupSessions(list, '');
    if (!g.order.length) {
        html += '<div class="empty">No hay chats todavía. Creá uno para empezar.</div>';
    } else {
        var opens = loadOpenProjects();
        var flash = state.focusFlash;        // se consume una sola vez
        state.focusFlash = null;
        var firstKey = g.order[0];
        for (var i = 0; i < g.order.length; i++) {
            var key = g.order[i];
            var grp = g.groups[key];
            var label = grp.label || '(sin proyecto)';
            var hasStored = !!(opens && Object.prototype.hasOwnProperty.call(opens, key));
            var containsCur = false;
            for (var cc = 0; cc < grp.sessions.length; cc++) {
                if (grp.sessions[cc].id === state.currentId) { containsCur = true; break; }
            }
            var open = hasStored ? !!opens[key]
                : (containsCur || key === firstKey || key === flash || key === state.focusFolder);
            var act = groupActivity(grp.sessions);
            var actHtml = act === 'working' ? '<span class="sbusy" title="trabajando ahora…"></span> '
                : (act === 'waiting' ? '<span class="sdot" title="esperando respuesta"></span> ' : '');
            var total = grp.sessions.length;
            var shown = Math.min(total, 4);
            var hidden = total - shown;
            html += '<div class="projsec' + (open ? ' open' : '') + '" data-folder="' + esc(key) + '">'
                + '<button type="button" class="pshead" data-folder="' + esc(key) + '" title="' + (open ? 'Contraer' : 'Expandir') + '">'
                + '<span class="chev">' + (open ? '▾' : '▸') + '</span>'
                + '<span class="psname">' + esc(label) + '</span>'
                + actHtml
                + '<span class="pscount">' + total + (total === 1 ? ' sesión' : ' sesiones') + '</span>'
                + '</button>'
                + '<div class="pbody">'
                + '<div class="cards">';
            for (var j = 0; j < shown; j++) {
                var s = grp.sessions[j];
                var prev = s.preview ? esc(s.preview) : 'Sin mensajes aún';
                var busy = s.state === 'working'
                    ? '<span class="sbusy" title="trabajando ahora…"></span> '
                    : (s.state === 'waiting' ? '<span style="color:var(--mine)">●</span> ' : '');
                html += '<div class="card" data-sid="' + s.id + '">'
                    + '<div class="grow">'
                    + '<div class="cname">' + esc(s.name) + '</div>'
                    + '<div class="cmeta">' + busy + esc(s.model || 'sin modelo') + ' · ' + esc(s.agent || 'build') + '</div>'
                    + (s.preview ? '<div class="cpreview">' + prev + '</div>' : '')
                    + '</div>'
                    + (isAdmin() ? '<button type="button" class="kebab" aria-label="Opciones" title="Opciones">⋮</button>' : '')
                    + '</div>';
            }
            html += '</div>';
            html += '<div class="histrow">'
                + '<button type="button" class="histbtn" data-folder="' + esc(key) + '">'
                + (hidden > 0 ? 'ver historial · ' + hidden + ' más' : 'ver historial')
                + '</button>'
                + '<button type="button" class="histbtn filesbtn" data-folder="' + esc(key) + '" title="Archivos del proyecto">ver archivos</button>'
                + '</div>';
            html += '</div></div>';
        }
    }
    els.home.innerHTML = html;

    // Resaltar y llevar al proyecto pedido desde el sidebar (una sola vez).
    if (flash) {
        var secs = els.home.querySelectorAll('.projsec');
        for (var s2 = 0; s2 < secs.length; s2++) {
            if (secs[s2].getAttribute('data-folder') === flash) {
                secs[s2].classList.add('flash');
                try { secs[s2].scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e) {}
                setTimeout(function (el) {
                    if (el) el.classList.remove('flash');
                }, 1600, secs[s2]);
                break;
            }
        }
    }

    var cards = els.home.querySelectorAll('.card');
    for (var a = 0; a < cards.length; a++) {
        (function (card) {
            card.addEventListener('click', function (e) {
                if (e.target.closest('.kebab')) return;
                openChat(parseInt(card.dataset.sid, 10));
            });
        })(cards[a]);
    }

    renderSidebar();
    state.subtitle = list.length === 1 ? '1 chat' : list.length + ' chats';
    if (state.view === 'home') els.hSub.textContent = state.subtitle;
    updateStatusbar();
}

async function loadSessions() {
    var data = await api('api.php?action=sessions');
    if (data.ok) {
        lsSet('ob_sessions', data.sessions || []);
        renderHome(data.sessions || []);
    } else if (!state.sessions.length) {
        els.home.innerHTML = '<div class="empty">Sin conexión</div>';
    }
}

// ---------------------------------------------------------------------------
// Render de contenido: markdown ligero (negritas, cursiva, tachado, código,
// listas, encabezados, citas, separadores, enlaces) + fences de código.
// ---------------------------------------------------------------------------
// Inline: code spans primero; luego bold/italic/strike/enlaces sobre lo demás.
function mdInline(raw) {
    var out = '';
    var parts = String(raw).split(/`([^`\n]+)`/g); // impares = código
    for (var i = 0; i < parts.length; i++) {
        if (i % 2 === 1) {
            out += '<code class="inl">' + esc(parts[i]) + '</code>';
            continue;
        }
        var s = esc(parts[i]);
        s = s.replace(/\*\*([^*\n][^*\n]*?)\*\*/g, '<strong>$1</strong>');
        s = s.replace(/(^|[\s(>.,;:!?¡¿"“])\*([^*\s][^*\n]*?)\*(?=$|[\s).,;:!?<>"”])/g, '$1<em>$2</em>');
        s = s.replace(/(^|[\s(>.,;:!?¡¿"“])_([^_\s][^_\n]*?)_(?=$|[\s).,;:!?<>"”])/g, '$1<em>$2</em>');
        s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
        s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)<>"']+)\)/g, function (m, t, u) {
            return '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + t + '</a>';
        });
        out += s;
    }
    return out;
}

// Bloques: encabezados, separadores, citas, listas y párrafos (línea = <br>,
// para respetar el corte de línea del output del CLI).
function mdBlocks(raw) {
    var lines = String(raw).replace(/\r\n?/g, '\n').split('\n');
    var html = '';
    var para = [];
    var list = null;
    function flushPara() {
        if (!para.length) return;
        html += '<div class="md-p">' + para.map(mdInline).join('<br>') + '</div>';
        para = [];
    }
    function flushList() {
        if (!list) return;
        html += '</' + list + '>';
        list = null;
    }
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var t = line.trim();
        if (t === '') { flushPara(); flushList(); continue; }
        var h = t.match(/^(#{1,4})\s+(.*)$/);
        if (h) { flushPara(); flushList(); html += '<div class="md-h md-h' + h[1].length + '">' + mdInline(h[2]) + '</div>'; continue; }
        if (/^([-*_])\1{2,}$/.test(t)) { flushPara(); flushList(); html += '<hr class="md-hr">'; continue; }
        var q = line.match(/^\s*>\s?(.*)$/);
        if (q) { flushPara(); flushList(); html += '<div class="md-quote">' + mdInline(q[1]) + '</div>'; continue; }
        var ul = line.match(/^\s*[-*+]\s+(.*)$/);
        if (ul) {
            flushPara();
            if (list !== 'ul') { flushList(); html += '<ul class="md-ul">'; list = 'ul'; }
            html += '<li>' + mdInline(ul[1]) + '</li>';
            continue;
        }
        var ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
        if (ol) {
            flushPara();
            if (list !== 'ol') { flushList(); html += '<ol class="md-ol">'; list = 'ol'; }
            html += '<li>' + mdInline(ol[1]) + '</li>';
            continue;
        }
        flushList();
        para.push(line);
    }
    flushPara();
    flushList();
    return html;
}

// Resalta la búsqueda sobre nodos de texto (DOM), sin tocar las etiquetas.
function highlightDom(html, query) {
    var q = String(query || '').trim().toLowerCase();
    if (!q) return html;
    var tmp = document.createElement('div');
    tmp.innerHTML = html;
    var walker = document.createTreeWalker(tmp, NodeFilter.SHOW_TEXT, null);
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        var text = node.nodeValue;
        var low = text.toLowerCase();
        if (low.indexOf(q) < 0) continue;
        var frag = document.createDocumentFragment();
        var pos = 0;
        var idx = low.indexOf(q);
        while (idx >= 0) {
            if (idx > pos) frag.appendChild(document.createTextNode(text.slice(pos, idx)));
            var mark = document.createElement('mark');
            mark.textContent = text.substr(idx, q.length);
            frag.appendChild(mark);
            pos = idx + q.length;
            idx = low.indexOf(q, pos);
        }
        if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
        node.parentNode.replaceChild(frag, node);
    }
    return tmp.innerHTML;
}

// ---------------------------------------------------------------------------
// Resaltado de sintaxis ligero (sin dependencias): reglas sticky por familia
// de lenguajes, aplicadas en un solo pase. Colores vía tokens --hl-* del tema.
// ---------------------------------------------------------------------------
var HL_RULES = {
    js: [
        { re: /\/\*[\s\S]*?(?:\*\/|$)/y, cls: 'cm' },
        { re: /\/\/[^\n]*/y, cls: 'cm' },
        { re: /"(?:\\.|[^"\\\n])*"?/y, cls: 'st' },
        { re: /'(?:\\.|[^'\\\n])*'?/y, cls: 'st' },
        { re: /`(?:\\.|[^`\\])*`?/y, cls: 'st' },
        { re: /\b0x[0-9a-fA-F]+\b|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y, cls: 'nu' },
        { re: /\b(?:if|else|for|while|do|switch|case|default|break|continue|return|try|catch|finally|throw|await|yield|new|delete|typeof|instanceof|in|of|void)\b/y, cls: 'k2' },
        { re: /\b(?:var|let|const|function|class|extends|super|this|static|get|set|async|import|export|from|as|true|false|null|undefined|NaN)\b/y, cls: 'kw' },
        { re: /\b[A-Za-z_$][\w$]*(?=\s*\()/y, cls: 'fn' },
        { re: /\b[A-Z][\w$]*\b/y, cls: 'ty' }
    ],
    py: [
        { re: /"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)/y, cls: 'st' },
        { re: /#[^\n]*/y, cls: 'cm' },
        { re: /"(?:\\.|[^"\\\n])*"?/y, cls: 'st' },
        { re: /'(?:\\.|[^'\\\n])*'?/y, cls: 'st' },
        { re: /\b0x[0-9a-fA-F]+\b|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y, cls: 'nu' },
        { re: /\b(?:if|elif|else|for|while|return|break|continue|pass|raise|try|except|finally|with|as|in|is|not|and|or|assert|del|yield|await|async|match|case)\b/y, cls: 'k2' },
        { re: /\b(?:def|class|lambda|import|from|global|nonlocal|True|False|None)\b/y, cls: 'kw' },
        { re: /\bself\b|\bcls\b/y, cls: 'pr' },
        { re: /\b[A-Za-z_]\w*(?=\s*\()/y, cls: 'fn' },
        { re: /\b[A-Z]\w*\b/y, cls: 'ty' }
    ],
    clike: [
        { re: /\/\*[\s\S]*?(?:\*\/|$)/y, cls: 'cm' },
        { re: /\/\/[^\n]*/y, cls: 'cm' },
        { re: /"(?:\\.|[^"\\\n])*"?/y, cls: 'st' },
        { re: /'(?:\\.|[^'\\\n])*'?/y, cls: 'st' },
        { re: /\b0x[0-9a-fA-F]+\b|\b\d[\d_]*(?:\.\d+)?(?:[uUlLfF]+)?\b/y, cls: 'nu' },
        { re: /\b(?:if|else|for|while|do|switch|case|default|break|continue|return|goto|try|catch|throw|new|delete|defer|go|range|select|fallthrough|match)\b/y, cls: 'k2' },
        { re: /\b(?:function|func|fn|class|struct|interface|enum|union|type|typedef|const|static|final|abstract|public|private|protected|virtual|override|namespace|using|template|typename|operator|sizeof|package|import|use|mod|pub|impl|trait|var|let|mut|void|int|char|float|double|long|short|bool|byte|uint|string|true|false|null|nullptr|NULL|nil|this|self)\b/y, cls: 'kw' },
        { re: /\b[A-Za-z_]\w*(?=\s*\()/y, cls: 'fn' },
        { re: /\b[A-Z]\w*\b/y, cls: 'ty' }
    ],
    sh: [
        { re: /#[^\n]*/y, cls: 'cm' },
        { re: /"(?:\\.|[^"\\])*"?/y, cls: 'st' },
        { re: /'[^']*'?/y, cls: 'st' },
        { re: /\$\{[^}\n]*\}|\$[\w]+/y, cls: 'pr' },
        { re: /\b\d+\b/y, cls: 'nu' },
        { re: /\b(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|in|function|return|export|local|declare|readonly|exit)\b/y, cls: 'kw' },
        { re: /\b[A-Za-z_][\w-]*(?=\()/y, cls: 'fn' }
    ],
    php: [
        { re: /\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*|#[^\n]*/y, cls: 'cm' },
        { re: /<\?(?:php|=)|\?>/y, cls: 'kw' },
        { re: /"(?:\\.|[^"\\])*"?/y, cls: 'st' },
        { re: /'(?:\\.|[^'\\])*'?/y, cls: 'st' },
        { re: /\$[\w]+/y, cls: 'pr' },
        { re: /\b0x[0-9a-fA-F]+\b|\b\d[\d_]*(?:\.\d+)?\b/y, cls: 'nu' },
        { re: /\b(?:if|else|elseif|for|foreach|while|do|switch|case|default|break|continue|return|try|catch|finally|throw|as|new|echo|print|yield|instanceof)\b/y, cls: 'k2' },
        { re: /\b(?:function|class|extends|implements|interface|trait|namespace|use|public|private|protected|static|final|abstract|const|var|global|true|false|null|self|parent|this)\b/y, cls: 'kw' },
        { re: /\b[A-Za-z_]\w*(?=\s*\()/y, cls: 'fn' },
        { re: /\b[A-Z]\w*\b/y, cls: 'ty' }
    ],
    html: [
        { re: /<!--[\s\S]*?(?:-->|$)/y, cls: 'cm' },
        { re: /"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?/y, cls: 'st' },
        { re: /<\/?[a-zA-Z][\w-]*|\/?>|<!DOCTYPE(?=[\s>])/iy, cls: 'kw' },
        { re: /[a-zA-Z-]+(?=\s*=)/y, cls: 'pr' }
    ],
    css: [
        { re: /\/\*[\s\S]*?(?:\*\/|$)/y, cls: 'cm' },
        { re: /"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?/y, cls: 'st' },
        { re: /@[\w-]+/y, cls: 'kw' },
        { re: /#[0-9a-fA-F]{3,8}\b/y, cls: 'nu' },
        { re: /\b\d+(?:\.\d+)?(?:px|em|rem|vh|vw|vmin|vmax|%|s|ms|deg|fr|ch|ex)?\b/y, cls: 'nu' },
        { re: /--[\w-]+|[a-zA-Z-]+(?=\s*:)/y, cls: 'pr' }
    ],
    json: [
        { re: /"(?:\\.|[^"\\])*"(?=\s*:)/y, cls: 'pr' },
        { re: /"(?:\\.|[^"\\])*"/y, cls: 'st' },
        { re: /\b-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y, cls: 'nu' },
        { re: /\b(?:true|false|null)\b/y, cls: 'kw' }
    ],
    sql: [
        { re: /--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y, cls: 'cm' },
        { re: /'(?:''|[^'])*'?/y, cls: 'st' },
        { re: /\b\d+(?:\.\d+)?\b/y, cls: 'nu' },
        { re: /\b(?:select|from|where|insert|into|values|update|set|delete|create|table|drop|alter|add|join|left|right|inner|outer|full|on|group|by|order|having|limit|offset|as|and|or|not|null|primary|key|foreign|references|default|unique|index|view|union|all|distinct|case|when|then|else|end|exists|between|like|in|asc|desc|count|sum|avg|min|max)\b/iy, cls: 'kw' }
    ],
    generic: [
        { re: /\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*|#[^\n]*/y, cls: 'cm' },
        { re: /"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?|`(?:\\.|[^`\\])*`?/y, cls: 'st' },
        { re: /\b0x[0-9a-fA-F]+\b|\b\d[\d_]*(?:\.\d+)?\b/y, cls: 'nu' },
        { re: /\b(?:if|else|for|while|return|function|class|def|import|export|from|const|var|let|new|true|false|null|nil|none|and|or|not|in|is|do|end|then|fi|case|switch|break|continue|try|catch|finally|throw|use|package|public|private|static)\b/iy, cls: 'kw' },
        { re: /\b[A-Za-z_]\w*(?=\s*\()/y, cls: 'fn' }
    ]
};

function hlKind(lang) {
    var l = String(lang || '').toLowerCase();
    if (/^(js|jsx|javascript|ts|tsx|typescript|mjs|cjs|node)$/.test(l)) return 'js';
    if (/^(py|python|python3|ipython)$/.test(l)) return 'py';
    if (/^php$/.test(l)) return 'php';
    if (/^(html|xml|svg|vue|svelte)$/.test(l)) return 'html';
    if (/^(css|scss|sass|less)$/.test(l)) return 'css';
    if (/^(json|jsonc|json5)$/.test(l)) return 'json';
    if (/^(bash|sh|shell|zsh|console|shell-session|powershell|ps1|bat|cmd)$/.test(l)) return 'sh';
    if (/^sql$/.test(l)) return 'sql';
    if (/^(c|h|cpp|c\+\+|cc|hpp|java|cs|csharp|go|golang|rust|rs|kotlin|kt|swift|dart|scala|groovy|objc|objective-c)$/.test(l)) return 'clike';
    return 'generic';
}

// En cada posición prueba las reglas en orden (sticky); lo que no casa va
// como texto plano. Bloques enormes quedan sin resaltar (tope de seguridad).
function hlCode(src, lang) {
    src = String(src || '');
    if (src.length > 60000) return esc(src);
    var rules = HL_RULES[hlKind(lang)] || HL_RULES.generic;
    var out = '';
    var plain = '';
    var pos = 0;
    var n = src.length;
    while (pos < n) {
        var hit = null;
        var cls = '';
        for (var i = 0; i < rules.length; i++) {
            var r = rules[i];
            r.re.lastIndex = pos;
            var m = r.re.exec(src);
            if (m && m[0]) { hit = m[0]; cls = r.cls; break; }
        }
        if (hit) {
            if (plain) { out += esc(plain); plain = ''; }
            out += '<span class="hl-' + cls + '">' + esc(hit) + '</span>';
            pos += hit.length;
        } else {
            plain += src[pos];
            pos++;
        }
    }
    if (plain) out += esc(plain);
    return out;
}

function renderContent(text, query) {
    var parts = String(text || '').split('```');
    var out = '';
    for (var i = 0; i < parts.length; i++) {
        if (i % 2 === 1) {
            var block = parts[i];
            var nl = block.indexOf('\n');
            var lang = '';
            var body = block;
            if (nl >= 0 && nl <= 24 && /^[A-Za-z0-9_+#.\-]*$/.test(block.slice(0, nl).trim())) {
                lang = block.slice(0, nl).trim();
                body = block.slice(nl + 1);
            }
            out += '<div class="codewrap">'
                + '<div class="codehead"><span class="lang">' + esc(lang || 'código') + '</span>'
                + '<button type="button" class="copybtn" data-copy="code" title="Copiar código">⧉ Copiar</button></div>'
                + '<pre class="codeblock">' + hlCode(body.replace(/\s+$/, ''), lang) + '</pre></div>';
        } else {
            out += mdBlocks(parts[i]);
        }
    }
    return query ? highlightDom(out, query) : out;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------
function stopProcTimer() {
    if (state.procTimer) { clearInterval(state.procTimer); state.procTimer = null; }
}

function highlightText(text, query) {
    var q = String(query || '').trim();
    if (!q) return esc(text);
    var idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx < 0) return esc(text);
    var before = esc(text.slice(0, idx));
    var match = esc(text.slice(idx, idx + q.length));
    var after = esc(text.slice(idx + q.length));
    return before + '<mark>' + match + '</mark>' + after;
}

// Bloque 💭 del razonamiento: plegado en el historial; abierto mientras genera.
function reasoningHtml(m, chatQuery) {
    if (m.role !== 'assistant' || !m.reasoning) return '';
    var open = m.status === 'streaming' ? ' open' : '';
    return '<details class="reasoning"' + open + '><summary>💭 razonamiento <span class="rsize">(' + fmtSize(m.reasoning.length) + ')</span></summary>'
        + '<div class="rbody">' + renderContent(m.reasoning, chatQuery) + '</div></details>';
}

function nearBottom() {
    var el = els.messages;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 140;
}

// Altura real de la barra inferior visible (hoja cerrada): en móvil es el
// botón que abre la hoja; además se suma la franja KITT si está abierta.
function jumpBarH() {
    var h = 10;
    var bar = (isMobileView() && els.composeOpen && els.composeOpen.classList.contains('show')) ? els.composeOpen : els.sendForm;
    if (bar) h += bar.offsetHeight;
    if (els.procrow && els.procrow.classList.contains('open')) h += els.procrow.offsetHeight;
    return h;
}

function onMsgScroll() {
    if (!els.jumpBtn || state.view !== 'chat') return;
    var nb = nearBottom();
    els.jumpBtn.classList.toggle('show', !nb);
    els.jumpBtn.style.bottom = jumpBarH() + 'px';
}

// Huella por mensaje: si cambia (llegaron tramos, se canceló, etc.) se
// reemplaza solo ese nodo; lo demás no se toca.
function msgSig(m) {
    return (m.status || '') + '|' + (m.text || '').length + '|' + (m.reasoning || '').length
        + '|' + (m.canceled ? 1 : 0) + '|' + (m.agent || '') + '|' + (m.author || '') + '|' + (m.img ? m.img.length : 0);
}

function msgNodeHtml(m, chatQuery) {
    var cls = m.role === 'user' ? 'mine' : 'theirs';
    if (m.status === 'canceled') cls += ' canceled';
    var who = m.role === 'user' ? '❯ ' + esc(m.author || 'vos') : '● Agente';
    if (m.agent === 'plan') cls += ' plan';
    var agentBadge = m.agent ? ' <span class="abadge ' + esc(m.agent) + '">' + esc(m.agent) + '</span>' : '';
    var stopBadge = m.canceled ? ' <span class="stopbadge">⏹ detenido</span>' : '';
    var streaming = m.role === 'assistant' && m.status === 'streaming';
    var hit = chatQuery && (m.text || '').toLowerCase().indexOf(chatQuery.toLowerCase()) >= 0;
    return '<div class="msg ' + cls + (hit ? ' hit' : '') + '" data-mid="' + (m.id || '') + '" data-sig="' + esc(msgSig(m)) + '">'
        + '<div class="role"><span class="who">' + who + '</span>' + agentBadge + stopBadge
        + (streaming ? '<span class="genbadge">generando…</span>' : '')
        + '<span class="rmeta" title="' + esc(timeStr(m.ts)) + '">' + esc(timeOnly(m.ts)) + '</span>'
        + '<button type="button" class="copybtn" data-copy="msg" title="Copiar mensaje">⧉</button></div>'
        + '<div class="body">' + (m.img ? '<img class="msg-img" src="' + esc(m.img) + '" alt="imagen adjunta">' : '')
        + reasoningHtml(m, chatQuery) + renderContent(m.text || '', chatQuery)
        + (streaming ? '<span class="stream-cursor">▊</span>' : '')
        + '</div>'
        + '</div>';
}

function daySepHtml(iso) {
    return '<div class="daysep"><span>' + esc(dayLabel(iso)) + '</span></div>';
}

// Agrega al DOM solo los mensajes nuevos y reemplaza los que cambiaron.
// Devuelve la cantidad de nodos agregados.
function syncMessages(msgs, chatQuery) {
    var added = 0;
    var cont = els.messages;
    for (var i = 0; i < msgs.length; i++) {
        var m = msgs[i];
        var existing = cont.querySelector('.msg[data-mid="' + m.id + '"]');
        if (existing) {
            var sig = String(msgSig(m));
            if (existing.getAttribute('data-sig') !== sig) {
                var repl = document.createElement('div');
                repl.innerHTML = msgNodeHtml(m, chatQuery);
                existing.parentNode.replaceChild(repl.firstChild, existing);
            }
            continue;
        }
        var k = dayKey(m.ts);
        if (k !== state.lastDay) {
            var sep = document.createElement('div');
            sep.innerHTML = daySepHtml(m.ts);
            cont.appendChild(sep.firstChild);
        }
        state.lastDay = k;
        var wrap = document.createElement('div');
        wrap.innerHTML = msgNodeHtml(m, chatQuery);
        cont.appendChild(wrap.firstChild);
        added++;
    }
    return added;
}

// Franja "opencode trabajando…" (barra KITT) fija sobre la barra de envío, con botón detener.
function updateProcRow(msgs) {
    var row = els.procrow;
    if (!row) return;
    var lastUser = null;
    for (var wi = msgs.length - 1; wi >= 0; wi--) {
        if (msgs[wi].role === 'user') { lastUser = msgs[wi]; break; }
    }
    var waiting = !!lastUser && lastUser.status !== 'done' && lastUser.status !== 'error' && lastUser.status !== 'canceled';
    if (!waiting) {
        stopProcTimer();
        row.classList.remove('open');
        if (els.jumpBtn && els.jumpBtn.classList.contains('show')) els.jumpBtn.style.bottom = jumpBarH() + 'px';
        return;
    }
    var since = (new Date(lastUser.ts)).getTime();
    if (!isFinite(since)) since = Date.now();
    state.procSince = since;
    if (!row.classList.contains('open')) {
        var btn = document.getElementById('btnStop');
        if (btn) {
            btn.disabled = false;
            var tx = btn.querySelector('.stoptxt');
            if (tx) tx.textContent = 'detener';
        }
        row.classList.add('open');
        if (els.jumpBtn && els.jumpBtn.classList.contains('show')) els.jumpBtn.style.bottom = jumpBarH() + 'px';
    }
    if (!state.procTimer) {
        var tick = function () {
            var ind = document.getElementById('proc-ind');
            if (!ind) { stopProcTimer(); return; }
            var sec = Math.round((Date.now() - state.procSince) / 1000);
            var warn = sec >= 240;
            ind.className = 'typing proc' + (state.online ? '' : ' pause') + (warn ? ' warn' : '');
            row.classList.toggle('warn', warn);
            var lbl = document.getElementById('proc-label');
            if (lbl) {
                var txt = state.online ? (isMobileView() ? 'trabajando...' : 'opencode está trabajando...') : 'esperando el puente...';
                var tokTxt = sessionTokensLabel(state.currentSession || {});
                lbl.textContent = (warn ? '⚠ ' : '') + txt + (tokTxt ? ' · ' + tokTxt + ' tok' : '');
            }
            var tm = document.getElementById('proc-time');
            if (tm) tm.textContent = sec + 's';
        };
        tick();
        state.procTimer = setInterval(tick, 1000);
    }
}
if (els.procrow) document.getElementById('btnStop').addEventListener('click', cancelCurrentRun);

function renderChat(session, messages) {
    // Un chat abierto desde otra vista (búsqueda global, link directo) puede
    // pertenecer a otra PC: se pasa al puente dueño para ver su catálogo.
    var owner = session ? (session.bridge || '') : '';
    if (owner && owner !== activeBridgeId() && bridgeList().length > 1) {
        state.activeBridge = owner;
        storeBridge(owner);
        state.catalog = null;
        state.catVer = '';
        renderBridgeBar();
        refreshBridgeData();
    }
    state.messages = messages || [];
    if (session) {
        state.currentSession = session;
        if (session.folder) state.lastFolder = session.folder;
        els.hTitle.textContent = session.name || 'chat';
        els.hSub.textContent = sessionSubtitle(session);
    }
    var msgs = state.messages;
    var chatQuery = (state.chatSearch && state.chatSearch.query) || '';
    // Render completo solo al cambiar de chat o al buscar; el resto es incremental.
    var full = !!chatQuery || state.renderSid !== state.currentId;
    state.renderSid = state.currentId;
    var autoScroll = nearBottom();
    var addedCount = 0;

    if (full) {
        var html = '';
        var prevDay = '';
        for (var i = 0; i < msgs.length; i++) {
            var k = dayKey(msgs[i].ts);
            if (k !== prevDay) { html += daySepHtml(msgs[i].ts); prevDay = k; }
            html += msgNodeHtml(msgs[i], chatQuery);
        }
        els.messages.innerHTML = html || '<div class="empty">Sin mensajes. Escribí algo.</div>';
        state.lastDay = prevDay;
    } else {
        addedCount = syncMessages(msgs, chatQuery);
    }
    updateProcRow(msgs);

    if (full) {
        els.messages.scrollTop = els.messages.scrollHeight;
        if (els.jumpBtn) els.jumpBtn.classList.remove('show');
        if (chatQuery && state.chatSearch.firstHit) {
            var first = els.messages.querySelector('.msg.hit');
            if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
    } else if (autoScroll) {
        els.messages.scrollTop = els.messages.scrollHeight;
    } else if (addedCount > 0 && els.jumpBtn) {
        els.jumpBtn.classList.add('show');
        els.jumpBtn.style.bottom = jumpBarH() + 'px';
    }
    renderSidebar();
    updateStatusbar();
}

// Copiar mensajes y bloques de código (delegado, sobrevive a los re-renders).
els.messages.addEventListener('click', function (e) {
    var btn = e.target.closest('.copybtn');
    if (!btn) return;
    var kind = btn.getAttribute('data-copy');
    if (kind === 'code') {
        var wrapEl = btn.closest('.codewrap');
        var pre = wrapEl ? wrapEl.querySelector('pre.codeblock') : null;
        if (pre) copyText(pre.textContent, 'código copiado');
        return;
    }
    var msgEl = btn.closest('.msg');
    if (!msgEl) return;
    var mid = parseInt(msgEl.getAttribute('data-mid'), 10);
    for (var i = 0; i < state.messages.length; i++) {
        if (state.messages[i].id === mid) {
            var extra = state.messages[i].img ? '\n[imagen adjunta]' : '';
            copyText((state.messages[i].text || '') + extra, 'mensaje copiado');
            return;
        }
    }
});

if (els.jumpBtn) {
    els.jumpBtn.addEventListener('click', function () {
        try { els.messages.scrollTo({ top: els.messages.scrollHeight, behavior: 'smooth' }); }
        catch (e) { els.messages.scrollTop = els.messages.scrollHeight; }
    });
}

// Refresco incremental: pide solo mensajes nuevos/cambiados (history?since=).
// Con incremental=false (cambio de chat) trae el historial completo.
async function loadHistory(sid, incremental) {
    var url = 'api.php?action=history&session=' + sid;
    var lastKnown = (!incremental || !state.messages.length) ? null
        : state.messages[state.messages.length - 1];
    if (lastKnown) {
        url += '&since=' + lastKnown.id + '&ts=' + encodeURIComponent(lastKnown.ts || '');
    }
    var data = await api(url);
    if (!data.ok) {
        toast('error al cargar el historial', 'error');
        return;
    }
    var msgs = data.messages || [];
    if (lastKnown) {
        var byId = {};
        for (var i = 0; i < state.messages.length; i++) byId[state.messages[i].id] = i;
        for (var j = 0; j < msgs.length; j++) {
            var u = msgs[j];
            if (byId[u.id] !== undefined) state.messages[byId[u.id]] = u;
            else { byId[u.id] = state.messages.length; state.messages.push(u); }
        }
        msgs = state.messages;
    }
    renderChat(data.session, msgs);
}

function openChat(id) {
    state.currentId = id;
    state.chatSearch = { query: '', firstHit: false };
    if (state.view !== 'chat') state.prevView = state.view;
    showView('chat');
    els.messages.innerHTML = '<div class="empty">cargando…</div>';
    loadHistory(id);
    try { history.replaceState(null, '', 'chat.php?session=' + id); } catch (e) {}
}

function goBack() {
    if (state.prevView === 'history' && state.histFolder !== null) {
        openHistory(state.histFolder);
    } else {
        goHome();
    }
}

function goHome() {
    state.currentId = null;
    state.currentSession = null;
    state.chatSearch = null;
    showView('home');
    loadSessions();
}

// Sidebar: tocá un proyecto → lo expande y resalta en la vista de chats.
function focusProject(folder) {
    state.focusFolder = folder;
    state.focusFlash = folder;
    setProjectOpen(folder, true);
    if (state.view === 'home' && state.sessions.length) {
        renderHome(state.sessions);
        renderSidebar();
    } else {
        showView('home');
        loadSessions();
    }
}

// Convierte la carpeta absoluta de un proyecto en ruta relativa al workspace
// (para la vista de archivos). '' si no se puede derivar (usa la raiz).
function folderToFilesPath(folder) {
    var ws = state.catalog && state.catalog.workspace ? state.catalog.workspace : '';
    if (!folder || !ws) return '';
    var norm = function (p) { return String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase(); };
    var nws = norm(ws), nf = norm(folder);
    if (nf === nws || nf.indexOf(nws + '/') !== 0) return '';
    var raw = String(folder).replace(/\\/g, '/').replace(/\/+$/, '');
    var rawWs = String(ws).replace(/\\/g, '/').replace(/\/+$/, '');
    return raw.slice(rawWs.length + 1);
}

// Historial de un proyecto: vista aparte con buscador dentro del proyecto.
function openHistory(folder) {
    state.histFolder = folder;
    state.histLabel = projectLabel(folder) || '(sin proyecto)';
    state.histQuery = '';
    showView('history');
}

function histFilteredSessions() {
    var f = state.histFolder;
    var q = String(state.histQuery || '').trim().toLowerCase();
    var out = [];
    for (var i = 0; i < state.sessions.length; i++) {
        var s = state.sessions[i];
        if (s.folder !== f) continue;
        if (q) {
            var hay = ((s.name || '') + ' ' + (s.preview || '') + ' ' + (s.model || '')).toLowerCase();
            if (hay.indexOf(q) < 0) continue;
        }
        out.push(s);
    }
    return out;
}

function renderHistory() {
    if (!els.viewHistory) return;
    if (state.histFolder === null) {
        els.viewHistory.innerHTML = '<div class="placeholder">Elegí un proyecto desde el sidebar.</div>';
        return;
    }
    var label = state.histLabel || projectLabel(state.histFolder) || '(sin proyecto)';
    els.viewHistory.innerHTML =
        '<div class="view-head"><h2>historial · ' + esc(label) + '</h2></div>'
        + '<div class="files-toolbar">'
        + '<div class="search-bar" style="flex:1;margin:0">'
        + '<span>🔍</span>'
        + '<input type="text" id="histInput" placeholder="buscar en este proyecto…" autocomplete="off" value="' + esc(state.histQuery) + '">'
        + '</div>'
        + '</div>'
        + '<div id="histList"></div>';
    var input = document.getElementById('histInput');
    if (input) {
        input.addEventListener('input', function () {
            state.histQuery = input.value;
            renderHistList();
        });
    }
    renderHistList();
}

function renderHistList() {
    var box = document.getElementById('histList');
    if (!box) return;
    var list = histFilteredSessions();
    var totalInProj = 0;
    for (var i = 0; i < state.sessions.length; i++) {
        if (state.sessions[i].folder === state.histFolder) totalInProj++;
    }
    var html = '<div class="search-summary">' + list.length + ' de ' + totalInProj + ' sesión(es)</div>';
    if (!list.length) {
        html += '<div class="placeholder">Sin coincidencias en este proyecto.</div>';
        box.innerHTML = html;
        return;
    }
    html += '<div class="cards">';
    for (var j = 0; j < list.length; j++) {
        var s = list[j];
        var busy = s.state === 'working'
            ? '<span class="sbusy" title="trabajando ahora…"></span> '
            : (s.state === 'waiting' ? '<span style="color:var(--mine)">●</span> ' : '');
        html += '<div class="card" data-sid="' + s.id + '">'
            + '<div class="grow">'
            + '<div class="cname">' + esc(s.name) + '</div>'
            + '<div class="cmeta">' + busy + esc(s.model || 'sin modelo') + ' · ' + esc(s.agent || 'build') + ' · ' + esc(timeShort(s.last_ts)) + '</div>'
            + (s.preview ? '<div class="cpreview">' + esc(s.preview) + '</div>' : '')
            + '</div>'
            + '</div>';
    }
    html += '</div>';
    box.innerHTML = html;
    var cards = box.querySelectorAll('.card');
    for (var c = 0; c < cards.length; c++) {
        (function (card) {
            card.addEventListener('click', function () {
                openChat(parseInt(card.getAttribute('data-sid'), 10));
            });
        })(cards[c]);
    }
}

// ---------------------------------------------------------------------------
// Modal nueva sesión
// ---------------------------------------------------------------------------
function applyCatalogPayload(data) {
    if (!data || !data.ok) return false;
    var changed = false;
    if (data.catalog) {
        // Puede llegar un catálogo de otro puente (SSE): se ignora.
        if (data.bridge !== undefined && data.bridge !== activeBridgeId()) {
            if (Array.isArray(data.bridges)) applyBridges(data.bridges);
            return false;
        }
        state.catalog = data.catalog;
        if (data.cat_ver) state.catVer = data.cat_ver;
        lsSet(catalogKey(), state.catalog);
        lsSet(catalogVerKey(), state.catVer);
        fillSelects();
        changed = true;
    } else if (data.cat_ver) {
        state.catVer = data.cat_ver;
    }
    if (Array.isArray(data.bridges)) applyBridges(data.bridges);
    if (data.online_ts && state.catalog) {
        state.catalog.last_online_ts = data.online_ts;
    }
    applyOnlineUI();
    return changed;
}

// Descarga el catálogo del puente activo (condicionado por versión).
async function refreshActiveCatalog() {
    var data = await api('api.php?action=catalog&v=' + encodeURIComponent(state.catVer || ''));
    if (data.ok) applyCatalogPayload(data);
}

// El catálogo se mantiene fresco por bootstrap/SSE/poll; esta función ya no
// re-descarga en cada modal, solo garantiza que exista.
async function loadCatalog() {
    if (!state.catalog) {
        var data = await api('api.php?action=catalog');
        applyCatalogPayload(data);
    }
    updateStatusbar();
}

// ---------------------------------------------------------------------------
// Selects de modelos: favoritos (config del puente) + catálogo completo
// agrupado por proveedor, con buscador opcional.
// ---------------------------------------------------------------------------
function selectHasValue(select, val) {
    var opts = select.options;
    for (var i = 0; i < opts.length; i++) {
        if (opts[i].value === val) return true;
    }
    return false;
}

function fillModelOptions(select, searchInput, current, onResult) {
    if (!select) return 0;
    var c = state.catalog || {};
    var favs = Array.isArray(c.models) ? c.models.slice() : [];
    var groups = (c.models_full && typeof c.models_full === 'object') ? c.models_full : {};
    var vision = Array.isArray(c.vision) ? c.vision : [];
    var q = searchInput ? String(searchInput.value || '').trim().toLowerCase() : '';
    function matches(id) { return !q || id.toLowerCase().indexOf(q) >= 0; }
    function addGroup(label, ids, prefix) {
        var og = document.createElement('optgroup');
        og.label = label;
        for (var i = 0; i < ids.length; i++) {
            var id = ids[i];
            var o = document.createElement('option');
            o.value = id;
            o.textContent = (vision.indexOf(id) >= 0 ? '👁 ' : '')
                + (prefix && id.indexOf(prefix + '/') === 0 ? id.slice(prefix.length + 1) : id);
            og.appendChild(o);
        }
        select.appendChild(og);
    }
    select.innerHTML = '';
    var total = 0;
    var fvis = favs.filter(matches);
    if (fvis.length) { addGroup('favoritos', fvis, null); total += fvis.length; }
    var provs = Object.keys(groups).sort(function (a, b) { return a.localeCompare(b); });
    for (var i = 0; i < provs.length; i++) {
        var p = provs[i];
        var list = (Array.isArray(groups[p]) ? groups[p] : []).filter(matches);
        if (!list.length) continue;
        addGroup(p + ' (' + list.length + ')', list, p);
        total += list.length;
    }
    // El modelo actual puede no estar en la lista (ej. favorito quitado del config).
    if (current && favs.indexOf(current) < 0 && !selectHasValue(select, current)) {
        addGroup('actual', [current], null);
        total += 1;
    }
    if (current && selectHasValue(select, current)) {
        select.value = current;
    }
    if (select.selectedIndex < 0 && select.options.length) {
        select.selectedIndex = 0;
    }
    if (onResult) onResult(total, q);
    return total;
}

function fillSelects() {
    var c = state.catalog || { folders: [], models: [], agents: [] };
    var folders = c.folders || [];
    var agents = c.agents && c.agents.length ? c.agents : ['build', 'plan'];

    var prevValue = els.fFolder.value;
    els.fFolder.innerHTML = '';
    for (var i = 0; i < folders.length; i++) {
        var fo = document.createElement('option');
        fo.value = folders[i].path;
        fo.textContent = folders[i].name;
        els.fFolder.appendChild(fo);
    }

    var modelCount = fillModelOptions(els.fModel, els.fModelSearch, els.fModel.value, null);
    if (els.fModelSearch) {
        els.fModelSearch.oninput = function () {
            fillModelOptions(els.fModel, els.fModelSearch, els.fModel.value, null);
        };
    }

    els.fAgent.innerHTML = '';
    for (var k = 0; k < agents.length; k++) {
        var ao = document.createElement('option');
        ao.value = agents[k];
        ao.textContent = agents[k] === 'plan' ? 'Plan (solo analiza)'
            : agents[k] === 'build' ? 'Build (construye y edita)'
            : agents[k];
        els.fAgent.appendChild(ao);
    }

    // Preselección: carpeta del último chat activo si sigue disponible.
    if (state.lastFolder) {
        var found = false;
        for (var x = 0; x < els.fFolder.options.length; x++) {
            if (els.fFolder.options[x].value === state.lastFolder) { found = true; break; }
        }
        if (found) els.fFolder.value = state.lastFolder;
    } else if (prevValue) {
        els.fFolder.value = prevValue;
    }

    els.fFolderCreate.style.display = c.allow_create_folders && c.workspace ? '' : 'none';
    els.fNewFolderMsg.textContent = '';

    var ready = folders.length > 0 && modelCount > 0 && agents.length > 0;
    els.fWarn.style.display = ready ? 'none' : '';
    els.btnSave.disabled = !ready;
}

function openModal(preselectFolder) {
    loadCatalog().then(function () {
        els.overlay.classList.add('show');
        els.fMsg.value = '';
        els.fNewFolder.value = '';
        els.fNewFolderMsg.textContent = '';
        if (preselectFolder) {
            for (var i = 0; i < els.fFolder.options.length; i++) {
                if (els.fFolder.options[i].value === preselectFolder) {
                    els.fFolder.value = preselectFolder;
                    break;
                }
            }
        }
        // Carpeta y modelo suelen venir preseleccionados: el foco va al mensaje.
        try { els.fMsg.focus(); } catch (e) {}
    });
}

function closeModal() {
    els.overlay.classList.remove('show');
}

els.btnNewSession.addEventListener('click', function () {
    document.body.classList.remove('sidebar-open');
    openModal();
});

if (els.fabNew) {
    els.fabNew.addEventListener('click', openModal);
}

els.btnCancel.addEventListener('click', closeModal);
els.overlay.addEventListener('click', function (e) { if (e.target === els.overlay) closeModal(); });

els.btnSave.addEventListener('click', async function () {
    var folder = els.fFolder.value;
    var model = els.fModel.value;
    var agent = els.fAgent.value;
    if (!folder || !model || !agent) return;
    var first = els.fMsg.value.trim();
    els.btnSave.disabled = true;
    try {
        // El nombre lo pone el auto-título con el primer mensaje (o "Chat N").
        var data = await api('api.php?action=session_create', apiCsrf('POST', { folder: folder, model: model, agent: agent }));
        if (data.ok) {
            state.lastFolder = folder;
            closeModal();
            openChat(data.session.id);
            loadSessions();
            if (first) {
                els.input.value = first;
                autoGrow();
                els.sendForm.dispatchEvent(new Event('submit', { cancelable: true }));
            }
        } else {
            toast(data.error || 'no se pudo crear la sesión', 'error');
        }
    } finally {
        els.btnSave.disabled = false;
    }
});

// Enter en el mensaje = crear (shift+enter = salto de línea).
els.fMsg.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!els.btnSave.disabled) els.btnSave.click();
    }
});

els.btnNewFolder.addEventListener('click', async function () {
    var name = els.fNewFolder.value.trim();
    if (!name) return;
    els.fNewFolderMsg.textContent = 'enviando solicitud…';
    els.btnNewFolder.disabled = true;
    var data = await api('api.php?action=request_folder', apiCsrf('POST', { name: name }));
    if (!data.ok) {
        els.fNewFolderMsg.textContent = data.error || 'error';
        els.btnNewFolder.disabled = false;
        return;
    }
    els.fNewFolderMsg.textContent = 'creando carpeta „' + name + '“…';
    var tries = 0;
    var timer = setInterval(async function () {
        tries++;
        var cat = await api('api.php?action=catalog&v=' + encodeURIComponent(state.catVer || ''));
        if (cat.ok) {
            applyCatalogPayload(cat);
        }
        var found = null;
        var list = (state.catalog && state.catalog.folders) || [];
        for (var i = 0; i < list.length; i++) {
            if (list[i].name === name || list[i].path.indexOf(name) >= 0) { found = list[i]; break; }
        }
        if (found) {
            clearInterval(timer);
            els.fNewFolderMsg.textContent = '';
            els.btnNewFolder.disabled = false;
            state.lastFolder = found.path;
            fillSelects();
            els.fFolder.value = found.path;
        } else if (tries > 15) {
            clearInterval(timer);
            els.btnNewFolder.disabled = false;
            els.fNewFolderMsg.textContent = 'tardó demasiado. ¿Está el puente iniciado?';
        } else {
            els.fNewFolderMsg.textContent = 'creando carpeta „' + name + '“… (intento ' + tries + ')';
        }
    }, 2000);
});

// ---------------------------------------------------------------------------
// Cambiar modelo / agente del chat activo
// ---------------------------------------------------------------------------
function fillModelModal(c) {
    var cur = state.currentSession || {};
    var agents = (c && c.agents && c.agents.length) ? c.agents : ['build', 'plan'];
    var fill = function () {
        var keep = els.fModel2.value || cur.model || '';
        fillModelOptions(els.fModel2, els.mSearch, keep, function (total, q) {
            if (!total) {
                els.mWarn.textContent = q ? 'sin coincidencias para “' + q + '”.' : 'el puente aún no sincronizó modelos.';
                els.mWarn.style.display = '';
            } else {
                els.mWarn.style.display = 'none';
            }
            els.btnModelSave.disabled = !total;
        });
    };
    fill();
    if (els.mSearch) {
        els.mSearch.value = '';
        els.mSearch.oninput = fill;
    }
    els.fAgent2.innerHTML = '';
    for (var j = 0; j < agents.length; j++) {
        var ao = document.createElement('option');
        ao.value = agents[j];
        ao.textContent = agents[j] === 'plan' ? 'Plan (solo analiza)'
            : agents[j] === 'build' ? 'Build (construye y edita)'
            : agents[j];
        els.fAgent2.appendChild(ao);
    }
    if (cur.agent) {
        for (var y = 0; y < els.fAgent2.options.length; y++) {
            if (els.fAgent2.options[y].value === cur.agent) { els.fAgent2.value = cur.agent; break; }
        }
    }
}

function openModelModal() {
    if (state.currentId === null || !state.currentSession) return;
    loadCatalog().then(function () {
        fillModelModal(state.catalog);
        els.mTitle.textContent = (state.currentSession.name || ('chat ' + state.currentId)) + ' · ' + projectLabel(state.currentSession.folder);
        els.modelOverlay.classList.add('show');
    });
}

function closeModelModal() {
    els.modelOverlay.classList.remove('show');
}

els.sbModel.addEventListener('click', openModelModal);
els.btnModelCancel.addEventListener('click', closeModelModal);
els.modelOverlay.addEventListener('click', function (e) { if (e.target === els.modelOverlay) closeModelModal(); });

els.btnModelSave.addEventListener('click', async function () {
    var model = els.fModel2.value;
    var agent = els.fAgent2.value;
    if (!model || !agent || state.currentId === null) return;
    els.btnModelSave.disabled = true;
    var data = await api('api.php?action=session_update', apiCsrf('POST', { id: state.currentId, model: model, agent: agent }));
    els.btnModelSave.disabled = false;
    if (data.ok && data.session) {
        state.currentSession = data.session;
        els.hSub.textContent = sessionSubtitle(data.session);
        updateStatusbar();
        closeModelModal();
    } else {
        toast(data.error || 'error al guardar', 'error');
    }
});

// ---------------------------------------------------------------------------
// Cambiar agente del chat activo (Ctrl+. alterna plan ↔ build)
// ---------------------------------------------------------------------------
async function toggleAgent() {
    if (state.currentId === null || !state.currentSession) return;
    var cur = state.currentSession.agent || 'build';
    var next = cur === 'plan' ? 'build' : 'plan';
    var agents = (state.catalog && state.catalog.agents && state.catalog.agents.length)
        ? state.catalog.agents : ['build', 'plan'];
    if (agents.indexOf(next) < 0) {
        toast('el agente "' + next + '" no está disponible', 'error');
        return;
    }
    var data = await api('api.php?action=session_update', apiCsrf('POST', { id: state.currentId, agent: next }));
    if (data.ok && data.session) {
        state.currentSession = data.session;
        els.hSub.textContent = sessionSubtitle(data.session);
        updateStatusbar();
        els.sbModel.classList.remove('flash');
        void els.sbModel.offsetWidth; // reinicia la animación
        els.sbModel.classList.add('flash');
        toast('agente → ' + next, 'ok');
    } else {
        toast(data.error || 'error al cambiar agente', 'error');
    }
}

// ---------------------------------------------------------------------------
// Imagen adjunta (modelos con visión)
// ---------------------------------------------------------------------------
function setPendingImage(dataUrl) {
    state.pendingImage = dataUrl;
    if (dataUrl) {
        els.imgThumb.src = dataUrl;
        els.imgMeta.textContent = fmtSize(dataUrl.length * 3 / 4);
        els.imgPreview.style.display = 'flex';
    } else {
        els.imgInput.value = '';
        els.imgPreview.style.display = 'none';
        els.imgThumb.src = '';
        els.imgMeta.textContent = '';
    }
}

function modelHasVision(model) {
    var c = state.catalog || {};
    return Array.isArray(c.vision) && c.vision.indexOf(model) >= 0;
}

if (els.btnImg) {
    els.btnImg.addEventListener('click', function () {
        if (state.currentId === null) return;
        els.imgInput.click();
    });
    els.imgInput.addEventListener('change', function () {
        var f = els.imgInput.files && els.imgInput.files[0];
        if (!f) return;
        if (!/^image\/(png|jpe?g|webp|gif)$/.test(f.type)) {
            alert('Formato no soportado: usá PNG, JPG, WebP o GIF.');
            els.imgInput.value = '';
            return;
        }
        if (f.size > 4 * 1024 * 1024) {
            alert('Imagen demasiado grande (máx 4 MB).');
            els.imgInput.value = '';
            return;
        }
        var model = (state.currentSession && state.currentSession.model) || '';
        if (model && !modelHasVision(model) && !confirm('El modelo "' + model + '" no declara soporte de imágenes (👁) y puede fallar. ¿Adjuntar igual?')) {
            els.imgInput.value = '';
            return;
        }
        var fr = new FileReader();
        fr.onload = function () { setPendingImage(String(fr.result || '')); };
        fr.readAsDataURL(f);
    });
    els.imgRemove.addEventListener('click', function () { setPendingImage(null); });
}

// ---------------------------------------------------------------------------
// Dictado por voz (Web Speech API nativa del navegador; sin dependencias).
// ---------------------------------------------------------------------------
var SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
var voice = { rec: null, listening: false, base: '' };

function voiceSetListening(on) {
    voice.listening = on;
    if (!els.btnMic) return;
    els.btnMic.classList.toggle('listening', on);
    els.btnMic.title = on ? 'Detener dictado' : 'Dictar por voz';
    els.btnMic.setAttribute('aria-label', on ? 'Detener dictado' : 'Dictar por voz');
}

function voiceStop() {
    if (voice.rec && voice.listening) {
        try { voice.rec.stop(); } catch (e) {}
    }
    voiceSetListening(false);
}

function voiceStart() {
    if (!voice.rec || state.currentId === null) return;
    voice.base = els.input.value ? els.input.value.replace(/\s+$/, ' ') : '';
    try { voice.rec.start(); } catch (e) { /* ya estaba iniciado */ }
    voiceSetListening(true);
    toast('dictado activo · hablá ahora', 'ok');
}

if (els.btnMic) {
    if (!SpeechRec) {
        els.btnMic.style.display = 'none';
    } else {
        voice.rec = new SpeechRec();
        voice.rec.lang = navigator.language || 'es-AR';
        voice.rec.continuous = true;
        voice.rec.interimResults = true;
        voice.rec.onresult = function (ev) {
            var fin = '', interim = '';
            for (var i = ev.resultIndex; i < ev.results.length; i++) {
                var r = ev.results[i];
                if (r.isFinal) fin += r[0].transcript;
                else interim += r[0].transcript;
            }
            if (fin) voice.base = (voice.base + fin).replace(/\s+/g, ' ');
            var tail = interim ? (voice.base ? ' ' : '') + interim : '';
            els.input.value = (voice.base + tail).replace(/^\s+/, '');
            autoGrow();
        };
        voice.rec.onerror = function (ev) {
            voiceSetListening(false);
            var m = (ev && ev.error) || '';
            if (m === 'not-allowed' || m === 'service-not-allowed') toast('permiso de micrófono denegado', 'error');
            else if (m !== 'aborted' && m !== 'no-speech') toast('dictado: ' + m, 'error');
        };
        voice.rec.onend = function () { voiceSetListening(false); };
        els.btnMic.addEventListener('click', function () {
            if (voice.listening) voiceStop();
            else voiceStart();
        });
    }
}

// ---------------------------------------------------------------------------
// Plantillas de prompts (atajos guardados en el navegador).
// ---------------------------------------------------------------------------
var TPL_KEY = 'ob_tpl';

function tplLoad() {
    try {
        var a = JSON.parse(localStorage.getItem(TPL_KEY) || '[]');
        if (!Array.isArray(a)) return [];
        return a.filter(function (x) { return typeof x === 'string' && x.trim() !== ''; }).slice(0, 30);
    } catch (e) { return []; }
}
function tplStore(list) {
    try { localStorage.setItem(TPL_KEY, JSON.stringify(list)); } catch (e) {}
}
function tplClose() {
    if (els.tplPanel) els.tplPanel.style.display = 'none';
}
function tplRender() {
    var list = tplLoad();
    var html = '';
    for (var i = 0; i < list.length; i++) {
        html += '<div class="tpl-row" data-tpl="' + i + '"><span class="tpl-text">' + esc(list[i]) + '</span>'
            + '<button type="button" class="tpl-del" data-del="' + i + '" title="Borrar plantilla" aria-label="Borrar plantilla">✕</button></div>';
    }
    if (!list.length) html += '<div class="tpl-empty">No hay plantillas. Escribí un prompt y tocá “guardar lo escrito”.</div>';
    html += '<button type="button" class="tpl-save" id="tplSave">＋ guardar lo escrito</button>';
    els.tplPanel.innerHTML = html;
}
function tplOpen() {
    closeSlash();
    tplRender();
    els.tplPanel.style.display = 'block';
}
function tplInsert(text) {
    var cur = els.input.value;
    els.input.value = cur && cur.trim() !== '' ? (cur.replace(/\s+$/, '') + ' ' + text) : text;
    tplClose();
    autoGrow();
    els.input.focus();
    try { els.input.setSelectionRange(els.input.value.length, els.input.value.length); } catch (e) {}
}
function tplSaveCurrent() {
    var text = els.input.value.trim();
    if (!text) { toast('escribí un prompt primero', 'error'); return; }
    var list = tplLoad();
    if (list.indexOf(text) >= 0) { toast('esa plantilla ya existe', 'ok'); return; }
    list.unshift(text);
    tplStore(list.slice(0, 30));
    toast('plantilla guardada', 'ok');
    tplRender();
}

if (els.btnTpl && els.tplPanel) {
    els.btnTpl.addEventListener('click', function () {
        if (state.currentId === null) return;
        if (els.tplPanel.style.display === 'block') tplClose();
        else tplOpen();
    });
    els.tplPanel.addEventListener('click', function (e) {
        var del = e.target.closest('.tpl-del');
        if (del) {
            e.stopPropagation();
            var list = tplLoad();
            list.splice(parseInt(del.getAttribute('data-del'), 10), 1);
            tplStore(list);
            tplRender();
            return;
        }
        if (e.target.closest('.tpl-save')) { tplSaveCurrent(); return; }
        var row = e.target.closest('.tpl-row');
        if (row) {
            var list2 = tplLoad();
            var t = list2[parseInt(row.getAttribute('data-tpl'), 10)];
            if (typeof t === 'string') tplInsert(t);
        }
    });
}

// ---------------------------------------------------------------------------
// Composer: textarea multilínea (Enter envía, Shift+Enter salta de línea)
// y menú de comandos "/" con filtro, flechas y Enter.
// ---------------------------------------------------------------------------
function autoGrow() {
    var el = els.input;
    if (!el.scrollHeight) return; // oculta (chat no visible): no fijar altura
    el.style.height = 'auto';
    var max = 148;
    el.style.height = Math.min(el.scrollHeight, max) + 'px';
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
    if (els.jumpBtn) els.jumpBtn.style.bottom = jumpBarH() + 'px';
}

var slash = { open: false, items: [], sel: 0 };
function slashFilter(q) {
    q = String(q || '').trim().toLowerCase();
    return CMDS.filter(function (c) {
        return c.cmd.indexOf(q) === 0 || c.desc.toLowerCase().indexOf(q) >= 0;
    });
}
function renderSlash() {
    var html = '';
    for (var i = 0; i < slash.items.length; i++) {
        var c = slash.items[i];
        html += '<div class="item' + (i === slash.sel ? ' sel' : '') + '" data-i="' + i + '">'
            + '<b>' + esc(c.cmd) + '</b><span>' + esc(c.desc) + '</span></div>';
    }
    els.slashPanel.innerHTML = html || '<div class="item"><span>sin comandos que coincidan</span></div>';
}
function closeSlash() {
    if (!slash.open) return;
    slash.open = false;
    els.slashPanel.style.display = 'none';
}
function applySlash(cmd) {
    els.input.value = cmd + ' ';
    closeSlash();
    autoGrow();
    els.input.focus();
    try { els.input.setSelectionRange(els.input.value.length, els.input.value.length); } catch (e) {}
}

els.input.addEventListener('input', function () {
    autoGrow();
    var v = els.input.value;
    if (state.view === 'chat' && v.charAt(0) === '/') {
        tplClose();
        slash.items = slashFilter(v);
        slash.sel = 0;
        renderSlash();
        els.slashPanel.style.display = 'block';
        slash.open = true;
    } else {
        closeSlash();
    }
});

els.input.addEventListener('keydown', function (e) {
    if (slash.open) {
        if (e.key === 'ArrowDown' && slash.items.length) {
            e.preventDefault();
            slash.sel = (slash.sel + 1) % slash.items.length;
            renderSlash();
            return;
        }
        if (e.key === 'ArrowUp' && slash.items.length) {
            e.preventDefault();
            slash.sel = (slash.sel - 1 + slash.items.length) % slash.items.length;
            renderSlash();
            return;
        }
        if ((e.key === 'Enter' || e.key === 'Tab') && slash.items.length) {
            e.preventDefault();
            e.stopPropagation();
            applySlash(slash.items[slash.sel].cmd);
            return;
        }
        if (e.key === 'Escape') {
            e.stopPropagation();
            if (els.tplPanel && els.tplPanel.style.display === 'block') tplClose();
            else closeSlash();
            return;
        }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        els.sendForm.dispatchEvent(new Event('submit', { cancelable: true }));
    }
});

els.slashPanel.addEventListener('click', function (e) {
    var it = e.target.closest('.item');
    if (!it || it.getAttribute('data-i') === null) return;
    applySlash(slash.items[parseInt(it.getAttribute('data-i'), 10)].cmd);
});

// ---------------------------------------------------------------------------
// Enviar mensaje
// ---------------------------------------------------------------------------
els.sendForm.addEventListener('submit', async function (ev) {
    ev.preventDefault();
    if (state.currentId === null) return;
    if (!state.online) {
        toast('el puente está apagado. Iniciá “OpenBridge” en tu PC.', 'error');
        return;
    }
    var text = els.input.value.trim();
    if ((!text && !state.pendingImage) || state.isSending) return;
    state.isSending = true;
    voiceStop();
    try {
        var body = { session: state.currentId, text: text };
        if (state.pendingImage) body.image = state.pendingImage;
        var data = await api('api.php?action=send', apiCsrf('POST', body));
        if (data.ok) {
            els.input.value = '';
            autoGrow();
            closeSlash();
            tplClose();
            setPendingImage(null);
            await loadHistory(state.currentId, true);
        } else {
            toast(data.error || 'error al enviar', 'error');
        }
    } catch (e) {
        toast('error al enviar', 'error');
    } finally {
        state.isSending = false;
        if (isMobileView()) composeCloseSheet();
        else els.input.focus();
    }
});

// ---------------------------------------------------------------------------
// Cancelar la ejecución en curso (el puente corta opencode en ~2 s)
// ---------------------------------------------------------------------------
async function cancelCurrentRun() {
    if (state.currentId === null) return;
    var btn = document.getElementById('btnStop');
    if (btn) {
        btn.disabled = true;
        var tx = btn.querySelector('.stoptxt');
        if (tx) tx.textContent = 'cancelando...';
    }
    await api('api.php?action=cancel', apiCsrf('POST', { session: state.currentId }));
    if (state.currentId !== null) await loadHistory(state.currentId, true);
}

// ---------------------------------------------------------------------------
// Buscador dentro del chat activo
// ---------------------------------------------------------------------------
var chatSearchDebounce = null;
function bindChatSearch() {
    document.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && (e.key === '.' || e.code === 'Period')) {
            if (state.view === 'chat' && state.currentId !== null) {
                e.preventDefault();
                toggleAgent();
            }
            return;
        }
        if (e.key === 'Escape') {
            if (els.sendForm.classList.contains('open')) {
                composeCloseSheet();
                return;
            }
            if (els.cardMenu && els.cardMenu.classList.contains('open')) {
                closeCardMenu();
                return;
            }
            if (els.modelOverlay && els.modelOverlay.classList.contains('show')) {
                closeModelModal();
                return;
            }
        }
        if (state.view !== 'chat') return;
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
            e.preventDefault();
            ensureChatSearchBar();
            var input = document.getElementById('chatSearchInput');
            if (input) { input.focus(); input.select(); }
        } else if (e.key === 'Escape' && state.chatSearch) {
            state.chatSearch = null;
            removeChatSearchBar();
            if (state.currentId) loadHistory(state.currentId, true);
        }
    });
}

function ensureChatSearchBar() {
    if (document.getElementById('chatSearchBar')) return;
    var bar = document.createElement('div');
    bar.id = 'chatSearchBar';
    bar.className = 'search-bar';
    bar.innerHTML = '<span>🔍</span><input type="text" id="chatSearchInput" placeholder="buscar en este chat… (Esc para salir)"><span id="chatSearchCount"></span><button type="button" id="chatSearchClose" aria-label="Cerrar">×</button>';
    var sendbar = document.querySelector('form.sendbar');
    els.chat.insertBefore(bar, sendbar);
    document.getElementById('chatSearchClose').addEventListener('click', function () {
        state.chatSearch = null;
        removeChatSearchBar();
        if (state.currentId) loadHistory(state.currentId, true);
    });
    var input = document.getElementById('chatSearchInput');
    input.addEventListener('input', function () {
        clearTimeout(chatSearchDebounce);
        var q = input.value;
        chatSearchDebounce = setTimeout(function () {
            if (!q) {
                state.chatSearch = null;
                if (state.currentId) loadHistory(state.currentId, true);
                document.getElementById('chatSearchCount').textContent = '';
                return;
            }
            state.chatSearch = { query: q, firstHit: true };
            loadHistory(state.currentId, true);
            setTimeout(function () {
                var hits = els.messages.querySelectorAll('.msg.hit').length;
                document.getElementById('chatSearchCount').textContent = hits + (hits === 1 ? ' coincidencia' : ' coincidencias');
            }, 50);
        }, 220);
    });
}

function removeChatSearchBar() {
    var bar = document.getElementById('chatSearchBar');
    if (bar) bar.remove();
}

// ---------------------------------------------------------------------------
// Navegación
// ---------------------------------------------------------------------------
els.btnBack.addEventListener('click', goBack);
els.home.addEventListener('click', function (e) {
    if (e.target.closest('.newbtn')) openModal();
});

// ---------------------------------------------------------------------------
// Menú de opciones de tarjeta (⋮): por ahora solo Eliminar.
// ---------------------------------------------------------------------------
function openCardMenu(btn) {
    var card = btn.closest('.card');
    if (!card) return;
    var sid = parseInt(card.getAttribute('data-sid'), 10);
    els.cardMenu.innerHTML = '<div class="item danger" data-del="' + sid + '">🗑 Eliminar</div>';
    els.cardMenu.classList.add('open');
    var r = btn.getBoundingClientRect();
    var mw = els.cardMenu.offsetWidth || 170;
    var mh = els.cardMenu.offsetHeight || 46;
    var left = Math.max(8, Math.min(r.right - mw, window.innerWidth - mw - 8));
    var top = r.bottom + 6;
    if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
    els.cardMenu.style.left = left + 'px';
    els.cardMenu.style.top = top + 'px';
}

function closeCardMenu() {
    els.cardMenu.classList.remove('open');
}

els.home.addEventListener('click', function (e) {
    var k = e.target.closest('.kebab');
    if (!k) return;
    e.stopPropagation();
    var wasOpen = els.cardMenu.classList.contains('open');
    closeCardMenu();
    if (!wasOpen) openCardMenu(k);
});

// Grupos de proyectos en el home: contraer/expandir y abrir historial.
els.home.addEventListener('click', function (e) {
    var head = e.target.closest('.pshead');
    if (head) {
        e.stopPropagation();
        var sec = head.closest('.projsec');
        if (!sec) return;
        var folder = sec.getAttribute('data-folder');
        var nowOpen = sec.classList.toggle('open');
        var ch = head.querySelector('.chev');
        if (ch) ch.textContent = nowOpen ? '▾' : '▸';
        setProjectOpen(folder, nowOpen);
        return;
    }
    var hist = e.target.closest('.histbtn');
    if (hist && !e.target.closest('.filesbtn')) {
        e.stopPropagation();
        openHistory(hist.getAttribute('data-folder'));
        return;
    }
    var fbtn = e.target.closest('.filesbtn');
    if (fbtn) {
        e.stopPropagation();
        state.filesPath = folderToFilesPath(fbtn.getAttribute('data-folder'));
        delete state.filesCache[state.filesPath];
        showView('files');
    }
});

els.cardMenu.addEventListener('click', async function (e) {
    var it = e.target.closest('.item');
    closeCardMenu();
    if (!it) return;
    var sid = parseInt(it.getAttribute('data-del'), 10);
    if (!sid) return;
    if (!confirm('¿Borrar este chat y su historial?')) return;
    var data = await api('api.php?action=session_delete', apiCsrf('POST', { id: sid }));
    if (data.ok) {
        toast('chat eliminado', 'ok');
        loadSessions();
    } else {
        toast(data.error || 'no se pudo eliminar', 'error');
    }
});

els.home.addEventListener('scroll', closeCardMenu, { passive: true });
window.addEventListener('resize', closeCardMenu);

// ---------------------------------------------------------------------------
// Vista: Archivos
// ---------------------------------------------------------------------------
function fmtSize(n) {
    if (n === null || n === undefined) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

function sleepMs(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// Lista/lee archivos vía la cola del puente (modo remoto): encola fs_list o
// fs_read y consulta el resultado hasta que el puente lo resuelve.
async function runFsCommand(cmd, arg) {
    var enq = await api('api.php?action=run_oc', apiCsrf('POST', { cmd: cmd, args: [arg || ''] }));
    if (!enq.ok) return { ok: false, error: enq.error || 'no se pudo encolar' };
    for (var i = 0; i < 25; i++) {
        await sleepMs(1200);
        var st = await api('api.php?action=oc_command_status&id=' + enq.id);
        if (st.ok && (st.status === 'done' || st.status === 'error')) {
            if (st.status === 'error') return { ok: false, error: st.error || 'error del puente' };
            try { return { ok: true, data: JSON.parse(st.result) }; }
            catch (e) { return { ok: false, error: 'respuesta inválida del puente' }; }
        }
    }
    return { ok: false, error: 'el puente tardó demasiado (¿está encendido?)' };
}

// En local lee directo del disco (rápido); en remoto va por el puente.
async function loadFiles(path, force) {
    state.fileView = null;
    state.filesPath = path || '';
    var cacheKey = state.filesPath;
    var cached = !force && state.filesCache[cacheKey];
    if (cached) {
        state.filesEntries = state.filesCache[cacheKey];
        renderFilesView();
        return;
    }
    renderFilesLoading();
    if (isLocalHost()) {
        var url = 'api.php?action=browse';
        if (state.filesPath) url += '&path=' + encodeURIComponent(state.filesPath);
        var data = await api(url);
        if (data.ok) {
            state.filesEntries = data.entries || [];
            state.filesWorkspace = data.workspace;
            state.filesCache[cacheKey] = state.filesEntries;
            renderFilesView();
            return;
        }
        // sin lectura directa: probamos por el puente
    }
    renderFilesLoading();
    var res = await runFsCommand('fs_list', state.filesPath);
    if (res.ok) {
        state.filesEntries = (res.data && res.data.entries) || [];
        state.filesCache[cacheKey] = state.filesEntries;
        renderFilesView();
    } else {
        renderFilesError(res.error || 'No se pudo listar');
    }
}

function renderFilesLoading() {
    els.viewFiles.innerHTML = '<div class="view-head"><h2>archivos del proyecto</h2>'
        + '<div class="view-sub">' + esc(state.filesPath || '/') + '</div></div>'
        + '<div class="placeholder">consultando por el puente…</div>';
}

function renderFilesError(msg) {
    els.viewFiles.innerHTML = '<div class="view-head"><h2>archivos del proyecto</h2>'
        + '<div class="view-sub">' + esc((state.catalog && state.catalog.workspace) || (state.filesWorkspace || 'sin workspace')) + '</div></div>'
        + '<div class="placeholder">' + esc(msg) + '</div>';
}

function filesJoin(name) {
    return state.filesPath ? state.filesPath + '/' + name : name;
}

// ---------------------------------------------------------------------------
// Cambios del proyecto (git status/diff) vía la cola del puente.
// ---------------------------------------------------------------------------
function changesFolder() {
    return (state.currentSession && state.currentSession.folder) || '';
}

function renderChangesView() {
    els.hTitle.textContent = 'cambios';
    var folder = changesFolder();
    els.hSub.textContent = folder ? projectLabel(folder) : 'de la sesión abierta';
    if (!folder) {
        els.viewChanges.innerHTML = '<div class="placeholder">Abrí un chat para ver los cambios de su proyecto.</div>';
        return;
    }
    if (!state.online) {
        els.viewChanges.innerHTML = '<div class="placeholder">El puente está apagado. Iniciá “OpenBridge” en tu PC.</div>';
        return;
    }
    els.viewChanges.innerHTML = '<div class="view-head"><h2>cambios sin commitear</h2>'
        + '<div class="view-sub">' + esc(projectLabel(folder)) + '</div></div>'
        + '<div class="placeholder">consultando git…</div>';
    loadChanges(folder);
}

// ---------------------------------------------------------------------------
// Vista MCP: estado de los servidores MCP de opencode (opencode mcp list).
// ---------------------------------------------------------------------------
function renderMcpView() {
    els.hTitle.textContent = 'mcp';
    els.hSub.textContent = 'servidores MCP de opencode';
    if (!state.online) {
        els.viewMcp.innerHTML = '<div class="placeholder">El puente está apagado. Iniciá “OpenBridge” en tu PC.</div>';
        return;
    }
    els.viewMcp.innerHTML = '<div class="view-head"><h2>servidores MCP</h2>'
        + '<div class="view-sub">opencode mcp list</div></div>'
        + '<div class="placeholder">consultando opencode…</div>';
    loadMcp();
}

async function loadMcp() {
    var res = await ocCommand('mcp_list', [], 15, 700);
    if (!els.viewMcp) return;
    var head = '<div class="view-head"><h2>servidores MCP</h2>'
        + '<div class="view-sub">opencode mcp list</div></div>';
    if (!res.ok) {
        els.viewMcp.innerHTML = head + '<div class="placeholder">' + esc(res.error || 'no se pudo consultar') + '</div>';
        return;
    }
    var output = (res.data && res.data.output) || '';
    els.viewMcp.innerHTML = head + '<pre class="codeblock">'
        + esc(output || 'No hay servidores MCP configurados.') + '</pre>';
}

function chgStatusClass(st) {
    if (st === '??' || st === 'A') return 'add';
    if (st.indexOf('D') >= 0) return 'del';
    if (st.indexOf('M') >= 0 || st.indexOf('R') >= 0) return 'mod';
    return '';
}

function renderDiff(text) {
    var max = 200000;
    var trunc = false;
    if (text.length > max) { text = text.slice(0, max); trunc = true; }
    var lines = text.split('\n');
    var html = '';
    for (var i = 0; i < lines.length; i++) {
        var l = lines[i];
        var cls = 'diff-line';
        if (l.charAt(0) === '+') cls += ' add';
        else if (l.charAt(0) === '-') cls += ' del';
        else if (l.indexOf('@@') === 0) cls += ' hunk';
        else if (l.indexOf('diff --git') === 0 || l.indexOf('index ') === 0 || l.indexOf('--- ') === 0 || l.indexOf('+++ ') === 0) cls += ' head';
        html += '<div class="' + cls + '">' + esc(l || ' ') + '</div>';
    }
    if (trunc) html += '<div class="diff-line head">… (diff recortado)</div>';
    return '<div class="diff">' + html + '</div>';
}

function changesHead(folder, branch) {
    return '<div class="view-head"><h2>cambios sin commitear</h2><div class="view-sub">'
        + esc(projectLabel(folder)) + (branch ? ' · ' + esc(branch) : '') + '</div></div>';
}

async function loadChanges(folder) {
    var st = await ocCommand('git_status', [folder], 15, 500);
    if (!st.ok) {
        els.viewChanges.innerHTML = changesHead(folder, '')
            + '<div class="placeholder">' + esc(st.error || 'no se pudo consultar git') + '</div>';
        return;
    }
    var status = st.data || {};
    var files = status.files || [];
    if (!files.length) {
        els.viewChanges.innerHTML = changesHead(folder, status.branch)
            + '<div class="placeholder">Sin cambios: el árbol está limpio.</div>';
        return;
    }
    var list = '<div class="chg-files">';
    for (var i = 0; i < files.length; i++) {
        var rev = (isAdmin() && files[i].status !== '??')
            ? '<button type="button" class="chg-rev" data-path="' + esc(files[i].path) + '" title="Revertir este archivo" aria-label="Revertir este archivo">↩</button>'
            : '';
        list += '<div class="chg-row"><span class="chg-st ' + chgStatusClass(files[i].status) + '">' + esc(files[i].status) + '</span>'
            + '<span class="chg-path">' + esc(files[i].path) + '</span>' + rev + '</div>';
    }
    list += '</div>';
    var tracked = files.some(function (f) { return f.status !== '??'; });
    var toolbar = (isAdmin() && tracked)
        ? '<div class="files-toolbar"><button type="button" class="linkbtn" id="chgRevert">↩ revertir cambios rastreados</button></div>'
        : '';
    els.viewChanges.innerHTML = changesHead(folder, status.branch) + toolbar + list + '<div class="placeholder">cargando diff…</div>';

    var diff = await ocCommand('git_diff', [folder], 20, 700);
    var diffHtml;
    if (diff.ok) {
        var text = (diff.data && diff.data.diff) || '';
        diffHtml = text ? renderDiff(text) : '<div class="placeholder">Hay archivos nuevos o renombrados sin diff de contenido.</div>';
    } else {
        diffHtml = '<div class="placeholder">' + esc(diff.error || 'no se pudo obtener el diff') + '</div>';
    }
    els.viewChanges.innerHTML = changesHead(folder, status.branch) + toolbar + list + diffHtml;
}

// Revertir cambios rastreados (con confirmacion): borra las modificaciones que
// el agente u otros hicieron en archivos ya versionados. No toca los nuevos.
// Sirve para un archivo puntual (boton de la fila) o para todos.
if (els.viewChanges) {
    els.viewChanges.addEventListener('click', function (e) {
        if (!isAdmin()) return;
        var folder = changesFolder();
        if (!folder) return;
        var one = e.target.closest('.chg-rev');
        if (one) {
            var rel = one.getAttribute('data-path');
            if (!window.confirm('¿Revertir “' + rel + '”?\n\nNo se puede deshacer.')) return;
            one.disabled = true;
            ocCommand('git_checkout', [folder, rel], 15, 500).then(function (r) {
                toast(r.ok ? 'revertido: ' + rel : (r.error || 'no se pudo revertir'), r.ok ? 'ok' : 'error');
                renderChangesView();
            });
            return;
        }
        var all = e.target.closest('#chgRevert');
        if (!all) return;
        if (!window.confirm('¿Revertir TODOS los cambios de archivos rastreados en “' + projectLabel(folder) + '”?\n\nNo se puede deshacer. Los archivos nuevos sin seguimiento no se tocan.')) return;
        all.disabled = true;
        all.textContent = 'revirtiendo…';
        ocCommand('git_checkout', [folder], 15, 500).then(function (r) {
            toast(r.ok ? 'cambios revertidos' : (r.error || 'no se pudo revertir'), r.ok ? 'ok' : 'error');
            renderChangesView();
        });
    });
}

function renderFilesView() {
    state.fileView = null;
    var ws = (state.catalog && state.catalog.workspace) || (state.filesWorkspace || '');
    var html = '<div class="view-head"><h2>archivos del proyecto</h2>'
        + '<div class="view-sub">' + esc(ws || 'sin workspace') + '</div></div>'
        + '<div class="files-toolbar">'
        + (state.filesPath ? '<button type="button" class="linkbtn" id="filesBack">← volver</button>' : '')
        + '<span class="files-path">' + esc(state.filesPath || '/') + '</span>'
        + '<button type="button" class="linkbtn" id="filesReload">↻ recargar</button>'
        + '</div>';
    if (!ws) {
        html += '<div class="placeholder">El puente no ha definido un workspace. Iniciá “OpenBridge” en tu PC.</div>';
        els.viewFiles.innerHTML = html;
        return;
    }
    if (!state.filesEntries.length) {
        html += '<div class="placeholder">Carpeta vacía (o solo con carpetas ignoradas).</div>';
    } else {
        html += '<div class="files-list">';
        for (var i = 0; i < state.filesEntries.length; i++) {
            var e = state.filesEntries[i];
            var isFile = e.type === 'file';
            var meta = isFile
                ? fmtSize(e.size) + (e.mtime ? ' · ' + timeShort(new Date(e.mtime * 1000).toISOString()) : '')
                : 'carpeta';
            html += '<div class="files-row" data-path="' + esc(e.name) + '" data-type="' + e.type + '">'
                + '<span class="ic">' + (isFile ? '📄' : '📁') + '</span>'
                + '<span class="name">' + esc(e.name) + '</span>'
                + '<span class="size">' + esc(meta) + '</span>'
                + '</div>';
        }
        html += '</div>';
    }
    els.viewFiles.innerHTML = html;
    var back = document.getElementById('filesBack');
    if (back) back.addEventListener('click', function () {
        var parts = state.filesPath.split('/').filter(Boolean);
        parts.pop();
        loadFiles(parts.join('/'));
    });
    var reload = document.getElementById('filesReload');
    if (reload) reload.addEventListener('click', function () {
        delete state.filesCache[state.filesPath];
        loadFiles(state.filesPath, true);
    });
    var rows = els.viewFiles.querySelectorAll('.files-row');
    for (var k = 0; k < rows.length; k++) {
        (function (row) {
            row.addEventListener('click', function () {
                var p = row.getAttribute('data-path');
                if (row.getAttribute('data-type') === 'file') openFileView(filesJoin(p));
                else loadFiles(filesJoin(p));
            });
        })(rows[k]);
    }
}

// Visor read-only del contenido de un archivo (local directo, remoto por puente).
async function openFileView(rel) {
    state.fileView = { path: rel, loading: true };
    renderFileView();
    var res;
    if (isLocalHost()) {
        var data = await api('api.php?action=read_file&path=' + encodeURIComponent(rel));
        res = data.ok
            ? { ok: true, data: { path: data.path, size: data.size, kind: data.kind || 'text', content: data.content || '', url: data.url || '' } }
            : { ok: false, error: data.error || 'error al leer' };
    } else {
        res = await runFsCommand('fs_read', rel);
    }
    if (state.fileView && state.fileView.path === rel) {
        state.fileView.loading = false;
        state.fileView.ok = !!res.ok;
        if (res.ok) state.fileView.data = res.data;
        else state.fileView.error = res.error;
        renderFileView();
    }
}

function fileBaseName(p) {
    var parts = String(p || '').split('/');
    return parts[parts.length - 1] || p || '';
}
function fileExtOf(p) {
    var n = fileBaseName(p);
    var i = n.lastIndexOf('.');
    return i >= 0 ? n.slice(i + 1).toLowerCase() : '';
}

// Líneas con número y resaltado (estilo editor VSCode, sin dependencias).
function codeRowsHtml(content, ext) {
    var text = String(content || '').replace(/\r\n?/g, '\n');
    var lines = text.split('\n');
    if (text === '') lines = [];
    var w = String(lines.length).length;
    var html = '';
    for (var i = 0; i < lines.length; i++) {
        var no = i + 1;
        var gutter = '';
        for (var g = String(no).length; g < w; g++) gutter += ' ';
        gutter += no;
        var ln = lines[i] === '' ? ' ' : lines[i];
        html += '<div class="frow"><span class="fg">' + gutter + '</span>'
            + '<code class="fc">' + hlCode(ln, ext) + '</code></div>';
    }
    return html;
}

function renderFileView() {
    var fv = state.fileView;
    var name = fileBaseName(fv.path);
    var ext = fileExtOf(fv.path);
    var isImg = /^(png|jpe?g|gif|webp|avif)$/.test(ext);
    var isMd = ext === 'md' || ext === 'markdown';
    var html = '<div class="view-head"><h2>archivo</h2>'
        + '<div class="view-sub">' + esc(fv.path) + '</div></div>'
        + '<div class="files-toolbar"><button type="button" class="linkbtn" id="fileBack">← volver a la carpeta</button></div>';
    if (fv.loading) {
        html += '<div class="placeholder">consultando por el puente…</div>';
    } else if (!fv.ok) {
        html += '<div class="placeholder">' + esc(fv.error || 'No se pudo leer') + '</div>';
    } else {
        var d = fv.data || {};
        var content = String(d.content || '');
        var sizeTxt = d.size ? fmtSize(d.size) : '';
        var hasUrl = !!d.url;
        var isImage = isImg || d.kind === 'image' || hasUrl;
        html += '<div class="fviewer"><div class="fbar">'
            + '<span class="fname">' + esc(name) + '</span>'
            + (sizeTxt ? '<span class="fsize">' + esc(sizeTxt) + '</span>' : '')
            + '<span class="fro">solo lectura</span>';
        if (!isImage && (content || ext !== '')) {
            html += '<button type="button" class="copybtn" id="fileCopy" title="Copiar contenido">⧉ copiar</button>';
        }
        html += '</div>';
        if (isImage) {
            if (hasUrl) {
                html += '<div class="fimgwrap"><img src="' + esc(d.url) + '" alt="' + esc(name) + '"></div>';
            } else {
                html += '<div class="placeholder">No se puede previsualizar la imagen por esta vía.</div>';
            }
        } else if (isMd) {
            // Markdown formateado (mismo render ligero que el chat).
            html += '<div class="fscroll"><div class="mdview">' + renderContent(content) + '</div></div>';
        } else {
            if (!content) {
                html += '<div class="placeholder">(archivo vacío)</div>';
            } else {
                html += '<div class="fscroll"><div class="fcodewrap">' + codeRowsHtml(content, ext) + '</div></div>';
            }
        }
        html += '</div>';
    }
    els.viewFiles.innerHTML = html;
    var back = document.getElementById('fileBack');
    if (back) back.addEventListener('click', function () {
        state.fileView = null;
        renderFilesView();
    });
    var copy = document.getElementById('fileCopy');
    if (copy) copy.addEventListener('click', function () {
        var txt = String((fv.data && fv.data.content) || '');
        try {
            navigator.clipboard.writeText(txt);
            copy.textContent = '✓ copiado';
            setTimeout(function () { copy.textContent = '⧉ copiar'; }, 1200);
        } catch (e) { /* sin permisos */ }
    });
}

// ---------------------------------------------------------------------------
// Vista: Sesiones opencode
// ---------------------------------------------------------------------------
async function loadSessionsView() {
    var data = await api('api.php?action=oc_sessions');
    state.ocSessions = (data.ok && data.sessions) || [];
    renderSessionsView();
}

function renderSessionsView() {
    if (!state.ocSessions) {
        loadSessionsView();
        return;
    }
    var list = state.ocSessions;
    var html = '<div class="view-head"><h2>sesiones opencode</h2>'
        + '<div class="view-sub">' + list.length + ' sesión(es) vinculada(s)</div></div>'
        + '<div class="files-toolbar">'
        + '<button type="button" class="linkbtn" id="sessionsReload">↻ recargar</button>'
        + '</div>';
    if (!list.length) {
        html += '<div class="placeholder">Todavía no hay sesiones con opencode_session vinculado.</div>';
    } else {
        html += '<div class="cards sessions-list">';
        for (var i = 0; i < list.length; i++) {
            var s = list[i];
            html += '<div class="card" data-sid="' + s.session_id + '">'
                + '<div class="grow">'
                + '<div class="cname">' + esc(s.name) + '</div>'
                + '<div class="cmeta">' + esc(shortPath(s.folder)) + ' · ' + esc(s.model || 'sin modelo') + ' · ' + esc(s.agent) + '</div>'
                + (s.opencode_session ? '<div class="cmeta code">oc: ' + esc(s.opencode_session.slice(0, 16)) + '…</div>' : '<div class="cmeta" style="color:var(--muted)">sin opencode_session</div>')
                + '</div>'
                + '<button type="button" class="linkbtn" data-open="' + s.session_id + '" title="Abrir">abrir</button>'
                + '</div>';
        }
        html += '</div>';
    }
    els.viewSessions.innerHTML = html;
    var reload = document.getElementById('sessionsReload');
    if (reload) reload.addEventListener('click', loadSessionsView);
    var opens = els.viewSessions.querySelectorAll('[data-open]');
    for (var j = 0; j < opens.length; j++) {
        (function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                openChat(parseInt(btn.getAttribute('data-open'), 10));
            });
        })(opens[j]);
    }
}

// ---------------------------------------------------------------------------
// Vista: Buscar
// ---------------------------------------------------------------------------
var searchDebounce = null;
function renderSearchView() {
    if (!document.getElementById('searchInput')) {
        els.viewSearch.innerHTML = '<div class="view-head"><h2>buscar en todos los chats</h2>'
            + '<div class="view-sub">2+ caracteres</div></div>'
            + '<div class="search-bar"><span>🔍</span><input type="text" id="searchInput" placeholder="escribí una palabra o frase…" autofocus></div>'
            + '<div id="searchResults"></div>';
        var input = document.getElementById('searchInput');
        input.addEventListener('input', function () {
            clearTimeout(searchDebounce);
            var q = input.value;
            searchDebounce = setTimeout(function () { runSearch(q); }, 220);
        });
    }
    runSearch((document.getElementById('searchInput') || {}).value || '');
}

async function runSearch(q) {
    var out = document.getElementById('searchResults');
    if (!out) return;
    if (!q || q.length < 2) {
        out.innerHTML = '<div class="placeholder">escribí al menos 2 letras.</div>';
        return;
    }
    out.innerHTML = '<div class="placeholder">buscando…</div>';
    var data = await api('api.php?action=search_index&q=' + encodeURIComponent(q));
    if (!data.ok) {
        out.innerHTML = '<div class="placeholder">' + esc(data.error || 'error') + '</div>';
        return;
    }
    var res = data.results || [];
    if (!res.length) {
        out.innerHTML = '<div class="placeholder">sin coincidencias para “' + esc(q) + '”.</div>';
        return;
    }
    var html = '<div class="search-summary">' + res.length + ' chat(s) con coincidencias.</div>';
    for (var i = 0; i < res.length; i++) {
        var r = res[i];
        html += '<div class="search-group">'
            + '<div class="search-group-head"><b>' + esc(r.name) + '</b> · ' + r.count + ' coincidencia(s) · '
            + '<a href="#" data-sid="' + r.session_id + '" class="link">abrir chat</a></div>';
        for (var k = 0; k < r.matches.length; k++) {
            var m = r.matches[k];
            html += '<div class="search-match"><span class="role">' + esc(m.role) + '</span>' + highlightText(m.snippet, q) + '</div>';
        }
        html += '</div>';
    }
    out.innerHTML = html;
    var opens = out.querySelectorAll('[data-sid]');
    for (var j = 0; j < opens.length; j++) {
        (function (a) {
            a.addEventListener('click', function (e) {
                e.preventDefault();
                openChat(parseInt(a.getAttribute('data-sid'), 10));
            });
        })(opens[j]);
    }
}

// ---------------------------------------------------------------------------
// Vista: Vista previa del proyecto (túneles TunnelMole, corren en la PC)
// ---------------------------------------------------------------------------
function validPort(p) {
    var n = parseInt(p, 10);
    return (n >= 1 && n <= 65535) ? n : null;
}

function renderPreviewView() {
    if (!state.previewPort) {
        try { state.previewPort = localStorage.getItem('ob_lastPort') || ''; } catch (e) {}
    }
    els.viewPreview.innerHTML = '<div class="view-head"><h2>vista previa</h2>'
        + '<div class="view-sub">túneles del proyecto (TunnelMole, corren en tu PC)</div></div>'
        + (isAdmin()
            ? '<div class="tunnel-form">'
                + '<input type="text" id="tunnelPort" inputmode="numeric" placeholder="puerto (ej: 8080)" value="' + esc(state.previewPort) + '" autocomplete="off">'
                + '<button type="button" class="linkbtn" id="tunnelStart">abrir túnel</button>'
                + '</div>'
            : '')
        + '<div class="tnote-sec" style="margin:0 0 12px">los túneles son públicos en internet y viven mientras el puente esté corriendo · cerrálos al terminar</div>'
        + '<div id="tunnelList"></div>';
    var portInput = document.getElementById('tunnelPort');
    if (portInput) {
        portInput.addEventListener('input', function () {
            state.previewPort = portInput.value.replace(/[^0-9]/g, '');
            portInput.value = state.previewPort;
        });
        portInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); startTunnel(); }
        });
        var tunStartBtn = document.getElementById('tunnelStart');
        if (tunStartBtn) tunStartBtn.addEventListener('click', startTunnel);
    }
    renderTunnels();
    refreshTunnels();
}

function renderTunnels(busyMsg) {
    var box = document.getElementById('tunnelList');
    if (!box) return;
    var list = state.tunnels || [];
    var html = '';
    for (var i = 0; i < list.length; i++) {
        var t = list[i];
        var ready = !!(t.https || t.http);
        html += '<div class="tunnel">'
            + '<div class="thead"><span class="dot"' + (ready ? '' : ' style="background:var(--muted)"') + '></span>'
            + '<b>puerto ' + esc(t.port) + '</b>'
            + '<span class="tnote">' + (ready ? 'activo' : 'levantando…') + '</span>'
            + (isAdmin() ? '<button type="button" class="linkbtn" data-tstop="' + esc(t.port) + '">cerrar túnel</button>' : '')
            + '</div>'
            + (t.https ? '<div class="turl"><a href="' + esc(t.https) + '" target="_blank" rel="noopener noreferrer">' + esc(t.https) + '</a>'
                + '<button type="button" class="copybtn" data-tcopy="' + esc(t.https) + '" title="Copiar URL">⧉</button></div>' : '')
            + (t.http && t.http !== t.https ? '<div class="turl"><a href="' + esc(t.http) + '" target="_blank" rel="noopener noreferrer">' + esc(t.http) + '</a>'
                + '<button type="button" class="copybtn" data-tcopy="' + esc(t.http) + '" title="Copiar URL">⧉</button></div>' : '')
            + '</div>';
    }
    if (busyMsg) html += '<div class="placeholder">' + esc(busyMsg) + '</div>';
    if (!html) html = '<div class="placeholder">no hay túneles abiertos. Escribí el puerto del servidor del proyecto (ej: 8080) y abrí el túnel.</div>';
    box.innerHTML = html;
    var stops = box.querySelectorAll('[data-tstop]');
    for (var s = 0; s < stops.length; s++) {
        (function (btn) {
            btn.addEventListener('click', function () {
                stopTunnel(parseInt(btn.getAttribute('data-tstop'), 10));
            });
        })(stops[s]);
    }
    var cps = box.querySelectorAll('[data-tcopy]');
    for (var c = 0; c < cps.length; c++) {
        (function (btn) {
            btn.addEventListener('click', function () {
                copyText(btn.getAttribute('data-tcopy'), 'url copiada');
            });
        })(cps[c]);
    }
}

async function startTunnel() {
    var port = validPort(state.previewPort);
    if (!port) { toast('escribí un puerto válido (1–65535)', 'error'); return; }
    try { localStorage.setItem('ob_lastPort', String(port)); } catch (e) {}
    var already = (state.tunnels || []).some(function (t) { return parseInt(t.port, 10) === port && (t.https || t.http); });
    if (already) { toast('ya hay un túnel para el puerto ' + port, 'ok'); return; }
    renderTunnels('levantando túnel para el puerto ' + port + '… (la primera vez puede tardar si descarga tunnelmole)');
    var res = await runFsCommand('tunnel_start', String(port));
    if (!res.ok) {
        toast(res.error || 'no se pudo abrir el túnel', 'error');
        await refreshTunnels(true);
        return;
    }
    if (res.data && res.data.error) toast(res.data.error, 'error');
    await refreshTunnels(true);
}

async function stopTunnel(port) {
    if (!validPort(port)) return;
    renderTunnels('cerrando túnel del puerto ' + port + '…');
    var res = await runFsCommand('tunnel_stop', String(port));
    if (!res.ok) toast(res.error || 'no se pudo cerrar el túnel', 'error');
    await refreshTunnels(true);
}

async function refreshTunnels(quiet) {
    var res = await runFsCommand('tunnel_list', '');
    if (res.ok && res.data && Array.isArray(res.data.tunnels)) {
        state.tunnels = res.data.tunnels;
    } else if (!state.tunnels) {
        state.tunnels = [];
    }
    if (state.view === 'preview') renderTunnels();
    if (procState.open) renderProcTunnels();
}

// ---------------------------------------------------------------------------
// Procesos de la sesión activa (dev servers que corren en la PC vía el puente).
// proc_start/proc_stop/proc_list/proc_log viajan por la cola del puente como
// los túneles; el log se trae por trozos con un cursor (procState.offset).
// ---------------------------------------------------------------------------
function sessionProcFolder() {
    var s = state.currentSession;
    return (s && s.folder) ? s.folder : '';
}

function sessionProcLabel(folder) {
    var c = state.catalog;
    if (c && Array.isArray(c.folders)) {
        for (var i = 0; i < c.folders.length; i++) {
            if (c.folders[i].path === folder) return c.folders[i].name;
        }
    }
    return shortPath(folder);
}

// Encola un comando del puente y espera su resultado (hasta `tries` intentos).
// El primer chequeo es casi inmediato (el claim suele tardar < 1 s); después
// se va espaciando.
async function ocCommand(cmd, args, tries, gapMs) {
    var n = tries || 20;
    var g = gapMs || 700;
    var enq = await api('api.php?action=run_oc', apiCsrf('POST', { cmd: cmd, args: args || [] }));
    if (!enq.ok) return { ok: false, error: enq.error || 'no se pudo encolar' };
    for (var i = 0; i < n; i++) {
        await sleepMs(i === 0 ? 150 : (i < 3 ? 400 : g));
        var st = await api('api.php?action=oc_command_status&id=' + enq.id);
        if (st.ok && (st.status === 'done' || st.status === 'error')) {
            if (st.status === 'error') return { ok: false, error: st.error || 'error del puente' };
            try { return { ok: true, data: JSON.parse(st.result) }; }
            catch (e) { return { ok: false, error: 'respuesta inválida del puente' }; }
        }
    }
    return { ok: false, error: 'el puente tardó demasiado (¿está encendido?)' };
}

var procTimer = null;
var procLogBox = null;
var procLastFolder = '';
var procPolling = false;
var procTickCount = 0;
var procGen = 0;   // sube en cada reset/cambio de proceso: los resultados de un
                   // tick en vuelo que quedó viejo se descartan (sin estado rancio)
var PROC_POLL_MS = 2200;
var PROC_POLL_OFFLINE_MS = 5000;
var PROC_SUGGESTIONS = ['npm run dev', 'node server.js', 'npm start', 'npm run build'];

function procReset() {
    procGen++;
    procState.id = null;
    procState.offset = 0;
    procState.log = '';
    procState.logRendered = 0;
    procState.logDropped = false;
    procState.running = false;
    procState.exitCode = null;
    procState.cmd = '';
    procState.detectedPort = '';
    procState.portConflict = null;
}

function stopProcsPollTimer() {
    if (procTimer) { clearTimeout(procTimer); procTimer = null; }
}

function stopProcView() {
    // Sale de la vista (o cambia de sesión): corta el polling pero conserva
    // el estado (log/offset/cmd) para que al volver retome donde quedó.
    procState.open = false;
    stopProcsPollTimer();
}

function enterProcsView() {
    var folder = sessionProcFolder();
    if (!folder) {
        els.viewProcs.innerHTML = '<div class="placeholder">abrí una sesión con carpeta de proyecto para ver sus procesos.</div>';
        procState.open = false;
        stopProcsPollTimer();
        return;
    }
    if (procLastFolder !== folder) {
        // Otra sesión: estado limpio (log/id/puerto). Si es la misma carpeta,
        // se conserva el log y el cursor para retomar donde quedó.
        procLastFolder = folder;
        procReset();
    }
    procState.open = true;
    renderProcView(folder);
    procPollTick();
}

function renderProcView(folder) {
    var admin = isAdmin();
    els.viewProcs.innerHTML =
        '<div class="pp-head"><b>procesos</b><span class="pp-sub">' + esc(sessionProcLabel(folder)) + '</span>'
        + (state.currentId !== null ? '<button type="button" class="linkbtn pp-back" id="ppBack">← volver al chat</button>' : '')
        + '</div>'
        + '<div class="pp-status" id="procStatus"></div>'
        + '<div id="ppPortWarn"></div>'
        + '<pre id="procLog"><span class="pl-empty">sin salida todavía</span></pre>'
        + (admin ? '<div class="pp-tunnel">'
            + '<div class="pp-tunhead">compartir por túnel (tunnelmole, corre en tu PC)</div>'
            + '<div class="pp-tunform"><input type="text" id="ppTunPort" inputmode="numeric" placeholder="puerto (ej: 3000)" autocomplete="off">'
            + '<button type="button" class="linkbtn" id="ppTunStart">abrir túnel</button></div>'
            + '<div id="ppTunList"></div>'
            + '</div>' : '')
        + (admin ? '<div class="pp-chips" id="procChips"></div>' : '')
        + (admin ? '<div class="pp-form"><input type="text" id="procCmdInput" placeholder="npm run dev · node server.js …" autocomplete="off">'
            + '<button type="button" class="linkbtn" id="procStartBtn">iniciar</button></div>' : '')
        + (!admin ? '<div class="placeholder">solo un admin puede iniciar procesos o túneles.</div>' : '');
    var back = document.getElementById('ppBack');
    if (back) back.addEventListener('click', function () { showView('chat'); });
    var inp = document.getElementById('procCmdInput');
    if (inp) {
        inp.value = procState.input || '';
        inp.addEventListener('input', function () { procState.input = inp.value; });
        inp.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); startSessionProc(); }
        });
    }
    var startBtn = document.getElementById('procStartBtn');
    if (startBtn) startBtn.addEventListener('click', startSessionProc);
    var tunPort = document.getElementById('ppTunPort');
    if (tunPort) {
        tunPort.value = procState.detectedPort || '';
        tunPort.addEventListener('input', function () {
            tunPort.value = tunPort.value.replace(/[^0-9]/g, '');
            if (tunPort.value) state.previewPort = tunPort.value;
        });
        tunPort.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); panelStartTunnel(); }
        });
    }
    var tunStart = document.getElementById('ppTunStart');
    if (tunStart) tunStart.addEventListener('click', panelStartTunnel);
    if (admin) buildProcChips();
    procLogBox = document.getElementById('procLog');
    renderProcStatus();
    renderPortWarn();
    renderProcTunnels();
    refreshTunnels(true);
}

// Aviso "puerto en uso" cuando un dev server falla con EADDRINUSE, con la
// opción de liberarlo (pregunta antes de matar al proceso que lo agarra).
function renderPortWarn() {
    var box = document.getElementById('ppPortWarn');
    if (!box) return;
    if (!procState.portConflict) { box.innerHTML = ''; return; }
    var p = procState.portConflict;
    box.innerHTML = '<div class="pp-warn"><span>⚠ el puerto <b>' + esc(p) + '</b> está en uso'
        + ' (¿un dev server viejo?)</span>'
        + '<button type="button" class="linkbtn" id="ppFreePort">liberar puerto ' + esc(p) + '</button></div>';
    document.getElementById('ppFreePort').addEventListener('click', freePortConflict);
}

async function freePortConflict() {
    var p = procState.portConflict;
    if (!p) return;
    if (!confirm('¿Libero el puerto ' + p + '? Mata el proceso que lo está usando en tu PC.')) return;
    var btn = document.getElementById('ppFreePort');
    if (btn) btn.disabled = true;
    var res = await ocCommand('port_free', [String(p)], 30, 800);
    if (btn) btn.disabled = false;
    if (!res.ok) { toast(res.error || 'no se pudo liberar el puerto', 'error'); return; }
    if (res.data && res.data.freed) {
        toast('puerto ' + p + ' liberado · toqué iniciar para reintentar', 'ok');
        procState.portConflict = null;
        renderPortWarn();
    } else {
        toast('nadie está escuchando el puerto ' + p + ' ahora; reintentá iniciar', 'ok');
        procState.portConflict = null;
        renderPortWarn();
    }
}

function buildProcChips() {
    var box = document.getElementById('procChips');
    if (!box) return;
    var html = '';
    for (var i = 0; i < PROC_SUGGESTIONS.length; i++) {
        html += '<button type="button" class="chip" data-cmd="' + esc(PROC_SUGGESTIONS[i]) + '">' + esc(PROC_SUGGESTIONS[i]) + '</button>';
    }
    box.innerHTML = html;
    var chips = box.querySelectorAll('.chip');
    for (var c = 0; c < chips.length; c++) {
        (function (btn) {
            btn.addEventListener('click', function () {
                procState.input = btn.getAttribute('data-cmd');
                var inp = document.getElementById('procCmdInput');
                if (inp) inp.value = procState.input;
                startSessionProc();
            });
        })(chips[c]);
    }
}

function renderProcStatus(extra) {
    var box = document.getElementById('procStatus');
    if (!box) return;
    var startBtn = document.getElementById('procStartBtn');
    var html = '';
    var on = bridgeOnline();
    if (extra) {
        html = '<span class="dot"></span><span class="pp-cmd">' + esc(extra) + '</span>';
    } else if (!on) {
        html = '<span class="dot off"></span><span class="pp-cmd">puente apagado: no se pueden iniciar procesos</span>';
    } else if (procState.running) {
        html = '<span class="dot on"></span><span class="pp-cmd">' + esc(procState.cmd || 'proceso en marcha') + '</span>'
            + '<button type="button" class="linkbtn" id="procStopBtn">detener</button>';
    } else if (procState.exitCode !== null) {
        html = '<span class="dot off"></span><span class="pp-cmd">' + esc(procState.cmd || '')
            + (procState.exitCode === 0 ? ' · terminó' : ' · terminó con código ' + procState.exitCode) + '</span>'
            + (procState.exitErr ? ' <span style="color:var(--danger)">' + esc(procState.exitErr) + '</span>' : '');
    } else {
        html = '<span class="dot"></span><span class="pp-cmd">sin proceso en esta sesión · iniciá uno abajo</span>';
    }
    box.innerHTML = html;
    var stopBtn = document.getElementById('procStopBtn');
    if (stopBtn) stopBtn.addEventListener('click', stopSessionProc);
    if (startBtn) startBtn.disabled = !on;
    var input = document.getElementById('procCmdInput');
    if (input) input.disabled = !on;
}

function pushProcLog(text) {
    if (!text) return;
    var full = procState.log + text;
    if (full.length > 280000) {
        full = full.slice(-280000);
        procState.logDropped = true;
    }
    procState.log = full;
}

function flushProcLog() {
    if (!procLogBox) return;
    var wasBottom = procLogBox.scrollHeight - procLogBox.scrollTop - procLogBox.clientHeight < 48;
    if (procState.logDropped) {
        procLogBox.textContent = procState.log;
        procState.logDropped = false;
    } else if (procState.log.length > procState.logRendered) {
        if (procState.logRendered === 0) procLogBox.textContent = ''; // quita el placeholder
        var span = document.createElement('span');
        span.textContent = procState.log.slice(procState.logRendered);
        procLogBox.appendChild(span);
    }
    procState.logRendered = procState.log.length;
    if (wasBottom) procLogBox.scrollTop = procLogBox.scrollHeight;
}

function scheduleProcPoll() {
    stopProcsPollTimer();
    if (!procState.open) return;
    var delay = bridgeOnline() ? PROC_POLL_MS : PROC_POLL_OFFLINE_MS;
    procTimer = setTimeout(procPollTick, delay);
}

async function procPollTick() {
    if (!procState.open || procPolling) return;   // un solo loop de polling
    procPolling = true;
    var myGen = procGen;
    try {
        var folder = sessionProcFolder();
        if (!folder) {
            // Se fue la carpeta (sesión cerrada): mensaje y fuera.
            els.viewProcs.innerHTML = '<div class="placeholder">abrí una sesión con carpeta de proyecto para ver sus procesos.</div>';
            procState.open = false;
            stopProcsPollTimer();
            return;
        }
        if (!bridgeOnline()) {
            renderProcStatus();
            scheduleProcPoll();
            return;
        }
        // "consultando…" solo hasta que sepamos el estado: después el estado
        // real persiste entre ticks (si no, el cartel parpadea en cada ciclo).
        if (!procState.id && !procState.running && procState.exitCode === null) {
            renderProcStatus('consultando…');
        }
        // proc_list solo cuando falta el proceso o ya terminó (para detectar
        // reinicios). Si corre, el proc_log ya trae running/done/exitCode:
        // la mitad de los comandos por ciclo.
        var needList = !procState.id || !procState.running;
        var list = needList ? await ocCommand('proc_list', [], 40, 600) : { ok: true, skipped: true };
        if (myGen !== procGen) return; // el estado cambó mientras volaba: descartar
        var knowNothing = !procState.id && !procState.running && procState.exitCode === null;
        if (list.ok && !list.skipped) {
            var mine = null;
            if (list.data && Array.isArray(list.data.procs)) {
                var cand = [];
                for (var i = 0; i < list.data.procs.length; i++) {
                    if (list.data.procs[i].folder === folder) cand.push(list.data.procs[i]);
                }
                // Preferimos el proceso corriente; si no hay, el más reciente.
                for (var k = 0; k < cand.length; k++) {
                    if (cand[k].running) { mine = cand[k]; break; }
                    if (!mine || cand[k].id > mine.id) mine = cand[k];
                }
            }
            if (mine && mine.id !== procState.id) {
                procReset();
                procState.id = mine.id;
            }
            if (mine) {
                procState.running = !!mine.running;
                procState.exitCode = mine.exitCode;
                if (mine.cmd) procState.cmd = mine.cmd;
                procState.exitErr = mine.exitErr || '';
            } else {
                // Sin proceso en esta carpeta (o el puente lo olvidó al reiniciar):
                // estado limpio, no arrastrar el botón "detener" de un proceso muerto.
                if (procState.id || procState.running) {
                    // Veníamos de seguir un proceso que ya no existe: casi seguro
                    // el puente se reinició (los procesos mueren con él).
                    toast('el puente se reinició: los procesos quedaron cortados', 'ok');
                }
                procState.running = false;
                procState.exitCode = null;
                procState.id = null;
                procState.log = '';
                procState.offset = 0;
                procState.cmd = '';
            }
            knowNothing = !procState.id && !procState.running && procState.exitCode === null;
        }
        if (procState.id) {
            var res = await ocCommand('proc_log', [String(procState.id), String(procState.offset)], 40, 600);
            if (myGen !== procGen) return; // idem: el reset de un inicio/parada ganó
            if (res.ok && res.data) {
                pushProcLog(res.data.text);
                procState.offset = (res.data.offset || 0);
                if (res.data.spawnError) procState.exitErr = res.data.spawnError;
                if (res.data.done) {
                    procState.running = false;
                    procState.exitCode = res.data.exitCode;
                }
                // Puerto del dev server detectado en la salida (para el túnel).
                var pm = String(res.data.text || '').match(/(?:localhost|127\.0\.0\.1):\s*(\d{1,5})/i);
                if (pm && !procState.detectedPort) {
                    procState.detectedPort = pm[1];
                    var tp = document.getElementById('ppTunPort');
                    if (tp && !tp.value) tp.value = pm[1];
                }
                // Puerto en uso (dev server viejo): ofrecer liberarlo.
                if (!procState.portConflict) {
                    var em = String(res.data.text || '').match(/EADDRINUSE[^0-9]*([0-9]{1,5})/i)
                        || String(res.data.text || '').match(/address already in use[^0-9]*([0-9]{1,5})/i);
                    if (em) procState.portConflict = parseInt(em[1], 10);
                }
            }
        }
        // Túneles: refresco liviano cada 3 ciclos (cada uno es un comando más).
        procTickCount++;
        if (procState.open && procTickCount % 3 === 0) {
            await refreshTunnels(true);
        }
        if (procState.open && myGen === procGen) {
            // Con la cola caída o lenta: conservar el último estado real en vez
            // de pintar "sin proceso" (que escondería el botón "detener").
            if (list.ok || !knowNothing) renderProcStatus();
            renderPortWarn();
            flushProcLog();
        }
    } catch (e) {
        // nunca deja de pollear
    } finally {
        procPolling = false;
        scheduleProcPoll();
    }
}

async function startSessionProc() {
    var folder = sessionProcFolder();
    if (!folder) return;
    var cmd = (procState.input || '').trim();
    if (!cmd) { toast('escribí un comando (ej: npm run dev)', 'error'); return; }
    renderProcStatus('iniciando: ' + cmd + '…');
    var res = await ocCommand('proc_start', [folder, cmd], 45, 700);
    if (!res.ok) {
        if ((res.error || '').indexOf('tardó demasiado') >= 0) {
            // El puente está procesando un mensaje: el comando quedó encolado
            // y va a arrancar cuando se libere. El polling lo adopta solo.
            toast('el puente está ocupado; el proceso va a arrancar en cuanto se libere', 'ok');
            renderProcStatus('esperando al puente (ocupado)…');
            return;
        }
        toast(res.error || 'no se pudo iniciar el proceso', 'error');
        renderProcStatus();
        return;
    }
    procReset();
    procState.id = res.data && res.data.id ? res.data.id : null;
    procState.running = true;
    procState.cmd = cmd;
    procState.input = cmd;
    if (!procState.id) { toast('no se recibió el id del proceso', 'error'); }
    await procPollTick();
}

async function stopSessionProc() {
    if (!procState.id) return;
    renderProcStatus('deteniendo…');
    var res = await ocCommand('proc_stop', [String(procState.id)], 30, 700);
    procGen++;
    if (!res.ok) toast(res.error || 'no se pudo detener el proceso', 'error');
    await procPollTick();
}

function renderProcTunnels(busyMsg) {
    var box = document.getElementById('ppTunList');
    if (!box) return;
    var list = state.tunnels || [];
    var html = '';
    for (var i = 0; i < list.length; i++) {
        var t = list[i];
        var ready = !!(t.https || t.http);
        html += '<div class="tunnel"><div class="thead"><span class="dot"' + (ready ? '' : ' style="background:var(--muted)"') + '></span>'
            + '<b>puerto ' + esc(t.port) + '</b><span class="tnote">' + (ready ? 'activo' : 'levantando…') + '</span>'
            + (isAdmin() ? '<button type="button" class="linkbtn" data-ptstop="' + esc(t.port) + '">cerrar</button>' : '')
            + '</div>'
            + (t.https ? '<div class="turl"><a href="' + esc(t.https) + '" target="_blank" rel="noopener noreferrer">' + esc(t.https) + '</a>'
                + '<button type="button" class="copybtn" data-ptcopy="' + esc(t.https) + '" title="Copiar URL">⧉</button></div>' : '')
            + (t.http && t.http !== t.https ? '<div class="turl"><a href="' + esc(t.http) + '" target="_blank" rel="noopener noreferrer">' + esc(t.http) + '</a>'
                + '<button type="button" class="copybtn" data-ptcopy="' + esc(t.http) + '" title="Copiar URL">⧉</button></div>' : '')
            + '</div>';
    }
    if (busyMsg) html += '<div class="pp-msg" style="padding:4px 0 0">' + esc(busyMsg) + '</div>';
    if (!html) html = '<div class="pp-msg" style="padding:4px 0 0">sin túneles abiertos</div>';
    box.innerHTML = html;
    var stops = box.querySelectorAll('[data-ptstop]');
    for (var s = 0; s < stops.length; s++) {
        (function (btn) {
            btn.addEventListener('click', function () {
                panelStopTunnel(parseInt(btn.getAttribute('data-ptstop'), 10));
            });
        })(stops[s]);
    }
    var cps = box.querySelectorAll('[data-ptcopy]');
    for (var c = 0; c < cps.length; c++) {
        (function (btn) {
            btn.addEventListener('click', function () {
                copyText(btn.getAttribute('data-ptcopy'), 'url copiada');
            });
        })(cps[c]);
    }
}

// Túnel desde el panel de la sesión (misma cola del puente que los procesos).
async function panelStartTunnel() {
    var inp = document.getElementById('ppTunPort');
    var port = validPort(inp ? inp.value : '');
    if (!port) { toast('escribí un puerto válido (1–65535)', 'error'); return; }
    try { localStorage.setItem('ob_lastPort', String(port)); } catch (e) {}
    var already = (state.tunnels || []).some(function (t) { return parseInt(t.port, 10) === port; });
    if (already) { toast('ya hay un túnel para el puerto ' + port, 'ok'); return; }
    renderProcTunnels('levantando túnel para el puerto ' + port + '… (la primera vez descarga tunnelmole)');
    // Tope generoso: con el fallback de npx la primera vez descarga el paquete.
    var res = await ocCommand('tunnel_start', [String(port)], 90, 800);
    if (!res.ok) toast(res.error || 'no se pudo abrir el túnel', 'error');
    await refreshTunnels(true);
    renderProcTunnels();
}

async function panelStopTunnel(port) {
    if (!validPort(port)) return;
    renderProcTunnels('cerrando túnel del puerto ' + port + '…');
    var res = await ocCommand('tunnel_stop', [String(port)], 30, 700);
    if (!res.ok) toast(res.error || 'no se pudo cerrar el túnel', 'error');
    await refreshTunnels(true);
    renderProcTunnels();
}

// ---------------------------------------------------------------------------
// SSE: stream persistente con fallback a polling.
// ---------------------------------------------------------------------------
function scheduleRefresh(reason) {
    var now = Date.now();
    if (state.refreshPending) return;
    var elapsed = now - (state.lastRefresh || 0);
    var wait = elapsed < 600 ? (600 - elapsed) : 0;
    state.refreshPending = true;
    setTimeout(function () {
        state.refreshPending = false;
        state.lastRefresh = Date.now();
        refreshActiveView(reason);
    }, wait);
}

function sseDisabled() {
    if (typeof CFG.sseDisabled !== 'undefined') return !!CFG.sseDisabled;
    try {
        var h = location.hostname || '';
        if (h === '127.0.0.1' || h === 'localhost') return true;
        var m = /[?&]sse=0(?:&|$)/.test(location.search || '');
        if (m) return true;
    } catch (e) {}
    return false;
}

function startSSE() {
    if (state.sseBroken) { startPollingFallback(); return; }
    if (state.sse) { try { state.sse.close(); } catch (e) {} }
    if (sseDisabled()) {
        try { console.log('SSE desactivado (local), usando polling'); } catch (e) {}
        startPollingFallback();
        return;
    }
    if (!('EventSource' in window)) { startPollingFallback(); return; }
    var es = new EventSource('api.php?action=stream&bridge=' + encodeURIComponent(activeBridgeId()));
    state.sse = es;
    state.sseGotHello = false;
    // Si el hosting bufferea la respuesta, 'hello' no llega a tiempo:
    // cortamos y pasamos a polling para no quedarnos colgados.
    clearTimeout(state.sseHelloTimer);
    state.sseHelloTimer = setTimeout(function () {
        if (!state.sseGotHello) {
            state.sseBroken = true;
            try { es.close(); } catch (e2) {}
            state.sse = null;
            try { console.log('SSE sin respuesta (hosting lo bufferea), usando polling'); } catch (e3) {}
            startPollingFallback();
        }
    }, 6000);
    es.addEventListener('hello', function () {
        state.sseGotHello = true;
        clearTimeout(state.sseHelloTimer);
        state.sseBackoff = 1000;
    });
    es.addEventListener('online', function (e) {
        // Latido de los puentes: evento liviano con su resumen (selector).
        try {
            var d = JSON.parse(e.data);
            if (Array.isArray(d.bridges)) applyBridges(d.bridges);
            if (d.ts && state.catalog) {
                var info = activeBridgeInfo();
                if (info && info.online) state.catalog.last_online_ts = d.ts;
            }
            applyOnlineUI();
        } catch (err) { /* ignore */ }
    });
    es.addEventListener('catalog', function (e) {
        // Cambió el catálogo de un puente: solo interesa si es el activo.
        try {
            var d = JSON.parse(e.data);
            if (typeof d.bridge !== 'string') return;
            if (d.bridge === activeBridgeId()) refreshActiveCatalog();
        } catch (err) { /* ignore */ }
    });
    es.addEventListener('sessions_changed', function () {
        if (state.view === 'home') scheduleRefresh('sessions_changed');
        else if (state.view === 'chat') scheduleRefresh('sessions_changed');
        else if (state.view === 'history') scheduleRefresh('sessions_changed');
        else if (state.view === 'sessions' && typeof loadSessionsView === 'function') loadSessionsView();
    });
    es.addEventListener('ping', function () { /* keep-alive */ });
    es.addEventListener('bye', function () {
        state.sseBackoff = 1000;
    });
    es.onerror = function () {
        clearTimeout(state.sseHelloTimer);
        if (state.sseBroken) return;
        try { es.close(); } catch (e) {}
        state.sse = null;
        setTimeout(function () { startSSE(); }, state.sseBackoff);
        state.sseBackoff = Math.min(state.sseBackoff * 2, 15000);
    };
}

// Polling (fallback cuando no hay SSE o el hosting lo bufferea).
// Adaptativo: sondeo liviano del catálogo (con ?v= responde mínimo si no
// cambió) y refresco rápido del chat solo mientras hay algo esperando.
function chatWaiting() {
    if (state.view !== 'chat' || !state.messages.length) return false;
    // Miramos los últimos 3: mientras el usuario esté pendiente O el borrador
    // del asistente siga en streaming hay que refrescar rápido (si no, la
    // respuesta final nunca llega y la franja KITT queda pegada).
    var n = state.messages.length;
    for (var i = n - 1; i >= Math.max(0, n - 3); i--) {
        var st = state.messages[i].status || 'done';
        if (st === 'pending' || st === 'processing' || st === 'streaming') return true;
    }
    return false;
}

function startPollingFallback() {
    if (state.pollTimer) return;
    var tick = async function () {
        var wait = POLL_BASE_MS;
        try {
            var data = await api('api.php?action=catalog&v=' + encodeURIComponent(state.catVer || ''));
            if (data.ok && applyCatalogPayload(data)) scheduleRefresh('poll');
        } catch (e) { /* reintenta en el próximo ciclo */ }
        if (state.view === 'chat') {
            if (chatWaiting()) {
                scheduleRefresh('poll-chat');
                wait = POLL_FAST_MS;
            }
        } else if (state.view === 'home') {
            scheduleRefresh('poll-sessions');
        }
        state.pollTimer = setTimeout(tick, wait);
    };
    tick();
}

function refreshActiveView(reason) {
    if (state.view === 'home' && typeof loadSessions === 'function') loadSessions();
    else if (state.view === 'chat') {
        if (state.currentId !== null && typeof loadHistory === 'function') loadHistory(state.currentId, true);
        // El sidebar necesita previews frescas (punto "esperando respuesta").
        if (typeof loadSessions === 'function') loadSessions();
    }
    else if (state.view === 'files' && typeof loadFiles === 'function') loadFiles(state.filesPath);
    else if (state.view === 'sessions' && typeof loadSessionsView === 'function') loadSessionsView();
    else if (state.view === 'history' && typeof renderHistory === 'function') renderHistory();
    // search: solo refresca si hay query activa (lo dispara el debounce del input)
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
// Arranque en dos fases: pinta al instante con la caché local y refresca con
// un único llamado a bootstrap (catálogo condicionado por versión + sesiones).
async function boot() {
    var cachedCat = lsGet(catalogKey());
    var cachedVer = lsGet(catalogVerKey());
    var cachedSessions = lsGet('ob_sessions');
    var painted = false;
    if (cachedCat && typeof cachedCat === 'object') {
        state.catalog = cachedCat;
        state.catVer = typeof cachedVer === 'string' ? cachedVer : '';
        fillSelects();
        applyOnlineUI();
    }
    if (Array.isArray(cachedSessions) && cachedSessions.length) {
        renderHome(cachedSessions);
        painted = true;
    }
    renderBridgeBar();
    var data = await api('api.php?action=bootstrap&v=' + encodeURIComponent(state.catVer || ''));
    if (data.ok) {
        applyBootPayload(data);
    } else if (!painted) {
        els.home.innerHTML = '<div class="empty">Sin conexión</div>';
    }
}

// ---------------------------------------------------------------------------
// Avisos push (Web Push nativo de la PWA).
// Suscripción del dispositivo al push service; el servidor guarda el endpoint
// y avisa cuando la IA termina de responder.
// ---------------------------------------------------------------------------
function pushSupported() {
    return !!(CFG.pushEnabled && CFG.pushKey
        && 'Notification' in window && 'PushManager' in window
        && 'serviceWorker' in navigator && window.isSecureContext);
}

function b64urlToBytes(b64) {
    var t = String(b64).replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    var bin = atob(t);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function bytesToB64url(buf) {
    var bytes = new Uint8Array(buf);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pushSetBtn(on, denied) {
    if (!els.btnPush) return;
    els.btnPush.classList.remove('on', 'denied');
    if (denied) els.btnPush.classList.add('denied');
    else if (on) els.btnPush.classList.add('on');
    els.btnPush.setAttribute('aria-pressed', on ? 'true' : 'false');
    els.btnPush.title = on ? 'Avisos activados · tocar para desactivar'
        : (denied ? 'Avisos bloqueados por el navegador' : 'Activar avisos en este dispositivo');
}

async function pushReport(sub) {
    var p256dh = sub.getKey ? sub.getKey('p256dh') : null;
    var auth = sub.getKey ? sub.getKey('auth') : null;
    if (!p256dh || !auth) return false;
    var res = await api('api.php?action=push_subscribe', apiCsrf('POST', {
        endpoint: sub.endpoint,
        p256dh: bytesToB64url(p256dh),
        auth: bytesToB64url(auth),
        ua: (navigator.userAgent || '').slice(0, 120)
    }));
    return !!(res && res.ok);
}

async function pushSubscribe() {
    var reg = await navigator.serviceWorker.ready;
    var sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64urlToBytes(CFG.pushKey)
    });
    return await pushReport(sub);
}

async function pushDisable() {
    var reg = await navigator.serviceWorker.ready;
    var sub = await reg.pushManager.getSubscription();
    if (sub) {
        api('api.php?action=push_unsubscribe', apiCsrf('POST', { endpoint: sub.endpoint }));
        try { await sub.unsubscribe(); } catch (e) {}
    }
    pushSetBtn(false, false);
    toast('Avisos desactivados en este dispositivo');
}

async function pushSync() {
    if (!pushSupported()) return;
    els.btnPush.style.display = 'inline-flex';
    if (Notification.permission !== 'granted') {
        pushSetBtn(false, Notification.permission === 'denied');
        return;
    }
    var sub = null;
    try {
        var reg = await navigator.serviceWorker.ready;
        sub = await reg.pushManager.getSubscription();
    } catch (e) { pushSetBtn(false, false); return; }
    if (!sub) {
        try {
            var ok = await pushSubscribe();
            pushSetBtn(ok, false);
        } catch (e) { pushSetBtn(false, false); }
        return;
    }
    // Ya existe la suscripción: se re-reporta (idempotente) por si el servidor la perdió.
    var ok = await pushReport(sub);
    pushSetBtn(ok, false);
}

function initPush() {
    if (!pushSupported()) return;
    els.btnPush.addEventListener('click', async function () {
        if (Notification.permission === 'denied') {
            toast('Los avisos están bloqueados · permitilos en los ajustes del navegador', 'error');
            return;
        }
        // Pedir el permiso al inicio del handler conserva el gesto del usuario.
        if (Notification.permission !== 'granted') {
            var granted = (await Notification.requestPermission()) === 'granted';
            if (!granted) {
                pushSetBtn(false, Notification.permission === 'denied');
                toast('Necesitás permitir las notificaciones para recibir avisos', 'error');
                return;
            }
        }
        var sub = null;
        try {
            var reg = await navigator.serviceWorker.ready;
            sub = await reg.pushManager.getSubscription();
        } catch (e) {}
        if (sub) {
            pushDisable();
            return;
        }
        try {
            var ok = await pushSubscribe();
            if (ok) {
                pushSetBtn(true, false);
                toast('Avisos activados · te avisamos cuando la IA responda');
            } else {
                toast('No se pudieron registrar los avisos', 'error');
            }
        } catch (e) {
            toast('No se pudieron activar los avisos', 'error');
        }
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(function () {}).then(function () {
        return pushSync();
    });
}

applyTheme(state.theme, { persist: false });
bindChatSearch();
els.messages.addEventListener('scroll', onMsgScroll, { passive: true });
autoGrow();
showView('home');
boot();
startSSE();
if (INITIAL_SESSION !== null) openChat(INITIAL_SESSION);

if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(function () {});
}

if (pushSupported()) initPush();
