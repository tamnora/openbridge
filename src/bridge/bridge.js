/**
 * Puente entre tu hosting (PHP) y opencode en tu PC (v2).
 *
 * - Lee bridge/folders.json y `opencode models`, y los sincroniza al hosting.
 * - Consulta el hosting por mensajes nuevos (poll) y ejecuta:
 *      opencode run --model <m> [--session <id> | --title bridge-<session-app>] "<mensaje>"
 *   en la carpeta del chat. Luego publica la respuesta y enlaza la sesión real
 *   de opencode con el chat para continuarla en los siguientes mensajes.
 *
 * Uso:
 *   node bridge.js            (usa bridge/config.json)
 */
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Casa portable: config.json, folders.json, logs y estado viven en
// `<base>/.openbridge`. La CLI setea OPENBRIDGE_HOME a la base (cwd/--dir); si
// no hay env, soportamos la instalacion clasica (config al lado del script) o
// una base deducida del cwd.
const BASE = process.env.OPENBRIDGE_HOME || process.env.OPENCONEX_HOME || '';
const HOME = BASE
    ? path.join(BASE, '.openbridge')
    : (function () {
        if (fs.existsSync(path.join(__dirname, 'config.json'))) return __dirname;
        if (fs.existsSync(path.join(__dirname, '.openbridge', 'config.json'))) return path.join(__dirname, '.openbridge');
        return path.join(process.cwd(), '.openbridge');
    })();

const CONFIG_PATH = path.join(HOME, 'config.json');
const MODE_PATH = path.join(HOME, 'mode.txt');
const config = loadConfig();

if (!config.apiUrl) {
    console.error('[bridge] Falta "apiUrl" en ' + CONFIG_PATH);
    process.exit(1);
}

// Identidad de este puente (una computadora). El hosting puede atender varias
// PCs a la vez: cada una sincroniza su catálogo y ejecuta SUS sesiones. Sin
// config.bridgeId, se usa el hostname de la máquina.
const BRIDGE_ID = (function () {
    let raw = String(config.bridgeId || os.hostname() || '');
    let id = raw.replace(/[^A-Za-z0-9._\-]/g, '');
    id = id.replace(/^[^A-Za-z0-9]+/, '');
    id = id.slice(0, 40);
    return /^[A-Za-z0-9][A-Za-z0-9._\-]{0,39}$/.test(id) ? id : 'puente';
})();
const BRIDGE_NAME = (String(config.bridgeName || config.bridgeId || os.hostname() || BRIDGE_ID))
    .replace(/[^\p{L}\p{N} ._\-]/gu, '').slice(0, 40) || BRIDGE_ID;

// Lock anti-instancias-múltiples: dos puentes compiten por el poll, corren
// barridos en paralelo y se pisan sync-state.json. Si el pid del lock vive,
// este proceso se va; si el lock quedó huérfano, se adopta.
const LOCK_PATH = path.join(HOME, '.bridge.pid');
try {
    const prev = parseInt(fs.readFileSync(LOCK_PATH, 'utf8').trim(), 10);
    if (prev && prev !== process.pid) {
        let alive = false;
        try { process.kill(prev, 0); alive = true; } catch (e) { /* muerto */ }
        if (alive) {
            console.error('[bridge] Ya hay un puente corriendo (pid ' + prev + '). Reinicialo con `openbridge bridge --reload` (o cerralo con `openbridge bridge --stop`).');
            process.exit(1);
        }
        console.error('[bridge] lock huérfano (pid ' + prev + ' ya no existe); lo adopto.');
    }
} catch (e) { /* sin lock previo */ }
try { fs.writeFileSync(LOCK_PATH, String(process.pid)); } catch (e) {}
process.on('exit', function () {
    try {
        if (fs.readFileSync(LOCK_PATH, 'utf8').trim() === String(process.pid)) fs.unlinkSync(LOCK_PATH);
    } catch (e) { /* nada */ }
});

// Registro de procesos lanzados (dev servers). Si el puente muere de golpe
// (taskkill /F de la ventana de control, apagón), sus hijos sobreviven y
// quedan agarrando puertos: al arrancar, este puente los detecta y los mata.
const PROCS_STATE_PATH = path.join(HOME, '.procs.json');
function saveProcsState() {
    const list = [];
    for (const p of procs.values()) {
        if (!p.running || !p.proc || !p.proc.pid) continue;
        list.push({ pid: p.proc.pid, cmd: p.cmd, folder: p.folder, port: p.port || null, startedAt: p.startedAt });
    }
    try {
        if (list.length) fs.writeFileSync(PROCS_STATE_PATH, JSON.stringify(list, null, 2));
        else if (fs.existsSync(PROCS_STATE_PATH)) fs.unlinkSync(PROCS_STATE_PATH);
    } catch (e) { /* sin registro no cortamos nada */ }
}
function killOrphansFromState() {
    let list = [];
    try {
        list = JSON.parse(fs.readFileSync(PROCS_STATE_PATH, 'utf8'));
    } catch (e) { return; }
    if (!Array.isArray(list) || !list.length) return;
    const killed = new Set();
    const killPid = (pid, why) => {
        pid = parseInt(pid, 10);
        if (!pid || pid === process.pid || killed.has(pid)) return;
        killed.add(pid);
        try {
            if (process.platform === 'win32') {
                spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
            } else {
                process.kill(pid, 'SIGKILL');
            }
            log('limpieza: eliminé el proceso huérfano del puente anterior (pid ' + pid + (why ? ', ' + why : '') + ')');
        } catch (e) {
            log('aviso: no pude matar el huérfano pid ' + pid + ': ' + (e && e.message));
        }
    };
    for (const it of list) {
        if (!it || typeof it !== 'object') continue;
        // Si el registro es muy viejo, el pid pudo ser reciclado: no arriesgar.
        if (it.startedAt && (Date.now() - it.startedAt) > 24 * 60 * 60 * 1000) continue;
        let alive = false;
        try { process.kill(parseInt(it.pid, 10), 0); alive = true; } catch (e) { /* muerto */ }
        if (alive) killPid(it.pid, it.cmd ? it.cmd : '');
        // El wrapper puede haber muerto y el hijo (el server) sobrevivió
        // agarrando el puerto: si conocemos el puerto, matamos a quien
        // escuche ahí. Es el caso clásico "npm start" → next/vite.
        if (it.port && tunnelPortOf([String(it.port)])) {
            killPidByPort(it.port);
        }
    }
    try { fs.unlinkSync(PROCS_STATE_PATH); } catch (e) { /* nada */ }
}

// Pid(s) escuchando en un puerto TCP (netstat en Windows; lsof/fuser en el resto).
function portListeners(port) {
    return runCmd(process.platform === 'win32' ? 'netstat' : 'lsof',
        process.platform === 'win32' ? ['-ano', '-p', 'tcp'] : ['-t', '-i', 'tcp:' + port, '-s', 'tcp:listen'],
        { timeout: 15000 }).then((r) => {
            if (process.platform !== 'win32') {
                return String(r.text || '').split(/\s+/).map(Number).filter((n) => n > 0);
            }
            const re = new RegExp(':' + port + '\\s');
            const pids = new Set();
            for (const line of String(r.text || '').split(/\r?\n/)) {
                if (!re.test(line) || !/LISTENING/i.test(line)) continue;
                const parts = line.trim().split(/\s+/);
                const pid = parseInt(parts[parts.length - 1], 10);
                if (pid > 0) pids.add(pid);
            }
            return [...pids];
        }).catch(() => []);
}

async function killPidByPort(port) {
    try {
        const pids = await portListeners(port);
        for (const pid of pids) {
            try {
                if (process.platform === 'win32') {
                    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
                } else {
                    process.kill(pid, 'SIGKILL');
                }
                log('limpieza: eliminé al que escuchaba el puerto ' + port + ' (pid ' + pid + ')');
            } catch (e) { /* sigue */ }
        }
    } catch (e) { /* nada */ }
}
killOrphansFromState();

// Modo activo: 'remoto' (hosting) o 'local' (php -S en la PC).
// Se alterna escribiendo "local"/"remoto" en bridge/mode.txt (lo hace la
// ventana OpenConex); el puente lo toma en el próximo ciclo sin reiniciar.
let activeMode = null;

const LOG_PATH = config.logFile
    ? path.resolve(HOME, config.logFile)
    : path.join(HOME, 'logs', 'bridge.log');
try { fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true }); } catch (e) { /* nada */ }

let busy = false;
const STARTED_AT = Date.now();
// Tras una respuesta del hosting volvemos a pollear rápido: con long-poll el
// hosting retiene la respuesta cuando no hay nada, así que el ritmo real de
// requests queda bajo incluso pidiendo seguido.
const POLL_QUICK_MS = 300;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function ts() {
    return new Date().toISOString();
}

function log(...parts) {
    const line = '[' + ts() + '] ' + parts.join(' ');
    try {
        fs.appendFileSync(LOG_PATH, line + '\n');
    } catch (e) { /* sin log no detenemos el puente */ }
    console.log(line);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
function loadConfig() {
    let raw;
    try {
        raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    } catch (e) {
        console.error('No se pudo leer ' + CONFIG_PATH + ': ' + e.message);
        process.exit(1);
    }
    try {
        const cfg = JSON.parse(raw);
        const merged = Object.assign(
            {
                apiToken: '',
                apiUrlLocal: '',
                mode: 'remoto',
                pollIntervalMs: 1500,
                command: 'opencode',
                opencodeTimeoutMs: 15 * 60 * 1000,
                logFile: 'bridge.log',
                foldersFile: 'folders.json',
                workspace: '',
                allowCreateFolders: false,
                // Cuantas sesiones recientes publica el indice por proyecto
                // conectado (el hub arranca en blanco y se conectan a mano).
                sessionIndexLimit: 4,
                models: [],
                agents: ['build', 'plan'],
                bridgeId: '',
                bridgeName: '',
                // Modo proxy: el hub no guarda el historial de las sesiones; el
                // barrido publica el indice liviano y la web pide el historial
                // on demand (session_history). La conversacion vive en opencode.
                proxyHistory: true,
                // Procesos de desarrollo lanzados desde la web (proc_start...).
                // bins mapea un nombre a una ruta (p. ej. php fuera del PATH).
                processes: {
                    enabled: true,
                    allow: ['npm', 'node', 'npx', 'php', 'python', 'python3', 'composer', 'pnpm', 'yarn'],
                    maxGlobal: 3,
                    bins: {},
                },
            },
            cfg
        );
        // Overrides por entorno (los setea `openbridge bridge --api --token ...`).
        if (process.env.OPENBRIDGE_API_URL) merged.apiUrl = process.env.OPENBRIDGE_API_URL;
        if (process.env.OPENBRIDGE_API_TOKEN) merged.apiToken = process.env.OPENBRIDGE_API_TOKEN;
        if (process.env.OPENBRIDGE_BRIDGE_ID) merged.bridgeId = process.env.OPENBRIDGE_BRIDGE_ID;
        if (process.env.OPENBRIDGE_BRIDGE_NAME) merged.bridgeName = process.env.OPENBRIDGE_BRIDGE_NAME;
        return merged;
    } catch (e) {
        console.error('config.json no es un JSON valido: ' + e.message);
        process.exit(1);
    }
}

// ---------------------------------------------------------------------------
// Carpetas habilitadas (bridge/folders.json)
// ---------------------------------------------------------------------------
function foldersFilePath() {
    return path.resolve(HOME, config.foldersFile);
}

function readFolders() {
    try {
        const parsed = JSON.parse(fs.readFileSync(foldersFilePath(), 'utf8'));
        return Array.isArray(parsed.folders) ? parsed.folders : [];
    } catch (e) {
        return [];
    }
}

function writeFolders(list) {
    fs.writeFileSync(foldersFilePath(), JSON.stringify({ folders: list }, null, 2));
}

// Una carpeta esta "conectada" solo si su flag active es true. Los folders.json
// viejos (sin flag) arrancan inactivos: el hub queda en blanco hasta que el
// usuario conecta un proyecto desde la web.
function folderIsActive(f) {
    return !!(f && typeof f !== 'string' && f.active === true);
}

// Normaliza una ruta para comparar carpetas (mismo criterio que el hub).
function normFolder(f) {
    return String(f || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}
function sameFolder(a, b) {
    return normFolder(a) === normFolder(b);
}

// Limite de sesiones publicadas de una carpeta (0 = usar el global).
function folderLimitOf(f) {
    const n = (f && typeof f === 'object' && Number(f.limit) > 0) ? Math.floor(Number(f.limit)) : 0;
    return n > 0 ? Math.min(200, n) : 0;
}

// Carpetas conectadas (activas) que todavia existen en disco, con su limite.
function activeFolderEntries() {
    const out = [];
    for (const f of readFolders()) {
        const p = typeof f === 'string' ? f : (f && f.path);
        if (!p || !folderIsActive(f)) continue;
        try { if (!fs.statSync(p).isDirectory()) continue; } catch (e) { continue; }
        out.push({ path: p, limit: folderLimitOf(f) });
    }
    return out;
}

// Rutas de las carpetas conectadas (activas) que todavia existen en disco.
function activeFolders() {
    return activeFolderEntries().map((e) => e.path);
}

// Marca/desmarca una carpeta como conectada (la agrega a folders.json si no
// estaba). Devuelve la ruta absoluta o '' si el path es invalido.
function setFolderActive(folderPath, active) {
    const p = String(folderPath || '').trim();
    if (!p) return '';
    let abs;
    try { abs = path.resolve(p); } catch (e) { return ''; }
    const list = readFolders();
    let idx = -1;
    for (let i = 0; i < list.length; i++) {
        const fp = typeof list[i] === 'string' ? list[i] : (list[i] && list[i].path);
        if (fp && path.resolve(fp) === abs) { idx = i; break; }
    }
    if (idx >= 0) {
        const cur = list[idx];
        const next = {
            name: (cur && typeof cur === 'object' && cur.name) ? cur.name : path.basename(abs),
            path: abs,
            active: !!active,
        };
        if (active && cur && typeof cur === 'object' && Number(cur.limit) > 0) next.limit = Math.floor(Number(cur.limit));
        list[idx] = next;
    } else {
        list.push({ name: path.basename(abs), path: abs, active: !!active });
    }
    writeFolders(list);
    return abs;
}

// Sube el limite de sesiones publicadas de una carpeta conectada (boton "Ver
// mas sesiones"). Devuelve el limite nuevo o 0 si el path es invalido.
function bumpFolderLimit(folderPath, step) {
    const p = String(folderPath || '').trim();
    if (!p) return 0;
    let abs;
    try { abs = path.resolve(p); } catch (e) { return 0; }
    const def = Math.max(1, Math.min(200, parseInt(config.sessionIndexLimit, 10) || 4));
    const inc = Math.max(1, parseInt(step, 10) || def);
    const list = readFolders();
    let idx = -1;
    for (let i = 0; i < list.length; i++) {
        const fp = typeof list[i] === 'string' ? list[i] : (list[i] && list[i].path);
        if (fp && path.resolve(fp) === abs) { idx = i; break; }
    }
    if (idx < 0) {
        list.push({ name: path.basename(abs), path: abs, active: true, limit: inc });
        writeFolders(list);
        return inc;
    }
    const cur = list[idx];
    const prev = folderLimitOf(cur) || def;
    const next = Math.max(1, Math.min(200, prev + inc));
    list[idx] = {
        name: (cur && typeof cur === 'object' && cur.name) ? cur.name : path.basename(abs),
        path: abs,
        active: true,
        limit: next,
    };
    writeFolders(list);
    return next;
}

// Desconecta todas las carpetas (reset del hub): el puente deja de publicar
// sesiones hasta que el usuario vuelva a conectar un proyecto.
function clearActiveFolders() {
    const list = readFolders().map((f) => {
        if (typeof f === 'string') return { name: path.basename(f), path: path.resolve(f), active: false };
        return { name: (f && f.name) || path.basename((f && f.path) || ''), path: (f && f.path) || '', active: false };
    });
    writeFolders(list);
    return list.length;
}

// ---------------------------------------------------------------------------
// API del hosting
// ---------------------------------------------------------------------------
function normalizeMode(v) {
    const m = String(v || '').trim().toLowerCase();
    if (m === 'local') return 'local';
    if (m === 'dual') return 'dual';
    return 'remoto';
}

// El modo pedido: mode.txt (escrito por la ventana OpenConex) tiene prioridad
// sobre config.json; el puente lo consulta en cada ciclo.
function requestedMode() {
    try {
        if (fs.existsSync(MODE_PATH)) {
            return normalizeMode(fs.readFileSync(MODE_PATH, 'utf8'));
        }
    } catch (e) { /* si no se puede leer, usamos config */ }
    return normalizeMode(config.mode);
}

// Destinos atendidos según el modo. En dual el puente sirve a los dos
// hostings a la vez: hace poll a cada uno y responde donde corresponde.
function activeTargets() {
    const mode = activeMode || requestedMode();
    return mode === 'dual' ? ['remoto', 'local'] : [mode];
}

function targetApiUrl(target) {
    if (target === 'local') {
        if (config.apiUrlLocal) return config.apiUrlLocal;
        log('aviso: destino "local" sin "apiUrlLocal" en config.json; uso el hosting remoto.');
        return config.apiUrl;
    }
    return config.apiUrl;
}

function activeApiUrl(target) {
    return targetApiUrl(target || (activeMode || requestedMode()));
}

// Detecta cambios de modo (local ↔ remoto ↔ dual) y resincroniza el catálogo.
function checkModeChange() {
    const want = requestedMode();
    if (activeMode === null) {
        activeMode = want;
        if (want === 'dual') {
            log('modo dual: atiendo remoto (' + config.apiUrl + ') y local (' + (config.apiUrlLocal || '(no definido)') + ')');
        } else {
            log('modo: ' + want + ' -> ' + targetApiUrl(want));
        }
        return;
    }
    if (want !== activeMode) {
        const prev = activeMode;
        activeMode = want;
        log('cambio de modo: ' + prev + ' -> ' + want);
        syncCatalog({ silent: true });
    }
}

async function api(action, body, target, opts) {
    let t = target;
    if (!t) {
        const targets = activeTargets();
        t = targets[0];
        if (targets.length > 1) {
            log('aviso: "' + action + '" sin destino en modo dual; uso ' + t + ' (revisar el ruteo)');
        }
    }
    const url = new URL(targetApiUrl(t));
    url.searchParams.set('action', action);

    const headers = { Accept: 'application/json' };
    let payload = null;
    if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
    }
    if (config.apiToken) {
        headers['X-Bridge-Token'] = config.apiToken;
    }
    // Identidad del puente: el hosting separa catálogo, sesiones y colas por PC.
    headers['X-Bridge-Id'] = BRIDGE_ID;
    headers['X-Bridge-Name'] = BRIDGE_NAME;

    const res = await fetch(url, {
        method: body !== undefined ? 'POST' : 'GET',
        headers,
        body: payload,
        signal: opts ? opts.signal : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
        throw new Error('HTTP ' + res.status + ' ' + (data.error || JSON.stringify(data)));
    }
    return data;
}

// ---------------------------------------------------------------------------
// Localizar opencode (Windows: resolver el .exe real del shim de pnpm/npm)
// ---------------------------------------------------------------------------
function resolveCommand() {
    const cmd = config.command;
    if (!cmd.includes(path.sep) && !cmd.includes('/')) {
        const found = resolveFromPath(cmd);
        if (found) return found;
    }
    return path.normalize(cmd.replace(/\//g, path.sep));
}

function resolveFromPath(name) {
    const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    if (process.platform !== 'win32') {
        for (const dir of dirs) {
            const p = path.join(dir, name);
            try {
                if (fs.existsSync(p)) return p;
            } catch (e) {}
        }
        return name;
    }

    const extras = ['.exe', '.cmd', '.bat'];
    for (const dir of dirs) {
        for (const ext of extras) {
            const p = path.join(dir, name + ext);
            try {
                if (!fs.existsSync(p)) continue;
                if (ext.toLowerCase() === '.exe') return p;
                const resolved = parseShimExe(p, dir);
                if (resolved) return resolved;
                return p;
            } catch (e) {}
        }
    }
    return name;
}

function parseShimExe(shimPath, shimDir) {
    const content = fs.readFileSync(shimPath, 'utf8');
    const m = content.match(/"([^"]+\.exe)"/i);
    if (!m) return null;
    let exe = m[1].replace(/%~dp0/gi, shimDir.endsWith(path.sep) ? shimDir : shimDir + path.sep);
    exe = exe.replace(/\//g, path.sep);
    return exe;
}

// Si `command` apunta a un script de Node (.js/.mjs/.cjs) lo ejecutamos con el
// node actual. Permite wrappers propios (p. ej. un runner que filtra logs) y
// que las pruebas usen un opencode simulado sin depender del PATH.
function isNodeScriptCommand(cmd) {
    return /\.(c|m)?js$/i.test(String(cmd || '').trim());
}

function commandSpec(args) {
    const cmd = config.command;
    if (isNodeScriptCommand(cmd)) {
        return { cmd: process.execPath, argv: [path.resolve(cmd)].concat(args) };
    }
    return { cmd: resolveCommand(), argv: args };
}

// ---------------------------------------------------------------------------
// Ejecutar comandos auxiliares de opencode
// ---------------------------------------------------------------------------
function stripAnsi(s) {
    return String(s || '')
        .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
        .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

// Spawn genérico con captura de salida y timeout (para helpers como port_free;
// runCli queda reservado al CLI de opencode).
function runCmd(bin, args, opts) {
    return new Promise((resolve) => {
        const timeoutMs = Math.max((opts && opts.timeout) || 0, 0);
        let child;
        try {
            child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        } catch (e) {
            resolve({ ok: false, code: null, text: '', spawnError: e.message });
            return;
        }
        let out = '';
        let timer = null;
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });
        if (timeoutMs) {
            timer = setTimeout(() => {
                try { child.kill(); } catch (e) { /* nada */ }
                resolve({ ok: false, code: null, text: out, killed: true });
            }, timeoutMs);
        }
        child.on('close', (code) => {
            if (timer) clearTimeout(timer);
            resolve({ ok: code === 0, code: code, text: out });
        });
        child.on('error', (e) => {
            if (timer) clearTimeout(timer);
            resolve({ ok: false, code: null, text: out, spawnError: e.message });
        });
    });
}

function runCli(args, opts) {
    return new Promise((resolve) => {
        const spec = commandSpec(args);
        const timeoutMs = Math.max((opts && opts.timeout) || 0, 0);
        const child = spawn(spec.cmd, spec.argv, {
            cwd: (opts && opts.cwd) || undefined,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: process.env,
            windowsHide: true,
        });

        let stdout = '';
        let stderr = '';
        let settled = false;
        let timer = null;

        if (timeoutMs > 0) {
            timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                try { child.kill(); } catch (e) {}
                resolve({ ok: false, code: null, text: (stripAnsi(stdout || stderr || '')).replace(/\s+$/g, ''), killed: true });
            }, timeoutMs);
        }

        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        // opencode lee stdin hasta EOF; si no cerramos, el pipe queda abierto y se cuelga.
        child.stdin.on('error', () => {});
        child.stdin.end();

        child.on('close', (code) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            const text = (stripAnsi(stdout || stderr || '')).replace(/\s+$/g, '');
            resolve({ ok: code === 0, code: code, text: text, killed: false });
        });

        // Sin esto, un spawn que falla (ENOENT puntual de Windows) cuelga la
        // promesa para siempre y congela el barrido.
        child.on('error', (err) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            resolve({ ok: false, code: null, text: '', killed: false, spawnError: err.message });
        });
    });
}

