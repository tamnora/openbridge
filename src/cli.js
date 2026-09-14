'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const paths = require('./paths');
const config = require('./config');
const store = require('./store');
const auth = require('./auth');
const push = require('./push');
const qr = require('./qr');
const web = require('./web/server');
const tunnel = require('./tunnel');
const log = require('./log');

const VERSION = require('../package.json').version;

// ---------------------------------------------------------------------------
// Utilidades CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
    const out = { _: [], flags: {} };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next !== undefined && !next.startsWith('-')) { out.flags[key] = next; i++; }
            else out.flags[key] = true;
        } else if (a.startsWith('-') && a.length === 2) {
            const next = argv[i + 1];
            if (next !== undefined && !next.startsWith('-')) { out.flags[a.slice(1)] = next; i++; }
            else out.flags[a.slice(1)] = true;
        } else {
            out._.push(a);
        }
    }
    return out;
}

// Una sola interfaz de consola para todas las preguntas (crear/cerrar una por
// pregunta puede perder entrada en Windows y guardar una contrasena equivocada).
function createPrompter() {
    const rl = require('node:readline/promises').createInterface({ input: process.stdin, output: process.stdout });
    return {
        async ask(question, def) {
            const answer = (await rl.question(question + (def ? ' [' + def + ']' : '') + ': ')).trim();
            return answer === '' ? (def || '') : answer;
        },
        close() { try { rl.close(); } catch (e) { /* nada */ } },
    };
}

// Pregunta ocultando lo que se escribe (contrasenas). Lee en modo raw y no
// deja eco; funciona en Windows y POSIX.
function askHidden(question) {
    return new Promise((resolve) => {
        const stdin = process.stdin;
        const stdout = process.stdout;
        stdout.write(question);
        let buf = '';
        const wasRaw = stdin.isRaw;
        if (stdin.isTTY) stdin.setRawMode(true);
        stdin.resume();
        const cleanup = () => {
            stdin.removeListener('data', onData);
            if (stdin.isTTY) stdin.setRawMode(wasRaw || false);
            stdin.pause();
        };
        const onData = (chunk) => {
            for (const ch of chunk.toString('utf8')) {
                if (ch === '\r' || ch === '\n') { cleanup(); stdout.write('\n'); resolve(buf); return; }
                if (ch === '\u0003') { cleanup(); stdout.write('\n'); process.exit(130); }
                if (ch === '\u007f' || ch === '\b') { if (buf.length) buf = buf.slice(0, -1); continue; }
                buf += ch;
            }
        };
        stdin.on('data', onData);
    });
}

function sanitizeId(s) {
    let id = String(s || '').replace(/[^A-Za-z0-9._-]/g, '').replace(/^[^A-Za-z0-9]+/, '').slice(0, 40);
    return /^[A-Za-z0-9]/.test(id) ? id : 'pc';
}

function killPid(pid) {
    if (!pid) return;
    try {
        if (process.platform === 'win32') {
            spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
        } else {
            // Los hijos se lanzan detached (grupo propio): matamos el grupo y,
            // por si no lo es, tambien el pid suelto.
            try { process.kill(-pid, 'SIGTERM'); } catch (e) { /* sin grupo */ }
            try { process.kill(pid, 'SIGTERM'); } catch (e) { /* ya no esta */ }
        }
    } catch (e) { /* ya no esta */ }
}

function pidAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

function runtimePath() { return paths.p('runtime.json'); }
function readRuntime() {
    try { return JSON.parse(fs.readFileSync(runtimePath(), 'utf8')); } catch (e) { return null; }
}
function writeRuntime(data) {
    try { fs.writeFileSync(runtimePath(), JSON.stringify(data, null, 2)); } catch (e) { /* nada */ }
}
function clearRuntime() {
    for (const f of [runtimePath(), paths.pidPath(), paths.bridgeLockPath()]) {
        try { fs.unlinkSync(f); } catch (e) { /* nada */ }
    }
}

// Muestra la URL como QR en la consola (para abrirla en el celular).
// Devuelve false si la URL es demasiado larga para el QR.
function printQr(url) {
    const art = qr.qrTerminal(url, 2);
    if (!art) return false;
    console.log(art);
    return true;
}

// Detiene el server en ejecucion (si lo hay) matando server + hijos. Devuelve
// true si habia uno. Se usa antes de reconfigurar para no dejar un proceso con
// la config vieja en memoria (p.ej. la contrasena).
function stopRunningServer() {
    const rt = readRuntime();
    if (!rt || !pidAlive(rt.pid)) { clearRuntime(); return false; }
    killPid(rt.pid);
    if (Array.isArray(rt.children)) {
        for (const c of rt.children) killPid(c);
    }
    clearRuntime();
    return true;
}

// Espera a que el hijo detached escriba runtime.json (con todo levantado:
// server + tunel + puente). Devuelve el runtime o null si el hijo murio/timeout.
function waitForRuntime(childPid, isDead, timeoutMs) {
    return new Promise((resolve) => {
        const start = Date.now();
        const tick = () => {
            if (isDead()) return resolve(null);
            const rt = readRuntime();
            if (rt && rt.pid && pidAlive(rt.pid) && (!childPid || rt.pid === childPid)) return resolve(rt);
            if (Date.now() - start > timeoutMs) return resolve(null);
            setTimeout(tick, 400);
        };
        tick();
    });
}