// Ejecuta opencode y emite {text, reasoning} acumulados por tramos vía onPartial.
// Los modelos razonadores emiten además eventos "reasoning" que se muestran
// en vivo (💭) y se guardan con la respuesta final.
// Resolución: { ok, code, text, reasoning, killed, canceled, sessionID, errorText }.
function streamCli(args, opts, onPartial) {
    return new Promise((resolve) => {
        const spec = commandSpec(args);
        const timeoutMs = Math.max((opts && opts.timeout) || 0, 0);
        const child = spawn(spec.cmd, spec.argv, {
            cwd: (opts && opts.cwd) || undefined,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: process.env,
            windowsHide: true,
        });

        let stdout = '';
        let stderr = '';
        let settled = false;
        let timer = null;
        let sessionID = null;
        let assistantMsgID = null;
        let errorText = '';
        const texts = [];
        const reasons = [];
        // Estructura tipo TUI: partes ordenadas (texto, razonamiento, tool).
        const parts = [];
        const partIdx = new Map();
        let flushedText = null;
        let flushedReasoning = null;
        let flushedParts = null;
        let lineBuf = '';

        function flush(v) {
            try { onPartial(v); } catch (e) {}
        }

        // Inserta o actualiza una parte por su id (los `tool` cambian de estado
        // varias veces: running -> completed/error).
        function putPart(p) {
            const pid = p && p.id ? String(p.id) : '';
            if (pid && partIdx.has(pid)) { parts[partIdx.get(pid)] = p; return; }
            if (pid) partIdx.set(pid, parts.length);
            parts.push(p);
        }

        // Firma fiel de las partes: cada id con su estado (una tool intermedia
        // que pasa running -> completed tambien debe republicarse).
        function partsSig() {
            let sig = parts.length + '';
            for (let i = 0; i < parts.length; i++) {
                const p = parts[i];
                sig += '|' + (p && p.id ? String(p.id) : i) + ':' +
                    (p && p.type === 'tool' && p.state ? p.state.status : p.type);
            }
            return sig;
        }

        function drain() {
            const acc = texts.join('\n').trim();
            const rac = reasons.join('\n').trim();
            const psig = partsSig();
            if (acc === flushedText && rac === flushedReasoning && psig === flushedParts) return;
            if (!acc && !rac && !parts.length) return;
            flushedText = acc;
            flushedReasoning = rac;
            flushedParts = psig;
            flush({ text: acc, reasoning: rac, parts: parts.slice() });
        }

        // Resultado común de las tres salidas (timeout, cancelación, cierre).
        function result(extra) {
            const parsed = texts.join('\n').trim();
            let fallback = (stripAnsi(stdout || stderr || '')).replace(/\s+$/g, '');
            // Con --format json la salida cruda son eventos, no respuesta: si
            // no se parseó ningún texto (corte a mitad de tool calls), no
            // publicar el JSON crudo como si fuera la respuesta.
            if (!parsed && /^\s*\{"type"/m.test(stdout)) fallback = '';
            return Object.assign({
                ok: false,
                code: null,
                text: parsed || fallback,
                reasoning: reasons.join('\n').trim(),
                parts: parts.slice(),
                killed: false,
                canceled: false,
                sessionID: sessionID,
                assistantMsgID: assistantMsgID,
                errorText: errorText,
            }, extra || {});
        }

        // Cancelación remota: la web marca el mensaje y el puente corta el
        // proceso en el próximo chequeo (~2 s).
        let cancelTimer = null;

        if (timeoutMs > 0) {
            timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                if (cancelTimer) clearInterval(cancelTimer);
                clearInterval(flusher);
                try { child.kill(); } catch (e) {}
                resolve(result({ killed: true }));
            }, timeoutMs);
        }

        if (typeof opts.cancelCheck === 'function') {
            cancelTimer = setInterval(async () => {
                if (settled) { clearInterval(cancelTimer); return; }
                let want = false;
                try { want = await opts.cancelCheck(); } catch (e) { /* reintenta */ }
                if (want && !settled) {
                    settled = true;
                    if (timer) clearTimeout(timer);
                    clearInterval(flusher);
                    clearInterval(cancelTimer);
                    log('cancelación remota: cortando opencode (sesión ' + sessionID + ')');
                    try { child.kill(); } catch (e2) {}
                    resolve(result({ killed: true, canceled: true }));
                }
            }, 2000);
        }

        function errorMessage(ev) {
            if (typeof ev.error === 'string' && ev.error) return ev.error;
            const e = ev.error;
            if (e && typeof e === 'object') {
                if (typeof e.message === 'string' && e.message) return e.message;
                const d = e.data;
                if (d && typeof d.message === 'string' && d.message) return d.message;
                if (d && typeof d === 'object') { try { return JSON.stringify(d); } catch (e2) {} }
            }
            if (typeof ev.message === 'string' && ev.message) return ev.message;
            return 'error';
        }

        function handleLine(l) {
            let ev;
            try { ev = JSON.parse(l); } catch (e) {
                return; // no era JSON completo (ruido/log): se descarta
            }
            if (!ev || typeof ev !== 'object') return;
            if (ev.sessionID && !sessionID) sessionID = ev.sessionID;
            if (ev.part && typeof ev.part === 'object') {
                if (ev.type === 'text' && typeof ev.part.text === 'string') {
                    texts.push(ev.part.text);
                    putPart({ type: 'text', id: ev.part.id, text: ev.part.text });
                } else if (ev.type === 'reasoning' && typeof ev.part.text === 'string') {
                    reasons.push(ev.part.text);
                    putPart({ type: 'reasoning', id: ev.part.id, text: ev.part.text });
                } else if (ev.type === 'tool') {
                    putPart({ type: 'tool', id: ev.part.id, tool: ev.part.tool, callID: ev.part.callID, state: ev.part.state });
                }
                // Id del mensaje de opencode (msg_...): identifica la respuesta
                // para que el hub no la duplique al importar del TUI. En el
                // stream JSON viene en `part.messageID`.
                const mid = ev.messageID || ev.part.messageID;
                if (typeof mid === 'string' && mid) assistantMsgID = mid;
            }
            if (ev.type === 'error') {
                errorText = errorMessage(ev);
            }
        }

        function addLines(raw) {
            // Acumula y procesa solo líneas completas; lo que quede sin \n
            // espera el próximo chunk (antes se perdían eventos cortados).
            lineBuf += String(raw || '');
            let idx;
            while ((idx = lineBuf.indexOf('\n')) >= 0) {
                const line = lineBuf.slice(0, idx).trim();
                lineBuf = lineBuf.slice(idx + 1);
                if (line) handleLine(line);
            }
        }

        child.stdout.on('data', (d) => {
            stdout += d;
            addLines(d);
        });
        child.stderr.on('data', (d) => { stderr += d; });
        child.stdin.on('error', () => {});
        child.stdin.end();

        // Publica parciales cada 300 ms: con el evento SSE 'inflight' la web
        // refresca enseguida, y un intervalo mas corto se nota en el en vivo.
        const flusher = setInterval(drain, 300);
        child.on('close', (code) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (cancelTimer) clearInterval(cancelTimer);
            clearInterval(flusher);
            if (lineBuf.trim()) handleLine(lineBuf.trim());
            drain();
            resolve(result({ ok: code === 0 }));
        });

        // Igual que runCli: un spawn fallido no puede colgar la ejecución.
        child.on('error', (err) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (cancelTimer) clearInterval(cancelTimer);
            clearInterval(flusher);
            resolve(result({ errorText: 'no se pudo ejecutar opencode: ' + err.message }));
        });
    });
}

// Devuelve la lista plana de modelos, o null si el CLI fallo (distinto de
// "no hay modelos": null permite conservar el ultimo catalogo bueno).
async function listModels() {
    const r = await runCli(['models'], { timeout: 60000 });
    if (!r.ok) {
        log('aviso: no se pudo listar modelos: ' + (r.text || r.code));
        return null;
    }
    return r.text.split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.includes('/') && !l.startsWith('#') && !l.startsWith('─') && !l.startsWith('═'));
}

// Catálogo completo de modelos agrupado por proveedor ("prov/modelo"),
// cacheado 30 min para no ejecutar el CLI en cada sincronización.
let modelsFullCache = null; // { groups: {proveedor: [ids]}, total, at }
const MODELS_FULL_TTL = 30 * 60 * 1000;

function flattenModels(groups) {
    const out = [];
    for (const k of Object.keys(groups || {})) out.push(...groups[k]);
    return out;
}

async function getModelsFull(force) {
    if (!force && modelsFullCache && (Date.now() - modelsFullCache.at) < MODELS_FULL_TTL) {
        return modelsFullCache;
    }
    const list = await listModels();
    // Fallo del CLI: no pisar el catalogo cacheado (ni el del hub) con vacio.
    if (list === null) {
        if (modelsFullCache) {
            log('aviso: fallo al listar modelos; conservo el catalogo anterior');
            return modelsFullCache;
        }
        return null;
    }
    const groups = {};
    for (const id of list) {
        const slash = id.indexOf('/');
        if (slash <= 0) continue;
        const prov = id.slice(0, slash);
        if (!groups[prov]) groups[prov] = [];
        groups[prov].push(id);
    }
    // Salida vacia con cache previo no vacio: probablemente transitorio; conservar.
    if (!list.length && modelsFullCache && modelsFullCache.total) {
        log('aviso: "opencode models" devolvio vacio; conservo el catalogo anterior');
        return modelsFullCache;
    }
    modelsFullCache = { groups: groups, total: list.length, at: Date.now() };
    return modelsFullCache;
}

// Capacidades por modelo (visión, adjuntos, ventana de contexto) a partir de
// `opencode models --verbose`; misma caché de 30 min que el catálogo completo.
let modelsCapsCache = null; // { caps: {id: {vision, attachment, ctx}}, at }

function parseModelsVerbose(text) {
    const caps = {};
    // El id puede tener varias barras (openrouter/~anthropic/claude-...).
    const headerRe = /^[\w.~\-]+(?:\/[\w.~\-:.+:]+)+$/;
    let cur = null;
    let buf = null;
    let depth = 0;
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.trim();
        if (buf === null) {
            if (headerRe.test(line)) {
                cur = line;
            } else if (cur && line === '{') {
                buf = '{';
                depth = 1;
            }
            continue;
        }
        buf += '\n' + line;
        for (const ch of line) {
            if (ch === '{') depth++;
            else if (ch === '}') depth--;
        }
        if (depth === 0) {
            try {
                const j = JSON.parse(buf);
                // El encabezado ("prov/modelo") usa el mismo formato que la
                // lista plana; j.id puede venir sin el proveedor.
                const id = cur || (typeof j.id === 'string' && j.id.includes('/') ? j.id : null);
                if (id) {
                    caps[id] = {
                        name: (typeof j.name === 'string') ? j.name.trim() : '',
                        vision: !!(j.capabilities && j.capabilities.input && j.capabilities.input.image),
                        attachment: !!(j.capabilities && j.capabilities.attachment),
                        ctx: (j.limit && j.limit.context) || 0,
                    };
                }
            } catch (e) { /* bloque no parseable: se ignora */ }
            buf = null;
        }
    }
    return caps;
}

async function getModelCaps(force) {
    if (!force && modelsCapsCache && (Date.now() - modelsCapsCache.at) < MODELS_FULL_TTL) {
        return modelsCapsCache.caps;
    }
    const r = await runCli(['models', '--verbose'], { timeout: 120000 });
    if (!r.ok) {
        log('aviso: no se pudieron leer las capacidades de modelos: ' + (r.text || r.code).slice(0, 100));
        return modelsCapsCache ? modelsCapsCache.caps : null;
    }
    const caps = parseModelsVerbose(r.text);
    // Sin capacidades parseadas pero con cache previo: conservar (formato cambió
    // o salida parcial) en vez de borrar vision/contexto en el hub.
    if (!Object.keys(caps).length && modelsCapsCache && Object.keys(modelsCapsCache.caps).length) {
        log('aviso: capacidades vacias; conservo las anteriores');
        return modelsCapsCache.caps;
    }
    modelsCapsCache = { caps: caps, at: Date.now() };
    const vis = Object.keys(caps).filter((k) => caps[k].vision);
    log('capacidades: ' + Object.keys(caps).length + ' modelos, ' + vis.length + ' con visión');
    return caps;
}

// Favoritos de config.json (o todos si no hay configurados), validados contra
// la lista completa si ya está cacheada (sin volver a ejecutar el CLI).
// Devuelve null si no hay favoritos y el CLI no pudo listar nada.
async function resolveModels() {
    const curated = Array.isArray(config.models)
        ? config.models.filter((m) => typeof m === 'string' && m.includes('/')).map((m) => m.trim())
        : [];
    const available = modelsFullCache ? flattenModels(modelsFullCache.groups) : null;
    if (!curated.length) {
        if (available && available.length) return available;
        const full = await getModelsFull();
        return full ? flattenModels(full.groups) : null;
    }
    if (available && available.length) {
        const missing = curated.filter((m) => !available.includes(m));
        if (missing.length) {
            log('aviso: no aparecen en "opencode models": ' + missing.join(', '));
        }
    }
    return curated;
}

function resolveAgents() {
    const list = Array.isArray(config.agents)
        ? config.agents.filter((a) => typeof a === 'string' && a.trim() !== '').map((a) => a.trim())
        : [];
    return list.length ? list : ['build', 'plan'];
}

// Consulta al hosting si el usuario pidió cancelar ese mensaje.
async function checkCancel(sessionId, target) {
    try {
        const r = await api('cancel_status', { session_id: sessionId }, target);
        return !!(r && r.cancel);
    } catch (e) { return false; }
}

// ---------------------------------------------------------------------------
// Ejecutar opencode con un mensaje de un chat (streaming opcional)
// ---------------------------------------------------------------------------
async function runOpencode(msg, onPartial) {
    const session = msg.session || {};
    const folder = session.folder || '';
    const model = session.model || '';
    const agent = session.agent || '';

    // --thinking: sin esto el CLI no emite los eventos "reasoning" (💭).
    const args = ['run', '--format', 'json', '--thinking'];
    if (model) args.push('--model', model);
    if (agent && resolveAgents().includes(agent)) args.push('--agent', agent);
    const cwd = folder ? path.resolve(folder) : undefined;
    if (msg.opencode_session) {
        args.push('--session', msg.opencode_session);
    } else {
        // Nombre elegido en la web como titulo de opencode (asi coinciden). Si
        // es un placeholder, dejamos que opencode titula solo desde el prompt.
        const nm = (msg.session && msg.session.name) ? String(msg.session.name).trim() : '';
        if (nm && !/^Chat \d+$/.test(nm) && !/^bridge-\d+$/.test(nm)) args.push('--title', nm);
    }

    // Imagen adjunta desde la web (dataURL) → archivo temporal → --file.
    let imgPath = null;
    if (msg.img && /^data:image\/(png|jpe?g|webp|gif);base64,/.test(msg.img)) {
        try {
            const mime = msg.img.slice(5, msg.img.indexOf(';'));
            const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }[mime] || '.png';
            imgPath = path.join(os.tmpdir(), 'ob-img-' + msg.session_id + '-' + msg.id + ext);
            fs.writeFileSync(imgPath, Buffer.from(msg.img.slice(msg.img.indexOf(',') + 1), 'base64'));
            log('imagen adjunta: ' + Math.round(fs.statSync(imgPath).size / 1024) + ' KB para el mensaje #' + msg.id);
        } catch (e) {
            log('aviso: no se pudo guardar la imagen adjunta: ' + e.message);
            imgPath = null;
        }
    }

    // Solo imagen, sin texto: opencode exige un mensaje.
    // El mensaje va antes de --file: yargs consume los valores siguientes
    // a una opción array, y se comería el texto si va después.
    args.push(msg.text || 'Analizá la imagen adjunta.');
    if (imgPath) {
        args.push('--file', imgPath);
    }

    log('ejecutando (sesión ' + (msg.opencode_session || 'nueva') + ', agente ' + (agent || 'default') + '): ' +
        '\n  cmd: ' + resolveCommand() + ' ' + args.slice(0, -1).join(' ') + ' "<mensaje>"' +
        (cwd ? '\n  cwd: ' + cwd : ''));

    const r = await streamCli(args, {
        cwd: cwd,
        timeout: Math.max(config.opencodeTimeoutMs || 0, 0),
        cancelCheck: () => checkCancel(msg.session_id, msg._t),
    }, onPartial);
    if (imgPath) {
        try { fs.unlinkSync(imgPath); } catch (e) { /* ya no está */ }
    }
    let out = (r.text || '').trim();
    if (r.canceled) {
        // Cancelada: conserva lo generado y avisa; nunca "Error".
        out = (out ? out + '\n\n' : '') + '⏹ Cancelado antes de terminar.';
    } else {
        if (!out && r.errorText) out = r.errorText;
        if (!out && !r.ok && !r.killed) out = 'Error: ' + r.code + ' (revisa el puente)';
        if (r.killed) out = (out ? out + '\n\n' : '') + '[La ejecución se cortó por tiempo límite]';
    }
    if (!out) out = 'ok (sin texto)';

    const reached = r.sessionID || msg.opencode_session || null;
    if (r.sessionID && r.sessionID !== msg.opencode_session) {
        log('sesión de opencode: ' + r.sessionID);
    } else if (!reached) {
        log('aviso: no se pudo detectar la sesión en el stream.');
    }

    return { text: out, reasoning: r.reasoning || '', parts: r.parts || [], opencodeSession: reached, errorText: r.errorText || '', canceled: !!r.canceled };
}

// ---------------------------------------------------------------------------
// Comandos "/xxx" enviados desde el celular
// ---------------------------------------------------------------------------
function parseSlash(text) {
    const t = String(text || '').trim();
    if (!t.startsWith('/')) return null;
    const sp = t.indexOf(' ');
    const name = (sp >= 0 ? t.slice(1, sp) : t.slice(1)).trim().toLowerCase();
    const arg = sp >= 0 ? t.slice(sp + 1).trim() : '';
    return { name: name, arg: arg, full: t };
}

// Respuesta inmediata de un comando local (no pasa por el modelo).
async function respondSimple(msg, text, clearSession) {
    const payload = {
        session_id: msg.session_id,
        user_id: msg.id,
        text: text,
        opencode_session: msg.opencode_session || '',
        clear_session: !!clearSession,
    };
    await api('respond', payload, msg._t);
    log('respuesta #' + msg.id + ' publicada (' + text.length + ' car., comando local)');
}

// Publica tramos parciales (texto y, si hay, razonamiento) en la API.
// Los parciales son best-effort: si fallan, se sigue.
function partialPoster(msg) {
    return async (partial) => {
        const text = String((partial && partial.text) || '').trim();
        const reasoning = String((partial && partial.reasoning) || '').trim();
        const parts = Array.isArray(partial && partial.parts) ? partial.parts : [];
        if (!text && !reasoning && !parts.length) return;
        try {
            await api('respond_partial', { session_id: msg.session_id, user_id: msg.id, text: text, reasoning: reasoning, parts: parts }, msg._t);
        } catch (e) { /* parciales son best-effort */ }
    };
}

async function runMessage(msg) {
    const slash = parseSlash(msg.text);
    if (!slash) {
        const r = await runOpencode(msg, partialPoster(msg));
        return r;
    }

    const name = slash.name;

    if (name === 'new' || name === 'clear' || name === 'nuevo') {
        log('comando /' + name + ' -> nueva sesión');
        await respondSimple(msg, '🧹 Nueva sesión iniciada. Escribí tu primer mensaje y arranco desde cero.', true);
        return { text: '', opencodeSession: null, done: true };
    }

    if (name === 'compact' || name === 'resumen' || name === 'summarize') {
        log('comando /' + name + ' -> liberar contexto');
        await respondSimple(msg, '🧹 Contexto liberado. La próxima respuesta usa una sesión nueva (compactación no soportada por CLI).', true);
        return { text: '', opencodeSession: null, done: true };
    }

    if (name === 'models') {
        log('comando /models' + (slash.arg ? ' (filtro: ' + slash.arg + ')' : ''));
        const full = await getModelsFull();
        const flat = full ? flattenModels(full.groups) : [];
        const filtro = (slash.arg || '').trim().toLowerCase();
        let text;
        if (!flat.length) {
            text = 'No hay modelos disponibles (¿está instalado opencode?).';
        } else if (filtro) {
            const hits = flat.filter((m) => m.toLowerCase().includes(filtro));
            const shown = hits.slice(0, 60);
            text = 'Modelos que coinciden con "' + slash.arg + '" (' + hits.length + '):\n\n'
                + (shown.length ? shown.map((m) => '• ' + m).join('\n') : '(sin coincidencias)')
                + (hits.length > shown.length ? '\n\n… y ' + (hits.length - shown.length) + ' más. Refiná el filtro.' : '');
        } else {
            const provs = Object.keys(full.groups).sort((a, b) => a.localeCompare(b));
            text = 'Proveedores disponibles (' + provs.length + ' proveedores, ' + flat.length + ' modelos):\n\n'
                + provs.map((p) => '• ' + p + ' (' + full.groups[p].length + ')').join('\n')
                + '\n\nBuscá con "/models <texto>" (ej: /models glm) o con el buscador del modal en la web.';
        }
        await respondSimple(msg, text, false);
        return { text: '', opencodeSession: null, done: true };
    }

    if (name === 'agents') {
        log('comando /agents');
        const agents = resolveAgents();
        const text = 'Agentes disponibles (' + agents.length + '):\n\n' + agents.map((a) => '• ' + a).join('\n');
        await respondSimple(msg, text, false);
        return { text: '', opencodeSession: null, done: true };
    }

    if (name === 'mcp') {
        log('comando /mcp');
        const r = await runCli(['mcp', 'list'], { timeout: 30000 });
        const text = r.ok
            ? (r.text || 'No hay servidores MCP configurados.')
            : 'No se pudieron listar los MCP: ' + (r.text || ('exit ' + r.code));
        await respondSimple(msg, text, false);
        return { text: '', opencodeSession: null, done: true };
    }

    if (name === 'workspace') {
        log('comando /workspace');
        const ws = config.workspace ? path.resolve(config.workspace) : '';
        const text = ws
            ? 'Espacio de trabajo:\n\n' + ws
            : 'El workspace no está definido en config.json.';
        await respondSimple(msg, text, false);
        return { text: '', opencodeSession: null, done: true };
    }

    if (name === 'status' || name === 'estado') {
        log('comando /' + name);
        const up = Math.floor((Date.now() - STARTED_AT) / 1000);
        const upStr = up >= 60 ? Math.floor(up / 60) + 'min ' + (up % 60) + 's' : up + 's';
        const ws = config.workspace ? path.resolve(config.workspace) : '(sin definir)';
        const text = 'Estado del puente:\n\n'
            + '• PID: ' + process.pid + '\n'
            + '• Puente: ' + BRIDGE_ID + (BRIDGE_NAME && BRIDGE_NAME !== BRIDGE_ID ? ' (' + BRIDGE_NAME + ')' : '') + '\n'
            + '• Encendido hace: ' + upStr + '\n'
            + '• Ocupado: ' + (busy ? 'sí' : 'no') + '\n'
            + '• Modo: ' + (activeMode || requestedMode()) + '\n'
            + '• API activa: ' + activeApiUrl() + '\n'
            + '• Hosting remoto: ' + config.apiUrl + '\n'
            + '• API local: ' + (config.apiUrlLocal || '(no definida)') + '\n'
            + '• Modelos: ' + (config.models || []).length + ' favoritos'
                + (modelsFullCache ? ', ' + modelsFullCache.total + ' disponibles (' + Object.keys(modelsFullCache.groups).length + ' proveedores)' : '') + '\n'
            + '• Agentes: ' + (resolveAgents().length) + '\n'
            + '• Workspace: ' + ws;
        await respondSimple(msg, text, false);
        return { text: '', opencodeSession: null, done: true };
    }

    if (name === 'help' || name === 'ayuda' || name === 'comandos') {
        log('comando /' + name);
        const text = 'Comandos disponibles:\n\n'
            + '• /new, /clear, /nuevo — empezar una conversación nueva\n'
            + '• /compact, /resumen, /summarize — liberar contexto\n'
            + '• /models [filtro] — proveedores disponibles o búsqueda de modelos\n'
            + '• /agents — listar agentes disponibles\n'
            + '• /mcp — servidores MCP de opencode y su estado\n'
            + '• /folders, /carpetas, /dirs — listar carpetas del workspace\n'
            + '• /workspace — mostrar el espacio de trabajo\n'
            + '• /status, /estado — estado del puente\n'
            + '• /help, /ayuda — esta ayuda\n'
            + '• /<cualquier-cosa> — comando custom de opencode (si existe); si no, se trata como un mensaje normal.';
        await respondSimple(msg, text, false);
        return { text: '', opencodeSession: null, done: true };
    }

    if (name === 'folders' || name === 'carpetas' || name === 'dirs') {
        log('comando /' + name);
        const workspace = config.workspace ? path.resolve(config.workspace) : '';
        const list = listWorkspaceFolders(workspace);
        const text = list.length
            ? 'Carpetas del workspace:\n\n' + list.join('\n')
            : 'No se encontraron carpetas' + (workspace ? '' : ' (workspace sin definir)') + '.';
        await respondSimple(msg, text, false);
        return { text: '', opencodeSession: null, done: true };
    }

    // Comando custom de opencode (p. ej. /review) vía --command; si no existe, cae en prompt normal.
    log('comando /' + name + ' -> intentando custom command');
    const cmdArgs = ['run', '--format', 'json', '--thinking', '--command', name];
    if (slash.arg) cmdArgs.push(slash.arg);
    const session = msg.session || {};
    const cwd = session.folder ? path.resolve(session.folder) : undefined;
    const r = await streamCli(cmdArgs, {
        cwd: cwd,
        timeout: Math.max(config.opencodeTimeoutMs || 0, 0),
        cancelCheck: () => checkCancel(msg.session_id, msg._t),
    }, partialPoster(msg));
    if ((r.errorText || r.text).indexOf('Command not found') >= 0) {
        log('comando /' + name + ' no existe; lo trato como mensaje normal');
        const r2 = await runOpencode(msg, partialPoster(msg));
        return r2;
    }
    let out = (r.text || '').trim();
    if (!out && r.errorText) out = r.errorText;
    if (r.killed) out = (out ? out + '\n\n' : '') + '[La ejecución se cortó por tiempo límite]';
    if (!out) out = 'ok (sin texto)';
    const reached = r.sessionID || msg.opencode_session || null;
    if (r.sessionID && r.sessionID !== msg.opencode_session) log('sesión de opencode: ' + r.sessionID);
    return { text: out, reasoning: r.reasoning || '', opencodeSession: reached };
}