async function scanFolders(workspace) {
    const out = [];
    try {
        const items = await fsp.readdir(workspace, { withFileTypes: true });
        for (const it of items) {
            if (it.name.startsWith('.')) continue;
            if (!it.isDirectory()) continue;
            out.push({ name: it.name, path: path.join(workspace, it.name) });
        }
    } catch (e) { /* workspace inexistente */ }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------
async function cmdInit(argv) {
    const { flags } = parseArgs(argv);
    const home = paths.home();
    paths.ensureDirs();

    if (paths.exists() && !flags.force) {
        console.log('Ya existe una configuracion en ' + home);
        console.log('Usa --force para reconfigurar (se pisan config.json/app.json).');
        return 0;
    }
    if (paths.exists() && flags.force) {
        const prev = config.readApp();
        if ((prev.users || []).length > 1) {
            console.log('aviso: --force deja un unico usuario admin; se pierden los demas usuarios.');
        }
    }

    if (stopRunningServer()) {
        console.log('Habia un server corriendo; lo detuve para reconfigurar (reinicialo con `openbridge server`).');
    }

    const cwd = process.cwd();
    const interactive = !flags.yes && process.stdin.isTTY;
    const prompt = interactive ? createPrompter() : null;

    let workspace, name, port, provider, password;
    try {
        workspace = flags.workspace || (interactive ? await prompt.ask('Carpeta de trabajo (workspace)', cwd) : cwd);
        workspace = path.resolve(workspace);
        name = flags.name || (interactive ? await prompt.ask('Nombre de esta computadora', os.hostname()) : os.hostname());
        port = parseInt(flags.port || (interactive ? await prompt.ask('Puerto local', '8799') : '8799'), 10) || 8799;
        provider = flags.tunnel || (interactive ? await prompt.ask('Tunel (tunnelmole/ngrok/cloudflare/none)', 'tunnelmole') : 'tunnelmole');
        password = flags.password || '';
    } finally {
        if (prompt) prompt.close();
    }
    let generated = false;
    if (!password && interactive) password = await askHidden('Contrasena de acceso (enter = generar): ');
    if (!password) {
        password = config.randomToken(12);
        generated = true;
    }
    provider = String(provider || 'tunnelmole').toLowerCase();
    if (provider === 'cloudflared') provider = 'cloudflare';
    if (!['tunnelmole', 'ngrok', 'cloudflare', 'none'].includes(provider)) {
        console.log('aviso: proveedor de tunel desconocido "' + provider + '"; uso tunnelmole.');
        provider = 'tunnelmole';
    }
    const id = flags.id || sanitizeId(name);

    const bridgeToken = config.randomToken(32);
    const csrfSecret = config.randomToken(32);
    let vapid = { publicKey: '', privateKey: '' };
    try { vapid = config.genVapid(); } catch (e) { console.log('aviso: no se pudieron generar claves VAPID (avisos push desactivados)'); }

    const bridgeCfg = {
        ...config.DEFAULT_BRIDGE,
        apiUrl: 'http://127.0.0.1:' + port + '/api.php',
        apiUrlLocal: '',
        mode: 'remoto',
        apiToken: bridgeToken,
        logFile: 'logs/bridge.log',
        foldersFile: 'folders.json',
        workspace,
        allowCreateFolders: true,
        bridgeId: id,
        bridgeName: name,
    };
    const adminName = flags.user || 'admin';
    const appCfg = {
        ...config.DEFAULT_APP,
        port,
        host: '127.0.0.1',
        users: [config.makeUser(adminName, password, 'admin')],
        csrfSecret,
        bridgeToken,
        vapid,
        tunnel: { provider, domain: flags.domain ? String(flags.domain) : '' },
    };
    config.writeBridge(bridgeCfg);
    config.writeApp(appCfg);

    const folders = await scanFolders(workspace);
    config.writeJsonFile(paths.foldersPath(), { folders });

    console.log('');
    console.log('OpenBridge configurado.');
    console.log('  carpeta   : ' + paths.baseDir());
    console.log('  datos     : ' + home + '  (config, data, logs)');
    console.log('  workspace : ' + workspace);
    console.log('  puente    : ' + id + ' (' + name + ')');
    console.log('  URL local : http://127.0.0.1:' + port + '/chat.php');
    console.log('  usuario   : ' + adminName);
    console.log('  contrasena: ' + password + (generated ? '  (generada)' : ''));
    console.log('  tunel     : ' + provider);
    console.log('  carpetas  : ' + folders.length + ' en folders.json');
    if (generated) console.log('  -> guarda esta contrasena: no se vuelve a mostrar.');
    console.log('');
    console.log('  QR local (misma PC):');
    printQr('http://127.0.0.1:' + port + '/chat.php');
    console.log('');
    console.log('Siguiente paso:  openbridge server');
    return 0;
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------
async function cmdServer(argv) {
    const { flags } = parseArgs(argv);
    if (!paths.exists()) {
        console.error('No hay configuracion en ' + paths.home() + '. Corre primero: openbridge init');
        return 1;
    }
    paths.ensureDirs();

    const app = config.readApp();
    const bridgeCfg = config.readBridge();
    const port = parseInt(flags.port || app.port, 10) || 8799;
    const host = app.host || '127.0.0.1';

    const isChild = !!process.env.OPENBRIDGE_DETACHED;
    const foreground = !!flags.stream || isChild;

    // Ya hay un server corriendo: no arrancamos otro.
    if (!isChild) {
        const cur = readRuntime();
        if (cur && pidAlive(cur.pid)) {
            console.log('OpenBridge ya esta corriendo (pid ' + cur.pid + ').');
            await printStatus();
            return 0;
        }
    }

    // Por defecto en segundo plano: relanzamos este comando detached (con
    // --stream para que el hijo corra en primer plano) y esperamos a que
    // levante todo para mostrar el status.
    if (!foreground) {
        const bin = process.argv[1];
        const passthrough = argv.filter((a) => a !== '--detach' && a !== '--stream');
        const child = spawn(process.execPath, [bin, 'server', '--stream', ...passthrough], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
            env: { ...process.env, OPENBRIDGE_HOME: paths.baseDir(), OPENBRIDGE_DETACHED: '1' },
        });
        child.unref();
        let dead = false;
        child.on('exit', () => { dead = true; });
        console.log('OpenBridge arrancando en segundo plano (pid ' + child.pid + ')...');
        const rt = await waitForRuntime(child.pid, () => dead, 120000);
        console.log('');
        await printStatus();
        if (!rt) {
            console.log('');
            console.log('No pude confirmar el arranque. Revisa: openbridge logs');
        }
        return 0;
    }

    // El puente de este server siempre apunta al server local.
    const localApi = 'http://127.0.0.1:' + port + '/api.php';
    let cfgChanged = false;
    if (bridgeCfg.apiUrl !== localApi) { bridgeCfg.apiUrl = localApi; cfgChanged = true; }
    if (bridgeCfg.apiToken !== app.bridgeToken) { bridgeCfg.apiToken = app.bridgeToken; cfgChanged = true; }
    if (cfgChanged) config.writeBridge(bridgeCfg);

    const server = web.createServer(app);
    try {
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, host, resolve);
        });
    } catch (e) {
        if (e && e.code === 'EADDRINUSE') {
            log.error('puerto ' + port + ' ocupado (¿ya corre OpenBridge?). Usa --port <otro> o `openbridge stop`.');
            return 1;
        }
        throw e;
    }
    log.log('OpenBridge ' + VERSION + ' escuchando en http://' + host + ':' + port + '/chat.php');

    // Tunel
    let tun = { url: '', provider: 'none', stop: () => {}, pid: 0 };
    if (!flags['no-tunnel'] && (app.tunnel.provider || 'tunnelmole') !== 'none') {
        try {
            log.log('Abriendo tunel (' + app.tunnel.provider + ')...');
            tun = await tunnel.startTunnel(port, app.tunnel.provider, {
                domain: app.tunnel.domain || '',
                log: (m) => log.log(m),
            });
            if (tun.url) {
                log.log('URL publica: ' + tun.url + '/chat.php');
                log.warn('el tunel es publico mientras corre; cerralo con Ctrl+C cuando no lo uses.');
            }
        } catch (e) {
            log.warn('no se pudo abrir el tunel: ' + e.message);
        }
    }
    app.baseUrl = tun.url || ('http://' + host + ':' + port);

    // Puente (proceso hijo). En POSIX detached crea su propio grupo para poder
    // matar tambien a los opencode que lance.
    const bridgePath = path.join(__dirname, 'bridge', 'bridge.js');
    const bridge = spawn(process.execPath, [bridgePath], {
        cwd: paths.home(),
        env: { ...process.env, OPENBRIDGE_HOME: paths.baseDir() },
        stdio: 'inherit',
        windowsHide: true,
        detached: process.platform !== 'win32',
    });
    bridge.on('exit', (code) => log.log('puente termino (codigo ' + code + ')'));

    const runtime = {
        pid: process.pid,
        port,
        host,
        bridge: bridgeCfg.bridgeId || '',
        localUrl: 'http://' + host + ':' + port + '/chat.php',
        publicUrl: tun.url ? tun.url + '/chat.php' : '',
        tunnel: tun.provider,
        startedAt: new Date().toISOString(),
        children: [bridge.pid, tun.pid].filter((n) => typeof n === 'number' && n > 0),
    };
    writeRuntime(runtime);
    try { fs.writeFileSync(paths.pidPath(), String(process.pid)); } catch (e) { /* nada */ }

    let closing = false;
    const shutdown = () => {
        if (closing) return;
        closing = true;
        log.log('Cerrando OpenBridge...');
        try { killPid(bridge.pid); } catch (e) { /* nada */ }
        try { tun.stop(); } catch (e) { /* nada */ }
        try { server.close(); } catch (e) { /* nada */ }
        clearRuntime();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return new Promise(() => { /* corre hasta Ctrl+C */ });
}