// ---------------------------------------------------------------------------
// Crear una carpeta solicitada remotamente
// ---------------------------------------------------------------------------
// Lista las subcarpetas de primer nivel del workspace (solo directorios, no archivos).
function listWorkspaceFolders(workspace) {
    return listWorkspaceFoldersRecursive(workspace, 1);
}

// Recorre subcarpetas hasta `maxDepth` (default 3) excluyendo node_modules, .git y carpetas ocultas.
function listWorkspaceFoldersRecursive(workspace, maxDepth) {
    if (!workspace) return [];
    maxDepth = maxDepth || 3;
    let root;
    try {
        root = path.resolve(workspace);
        if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
    } catch (e) { return []; }
    const SKIP = new Set(['node_modules', '.git', '.next', '.cache', 'dist', 'build', '.venv', '__pycache__']);
    const out = [];
    function walk(dir, depth, prefix) {
        let names = [];
        try {
            names = fs.readdirSync(dir).filter((n) => {
                if (n.startsWith('.')) return false;
                if (SKIP.has(n)) return false;
                try { return fs.statSync(path.join(dir, n)).isDirectory(); } catch (e) { return false; }
            });
        } catch (e) { return; }
        names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
        for (const n of names) {
            const full = path.join(dir, n);
            const rel = prefix ? prefix + '/' + n : n;
            out.push({ name: n, path: full, rel: rel, depth: depth });
            if (depth < maxDepth) walk(full, depth + 1, rel);
        }
    }
    walk(root, 1, '');
    return out;
}

function createRemoteFolder(name) {
    const clean = String(name || '').trim();
    if (!config.allowCreateFolders) throw new Error('creación remota desactivada en config.json');
    const workspace = config.workspace ? path.resolve(config.workspace) : '';
    if (!workspace) throw new Error('config.json no define "workspace"');
    if (!/^[A-Za-z0-9][A-Za-z0-9 _\-\.\(\)]{1,49}$/.test(clean)) {
        throw new Error('nombre de carpeta inválido');
    }
    if (!fs.existsSync(workspace)) throw new Error('el espacio de trabajo no existe: ' + workspace);
    const dir = path.join(workspace, clean);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    // Una carpeta creada desde la web queda conectada de una.
    setFolderActive(dir, true);
    return { name: clean, path: dir };
}

async function handleFolderRequest(req) {
    const name = String(req.name || '').trim();
    log('solicitud de carpeta: "' + name + '" (id ' + req.id + ')');
    try {
        const folder = createRemoteFolder(name);
        await api('folder_done', { id: req.id, ok: true, folder: folder }, req._t);
        log('carpeta creada: ' + folder.path);
    } catch (e) {
        log('error al crear carpeta: ' + e.message);
        try { await api('folder_done', { id: req.id, ok: false, error: e.message }, req._t); } catch (e2) { /* noop */ }
    }
}

// Conectar/desconectar un proyecto desde la web. Al conectar se publica de una
// el indice (ultimas sesiones) y el catalogo para que aparezca en el sidebar.
async function handleFolderToggle(cmd, active) {
    const target = String((cmd.args && cmd.args[0]) || '').trim();
    if (!target) {
        await api('command_done', { id: cmd.id, ok: false, text: '', error: 'falta la carpeta' }, cmd._t);
        return;
    }
    const abs = setFolderActive(target, active);
    if (!abs) {
        await api('command_done', { id: cmd.id, ok: false, text: '', error: 'carpeta invalida' }, cmd._t);
        return;
    }
    try {
        await pushSessionIndex(cmd._t);
        await syncCatalog({ silent: true });
    } catch (e) {
        log('aviso: no pude refrescar tras ' + (active ? 'conectar' : 'desconectar') + ' ' + abs + ': ' + e.message);
    }
    await api('command_done', {
        id: cmd.id,
        ok: true,
        text: JSON.stringify({ folder: abs, active: !!active }),
        error: '',
    }, cmd._t);
    log('carpeta ' + (active ? 'conectada' : 'desconectada') + ': ' + abs);
}

// "Ver mas sesiones": sube el limite publicado de una carpeta conectada y
// republica el indice para que el hub importe las siguientes.
async function handleFolderMore(cmd) {
    const target = String((cmd.args && cmd.args[0]) || '').trim();
    const step = parseInt((cmd.args && cmd.args[1]), 10) || (parseInt(config.sessionIndexLimit, 10) || 4);
    if (!target) {
        await api('command_done', { id: cmd.id, ok: false, text: '', error: 'falta la carpeta' }, cmd._t);
        return;
    }
    const limit = bumpFolderLimit(target, step);
    if (!limit) {
        await api('command_done', { id: cmd.id, ok: false, text: '', error: 'carpeta invalida' }, cmd._t);
        return;
    }
    try { await pushSessionIndex(cmd._t); } catch (e) {
        log('aviso: no pude refrescar tras pedir mas sesiones de ' + target + ': ' + e.message);
    }
    await api('command_done', {
        id: cmd.id,
        ok: true,
        text: JSON.stringify({ folder: target, limit: limit }),
        error: '',
    }, cmd._t);
    log('mas sesiones: ' + target + ' (limite ' + limit + ')');
}

// Reset pedido por el hub: desconecta todos los proyectos para que el sidebar
// quede en blanco. Confirma con reset_ack (el hub borra el marcador).
async function handleBridgeReset() {
    const n = clearActiveFolders();
    log('reset del hub: ' + n + ' proyecto(s) desconectado(s)');
    for (const t of activeTargets()) {
        try { await api('reset_ack', {}, t); } catch (e) { /* el poll reintenta */ }
    }
    try { await pushSessionIndex(); } catch (e) { /* noop */ }
    try { await syncCatalog({ silent: true }); } catch (e) { /* noop */ }
}

// ---------------------------------------------------------------------------
// Sincronizar catálogo (carpetas + modelos + workspace + flags + agentes)
// ---------------------------------------------------------------------------
async function syncCatalog(opts) {
    try {
        // El catalogo ofrece las carpetas nivel 1 del workspace + las que el
        // usuario ya conecto (aunque esten mas profundo), cada una con su flag
        // `active`. El sidebar solo muestra las conectadas con sesiones.
        const activeByPath = new Map();
        for (const f of readFolders()) {
            const p = typeof f === 'string' ? f : (f && f.path);
            if (p) activeByPath.set(path.resolve(p), folderIsActive(f));
        }
        let folders = [];
        if (config.workspace) {
            const root = path.resolve(config.workspace);
            const seen = new Set();
            const push = (name, p) => {
                let abs;
                try { abs = path.resolve(p); } catch (e) { return; }
                if (seen.has(abs)) return;
                seen.add(abs);
                folders.push({ name: name || path.basename(abs), path: abs, active: !!activeByPath.get(abs) });
            };
            // Primero las conectadas dentro del workspace (no se pierden aunque
            // esten por debajo del nivel 1).
            for (const [abs, active] of activeByPath) {
                if (!active) continue;
                try {
                    const rel = path.relative(root, abs);
                    if (!rel || rel.split(path.sep).includes('..')) continue;
                    if (!fs.statSync(abs).isDirectory()) continue;
                } catch (e) { continue; }
                push(path.basename(abs), abs);
            }
            try {
                const discovered = listWorkspaceFolders(config.workspace); // depth 1
                for (const d of discovered) {
                    const rel = path.relative(root, path.resolve(d.path));
                    if (!rel || rel.split(path.sep).includes('..') || rel.includes(path.sep)) continue;
                    push(d.name, d.path);
                }
            } catch (e) {
                log('aviso: no pude escanear el workspace: ' + e.message);
            }
        }
        const full = await getModelsFull();
        const models = await resolveModels();
        const agents = resolveAgents();
        const caps = await getModelCaps();
        const payload = {
            folders: folders,
            workspace: config.workspace || '',
            allowCreateFolders: !!config.allowCreateFolders,
            agents: agents,
        };
        // Los campos de modelos solo se envian si el CLI respondio. Si no, se
        // omiten para que el hub conserve el ultimo catalogo bueno (no vaciarlo).
        if (models !== null) payload.models = models;
        if (full) payload.models_full = full.groups;
        if (caps) {
            payload.vision = Object.keys(caps).filter((k) => caps[k].vision);
            const modelsCtx = {};
            const modelsNames = {};
            for (const k of Object.keys(caps)) {
                const c = caps[k] || {};
                if (typeof c.ctx === 'number' && c.ctx > 0) modelsCtx[k] = c.ctx;
                if (typeof c.name === 'string' && c.name !== '') modelsNames[k] = c.name;
            }
            payload.models_ctx = modelsCtx;
            payload.models_names = modelsNames;
        }
        let res = null;
        for (const t of activeTargets()) {
            try {
                const r1 = await api('sync_catalog', payload, t);
                if (!res) res = r1;
            } catch (e2) {
                log('aviso: no se pudo sincronizar el catálogo con ' + t + ': ' + e2.message);
            }
        }
        if (!res) res = { folders: 0, models: 0, agents: 0 };
        if (!opts || !opts.silent) {
            const totalModels = full ? full.total : 0;
            const providers = full ? Object.keys(full.groups).length : 0;
            log('catálogo sincronizado: ' + res.folders + ' carpetas, ' + totalModels + ' modelos en '
                + providers + ' proveedores (' + res.models + ' favoritos), ' + res.agents + ' agentes' +
                (config.allowCreateFolders ? ' · creacion remota: ON' : ' · creacion remota: OFF'));
            log('workspace: ' + (config.workspace || '(sin definir)'));
            log('favoritos (' + (models ? models.length : 0) + '): ' + (models ? models.join(', ') : '(sin datos)'));
            log('agentes (' + agents.length + '): ' + agents.join(', '));
        }
    } catch (e) {
        log('aviso: no se pudo sincronizar el catálogo: ' + e.message);
    }
}

// ---------------------------------------------------------------------------
// Historial único: importa al hosting las sesiones de opencode hechas en el
// TUI local. opencode en la PC es la fuente; la web las espeja y puede
// continuarlas (el puente ya usa --session al responder).
// ---------------------------------------------------------------------------
const SYNC_STATE_PATH = path.join(HOME, 'sync-state.json');
// v5: los espejos importados ahora se marcan (`importada`) y salen de
// known_oc; re-importa todo una vez para marcarlos y corregir su carpeta.
let syncState = { version: 5, targets: {} };
try {
    const parsed = JSON.parse(fs.readFileSync(SYNC_STATE_PATH, 'utf8'));
    if (parsed && parsed.version === 5 && parsed.targets) syncState = parsed;
} catch (e) { /* estado nuevo */ }
// Estado por destino (remoto/local): cada hosting lleva su propia marca de
// qué sesiones ya importó (el merge es idempotente igual).
function targetState(t) {
    const mode = t || activeMode || requestedMode();
    const s = syncState.targets[mode] || (syncState.targets[mode] = { folders: {}, fullScanTs: 0 });
    return s;
}
function saveSyncState() {
    try { fs.writeFileSync(SYNC_STATE_PATH, JSON.stringify(syncState)); } catch (e) {}
}

let sweepRunning = false;
let lastKnownOc = { remoto: [], local: [] }; // chats web ya vinculados, por destino
let activeRunFolder = null; // carpeta con un mensaje procesándose (evita carreras)
let activeMsgSession = null; // id de sesión (del hosting) cuyo mensaje se está ejecutando
let activeMsgTarget = null;  // destino donde vive esa sesión
const importBackoffUntil = { remoto: 0, local: 0 }; // backoff si el hosting no soporta session_import

// Avisa al hosting qué sesión está ejecutando opencode (o que ya no hay
// ninguna). Con sessionId null limpia el estado. Fire-and-forget.
function notifyBusy(target, sessionId) {
    if (!target) return;
    api('heartbeat', { busy: sessionId != null, busy_session: sessionId || null }, target).catch(() => {});
}

// Un destino caído (p. ej. el servidor local apagado en modo DUAL) no debe
// inundar el log: se sigue reintentando, pero el mensaje de error sale como
// mucho una vez por minuto por destino.
const downLogAt = {}; // destino -> próximo instante en el que se vuelve a loguear
function shouldLogDown(t) {
    const now = Date.now();
    if (now < (downLogAt[t] || 0)) return false;
    downLogAt[t] = now + 60000;
    return true;
}