// ---------------------------------------------------------------------------
// stop / status / logs
// ---------------------------------------------------------------------------
async function cmdStop() {
    const rt = readRuntime();
    const pid = rt && rt.pid ? rt.pid : parseInt((() => { try { return fs.readFileSync(paths.pidPath(), 'utf8'); } catch (e) { return ''; } })(), 10);
    if (!pid || !pidAlive(pid)) {
        clearRuntime();
        console.log('OpenBridge no esta corriendo.');
        return 0;
    }
    killPid(pid);
    if (rt && Array.isArray(rt.children)) {
        for (const c of rt.children) killPid(c);
    }
    clearRuntime();
    console.log('OpenBridge detenido (pid ' + pid + ').');
    return 0;
}

async function printStatus() {
    const rt = readRuntime();
    if (!rt || !pidAlive(rt.pid)) {
        console.log('OpenBridge: detenido');
        if (paths.exists()) {
            console.log('  carpeta: ' + paths.baseDir());
            console.log('  datos  : ' + paths.home());
        }
        return false;
    }
    console.log('OpenBridge: corriendo (pid ' + rt.pid + ')');
    console.log('  local  : ' + rt.localUrl);
    if (rt.publicUrl) console.log('  publico: ' + rt.publicUrl);
    console.log('  tunel  : ' + rt.tunnel);
    console.log('  inicio : ' + rt.startedAt);
    try {
        const bridgeId = rt.bridge || await store.soleBridgeId();
        const online = bridgeId ? await store.bridgeOnlineLive(bridgeId) : false;
        console.log('  puente : ' + (bridgeId || '(sin id)') + (online ? ' en linea' : ' sin senal'));
        const sessions = await store.sessionsListFull();
        console.log('  chats  : ' + sessions.length);
    } catch (e) { /* sin datos todavia */ }
    const target = rt.publicUrl || rt.localUrl;
    if (target) {
        console.log('');
        console.log(rt.publicUrl ? '  escanea para abrir en el celular:' : '  QR local (misma PC):');
        if (!printQr(target)) console.log('  (URL demasiado larga para el QR; usa el link de arriba)');
    }
    return true;
}

async function cmdStatus() {
    await printStatus();
    return 0;
}

// Muestra la URL como QR para escanear desde el celular.
async function cmdQr() {
    const rt = readRuntime();
    if (rt && pidAlive(rt.pid) && (rt.publicUrl || rt.localUrl)) {
        const target = rt.publicUrl || rt.localUrl;
        console.log((rt.publicUrl ? 'URL publica' : 'URL local') + ': ' + target);
        console.log('');
        if (!printQr(target)) { console.log('URL demasiado larga para el QR.'); return 1; }
        return 0;
    }
    if (!paths.exists()) {
        console.error('No hay configuracion. Corre primero: openbridge init');
        return 1;
    }
    const app = config.readApp();
    const url = 'http://' + (app.host || '127.0.0.1') + ':' + (app.port || 8799) + '/chat.php';
    console.log('URL local (el server no esta corriendo): ' + url);
    console.log('');
    if (!printQr(url)) { console.log('URL demasiado larga para el QR.'); return 1; }
    return 0;
}

// Muestra o cambia el proveedor de tunel (y su dominio fijo) sin reconfigurar
// todo. Cambiar el proveedor requiere reiniciar el server.
async function cmdTunnel(argv) {
    const { flags, _ } = parseArgs(argv);
    if (!paths.exists()) {
        console.error('No hay configuracion. Corre primero: openbridge init');
        return 1;
    }
    const app = config.readApp();
    const cur = app.tunnel || { provider: 'tunnelmole', domain: '' };
    const arg = String(_[0] || '').toLowerCase();

    if (arg === '' || arg === 'status' || arg === 'show') {
        const rt = readRuntime();
        const running = rt && pidAlive(rt.pid);
        console.log('proveedor : ' + (cur.provider || 'tunnelmole'));
        console.log('dominio   : ' + (cur.domain || '(aleatorio)'));
        console.log('estado    : ' + (running ? 'corriendo' : 'detenido'));
        if (running && rt.publicUrl) console.log('publico   : ' + rt.publicUrl);
        return 0;
    }

    let provider = arg;
    if (provider === 'cloudflared') provider = 'cloudflare';
    if (!['tunnelmole', 'ngrok', 'cloudflare', 'none'].includes(provider)) {
        console.error('Proveedor desconocido: ' + arg + ' (usar tunnelmole|ngrok|cloudflare|none)');
        return 1;
    }
    const domain = flags.domain !== undefined ? String(flags.domain).trim() : String(cur.domain || '');
    app.tunnel = { provider, domain };
    config.writeApp(app);
    console.log('Tunel configurado: ' + provider + (domain ? '  (dominio ' + domain + ')' : ''));
    if (provider === 'ngrok' && !domain) {
        console.log('aviso: ngrok sin dominio fijo da URL aleatoria; pasá --domain <sub.ngrok.app> para una estable.');
    }
    if (provider === 'cloudflare' && domain) {
        console.log('aviso: el quick tunnel de cloudflared ignora el dominio (URL aleatoria).');
    }
    const rt = readRuntime();
    if (rt && pidAlive(rt.pid)) {
        console.log('Hay un server corriendo: reinicialo para aplicar (openbridge stop && openbridge server).');
    }
    return 0;
}

async function cmdLogs(argv) {
    const { flags } = parseArgs(argv);
    const n = parseInt(flags.n || '40', 10) || 40;
    const files = [];
    if (flags.server) files.push(paths.serverLogPath());
    if (flags.bridge) files.push(paths.bridgeLogPath());
    if (!files.length) files.push(paths.serverLogPath(), paths.bridgeLogPath());
    if (flags.follow) {
        let stopped = false;
        const tails = [];
        for (const file of files) {
            console.log('=== siguiendo ' + file + ' (Ctrl+C para salir) ===');
            let pos = 0;
            try { pos = fs.statSync(file).size; } catch (e) { pos = 0; }
            const t = setInterval(() => {
                try {
                    const st = fs.statSync(file);
                    if (st.size < pos) pos = 0;
                    if (st.size > pos) {
                        const fd = fs.openSync(file, 'r');
                        const len = st.size - pos;
                        const buf = Buffer.alloc(len);
                        fs.readSync(fd, buf, 0, len, pos);
                        fs.closeSync(fd);
                        process.stdout.write(buf.toString('utf8'));
                        pos = st.size;
                    }
                } catch (e) { /* sin log todavia */ }
            }, 700);
            tails.push(t);
        }
        await new Promise((resolve) => {
            const stop = () => {
                if (stopped) return;
                stopped = true;
                for (const t of tails) clearInterval(t);
                resolve();
            };
            process.on('SIGINT', stop);
            process.on('SIGTERM', stop);
        });
        return 0;
    }
    for (const file of files) {
        console.log('=== ' + file + ' ===');
        try {
            const lines = (await fsp.readFile(file, 'utf8')).split(/\r?\n/);
            console.log(lines.slice(-n).join('\n'));
        } catch (e) {
            console.log('(sin log)');
        }
        console.log('');
    }
    return 0;
}