function normFolder(f) {
    return String(f || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function topWorkspaceFolders() {
    if (!config.workspace) return [];
    let root;
    try { root = path.resolve(config.workspace); } catch (e) { return []; }
    let names = [];
    try { names = fs.readdirSync(root); } catch (e) { return []; }
    const out = [];
    for (const name of names) {
        if (fsSkipName(name)) continue;
        try {
            if (fs.statSync(path.join(root, name)).isDirectory()) out.push(path.join(root, name));
        } catch (e) { /* sigue */ }
    }
    return out;
}

// `opencode session list` muestra solo la hora ("HH:MM") para las sesiones de
// hoy y "HH:MM · D/M/YYYY" para las viejas. Como el marcador del barrido
// compara ese texto, una sesion tocada hoy a las 11:32 y otra manana a las
// 11:32 colisionaban y no se reimportaba. Se normaliza siempre con fecha.
function todayStamp() {
    const d = new Date();
    return d.getDate() + '/' + (d.getMonth() + 1) + '/' + d.getFullYear();
}

// Parsea la tabla de `opencode session list` (columnas: ID, Title, Updated).
async function listSessionsInFolder(folder) {
    const r = await runCli(['session', 'list'], { cwd: folder, timeout: 30000 });
    if (!r.ok) return [];
    const out = [];
    for (const line of r.text.split(/\r?\n/)) {
        const idm = line.match(/^(ses_[A-Za-z0-9]+)\s{2,}/);
        if (!idm) continue;
        const rest = line.slice(idm[1].length).trim();
        const tm = rest.match(/\s(\d{1,2}:\d{2}(?: · .+)?)$/);
        let updated = tm ? tm[1] : '';
        if (updated && updated.indexOf('·') < 0) updated = updated + ' · ' + todayStamp();
        out.push({
            id: idm[1],
            title: (tm ? rest.slice(0, tm.index) : rest).trim(),
            updated: updated,
        });
    }
    return out;
}

// Exporta una sesión solo para leer tokens/costo acumulados (chats web ya
// vinculados: no se importan mensajes, solo se actualizan esos dos números).
// De paso manda la carpeta real (info.directory): corrige sesiones que una
// pasada vieja clasificó con la carpeta del barrido en vez del proyecto.
async function refreshTokens(folder, sess, target) {
    const r = await runCli(['export', sess.id], { cwd: folder, timeout: 90000 });
    if (!r.ok || !r.text) throw new Error('export falló');
    const data = JSON.parse(r.text);
    const info = data.info || {};
    const tk = info.tokens || {};
    const tokens = (tk.input || 0) + (tk.output || 0) + (tk.reasoning || 0);
    const realDir = typeof info.directory === 'string' && info.directory ? info.directory : folder;
    await api('session_tokens', {
        opencode_session: sess.id,
        tokens: tokens,
        cost: typeof info.cost === 'number' ? info.cost : 0,
        folder: realDir,
    }, target);
}

// Exporta una sesión de opencode (JSON) y la manda al hosting indicado. El
// merge del hosting es idempotente (clave rol|fecha|texto): reimportar no duplica.
// `opts.rename` fuerza a que el titulo de opencode pise el nombre del hub (lo usa
// el sync manual; el barrido normal respeta el nombre si no es por defecto).
async function exportAndImport(folder, sess, target, opts) {
    const r = await runCli(['export', sess.id], { cwd: folder, timeout: 90000 });
    if (!r.ok || !r.text) throw new Error('export falló' + (r.killed ? ' (timeout)' : ''));
    const data = JSON.parse(r.text);
    const msgs = [];
    let lastAgent = '';
    for (const m of (data.messages || [])) {
        const info = m.info || {};
        const role = info.role;
        if (role !== 'user' && role !== 'assistant') continue;
        const parts = m.parts || [];
        const text = parts
            .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
            .map((p) => p.text).join('\n\n').trim();
        const reasoning = role === 'assistant'
            ? parts.filter((p) => p && p.type === 'reasoning' && typeof p.text === 'string')
                .map((p) => p.text).join('\n\n').trim().slice(0, 50000)
            : '';
        if (!text && !reasoning) continue;
        const ts = info.time && info.time.created ? new Date(Number(info.time.created)).toISOString() : '';
        if (role === 'user' && info.agent) lastAgent = info.agent;
        const out = {
            role: role,
            text: text.slice(0, 50000),
            ts: ts,
            agent: role === 'assistant' ? lastAgent : (info.agent || ''),
        };
        if (info.id) out.oc_msg = String(info.id);
        if (reasoning) out.reasoning = reasoning;
        msgs.push(out);
    }
    const info = data.info || {};
    const updatedMs = info.time && info.time.updated ? Number(info.time.updated) : 0;
    // Carpeta real del proyecto donde vive la sesión: `session list` desde
    // carpetas sin git propio devuelve la lista del proyecto compartido, así
    // que la carpeta del barrido puede mentir. info.directory no.
    const realDir = typeof info.directory === 'string' && info.directory ? info.directory : folder;
    // Tokens de la sesión (sin cache read: es contexto releído, no consumo nuevo).
    const tk = info.tokens || {};
    const tokens = (tk.input || 0) + (tk.output || 0) + (tk.reasoning || 0);
    const res = await api('session_import', {
        opencode_session: sess.id,
        folder: realDir,
        name: String(info.title || sess.title || '').slice(0, 60),
        updated: updatedMs ? new Date(updatedMs).toISOString() : '',
        model: (Array.isArray(config.models) && config.models[0]) || '',
        agent: 'build',
        tokens: tokens,
        cost: typeof info.cost === 'number' ? info.cost : 0,
        rename: !!(opts && opts.rename),
        messages: msgs.slice(-400),
    }, target);
    return { realDir: realDir, added: (res && parseInt(res.added, 10)) || 0, session_id: (res && res.session_id) || null };
}

// ---------------------------------------------------------------------------
// Proxy de historial: el hub no guarda conversaciones. La web pide el historial
// de una sesion y el puente lo saca del export de opencode, normalizado a la
// estructura tipo TUI (partes: texto, razonamiento, tool, imagen).
// ---------------------------------------------------------------------------
// opencode guarda el mensaje del usuario entre comillas dobles y, si hubo un
// adjunto, le antepone el detalle del archivo. Para mostrar usamos el texto real.
function cleanUserText(text) {
    let s = String(text || '').trim();
    if (s.indexOf('Called the Read tool with the following input:') === 0) {
        const marker = 'read successfully';
        const mi = s.toLowerCase().lastIndexOf(marker);
        if (mi >= 0) s = s.slice(mi + marker.length).trim();
    }
    if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') s = s.slice(1, -1).trim();
    return s;
}

// Convierte el JSON de `opencode export` en mensajes con `parts` ordenadas.
function normalizeExport(data) {
    const out = [];
    let lastAgent = '';
    for (const m of (data.messages || [])) {
        const info = m.info || {};
        const role = info.role;
        if (role !== 'user' && role !== 'assistant') continue;
        const parts = [];
        for (const p of (m.parts || [])) {
            if (!p || typeof p !== 'object') continue;
            if (p.type === 'text' && typeof p.text === 'string' && p.text !== '') {
                parts.push({ type: 'text', text: role === 'user' ? cleanUserText(p.text) : p.text });
            } else if (p.type === 'reasoning' && typeof p.text === 'string' && p.text !== '') {
                parts.push({ type: 'reasoning', text: p.text });
            } else if (p.type === 'tool') {
                parts.push({ type: 'tool', tool: p.tool || '', callID: p.callID || '', state: p.state || {} });
            } else if (p.type === 'file' && p.mime && p.url) {
                parts.push({ type: 'file', mime: p.mime, url: p.url, filename: p.filename || '' });
            }
        }
        if (!parts.length) continue;
        if (role === 'user' && info.agent) lastAgent = info.agent;
        const ts = info.time && info.time.created ? new Date(Number(info.time.created)).toISOString() : '';
        out.push({
            role,
            ts,
            oc_msg: info.id ? String(info.id) : '',
            agent: role === 'assistant' ? (info.agent || lastAgent) : (info.agent || ''),
            parts,
        });
    }
    return out;
}

function modelIdOf(info) {
    const mm = info && info.model;
    if (mm && typeof mm === 'object') {
        if (mm.providerID && mm.id) return mm.providerID + '/' + mm.id;
        if (mm.id) return String(mm.id);
    }
    if (info && typeof info.modelID === 'string' && info.modelID) {
        return (info.providerID ? info.providerID + '/' : '') + info.modelID;
    }
    return '';
}

async function exportSession(folder, oc) {
    const dir = folder || (config.workspace ? path.resolve(config.workspace) : '');
    const r = await runCli(['export', oc], { cwd: dir, timeout: 90000 });
    if (!r.ok || !r.text) throw new Error('export fallo' + (r.killed ? ' (timeout)' : ''));
    return JSON.parse(r.text);
}

// Comando de la web: devuelve el historial de una sesion (proxy, sin guardar).
async function sessionHistory(cmd) {
    const t = cmd._t || activeMode;
    const oc = String((cmd.args && cmd.args[0]) || '').trim();
    const folder = String((cmd.args && cmd.args[1]) || '').trim();
    if (!/^ses_[A-Za-z0-9]{4,64}$/.test(oc)) {
        await api('command_done', { id: cmd.id, ok: false, text: '', error: 'opencode_session invalido' }, t);
        return;
    }
    try {
        const data = await exportSession(folder, oc);
        const info = data.info || {};
        const tk = info.tokens || {};
        const payload = {
            id: cmd.id,
            opencode_session: oc,
            title: String(info.title || ''),
            directory: String(info.directory || folder || ''),
            model: modelIdOf(info),
            agent: String(info.agent || ''),
            tokens: (tk.input || 0) + (tk.output || 0) + (tk.reasoning || 0),
            cost: typeof info.cost === 'number' ? info.cost : 0,
            messages: normalizeExport(data),
        };
        await api('history_ready', payload, t);
        await api('command_done', { id: cmd.id, ok: true, error: '', text: JSON.stringify({ ready: true, count: payload.messages.length }) }, t);
        log('session_history ' + oc + ' (' + payload.messages.length + ' mensajes)');
    } catch (e) {
        await api('command_done', { id: cmd.id, ok: false, text: '', error: e.message }, t);
        log('session_history ' + oc + ' error: ' + e.message);
    }
}

// Lista las sesiones de un proyecto en JSON (trae `directory` y `updated` en
// epoch ms), que permite agrupar por proyecto real y ordenar por recencia.
// Fallback al parseo de tabla si la version de opencode no soporta --format.
async function listSessionsJson(folder) {
    const r = await runCli(['session', 'list', '--format', 'json'], { cwd: folder, timeout: 30000 });
    if (r.ok && r.text) {
        try {
            const arr = JSON.parse(r.text);
            if (Array.isArray(arr)) {
                const out = [];
                for (const s of arr) {
                    const id = s && typeof s.id === 'string' ? s.id : '';
                    if (!/^ses_[A-Za-z0-9]{4,64}$/.test(id)) continue;
                    const upd = Number(s.updated) || 0;
                    out.push({
                        id,
                        title: String(s.title || ''),
                        folder: String(s.directory || folder || ''),
                        updated: upd > 0 ? new Date(upd).toISOString() : '',
                        ts: upd,
                    });
                }
                return out;
            }
        } catch (e) { /* cae al parser de tabla */ }
    }
    const table = await listSessionsInFolder(folder);
    return table.map((s) => ({ id: s.id, title: s.title, folder, updated: s.updated, ts: 0 }));
}

// Indice liviano de sesiones de los proyectos CONECTADOS (id, titulo, carpeta,
// updated). Se cortan a las N mas recientes por proyecto (limit por carpeta o
// config sessionIndexLimit, default 4). Devuelve tambien el total de sesiones
// de cada carpeta para que la web sepa si hay mas para pedir. El hub poda lo
// que no venga aca.
async function buildSessionIndex(target) {
    const defLimit = Math.max(1, Math.min(200, parseInt(config.sessionIndexLimit, 10) || 4));
    const folders = activeFolderEntries();
    const seen = new Set();
    const sessions = [];
    const totals = {};
    for (const entry of folders) {
        const folder = entry.path;
        const limit = entry.limit > 0 ? Math.max(1, Math.min(200, entry.limit)) : defLimit;
        let list = [];
        try { list = await listSessionsJson(folder); } catch (e) { continue; }
        // `opencode session list` es global: descartamos las de otras carpetas.
        list = list.filter((s) => sameFolder(s.folder, folder));
        list.sort((a, b) => (b.ts || 0) - (a.ts || 0));
        totals[folder] = list.length;
        let taken = 0;
        for (const s of list) {
            if (seen.has(s.id)) continue;
            seen.add(s.id);
            sessions.push({ id: s.id, title: s.title || '', folder: folder, updated: s.updated || '' });
            taken++;
            if (taken >= limit) break;
        }
    }
    return { sessions: sessions, totals: totals };
}

async function pushSessionIndex(target) {
    const t = target || activeMode;
    try {
        const built = await buildSessionIndex(targetState(t));
        const sessions = built.sessions;
        await api('index_sync', { sessions: sessions, totals: built.totals }, t);
        if (!(pushSessionIndex._silent)) log('indice de sesiones (' + t + '): ' + sessions.length);
        return sessions.length;
    } catch (e) {
        log('aviso: no pude enviar el indice (' + t + '): ' + e.message);
        return 0;
    }
}

// Barrido: recorre carpetas (o una lista puntual), compara contra el estado
// local y exporta/importa las sesiones nuevas o actualizadas. Escaneo completo
// al arrancar y cada 6 h; los intermedios solo tocan carpetas con actividad.
const FULL_SCAN_MS = 6 * 60 * 60 * 1000;

async function syncSessions(opts) {
    if (sweepRunning) return;
    sweepRunning = true;
    try {
        for (const t of activeTargets()) {
            await sweepTarget(t, opts);
        }
    } finally {
        sweepRunning = false;
        // El watcher pudo pedir otro barrido mientras este corria: se reintenta
        // en vez de esperar al proximo cambio de la base o al respaldo de 3 min.
        if (sweepPending && !busy) { sweepPending = false; scheduleSweep('pendiente'); }
    }
}

// Barrido de un destino: importa al hosting t las sesiones de opencode que
// ese hosting no conoce. Incluye los chats web creados en el otro destino
// (todos viven en opencode): así ambos lados terminan viendo lo mismo.
async function sweepTarget(t, opts) {
    // Modo proxy: el hub no guarda conversaciones; solo publicamos el indice.
    if (config.proxyHistory !== false) return pushSessionIndex(t);
    // Si el hosting de t no soporta session_import (código viejo), no seguir
    // exportando al vacío: reintentamos dentro de un rato.
    if (Date.now() < (importBackoffUntil[t] || 0)) return 0;
    let imported = 0;
    const target = targetState(t);
    const full = !target.fullScanTs || (Date.now() - target.fullScanTs > FULL_SCAN_MS);
    let folders;
    const activeSet = new Set(activeFolders());
    if (opts && opts.folders && opts.folders.length) {
        folders = opts.folders.filter((f) => activeSet.has(f));
    } else if (full) {
        folders = Array.from(activeSet);
    } else {
        folders = Object.keys(target.folders).filter((f) => activeSet.has(f));
    }
    const knownOc = lastKnownOc[t] || [];
    // Primer barrido del destino (nada importado todavía): sin tope, para que
    // el lado nuevo se llene de una en vez de esperar varias pasadas.
    const sinTope = !Object.keys(target.folders).length;
    // Varias carpetas pueden listar la misma sesión (proyectos compartidos sin
    // git propio): solo se atiende una vez por pasada.
    const seen = new Set();
    for (const folder of folders) {
        if (busy) { log('barrido de sesiones pausado: hay un mensaje procesándose'); return imported; }
        if (activeRunFolder && normFolder(folder) === normFolder(activeRunFolder)) continue;
        let sessions = [];
        try {
            sessions = await listSessionsInFolder(folder);
        } catch (e) { continue; }
        if (!sessions.length) continue;
        const fstate = target.folders[folder] || (target.folders[folder] = {});
        for (const s of sessions) {
            // Sin cambios desde el último barrido (el marcador es el "updated"
            // de la lista, con precision de minuto). Con `force` (watcher) se
            // re-exportan las sesiones tocadas en los últimos 30 min para no
            // perder cambios dentro del mismo minuto.
            const unchanged = fstate[s.id] === s.updated;
            const forceRecent = !!(opts && opts.force) && listUpdatedRecent(s.updated, 30 * 60 * 1000);
            if (unchanged && !forceRecent) { seen.add(s.id); continue; }
            if (seen.has(s.id)) { fstate[s.id] = s.updated; continue; } // ya atendida en esta pasada
            seen.add(s.id);
            if (knownOc.includes(s.id)) {
                // Chat web vinculado: el hub ya tiene lo que publicó la web,
                // pero el TUI puede haber agregado mensajes. Se importa igual
                // (el merge deduplica por oc_msg) y el hub lo marca `importada`,
                // con lo que sale de known_oc y sigue sincronizando.
                try {
                    await exportAndImport(folder, s, t);
                    fstate[s.id] = s.updated;
                    saveSyncState();
                    imported++;
                } catch (e) {
                    log('aviso: no pude sincronizar ' + s.id + ': ' + e.message);
                }
                continue;
            }
            try {
                const res = await exportAndImport(folder, s, t);
                const realDir = res.realDir;
                fstate[s.id] = s.updated;
                if (realDir && realDir !== folder) {
                    // Carpeta canónica de la sesión: queda marcada también ahí
                    // para los barridos intermedios y refreshTokens.
                    const rf = target.folders[realDir] || (target.folders[realDir] = {});
                    rf[s.id] = s.updated;
                }
                saveSyncState();
                imported++;
                log('sesión importada (' + t + '): ' + s.id + ' "' + (s.title || '(sin título)') + '"'
                    + (realDir && realDir !== folder ? ' → ' + realDir : ''));
            } catch (e) {
                log('aviso: no se pudo importar ' + s.id + ': ' + e.message);
                if (e.message.indexOf('Acción no válida') >= 0) {
                    importBackoffUntil[t] = Date.now() + 10 * 60 * 1000;
                    log('barrido (' + t + '): el hosting no soporta session_import; reintento en 10 min (¿falta actualizar api.php?)');
                    return imported;
                }
            }
            if (!sinTope && imported >= 80) { log('barrido (' + t + '): tope de importaciones por pasada (sigue en la próxima)'); return imported; }
        }
    }
    if (full) {
        target.fullScanTs = Date.now();
        saveSyncState();
    }
    if (imported || !(opts && opts.silent)) {
        log('barrido de sesiones (' + t + '): ' + imported + ' importada(s)');
    }
    return imported;
}

// Carpetas para un sync forzado: solo las conectadas (activas). Antes sumaba
// el nivel 1 del workspace y todo el sync-state, lo que espejaba proyectos que
// el usuario nunca conecto.
function forcedFolders(target) {
    return activeFolders();
}

// Sync manual "total" de un destino: reimporta todo ignorando el estado local
// (recupera un hub que perdió datos) y reconcilia bajas (la PC manda). Corre
// desde un comando de la web, asi que NO usa el chequeo de `busy`; igual
// respeta `activeMsgSession` para no pisar una ejecución en curso.
async function forcedSyncAll(t) {
    if (sweepRunning) return { imported: 0, deleted: 0, skipped: true };
    if (activeMsgSession) return { imported: 0, deleted: 0, error: 'hay un mensaje en curso; reintentá en un momento' };
    sweepRunning = true;
    const target = targetState(t);
    let imported = 0;
    const known = new Set();
    const scanned = new Set();
    const seen = new Set();
    const TOPE = 200;
    try {
        for (const folder of forcedFolders(target)) {
            if (activeMsgSession) break;
            if (imported >= TOPE) break;
            let sessions = [];
            try {
                sessions = await listSessionsInFolder(folder);
            } catch (e) { continue; }
            if (!sessions.length) continue;
            scanned.add(folder);
            const fstate = target.folders[folder] || (target.folders[folder] = {});
            for (const s of sessions) {
                known.add(s.id);
                if (seen.has(s.id)) { fstate[s.id] = s.updated; continue; }
                seen.add(s.id);
                try {
                    const res = await exportAndImport(folder, s, t, { rename: true });
                    fstate[s.id] = s.updated;
                    if (res.realDir && res.realDir !== folder) {
                        scanned.add(res.realDir);
                        const rf = target.folders[res.realDir] || (target.folders[res.realDir] = {});
                        rf[s.id] = s.updated;
                    }
                    saveSyncState();
                    imported++;
                } catch (e) {
                    log('sync total (' + t + '): no pude importar ' + s.id + ': ' + e.message);
                }
                if (imported >= TOPE) break;
            }
        }
        // Reconciliar bajas: solo sesiones de este puente, importadas, cuya
        // carpeta fue escaneada y cuyo opencode_session ya no existe en la PC.
        let deleted = 0;
        try {
            const res = await api('session_reconcile', {
                known: Array.from(known),
                folders: Array.from(scanned),
            }, t);
            deleted = (res && parseInt(res.deleted, 10)) || 0;
        } catch (e) {
            log('sync total (' + t + '): no pude reconciliar bajas: ' + e.message);
        }
        target.fullScanTs = Date.now();
        saveSyncState();
        log('sync total (' + t + '): ' + imported + ' importada(s), ' + deleted + ' borrada(s)');
        return { imported: imported, deleted: deleted };
    } finally {
        sweepRunning = false;
    }
}

// Sync manual de una sesion puntual (boton en la vista del chat). Fuerza el
// export/import aunque el estado local diga que no cambió.
async function sessionSyncOne(cmd) {
    const t = cmd._t || activeMode;
    const oc = String((cmd.args && cmd.args[0]) || '').trim();
    const folder = String((cmd.args && cmd.args[1]) || '').trim();
    if (!/^ses_[A-Za-z0-9]{4,64}$/.test(oc)) {
        await api('command_done', { id: cmd.id, ok: false, text: '', error: 'opencode_session invalido' }, t);
        return;
    }
    const dir = folder || (config.workspace ? path.resolve(config.workspace) : '');
    if (!dir) {
        await api('command_done', { id: cmd.id, ok: false, text: '', error: 'sin carpeta ni workspace' }, t);
        return;
    }
    try {
        const res = await exportAndImport(dir, { id: oc, title: '' }, t, { rename: true });
        await api('command_done', {
            id: cmd.id, ok: true, error: '',
            text: JSON.stringify({ added: res.added, session_id: res.session_id }),
        }, t);
        log('sync sesion ' + oc + ' ok (' + res.added + ' mensajes nuevos)');
    } catch (e) {
        await api('command_done', { id: cmd.id, ok: false, text: '', error: e.message }, t);
        log('sync sesion ' + oc + ' error: ' + e.message);
    }
}

async function sessionSyncAll(cmd) {
    const t = cmd._t || activeMode;
    try {
        const res = await forcedSyncAll(t);
        if (res.error) {
            await api('command_done', { id: cmd.id, ok: false, text: '', error: res.error }, t);
            return;
        }
        await api('command_done', {
            id: cmd.id, ok: true, error: '',
            text: JSON.stringify({ imported: res.imported, deleted: res.deleted, skipped: !!res.skipped }),
        }, t);
    } catch (e) {
        await api('command_done', { id: cmd.id, ok: false, text: '', error: e.message }, t);
    }
}

// ---------------------------------------------------------------------------
// Sincronizacion casi en tiempo real. opencode persiste en su base SQLite
// (opencode.db / -wal / -shm); un watcher liviano mira mtime+tamano y dispara
// un barrido tras un periodo de calma, en vez de esperar 15 min.
// ---------------------------------------------------------------------------
let sweepPending = false;
let sweepTimer = null;
let lastSweepAt = 0;
// Cadencia del watcher y calma antes de barrer. Antes eran 4s + 8s, con un
// throttle de 30s que dejaba el barrido `pending` hasta el proximo mensaje (o
// el respaldo de 3 min): un chat hecho en el TUI tardaba en verse en el hub.
const WATCH_POLL_MS = 1500;
const WATCH_DEBOUNCE_MS = 2500;
const SWEEP_THROTTLE_MS = 5000;

function scheduleSweep(reason) {
    if (busy || sweepRunning) { sweepPending = true; return; }
    const since = Date.now() - lastSweepAt;
    if (since < SWEEP_THROTTLE_MS) {
        // Dentro del throttle: no perder el pedido. Un timer lo reintenta al
        // vencer la ventana (antes solo se corria al terminar un mensaje).
        sweepPending = true;
        if (!sweepTimer) {
            sweepTimer = setTimeout(() => {
                sweepTimer = null;
                if (sweepPending && !busy && !sweepRunning) { sweepPending = false; scheduleSweep('pendiente'); }
            }, SWEEP_THROTTLE_MS - since);
        }
        return;
    }
    lastSweepAt = Date.now();
    syncSessions({ silent: true, force: reason === 'watcher' }).catch(handleError);
}

function opencodeDataDirs() {
    const dirs = [];
    if (process.env.XDG_DATA_HOME) dirs.push(path.join(process.env.XDG_DATA_HOME, 'opencode'));
    dirs.push(path.join(os.homedir(), '.local', 'share', 'opencode'));
    dirs.push(path.join(os.homedir(), 'AppData', 'Local', 'opencode'));
    return dirs;
}
function opencodeDbSignature() {
    let sig = '';
    for (const d of opencodeDataDirs()) {
        for (const f of ['opencode.db', 'opencode.db-wal', 'opencode.db-shm']) {
            try {
                const st = fs.statSync(path.join(d, f));
                sig += f + ':' + Math.round(st.mtimeMs) + ':' + st.size + ';';
            } catch (e) { /* no existe en esa ruta */ }
        }
    }
    return sig;
}
// `updated` de `session list` es "HH:MM · D/M/YYYY" (precision de minuto).
function listUpdatedRecent(updated, windowMs) {
    const m = String(updated || '').match(/^(\d{1,2}):(\d{2})\s*·\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!m) return false;
    const ts = new Date(Number(m[5]), Number(m[4]) - 1, Number(m[3]), Number(m[1]), Number(m[2])).getTime();
    return ts > 0 && (Date.now() - ts) <= windowMs;
}
function startSyncWatcher() {
    let last = opencodeDbSignature();
    let timer = null;
    setInterval(() => {
        const sig = opencodeDbSignature();
        if (sig === '' || sig === last) return;
        last = sig;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => scheduleSweep('watcher'), WATCH_DEBOUNCE_MS);
    }, WATCH_POLL_MS);
    // Respaldo por si el watcher no ve el cambio (otra ruta o filesystem).
    setInterval(() => scheduleSweep('periodico'), 3 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Archivos: listado y lectura (read-only) resueltos por el puente,
// siempre dentro del workspace y sin recorrer basura (node_modules, .git...).
// ---------------------------------------------------------------------------
function fsSkipName(name) {
    if (!name || name.startsWith('.')) return true;
    const SKIP = new Set(['node_modules', 'dist', 'build', 'vendor', 'target', '__pycache__', '.next', '.cache', '.venv', '.gradle', '.idea', '.vscode']);
    return SKIP.has(name);
}

function resolveInWorkspace(rel) {
    const root = config.workspace ? path.resolve(config.workspace) : '';
    if (!root) throw new Error('config.json no define "workspace"');
    const parts = String(rel || '').replace(/\\/g, '/').split('/').filter((p) => p && p !== '.' && p !== '..');
    let abs = root;
    for (const p of parts) abs = path.join(abs, p);
    let real, rootReal;
    try {
        real = fs.realpathSync(abs);
        rootReal = fs.realpathSync(root);
    } catch (e) {
        throw new Error('ruta inexistente');
    }
    const rootNorm = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
    if (real !== rootReal && !real.startsWith(rootNorm)) throw new Error('fuera del workspace');
    return { abs: real, rel: parts.join('/') };
}

function fsList(rel) {
    const r = resolveInWorkspace(rel);
    const items = fs.readdirSync(r.abs, { withFileTypes: true });
    const dirs = [];
    const files = [];
    let skipped = false;
    for (const it of items) {
        if (fsSkipName(it.name)) { skipped = true; continue; }
        const full = path.join(r.abs, it.name);
        let st = null;
        try { st = fs.statSync(full); } catch (e) { continue; }
        if (st.isDirectory()) {
            dirs.push({ name: it.name, type: 'dir', size: null, mtime: Math.floor(st.mtimeMs / 1000) });
        } else if (st.isFile()) {
            files.push({ name: it.name, type: 'file', size: st.size, mtime: Math.floor(st.mtimeMs / 1000) });
        }
    }
    const cmp = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    dirs.sort(cmp);
    files.sort(cmp);
    const entries = dirs.concat(files);
    return { path: r.rel, entries: entries.slice(0, 500), truncated: entries.length > 500 || skipped };
}

function fsRead(rel) {
    const r = resolveInWorkspace(rel);
    const st = fs.statSync(r.abs);
    if (!st.isFile()) throw new Error('no es un archivo');
    if (st.size > 512 * 1024) throw new Error('demasiado grande (>512 KB)');
    const buf = fs.readFileSync(r.abs);
    const sample = buf.subarray(0, Math.min(buf.length, 4096));
    let nonPrint = 0;
    for (const b of sample) {
        if (b === 0 || (b < 32 && b !== 9 && b !== 10 && b !== 13)) nonPrint++;
    }
    if (sample.length && nonPrint / sample.length > 0.3) throw new Error('archivo binario');
    return { path: r.rel, size: st.size, content: buf.toString('utf8') };
}

async function handleFsCommand(cmd) {
    const rel = (cmd.args && cmd.args.length ? String(cmd.args[0]) : '');
    try {
        const r = cmd.name === 'fs_list' ? fsList(rel) : fsRead(rel);
        await api('fs_result', { id: cmd.id, ok: true, text: JSON.stringify(r), error: '' }, cmd._t);
        log('fs ' + cmd.name + ' "' + (rel || '/') + '" ok (' + JSON.stringify(r).length + ' car.)');
    } catch (e) {
        await api('fs_result', { id: cmd.id, ok: false, text: '', error: e.message }, cmd._t);
        log('fs ' + cmd.name + ' "' + (rel || '/') + '" error: ' + e.message);
    }
}

// ---------------------------------------------------------------------------
// Cambios del proyecto (git status / git diff) para revisar lo que tocó el
// agente desde el celular. Corre git en la carpeta de la sesión (validada
// dentro del workspace, igual que proc_start).
// ---------------------------------------------------------------------------
function parseGitStatus(text) {
    const files = [];
    let branch = '';
    for (const line of String(text).split('\n')) {
        if (line === '') continue;
        if (line.startsWith('## ')) { branch = line.slice(3).trim(); continue; }
        const status = line.slice(0, 2).trim() || '?';
        let p = line.slice(3);
        const arrow = p.indexOf(' -> ');
        if (arrow >= 0) p = p.slice(arrow + 4);
        files.push({ status, path: p });
    }
    return { branch, files };
}

function gitIn(folder, args, timeout = 30000) {
    const r = spawnSync('git', ['-C', folder].concat(args), {
        encoding: 'utf8',
        timeout,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
    });
    if (r.error) throw new Error(r.error.message || 'no se pudo ejecutar git');
    const text = String(r.stdout || '');
    return { code: r.status, text, err: String(r.stderr || '').trim() };
}

async function handleGitCommand(cmd) {
    let folder;
    try { folder = procResolveFolder(cmd.args && cmd.args[0]); }
    catch (e) {
        await api('command_done', { id: cmd.id, ok: false, text: '', error: e.message }, cmd._t);
        return;
    }
    try {
        if (cmd.name === 'git_status') {
            const r = gitIn(folder, ['status', '--porcelain=v1', '-b', '--untracked-files=all']);
            if (r.code !== 0) throw new Error(r.err || 'no es un repositorio git');
            await api('command_done', { id: cmd.id, ok: true, text: JSON.stringify(parseGitStatus(r.text)), error: '' }, cmd._t);
        } else if (cmd.name === 'git_checkout') {
            // Revierte cambios de archivos RASTREADOS dentro de la carpeta de la
            // sesion. Sin 2do argumento revierte todo (`.`); con argumento,
            // solo ese archivo relativo (sin `..` ni rutas absolutas).
            let target = (cmd.args && cmd.args.length > 1) ? String(cmd.args[1]) : '.';
            if (target !== '.') {
                if (path.isAbsolute(target) || target.split(/[\\/]/).includes('..')) {
                    throw new Error('ruta invalida');
                }
            }
            const r = gitIn(folder, ['checkout', '--', target]);
            if (r.code !== 0) throw new Error(r.err || 'no se pudo revertir');
            await api('command_done', { id: cmd.id, ok: true, text: JSON.stringify({ reverted: target }), error: '' }, cmd._t);
        } else {
            // diff HEAD: cambios preparados + sin preparar. `fs_result` admite
            // respuestas mas grandes que command_done (8000 car.).
            const r = gitIn(folder, ['--no-pager', 'diff', 'HEAD', '--no-color', '--no-ext-diff', '--no-renames']);
            if (r.code !== 0) throw new Error(r.err || 'no es un repositorio git');
            await api('fs_result', { id: cmd.id, ok: true, text: JSON.stringify({ diff: r.text }), error: '' }, cmd._t);
        }
        log('git ' + cmd.name + ' ok en ' + folder);
    } catch (e) {
        await api('command_done', { id: cmd.id, ok: false, text: '', error: e.message }, cmd._t);
        log('git ' + cmd.name + ' error: ' + e.message);
    }
}

// ---------------------------------------------------------------------------
// Procesa comandos read-only encolados por la web.
// ---------------------------------------------------------------------------

// Túneles TunnelMole: procesos vivos en esta PC, en memoria mientras corre el
// puente. La web los abre/cierra/lista con tunnel_start/tunnel_stop/tunnel_list.
const tunnels = new Map();
// Hostings que no soportan el poll liviano (api.php viejo): si en modo lite
// devuelven mensajes, los reclamaríamos y los ignoraríamos (quedarían
// colgados hasta el STALE). Se desactiva el lite para ese destino.
const liteUnsupported = new Set();

function tunnelPortOf(args) {
    const s = String((args && args.length ? args[0] : '') || '').trim();
    if (!/^\d{1,5}$/.test(s)) return null;
    const n = parseInt(s, 10);
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

async function tunnelDone(cmd, ok, payload, error) {
    await api('command_done', {
        id: cmd.id,
        ok,
        text: ok ? JSON.stringify(payload) : '',
        error: error || '',
    }, cmd._t);
}

function parseTunnelUrls(text) {
    const urls = [...new Set(String(text).match(/https?:\/\/[a-z0-9-]+\.tunnelmole\.net/g) || [])];
    return {
        https: urls.find((u) => u.startsWith('https')) || '',
        http: urls.find((u) => u.startsWith('http:')) || '',
    };
}

// Abre el túnel para un puerto. Si `tmole` está instalado lo usa; si no,
// recurre a `npx --yes tunnelmole` (lo descarga la primera vez). Los binarios
// se resuelven con el mismo resolver de los procesos: en Windows los shims
// .cmd no se pueden spawnear directo (EINVAL) y sin esto el túnel nunca abre.
function tunnelSpawn(port, onLine, onFail, onUrls, triedNpx = false) {
    let spec;
    try {
        spec = procResolveBin(triedNpx ? 'npx' : 'tmole', null);
    } catch (e) {
        if (!triedNpx) {
            log('túnel: tmole no está en PATH, probando con npx…');
            tunnelSpawn(port, onLine, onFail, onUrls, true);
            return;
        }
        onFail('no se encontró npx para abrir el túnel (' + e.message + ')');
        return;
    }
    const args = (spec.pre || []).concat(triedNpx ? ['--yes', 'tunnelmole', String(port)] : [String(port)]);
    let settled = false;
    // Si `tmole` existe pero falla (shim roto, sin PATH, etc.), reintentamos con
    // `npx --yes tunnelmole` en vez de darnos por vencidos.
    const retryNpx = () => {
        if (settled) return;
        settled = true;
        log('túnel: tmole falló, reintentando con npx tunnelmole…');
        tunnelSpawn(port, onLine, onFail, onUrls, true);
    };
    let proc;
    try {
        proc = spawn(spec.bin, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            windowsVerbatimArguments: !!spec.verbatim,
        });
    } catch (e) {
        if (!triedNpx) { retryNpx(); return; }
        onFail('no se pudo iniciar tunnelmole (' + e.message + '). Instalalo con: npm i -g tunnelmole');
        return;
    }
    let buf = '';
    const feed = (d) => {
        buf += String(d);
        const urls = parseTunnelUrls(buf);
        if (urls.https || urls.http) { settled = true; onUrls(urls); }
    };
    proc.stdout.on('data', feed);
    proc.stderr.on('data', feed);
    proc.on('error', (e) => {
        if (!triedNpx) { retryNpx(); return; }
        onFail('no se pudo iniciar tunnelmole (' + e.message + '). Instalalo con: npm i -g tunnelmole');
    });
    proc.on('exit', (code) => {
        if (settled) return;
        if (!triedNpx) { retryNpx(); return; }
        onFail('tmole terminó (código ' + code + ')' + (buf ? ': ' + buf.slice(0, 160).trim() : ''));
    });
    onLine(proc);
    return proc;
}

async function tunnelStart(cmd) {
    const port = tunnelPortOf(cmd.args);
    if (!port) {
        await tunnelDone(cmd, false, null, 'puerto inválido (usá 1–65535)');
        return;
    }
    const existing = tunnels.get(port);
    if (existing && existing.proc && !existing.proc.killed) {
        await tunnelDone(cmd, true, { port, ...existing.urls });
        return;
    }
    log('túnel: abriendo para el puerto ' + port + '…');
    let settled = false;
    let entry = null;
    let timer = null;
    const finish = async (ok, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (ok) {
            await tunnelDone(cmd, true, { port, ...entry.urls });
            log('túnel: puerto ' + port + ' → ' + (entry.urls.https || entry.urls.http));
            return;
        }
        tunnels.delete(port);
        if (entry && entry.proc) { try { entry.proc.kill(); } catch (e) { /* ya murió */ } }
        await tunnelDone(cmd, false, null, error || 'tunnelmole no devolvió URLs');
        log('túnel: error en puerto ' + port + ': ' + (error || 'sin URLs'));
    };
    entry = { port, proc: null, urls: { https: '', http: '' }, startedAt: Date.now() };
    tunnels.set(port, entry);
    // 85 s: con el fallback de npx, la primera vez descarga tunnelmole.
    timer = setTimeout(() => {
        finish(false, 'tunnelmole no devolvió URLs (85 s). ¿Está instalado? npm i -g tunnelmole');
    }, 85000);
    tunnelSpawn(
        port,
        (proc) => { entry.proc = proc; },
        (error) => finish(false, error),
        (urls) => {
            entry.urls = urls;
            finish(true);
        }
    );
}

async function tunnelStop(cmd) {
    const port = tunnelPortOf(cmd.args);
    if (!port) {
        await tunnelDone(cmd, false, null, 'puerto inválido (usá 1–65535)');
        return;
    }
    const entry = tunnels.get(port);
    if (!entry) {
        await tunnelDone(cmd, true, { port, stopped: true });
        return;
    }
    tunnels.delete(port);
    try {
        if (process.platform === 'win32' && entry.proc && entry.proc.pid) {
            spawn('taskkill', ['/PID', String(entry.proc.pid), '/T', '/F'], { windowsHide: true });
        } else if (entry.proc) {
            entry.proc.kill('SIGTERM');
        }
    } catch (e) { /* nada que cerrar */ }
    log('túnel: cerrado el puerto ' + port);
    await tunnelDone(cmd, true, { port, stopped: true });
}

async function tunnelList(cmd) {
    const list = [];
    for (const [port, e] of tunnels) {
        if (!e.proc || e.proc.killed) continue;
        list.push({
            port,
            https: e.urls.https,
            http: e.urls.http,
            uptime: Math.round((Date.now() - e.startedAt) / 1000),
        });
    }
    await tunnelDone(cmd, true, { tunnels: list });
}

// ---------------------------------------------------------------------------
// Procesos de desarrollo (dev servers). Viven en memoria del puente (mueren
// con él, como los túneles). Se lanzan SIEMPRE con cwd dentro del workspace y
// su binario debe estar en la whitelist de bridge/config.json → "processes".
// Sin shell: en Windows los shims .cmd/.bat se resuelven al binario real o se
// ejecutan vía cmd.exe, nunca interpolando la línea de comando.
// ---------------------------------------------------------------------------
const procs = new Map();          // id -> entrada
let nextProcId = 1;
const PROC_LOG_TAIL = 256 * 1024; // anillo de log retenido por proceso
const PROC_LOG_CHUNK = 32 * 1024; // máx. caracteres por respuesta de proc_log

function procConfig() {
    const p = (config && config.processes) || {};
    const norm = (a) => String(a).toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
    const DEFAULT_ALLOW = ['npm', 'node', 'npx', 'php', 'python', 'python3', 'composer', 'pnpm', 'yarn'];
    const LEGACY_ALLOW = ['npm', 'node', 'npx'];
    let allow = Array.isArray(p.allow) ? p.allow.map(norm) : DEFAULT_ALLOW.slice();
    // Las configs viejas traian el allow por defecto de antes. No debe bloquear
    // los runtimes nuevos (php/python/composer) despues de `openbridge update`:
    // solo se reemplaza cuando es EXACTAMENTE ese default viejo (los allow
    // personalizados se respetan tal cual).
    if (allow.length === LEGACY_ALLOW.length && LEGACY_ALLOW.every((x) => allow.indexOf(x) >= 0)) {
        allow = DEFAULT_ALLOW.slice();
    }
    // processes.bins: { php: "C:\\xampp\\php\\php.exe" } para runtimes que no
    // estan en el PATH (Windows). La clave es el nombre que se escribe en el
    // comando; el valor, la ruta al ejecutable.
    const bins = {};
    if (p.bins && typeof p.bins === 'object') {
        for (const k of Object.keys(p.bins)) {
            const name = norm(k);
            const val = String(p.bins[k] || '').trim();
            if (name && val) bins[name] = val;
        }
    }
    return {
        enabled: p.enabled !== false,
        allow,
        maxGlobal: Math.max(1, parseInt(p.maxGlobal, 10) || 3),
        bins,
    };
}

// La carpeta de trabajo debe ser real y quedar DENTRO del workspace. Misma
// garantía que los fs_*: realpath + prefijo del root. Nunca un cwd arbitrario.
function procResolveFolder(dir) {
    const root = config.workspace ? path.resolve(config.workspace) : '';
    if (!root) throw new Error('config.json no define "workspace"');
    if (!String(dir || '').trim()) throw new Error('carpeta vacía');
    let real, rootReal;
    try {
        real = fs.realpathSync(path.resolve(String(dir)));
        rootReal = fs.realpathSync(root);
    } catch (e) {
        throw new Error('carpeta inexistente');
    }
    const norm = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep;
    if (real !== rootReal && !real.startsWith(norm)) throw new Error('fuera del workspace');
    if (!fs.statSync(real).isDirectory()) throw new Error('no es una carpeta');
    return real;
}

function procTokenize(line) {
    // Trocea respetando comillas simples/dobles; no hay shell, así que nada más.
    const out = [];
    let cur = '';
    let q = '';
    for (const ch of String(line)) {
        if (q) {
            if (ch === q) q = '';
            else cur += ch;
        } else if (ch === '"' || ch === "'") {
            q = ch;
        } else if (ch === ' ' || ch === '\t') {
            if (cur) { out.push(cur); cur = ''; }
        } else {
            cur += ch;
        }
    }
    if (cur) out.push(cur);
    return out;
}

function procSafeToken(t) {
    // Refuerzo del lado puente aunque la web ya filtra: sin metacaracteres de
    // shell/cmd ni controles. Con esto armar una línea para cmd.exe es seguro.
    return /^[\p{L}\p{N} _\-.:@\/+=]+$/u.test(String(t));
}

function procFindOnPath(name) {
    const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
        for (const ext of ['.exe', '.cmd', '.bat']) {
            const p = path.join(dir, name + ext);
            try { if (fs.existsSync(p)) return { p, ext }; } catch (e) {}
        }
    }
    return null;
}

// Devuelve { bin, pre } listo para spawn(), sin shell. En Windows:
//  - node → el node.exe del PATH (o el del propio puente).
//  - npm/npx → node.exe + su cli (node_modules/npm/bin/*-cli.js), probado.
//  - otro permitido → .exe directo, o shim .cmd/.bat vía cmd.exe /c (spawn
//    directo de .cmd da EINVAL en Node/Windows).
function procResolveBin(token, allowSet, bins) {
    const bare = String(token).toLowerCase().replace(/\.(exe|cmd|bat|com)$/, '');
    if (bare.includes('/') || bare.includes('\\')) throw new Error('el programa debe ser un nombre en el PATH');
    // Mapa explícito (config.json → processes.bins): opt-in del dueño; tiene
    // prioridad sobre el PATH y no exige que el nombre esté en `allow`.
    if (bins && bins[bare]) {
        const p = String(bins[bare]);
        if (!fs.existsSync(p)) throw new Error('no existe el binario de "' + bare + '": ' + p);
        const ext = path.extname(p).toLowerCase();
        if (ext === '.cmd' || ext === '.bat') {
            return { bin: 'cmd.exe', pre: ['/d', '/s', '/c', '"' + p + '"'], verbatim: true };
        }
        return { bin: p, pre: [] };
    }
    // allowSet null = uso interno del puente (túneles); con lista, se exige.
    if (allowSet && !allowSet.has(bare)) throw new Error('programa no permitido (config.json → processes.allow)');
    if (process.platform !== 'win32') return { bin: token, pre: [] };
    if (bare === 'node') {
        const exe = procFindOnPath('node');
        return { bin: exe && exe.ext === '.exe' ? exe.p : process.execPath, pre: [] };
    }
    if (bare === 'npm' || bare === 'npx') {
        const nodeBin = process.execPath;
        const base = path.dirname(nodeBin);
        const script = path.join(base, 'node_modules', 'npm', 'bin', bare === 'npm' ? 'npm-cli.js' : 'npx-cli.js');
        if (fs.existsSync(script)) return { bin: nodeBin, pre: [script] };
        throw new Error('no encontré ' + bare + '-cli.js junto a node.exe');
    }
    const found = procFindOnPath(bare);
    if (!found) throw new Error('no se encontró "' + token + '" en el PATH');
    if (found.ext.toLowerCase() === '.exe') return { bin: found.p, pre: [] };
    // Shim .cmd/.bat: se ejecuta con cmd.exe. `verbatim` evita que Node vuelva a
    // citar el argumento (que ya viene entre comillas) y cmd reciba "\"ruta\"".
    return { bin: 'cmd.exe', pre: ['/d', '/s', '/c', '"' + found.p + '"'], verbatim: true };
}

async function procDone(cmd, ok, payload, error) {
    // Los trozos de log pueden superar el tope de command_done (8000 car.),
    // así que los resultados de proc_* viajan por proc_result (hasta 100 KB).
    await api('proc_result', {
        id: cmd.id,
        ok,
        text: ok ? JSON.stringify(payload) : '',
        error: error || '',
    }, cmd._t);
}

// Acumula salida en un anillo: el offset es un cursor de caracteres *limpios*
// (sin ANSI, CRLF normalizado) que devuelve proc_log y la web va avanzando.
function procFeed(entry, chunk) {
    const clean = stripAnsi(String(chunk)).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (!clean) return;
    entry.totalChars += clean.length;
    let merged = entry.log + clean;
    if (merged.length > PROC_LOG_TAIL) {
        const over = merged.length - PROC_LOG_TAIL;
        entry.ringStart += over;
        merged = merged.slice(over);
    }
    entry.log = merged;
    // Puerto del server detectado en la salida (para la limpieza de huérfanos
    // y para la web): "Local: http://localhost:3000" etc.
    if (!entry.port) {
        const m = entry.log.match(/(?:localhost|127\.0\.0\.1):\s*(\d{1,5})/i);
        if (m) {
            entry.port = parseInt(m[1], 10);
            saveProcsState();
        }
    }
}

function procKillTree(entry) {
    if (!entry || !entry.proc || entry.proc.killed) return;
    try {
        if (process.platform === 'win32' && entry.proc.pid) {
            spawn('taskkill', ['/PID', String(entry.proc.pid), '/T', '/F'], { windowsHide: true });
        } else {
            entry.proc.kill('SIGTERM');
        }
    } catch (e) { /* ya murió */ }
}

async function procStart(cmd) {
    const pc = procConfig();
    if (!pc.enabled) {
        await procDone(cmd, false, null, 'procesos deshabilitados en bridge/config.json');
        return;
    }
    let folder;
    try { folder = procResolveFolder(cmd.args && cmd.args[0]); }
    catch (e) { await procDone(cmd, false, null, e.message); return; }
    const cmdline = String(cmd.args && cmd.args[1] ? cmd.args[1] : '').trim();
    if (!cmdline) { await procDone(cmd, false, null, 'comando vacío'); return; }
    const tokens = procTokenize(cmdline);
    if (!tokens.length) { await procDone(cmd, false, null, 'comando vacío'); return; }
    for (const t of tokens) {
        if (!procSafeToken(t)) { await procDone(cmd, false, null, 'caracteres no permitidos en el comando'); return; }
    }
    // 1 proceso activo por carpeta (idempotente): si ya corre uno ahí, se devuelve.
    const live = [...procs.values()];
    const sameFolder = live.find((p) => p.running && p.folder === folder);
    if (sameFolder) {
        await procDone(cmd, true, { id: sameFolder.id, folder, running: true, already: true });
        return;
    }
    if (live.filter((p) => p.running).length >= pc.maxGlobal) {
        await procDone(cmd, false, null, 'máximo de procesos alcanzado (' + pc.maxGlobal + ')');
        return;
    }
    let spec;
    try { spec = procResolveBin(tokens[0], new Set(pc.allow), pc.bins); }
    catch (e) { await procDone(cmd, false, null, e.message); return; }
    const procArgs = (spec.pre || []).concat(tokens.slice(1));
    let child;
    try {
        child = spawn(spec.bin, procArgs, {
            cwd: folder,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: process.env,
            windowsHide: true,
            windowsVerbatimArguments: !!spec.verbatim,
        });
    } catch (e) {
        await procDone(cmd, false, null, 'no se pudo iniciar: ' + e.message);
        return;
    }
    const id = nextProcId++;
    const entry = {
        id, folder, cmd: cmdline, running: true,
        proc: child, spawnError: '',
        startedAt: Date.now(), exitedAt: null, exitCode: null,
        log: '', ringStart: 0, totalChars: 0,
    };
    procs.set(id, entry);
    child.stdout.on('data', (d) => procFeed(entry, d));
    child.stderr.on('data', (d) => procFeed(entry, d));
    child.on('error', (e) => { entry.spawnError = e.message; });
    child.on('close', (code) => {
        entry.running = false;
        entry.exitCode = code;
        entry.exitedAt = Date.now();
        log('proceso #' + id + ' terminó (código ' + code + '): ' + entry.cmd);
        saveProcsState();
        procCleanup();
    });
    log('proceso #' + id + ' iniciado en ' + folder + ': ' + cmdline);
    saveProcsState();
    await procDone(cmd, true, { id, folder, running: true, startedAt: entry.startedAt });
}

async function procStop(cmd) {
    const id = parseInt(String(cmd.args && cmd.args[0]), 10);
    const entry = procs.get(id);
    if (entry && entry.running) procKillTree(entry);
    await procDone(cmd, true, { id: isNaN(id) ? null : id, stopped: true });
}

// Libera un puerto TCP: encuentra los pid que escuchan y mata cada árbol.
// Lo dispara el panel cuando un dev server falla con EADDRINUSE.
function portFreePidsWin(text, port) {
    const re = new RegExp(':' + port + '\\s');
    const pids = new Set();
    for (const line of String(text).split(/\r?\n/)) {
        if (!re.test(line) || !/LISTENING/i.test(line)) continue;
        const parts = line.trim().split(/\s+/);
        const pid = parseInt(parts[parts.length - 1], 10);
        if (pid > 0) pids.add(pid);
    }
    return [...pids];
}

async function portFree(cmd) {
    const port = tunnelPortOf(cmd.args);
    if (!port) {
        await procDone(cmd, false, null, 'puerto inválido (usá 1–65535)');
        return;
    }
    let pids = [];
    try {
        if (process.platform === 'win32') {
            const r = await runCmd('netstat', ['-ano', '-p', 'tcp'], { timeout: 15000 });
            pids = portFreePidsWin(r.text, port);
        } else {
            let r = await runCmd('lsof', ['-t', '-i', 'tcp:' + port, '-s', 'tcp:listen'], { timeout: 15000 });
            if (!r.ok || !String(r.text || '').trim()) {
                r = await runCmd('fuser', [String(port) + '/tcp'], { timeout: 15000 });
            }
            pids = String(r.text || '').split(/\s+/).map(Number).filter((n) => n > 0);
        }
    } catch (e) { /* sigo con lo que haya */ }
    if (!pids.length) {
        await procDone(cmd, true, { port, freed: false, pids: [] });
        log('puerto ' + port + ': no encontré procesos escuchando');
        return;
    }
    const killed = [];
    for (const pid of pids) {
        try {
            if (process.platform === 'win32') {
                spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
            } else {
                process.kill(pid, 'SIGKILL');
            }
            killed.push(pid);
        } catch (e) { /* sigo con los demás */ }
    }
    log('puerto ' + port + ' liberado (pids: ' + killed.join(', ') + ')');
    await procDone(cmd, true, { port, freed: killed.length > 0, pids: killed });
}

function procCleanup() {
    // Suelta entradas viejas terminadas (topes en memoria del puente).
    const finished = [...procs.values()].filter((p) => !p.running);
    for (let i = 0; i < finished.length - 8; i++) procs.delete(finished[i].id);
}

async function procList(cmd) {
    const list = [...procs.values()]
        .filter((p) => p.running || p.exitedAt)
        .map((p) => ({
            id: p.id,
            folder: p.folder,
            cmd: p.cmd,
            running: p.running,
            startedAt: p.startedAt,
            exitedAt: p.exitedAt,
            exitCode: p.exitCode,
        }))
        .sort((a, b) => (b.running - a.running) || (b.startedAt - a.startedAt));
    await procDone(cmd, true, { procs: list });
}

async function procLog(cmd) {
    const id = parseInt(String(cmd.args && cmd.args[0]), 10);
    let offset = parseInt(String(cmd.args && cmd.args[1]), 10);
    if (!(offset >= 0)) offset = 0;
    const entry = procs.get(id);
    if (!entry) {
        // Desapareció (puente reiniciado o entrada podada): fin del stream.
        await procDone(cmd, true, { text: '', offset: 0, running: false, done: true, exitCode: null });
        return;
    }
    let start = Math.min(Math.max(offset, entry.ringStart), entry.totalChars);
    const avail = entry.totalChars - start;
    const take = Math.min(avail, PROC_LOG_CHUNK);
    const seg = entry.log.slice(start - entry.ringStart, start - entry.ringStart + take);
    await procDone(cmd, true, {
        text: seg,
        offset: start + take,
        running: entry.running,
        done: !entry.running,
        exitCode: entry.exitCode,
        spawnError: entry.spawnError || '',
    });
}

// Inspecciona la raíz de un proyecto (read-only) y sugiere cómo correrlo en dev:
// package.json (scripts), composer.json/artisan y entrypoints PHP. Devuelve
// { folder, kind, port, suggestions: [{ label, cmd }] }.
async function procDetect(cmd) {
    let folder;
    try { folder = procResolveFolder(cmd.args && cmd.args[0]); }
    catch (e) { await procDone(cmd, false, null, e.message); return; }
    const out = { folder, kind: '', port: '', suggestions: [] };
    const add = (label, c) => {
        if (c && !out.suggestions.some((s) => s.cmd === c)) out.suggestions.push({ label, cmd: c });
    };
    const readJson = (name) => {
        try { return JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8')); }
        catch (e) { return null; }
    };
    const has = (rel) => { try { return fs.existsSync(path.join(folder, rel)); } catch (e) { return false; } };

    // Node: scripts de package.json (dev/start/serve/preview).
    const pkg = readJson('package.json');
    if (pkg) {
        out.kind = 'node';
        const scripts = (pkg && pkg.scripts) || {};
        for (const key of ['dev', 'start', 'serve', 'preview']) {
            if (scripts[key]) add((key === 'start' ? 'npm start' : 'npm run ' + key) + '  (package.json)',
                key === 'start' ? 'npm start' : 'npm run ' + key);
        }
        if (!out.suggestions.length) {
            const entry = pkg.main || (has('server.js') ? 'server.js' : (has('index.js') ? 'index.js' : ''));
            if (entry) add('node ' + entry, 'node ' + entry);
        }
    }

    // PHP: artisan (Laravel), scripts de composer y front controllers.
    const composer = readJson('composer.json');
    if (has('artisan')) {
        out.kind = out.kind || 'php';
        add('php artisan serve', 'php artisan serve');
    }
    if (composer && composer.scripts && typeof composer.scripts === 'object') {
        for (const key of Object.keys(composer.scripts)) {
            if (key === 'serve' || key === 'dev' || key === 'start') {
                out.kind = out.kind || 'php';
                add('composer run ' + key, 'composer run ' + key);
            }
        }
    }
    if (!has('artisan')) {
        const entries = ['public/index.php', 'backend/public/index.php', 'web/index.php', 'index.php'];
        const entry = entries.find(has);
        if (entry) {
            out.kind = out.kind || 'php';
            out.port = out.port || '3001';
            add('php -S 127.0.0.1:3001 ' + entry, 'php -S 127.0.0.1:3001 ' + entry);
            const dir = path.posix.dirname(entry);
            if (dir && dir !== '.') {
                add('php -S 127.0.0.1:3001 -t ' + dir, 'php -S 127.0.0.1:3001 -t ' + dir);
            }
        }
    }
    await procDone(cmd, true, out);
}

async function handleCommand(cmd) {
    // Comandos fs_* los resuelve el puente directamente (sin opencode CLI).
    if (cmd.name === 'fs_list' || cmd.name === 'fs_read') {
        await handleFsCommand(cmd);
        return;
    }
    // Servidores MCP de opencode: se devuelve JSON con la salida cruda para que
    // la web la muestre en el panel.
    if (cmd.name === 'mcp_list') {
        const r = await runCli(['mcp', 'list'], { timeout: 30000 });
        await api('command_done', {
            id: cmd.id,
            ok: r.ok,
            text: JSON.stringify({ output: r.text || '', ok: r.ok }),
            error: r.ok ? '' : ('exit ' + r.code),
        }, cmd._t);
        log('comando #' + cmd.id + ' mcp_list (ok=' + r.ok + ')');
        return;
    }
    // Cambios git del proyecto (status/diff/revertir).
    if (cmd.name === 'git_status' || cmd.name === 'git_diff' || cmd.name === 'git_checkout') {
        await handleGitCommand(cmd);
        return;
    }
    // Túneles también son del puente (procesos de esta PC).
    if (cmd.name === 'tunnel_start') { await tunnelStart(cmd); return; }
    if (cmd.name === 'tunnel_stop') { await tunnelStop(cmd); return; }
    if (cmd.name === 'tunnel_list') { await tunnelList(cmd); return; }
    // Procesos de desarrollo (dev servers) en la carpeta de una sesión.
    if (cmd.name === 'proc_start') { await procStart(cmd); return; }
    if (cmd.name === 'proc_stop') { await procStop(cmd); return; }
    if (cmd.name === 'proc_list') { await procList(cmd); return; }
    if (cmd.name === 'proc_log') { await procLog(cmd); return; }
    if (cmd.name === 'proc_detect') { await procDetect(cmd); return; }
    if (cmd.name === 'port_free') { await portFree(cmd); return; }
    // Sincronizacion manual del historial (botones de la web).
    if (cmd.name === 'session_sync') { await sessionSyncOne(cmd); return; }
    if (cmd.name === 'session_sync_all') { await sessionSyncAll(cmd); return; }
    // Conectar/desconectar proyectos desde la web (sidebar en blanco por defecto).
    if (cmd.name === 'folder_attach') { await handleFolderToggle(cmd, true); return; }
    if (cmd.name === 'folder_detach') { await handleFolderToggle(cmd, false); return; }
    if (cmd.name === 'folder_more') { await handleFolderMore(cmd); return; }
    // Historial por proxy: la web lo pide y el puente lo saca de opencode.
    if (cmd.name === 'session_history') { await sessionHistory(cmd); return; }
    // Mapea el nombre "interno" al subcomando real de opencode.
    // Whitelist cerrada; cualquier nombre fuera de acá se rechaza.
    const MAP = {
        'models': ['models'],
        'session_list': ['session', 'list'],
        'session_info': ['session', 'info'],
        'opencode_version': ['--version'],
    };
    const argv = MAP[cmd.name];
    if (!argv) {
        await api('command_done', { id: cmd.id, ok: false, text: '', error: 'comando no soportado' }, cmd._t);
        return;
    }
    const args = argv.concat(cmd.args || []);
    log('ejecutando comando #' + cmd.id + ': ' + cmd.name + ' ' + (cmd.args || []).join(' '));
    const r = await runCli(args, { timeout: 30000 });
    await api('command_done', {
        id: cmd.id,
        ok: r.ok,
        text: r.text || '',
        error: r.ok ? '' : ('exit ' + r.code),
    }, cmd._t);
    log('comando #' + cmd.id + ' finalizado (ok=' + r.ok + ', ' + (r.text || '').length + ' car.)');
}

// ---------------------------------------------------------------------------
// Bucle principal
// ---------------------------------------------------------------------------
// Devuelve 'libre' si no había trabajo o 'trabajo' si procesó algo (para que
// el planificador ajuste el próximo poll). Los comandos que llegan mientras
// corre un mensaje los atiende el poll liviano en paralelo (ver tick abajo).
async function tick(opts) {
    checkModeChange();
    const wait = !(opts && opts.noWait);
    // Poll a cada destino en paralelo con espera larga del lado del hosting
    // (long-poll): si no hay nada, el hosting retiene la respuesta hasta 20 s.
    // En cuanto un destino trae trabajo cortamos las esperas restantes; como
    // el hosting solo reclama mensajes cuando va a responder, abortar esas
    // conexiones no deja nada colgado.
    const ac = new AbortController();
    const guard = setTimeout(() => ac.abort(), 35000); // si el hosting se cuelga
    const msgs = [], folders = [], cmds = [];
    let resetFlag = false;
    let cut = false;
    let resolveWork;
    const workPromise = new Promise((res) => { resolveWork = res; });
    const collect = (t, data) => {
        if (cut) return;
        if (Array.isArray(data.known_oc)) lastKnownOc[t] = data.known_oc;
        if (data.reset) resetFlag = true;
        for (const m of (data.messages || [])) { m._t = t; msgs.push(m); }
        for (const f of (data.folders || [])) { f._t = t; folders.push(f); }
        for (const c of (data.commands || [])) { c._t = t; cmds.push(c); }
        if (msgs.length || folders.length || cmds.length || resetFlag) resolveWork();
    };
    const ps = activeTargets().map((t) =>
        // waitMax 5: el hosting retiene la respuesta hasta 5 s cuando no hay
        // nada (antes 20 s). Los mensajes siguen avisando al instente (el peek
        // revisa cada 500 ms); lo que gana es la cola: un comando recién
        // encolado no queda preso hasta 20 s detrás de un ciclo largo.
        api('poll', wait ? { wait: 1, waitMax: 5 } : {}, t, { signal: ac.signal })
            .then((data) => collect(t, data))
            .catch((e) => { if (!cut && shouldLogDown(t)) log('no se pudo consultar ' + t + ': ' + e.message); })
    );
    await Promise.race([Promise.all(ps), workPromise]);
    let work = msgs.length > 0 || folders.length > 0 || cmds.length > 0 || resetFlag;
    if (work) {
        cut = true;
        ac.abort(); // el resto eran esperas largas sin nada que reclamar
    } else {
        await Promise.all(ps);
    }
    clearTimeout(guard);
    if (!work) return 'libre';

    busy = true;
    const involvedTargets = new Set();
    // Declarados fuera del try: el finally los necesita para cortar el
    // intervalo del poll liviano. Si quedaran dentro, un ReferenceError en el
    // finally salteaba el `busy = false` y el barrido de sesiones se apagaba.
    let liteRunning = false;
    let liteTimer = null;
    try {
        // Mientras corre un mensaje, atender SOLO comandos (fs/procesos/
        // túneles) en paralelo: `tick()` está esperando a runMessage y no
        // volverá a correr hasta terminar, así que sin esto la web remota se
        // queda ciega durante ejecuciones largas (archivos, procs, túneles).
        const litePoll = async () => {
            if (liteRunning) return;
            liteRunning = true;
            try {
                for (const t of activeTargets()) {
                    if (liteUnsupported.has(t)) continue;
                    try {
                        const data = await api('poll', { lite: 1 }, t);
                        if ((data.messages || []).length) {
                            // api.php sin soporte lite: reclamó mensajes. No
                            // volver a pedirle lite en esta sesión del puente.
                            liteUnsupported.add(t);
                            log('aviso: ' + t + ' no soporta poll liviano (api.php viejo); los comandos esperan al mensaje en curso');
                            continue;
                        }
                        for (const c of (data.commands || [])) {
                            c._t = t;
                            await handleCommand(c);
                        }
                    } catch (e) {
                        if (shouldLogDown(t)) {
                            log('aviso: poll liviano: ' + t + ' no responde (' + e.message + ') · reintentando en silencio hasta 60 s');
                        }
                    }
                }
            } finally {
                liteRunning = false;
            }
        };
        liteTimer = setInterval(litePoll, config.pollIntervalMs || 3000);
        litePoll();
        for (const m of msgs) {
            activeRunFolder = (m.session && m.session.folder) || activeRunFolder;
            if (m._t) involvedTargets.add(m._t);
            // Avisa al hosting cuál sesión está corriendo (para el indicador
            // "trabajando" en listas). Se notifica al cambiar de sesión.
            if (activeMsgSession !== m.session_id || activeMsgTarget !== m._t) {
                activeMsgSession = m.session_id;
                activeMsgTarget = m._t;
                notifyBusy(m._t, m.session_id);
            }
            log('mensaje nuevo #' + m.id + ' (' + (m._t || '?') + ', sesión ' + m.session_id + ', ' + m.text.length + ' car.)');
            const r = await runMessage(m);
            if (r.done) continue;
            const payload = {
                session_id: m.session_id,
                user_id: m.id,
                text: r.text,
                reasoning: r.reasoning || '',
                parts: r.parts || [],
                opencode_session: r.opencodeSession || '',
                oc_msg: r.assistantMsgID || '',
                canceled: !!r.canceled,
            };
            try {
                await api('respond', payload, m._t);
                log('respuesta #' + m.id + ' publicada en ' + (m._t || '?') + ' (' + r.text.length + ' car.)');
            } catch (e) {
                log('error al publicar la respuesta #' + m.id + ': ' + e.message);
            }
            // Refresca tokens/costo enseguida: el barrido solo corre cada 15 min.
            if (r.opencodeSession && m._t) {
                try {
                    await refreshTokens(path.resolve(m.session.folder || ''), { id: r.opencodeSession }, m._t);
                } catch (e) {
                    log('aviso: no pude refrescar tokens de ' + r.opencodeSession + ': ' + e.message);
                }
            }
        }
        for (const f of folders) {
            await handleFolderRequest(f);
        }
        for (const c of cmds) {
            await handleCommand(c);
        }
        if (folders.length) {
            await syncCatalog({ silent: true });
        }
        // El hub pidio un reset (clean/wipe-data): desconecta los proyectos.
        if (resetFlag) {
            await handleBridgeReset();
        }
    } finally {
        // El cleanup no debe depender de nada que pueda fallar: primero se
        // libera el estado, despues el intervalo.
        activeRunFolder = null;
        activeMsgSession = null;
        activeMsgTarget = null;
        busy = false;
        for (const t of involvedTargets) notifyBusy(t, null);
        try { if (liteTimer) clearInterval(liteTimer); } catch (e) { /* nada */ }
        liteTimer = null;
        // El watcher pudo pedir un barrido mientras opencode estaba ocupado:
        // se corre ahora que terminó (en vez de perderse).
        if (sweepPending) { sweepPending = false; scheduleSweep('pendiente'); }
    }
    return 'trabajo';
}

// Bucle de poll auto-agendado: tras cada respuesta volvemos a pollear enseguida
// (el hosting retiene la respuesta cuando no hay nada, así que el ritmo de
// requests queda bajo). Si el poll falla, volvemos al intervalo clásico.
function scheduleTick(delayMs) {
    setTimeout(async () => {
        let next = POLL_QUICK_MS;
        try {
            await tick();
        } catch (e) {
            handleError(e);
            next = config.pollIntervalMs;
        }
        scheduleTick(next);
    }, delayMs);
}

function handleError(err) {
    log('error inesperado: ' + ((err && err.stack) || err));
}

process.on('unhandledRejection', handleError);
process.on('uncaughtException', handleError);
process.on('SIGINT', () => {
    log('puente deteniendose (Ctrl+C)');
    process.exit(0);
});

(async function main() {
    checkModeChange();
    log('puente iniciado (' + BRIDGE_ID + (BRIDGE_NAME && BRIDGE_NAME !== BRIDGE_ID ? ' / ' + BRIDGE_NAME : '') + '). Hosting: ' + config.apiUrl + (config.apiUrlLocal ? ' · Local: ' + config.apiUrlLocal : '') + ' (modo ' + (activeMode || '?') + ')');
    log('verificando conexion...');
    for (const t of activeTargets()) {
        try {
            const pong = await api('ping', undefined, t);
            log('conexion ok (' + t + '): ' + pong.now);
        } catch (e) {
            log('ATENCION: no se pudo contactar ' + t + ': ' + e.message);
        }
    }
    await syncCatalog();
    // Heartbeat: le dice a cada hosting que el puente está vivo aunque esté
    // ocupado procesando un mensaje (y cuál sesión está corriendo).
    const heartbeat = () => {
        for (const t of activeTargets()) {
            // La sesión en ejecución solo se reporta al hosting donde vive
            // (en DUAL el otro lado no debe marcarla como "working").
            const mine = activeMsgTarget === t;
            const payload = { busy: mine && activeMsgSession != null, busy_session: mine ? activeMsgSession : null };
            api('heartbeat', payload, t).catch(() => {});
        }
    };
    heartbeat();
    setInterval(heartbeat, 15000);
    // Primer poll sin espera larga: carga known_oc y deja arrancar el barrido.
    await tick({ noWait: true });
    // Historial único: primer poll hecho (lastKnownOc cargado), importamos
    // en segundo plano y repetimos cada 15 minutos.
    syncSessions().catch(handleError);
    // Watcher de la base de opencode: sincroniza en segundos, no cada 15 min.
    startSyncWatcher();
    scheduleTick(POLL_QUICK_MS);
})();