// ---------------------------------------------------------------------------
// bridge (solo el puente, para modo hub remoto)
// ---------------------------------------------------------------------------
async function cmdBridge(argv) {
    const { flags } = parseArgs(argv);
    if (!fs.existsSync(paths.configPath())) {
        console.error('No hay configuracion de puente en ' + paths.home() + '. Corre primero: openbridge join <url> o openbridge init');
        return 1;
    }
    // Permite apuntar a otro hub sin editar config.json a mano.
    const env = { ...process.env, OPENBRIDGE_HOME: paths.baseDir() };
    if (flags.api) env.OPENBRIDGE_API_URL = String(flags.api);
    if (flags.token) env.OPENBRIDGE_API_TOKEN = String(flags.token);
    if (flags.id) env.OPENBRIDGE_BRIDGE_ID = String(flags.id);
    if (flags.name) env.OPENBRIDGE_BRIDGE_NAME = String(flags.name);
    const bridgePath = path.join(__dirname, 'bridge', 'bridge.js');
    const child = spawn(process.execPath, [bridgePath], {
        cwd: paths.home(),
        env,
        stdio: 'inherit',
        windowsHide: true,
    });
    return new Promise((resolve) => child.on('exit', (code) => resolve(code || 0)));
}

// ---------------------------------------------------------------------------
// join: esta PC se suma como puente de un hub (otra PC con `openbridge server`).
// Guarda la URL/token/identidad en config.json y arranca el puente.
// ---------------------------------------------------------------------------
async function cmdJoin(argv) {
    const { flags, _ } = parseArgs(argv);
    const url = String(_[0] || flags.api || '').trim();
    if (!url || !/^https?:\/\//i.test(url)) {
        console.error('Uso: openbridge join <url-del-hub> [--token <t>] [--id <pc>] [--name "<nombre>"] [--no-start]');
        console.error('Ej.:  openbridge join https://mi-pc.trycloudflare.com --token <t> --id pc2 --name "PC oficina"');
        return 1;
    }
    paths.ensureDirs();
    const cfg = config.readBridge();
    cfg.apiUrl = url.replace(/\/+$/, '');
    if (typeof flags.token === 'string') cfg.apiToken = flags.token;
    if (typeof flags.id === 'string') cfg.bridgeId = sanitizeId(flags.id);
    else if (!cfg.bridgeId) cfg.bridgeId = sanitizeId(os.hostname());
    if (typeof flags.name === 'string' && flags.name.trim()) cfg.bridgeName = flags.name.trim().slice(0, 40);
    else if (!cfg.bridgeName) cfg.bridgeName = cfg.bridgeId;
    config.writeBridge(cfg);

    console.log('Puente vinculado al hub: ' + cfg.apiUrl);
    console.log('  id     : ' + cfg.bridgeId);
    console.log('  nombre : ' + cfg.bridgeName);
    if (!cfg.apiToken) console.log('aviso: sin token (--token). Solo sirve si el hub no exige token del puente.');
    if (flags['no-start']) {
        console.log('Arrancalo cuando quieras con: openbridge bridge');
        return 0;
    }
    console.log('');
    console.log('Arrancando el puente (Ctrl+C para salir)...');
    return cmdBridge([]);
}

// ---------------------------------------------------------------------------
// import / reset (datos)
// ---------------------------------------------------------------------------
async function cmdImport(argv) {
    const { flags } = parseArgs(argv);
    const src = argv[0] || flags.dir;
    if (!src) {
        console.error('Uso: openbridge import <data-dir> [--force]');
        return 1;
    }
    const srcDir = path.resolve(src);
    let files;
    try {
        files = (await fsp.readdir(srcDir)).filter((f) => f.toLowerCase().endsWith('.json'));
    } catch (e) {
        console.error('No se pudo leer ' + srcDir + ': ' + e.message);
        return 1;
    }
    if (!files.length) {
        console.error('No hay archivos .json en ' + srcDir);
        return 1;
    }
    paths.ensureDirs();
    const destDir = paths.dataDir();
    let copied = 0, skipped = 0;
    for (const f of files) {
        const dest = path.join(destDir, f);
        if (fs.existsSync(dest) && !flags.force) { skipped++; continue; }
        await fsp.copyFile(path.join(srcDir, f), dest);
        copied++;
    }
    console.log('Importados ' + copied + ' archivo(s) a ' + destDir + (skipped ? ' (' + skipped + ' existentes, usa --force)' : ''));
    return 0;
}

async function cmdReset(argv) {
    const { flags } = parseArgs(argv);
    if (!paths.exists()) {
        console.error('No hay configuracion en ' + paths.home() + '. Corre primero: openbridge init');
        return 1;
    }
    if (flags.session) {
        const id = parseInt(flags.session, 10) || 0;
        if (id <= 0) { console.error('Sesion invalida.'); return 1; }
        await store.deleteSession(id);
        try { fs.unlinkSync(paths.messagesFile(id)); } catch (e) { /* nada */ }
        console.log('Sesion ' + id + ' borrada.');
        return 0;
    }
    if (!flags.yes && process.stdin.isTTY) {
        const prompt = createPrompter();
        const answer = await prompt.ask('Esto borra TODOS los chats y datos. Escribi "si" para confirmar', '');
        prompt.close();
        if (answer.toLowerCase() !== 'si' && answer.toLowerCase() !== 'sí') {
            console.log('Cancelado.');
            return 0;
        }
    }
    let removed = 0;
    try {
        for (const f of await fsp.readdir(paths.dataDir())) {
            if (!f.toLowerCase().endsWith('.json')) continue;
            try { await fsp.unlink(path.join(paths.dataDir(), f)); removed++; } catch (e) { /* nada */ }
        }
    } catch (e) { /* sin data */ }
    console.log('Datos reseteados (' + removed + ' archivo(s)).');
    return 0;
}

// ---------------------------------------------------------------------------
// passwd: cambia la contrasena sin reconfigurar todo
// ---------------------------------------------------------------------------
async function cmdPasswd(argv) {
    const { flags } = parseArgs(argv);
    if (!paths.exists()) {
        console.error('No hay configuracion en ' + paths.home() + '. Corre primero: openbridge init');
        return 1;
    }
    const app = config.readApp();
    const name = String(flags.user || (app.users[0] && app.users[0].name) || 'admin');
    const user = config.findUser(app, name);
    if (!user) {
        console.error('Usuario no encontrado: ' + name);
        return 1;
    }
    const interactive = !flags.yes && process.stdin.isTTY;
    let password = flags.password || '';
    if (!password && interactive) password = await askHidden('Nueva contrasena para "' + name + '" (enter = generar): ');
    let generated = false;
    if (!password) {
        password = config.randomToken(12);
        generated = true;
    }
    if (stopRunningServer()) console.log('Habia un server corriendo; lo detuve para aplicar el cambio.');
    user.password = config.hashPassword(password);
    user.pv = (parseInt(user.pv, 10) || 1) + 1; // invalida las sesiones abiertas
    config.writeApp(app);
    console.log('Contrasena actualizada para "' + user.name + '".');
    console.log('  contrasena: ' + password + (generated ? '  (generada)' : ''));
    console.log('  volve a arrancar: openbridge server');
    return 0;
}

// ---------------------------------------------------------------------------
// users: administracion de usuarios y roles (solo desde la CLI local)
// ---------------------------------------------------------------------------
async function cmdUsers(argv) {
    const { flags, _ } = parseArgs(argv);
    if (!paths.exists()) {
        console.error('No hay configuracion en ' + paths.home() + '. Corre primero: openbridge init');
        return 1;
    }
    const app = config.readApp();
    const sub = String(_[0] || 'list').toLowerCase();
    const name = _[1] || flags.name;

    const persist = (msg) => {
        if (stopRunningServer()) console.log('Habia un server corriendo; lo detuve para aplicar el cambio.');
        config.writeApp(app);
        console.log(msg);
        console.log('  volve a arrancar: openbridge server');
    };

    if (sub === 'list' || sub === 'ls') {
        const users = app.users || [];
        if (!users.length) { console.log('(sin usuarios)'); return 0; }
        for (const u of users) {
            console.log((u.disabled ? 'x' : 'o') + '  ' + u.name.padEnd(16) + '[' + u.role + ']');
        }
        return 0;
    }

    if (sub === 'add') {
        if (!config.userValidName(name)) { console.error('Nombre invalido (letras, numeros, . _ -; 1-32).'); return 1; }
        if (config.findUser(app, name)) { console.error('Ya existe el usuario "' + name + '".'); return 1; }
        let password = flags.password || '';
        if (!password && process.stdin.isTTY) password = await askHidden('Contrasena para "' + name + '" (enter = generar): ');
        let generated = false;
        if (!password) { password = config.randomToken(12); generated = true; }
        const role = config.USER_ROLES.includes(flags.role) ? flags.role : 'user';
        app.users.push(config.makeUser(name, password, role));
        persist('Usuario "' + name + '" agregado [' + role + '].');
        console.log('  contrasena: ' + password + (generated ? '  (generada)' : ''));
        return 0;
    }

    if (sub === 'remove' || sub === 'del' || sub === 'rm') {
        const user = config.findUser(app, name);
        if (!user) { console.error('Usuario no encontrado: ' + name); return 1; }
        if (user.role === 'admin' && config.adminCount(app) <= 1) { console.error('No podes borrar al ultimo admin.'); return 1; }
        app.users = app.users.filter((u) => u.id !== user.id);
        persist('Usuario "' + user.name + '" borrado.');
        return 0;
    }

    if (sub === 'passwd' || sub === 'password') {
        if (!name) { console.error('Uso: openbridge users passwd <nombre> [--password <clave>]'); return 1; }
        const extra = ['--user', name];
        if (flags.password) extra.push('--password', String(flags.password));
        return cmdPasswd(extra);
    }

    if (sub === 'role') {
        const user = config.findUser(app, name);
        if (!user) { console.error('Usuario no encontrado: ' + name); return 1; }
        const role = String(_[2] || flags.role || '').toLowerCase();
        if (!config.USER_ROLES.includes(role)) { console.error('Rol invalido (admin|user).'); return 1; }
        if (user.role === 'admin' && role !== 'admin' && config.adminCount(app) <= 1) { console.error('No podes quitarle el admin al ultimo admin.'); return 1; }
        user.role = role;
        persist('Rol de "' + user.name + '" -> ' + role + '.');
        return 0;
    }

    if (sub === 'disable' || sub === 'enable') {
        const user = config.findUser(app, name);
        if (!user) { console.error('Usuario no encontrado: ' + name); return 1; }
        const disabled = sub === 'disable';
        if (disabled && user.role === 'admin' && config.adminCount(app) <= 1) { console.error('No podes deshabilitar al ultimo admin.'); return 1; }
        user.disabled = disabled;
        persist('Usuario "' + user.name + '" ' + (disabled ? 'deshabilitado' : 'habilitado') + '.');
        return 0;
    }

    console.error('Uso: openbridge users [list|add|remove|passwd|role|disable|enable] [nombre] [--role admin|user] [--password <clave>]');
    return 1;
}

// ---------------------------------------------------------------------------
// autostart
// ---------------------------------------------------------------------------
function autostartPath() {
    if (process.platform === 'win32') {
        const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'OpenBridge.lnk');
    }
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'LaunchAgents', 'net.openbridge.server.plist');
    }
    return path.join(os.homedir(), '.config', 'systemd', 'user', 'openbridge.service');
}

async function cmdAutostart(argv) {
    const action = String(argv[0] || '').toLowerCase();
    if (action !== 'install' && action !== 'remove') {
        console.error('Uso: openbridge autostart install|remove');
        return 1;
    }
    const bin = process.argv[1];
    const node = process.execPath;
    const target = autostartPath();
    if (action === 'remove') {
        try { fs.unlinkSync(target); console.log('autostart quitado: ' + target); }
        catch (e) { console.log('no habia autostart instalado.'); }
        return 0;
    }
    try { fs.mkdirSync(path.dirname(target), { recursive: true }); } catch (e) { /* nada */ }
    const home = paths.baseDir();
    if (process.platform === 'win32') {
        const ps = [
            '$ws = New-Object -ComObject WScript.Shell;',
            '$sc = $ws.CreateShortcut(' + JSON.stringify(target) + ');',
            '$sc.TargetPath = ' + JSON.stringify(node) + ';',
            '$sc.Arguments = ' + JSON.stringify('"' + bin + '" server --stream --no-tunnel') + ';',
            '$sc.WorkingDirectory = ' + JSON.stringify(home) + ';',
            '$sc.WindowStyle = 7;',
            '$sc.Save();',
        ].join(' ');
        const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true });
        if (r.status !== 0) { console.error('No se pudo crear el acceso directo: ' + (r.stderr || '').trim()); return 1; }
    } else if (process.platform === 'darwin') {
        const plist = '<?xml version="1.0" encoding="UTF-8"?>\n'
            + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
            + '<plist version="1.0"><dict>'
            + '<key>Label</key><string>net.openbridge.server</string>'
            + '<key>ProgramArguments</key><array>'
            + '<string>' + node + '</string><string>' + bin + '</string><string>server</string><string>--stream</string><string>--no-tunnel</string>'
            + '</array>'
            + '<key>WorkingDirectory</key><string>' + home + '</string>'
            + '<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>'
            + '</dict></plist>\n';
        fs.writeFileSync(target, plist);
    } else {
        const unit = '[Unit]\nDescription=OpenBridge\nAfter=network-online.target\n\n'
            + '[Service]\nType=simple\n'
            + 'ExecStart=' + node + ' ' + bin + ' server --stream --no-tunnel\n'
            + 'WorkingDirectory=' + home + '\nRestart=on-failure\n\n'
            + '[Install]\nWantedBy=default.target\n';
        fs.writeFileSync(target, unit);
        spawnSync('systemctl', ['--user', 'daemon-reload'], { windowsHide: true });
        spawnSync('systemctl', ['--user', 'enable', '--now', 'openbridge.service'], { windowsHide: true });
    }
    console.log('autostart instalado: ' + target);
    console.log('  (arranca `openbridge server --stream --no-tunnel` en ' + home + ')');
    return 0;
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------
async function cmdDoctor() {
    const checks = [];
    const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
    checks.push(['Node ' + process.versions.node, nodeMajor >= 18, nodeMajor >= 18 ? '' : 'requiere Node 18+']);

    const oc = spawnSync('opencode', ['--version'], { encoding: 'utf8', shell: true });
    const ocOk = oc.status === 0;
    checks.push(['opencode', ocOk, ocOk ? (oc.stdout || '').trim() : 'no se encontro "opencode" en el PATH (npm i -g opencode-ai)']);

    const cfgOk = paths.exists();
    checks.push(['configuracion (' + paths.home() + ')', cfgOk, cfgOk ? '' : 'corre: openbridge init']);

    let portFree = true;
    if (cfgOk) {
        const app = config.readApp();
        portFree = await new Promise((resolve) => {
            const net = require('node:net');
            const s = net.createServer();
            s.once('error', () => resolve(false));
            s.once('listening', () => s.close(() => resolve(true)));
            s.listen(app.port, app.host || '127.0.0.1');
        });
        checks.push(['puerto ' + app.port, portFree, portFree ? '' : 'ocupado (¿ya corre OpenBridge?)']);
    }

    const webpush = (() => { try { require('web-push'); return true; } catch (e) { return false; } })();
    checks.push(['web-push (dependencias)', webpush, webpush ? '' : 'corre: npm install']);

    let ok = true;
    for (const [name, pass, hint] of checks) {
        console.log((pass ? '  OK  ' : ' FALTA') + '  ' + name + (hint ? '  ->  ' + hint : ''));
        if (!pass) ok = false;
    }
    return ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// update: compara con npm y, con --yes, actualiza la instalacion global.
// ---------------------------------------------------------------------------
function npmRun(args) {
    return spawnSync('npm', args, { encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true });
}

async function cmdUpdate(argv) {
    const { flags } = parseArgs(argv);
    const tag = (typeof flags.tag === 'string' && flags.tag) ? flags.tag : 'latest';
    const pkg = '@danieltmn/openbridge';
    const spec = pkg + '@' + tag;
    console.log('Version actual: ' + VERSION);

    const view = npmRun(['view', spec, 'version', '--json']);
    let latest = '';
    try { latest = String(JSON.parse(view.stdout)).trim(); } catch (e) { latest = String(view.stdout || '').trim().replace(/"/g, ''); }
    if (view.status !== 0 || !/^\d+\.\d+\.\d+/.test(latest)) {
        console.error('No se pudo consultar npm (' + tag + '): ' + ((view.stderr || '').trim() || 'revisa tu conexion'));
        return 1;
    }
    console.log('Disponible (' + tag + '): ' + latest);
    if (latest === VERSION) {
        console.log('Ya estas en la ultima version.');
        return 0;
    }
    if (flags.check) {
        console.log('Hay una version nueva. Corre: openbridge update --yes');
        return 0;
    }
    if (!flags.yes && !flags.y) {
        console.log('');
        console.log('Para actualizar ahora:');
        console.log('  openbridge update --yes        (o)  npm i -g ' + spec);
        return 0;
    }

    console.log('Actualizando a ' + spec + '...');
    const r = spawnSync('npm', ['i', '-g', spec], { stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true });
    if (r.status !== 0) {
        console.error('La actualizacion fallo. Proba a mano: npm i -g ' + spec);
        return 1;
    }
    console.log('Listo. Reinicia el server para usar la version nueva: openbridge stop && openbridge server');
    return 0;
}

// ---------------------------------------------------------------------------
function usage() {
    console.log('OpenBridge ' + VERSION + ' — tu opencode en el celular, sin hosting');
    console.log('');
    console.log('Uso: openbridge <comando> [opciones]');
    console.log('');
    console.log('  init      Configura la casa (workspace, contrasena, tunel)');
    console.log('  server    Arranca en segundo plano (muestra el estado al levantar)');
    console.log('  passwd    Cambia la contrasena de acceso (--user <nombre> --password <clave>)');
    console.log('  users     Usuarios y roles (list|add|remove|passwd|role|disable|enable)');
    console.log('  stop      Detiene el server en segundo plano');
    console.log('  status    Estado del server, puente y chats');
    console.log('  qr        Muestra la URL (publica o local) como QR para el celular');
    console.log('  tunnel    Muestra o cambia el proveedor de tunel (tunnelmole|ngrok|cloudflare|none) [--domain]');
    console.log('  logs      Ultimas lineas de los logs (--follow --server --bridge)');
    console.log('  bridge    Corre solo el puente (--api --token --id --name)');
    console.log('  join      Vincula esta PC como puente de un hub (<url> --token --id --name)');
    console.log('  import    Trae data/ de OpenConex (<data-dir> [--force])');
    console.log('  reset     Borra todos los chats/datos (--session <id> --yes)');
    console.log('  autostart Instala/quita el arranque automatico (install|remove)');
    console.log('  doctor    Verifica Node, opencode, configuracion y puerto');
    console.log('  update    Busca una version nueva en npm (--yes para actualizar)');
    console.log('');
    console.log('Opciones comunes: --dir <ruta>  (casa portable; default: directorio actual)');
    console.log('init: --workspace --name --id --port --password --tunnel --domain --yes --force');
    console.log('server: --port --no-tunnel --stream   (sin --stream corre en segundo plano)');
}

async function main(argv) {
    const args = argv && argv.length ? argv : ['help'];
    const { flags } = parseArgs(args);
    if (flags.dir) paths.setHome(flags.dir);
    const cmd = args[0];
    const skipMigrate = ['help', '-h', '--help', 'version', '-v', '--version'].includes(cmd);
    if (!skipMigrate) {
        const moved = paths.migrate();
        if (moved && moved.length) {
            console.log('Migre la configuracion a ' + paths.home() + ' (' + moved.join(', ') + ')');
        }
    }
    switch (cmd) {
        case 'init': return cmdInit(args.slice(1));
        case 'passwd': case 'password': return cmdPasswd(args.slice(1));
        case 'users': case 'user': return cmdUsers(args.slice(1));
        case 'server': case 'start': return cmdServer(args.slice(1));
        case 'stop': return cmdStop();
        case 'status': return cmdStatus();
        case 'qr': return cmdQr();
        case 'tunnel': return cmdTunnel(args.slice(1));
        case 'logs': return cmdLogs(args.slice(1));
        case 'bridge': return cmdBridge(args.slice(1));
        case 'join': return cmdJoin(args.slice(1));
        case 'import': return cmdImport(args.slice(1));
        case 'reset': return cmdReset(args.slice(1));
        case 'autostart': return cmdAutostart(args.slice(1));
        case 'doctor': return cmdDoctor();
        case 'update': return cmdUpdate(args.slice(1));
        case 'version': case '-v': case '--version': console.log(VERSION); return 0;
        case 'help': case '-h': case '--help': usage(); return 0;
        default:
            console.error('Comando desconocido: ' + cmd);
            usage();
            return 1;
    }
}

module.exports = { main };
