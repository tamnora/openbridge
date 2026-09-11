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

async function scanFolders(workspace) {
    const out = [];
    const skip = new Set();
    try {
        if (path.resolve(workspace) === path.resolve(paths.home())) {
            skip.add('data');
            skip.add('logs');
        }
    } catch (e) { /* nada */ }
    try {
        const items = await fsp.readdir(workspace, { withFileTypes: true });
        for (const it of items) {
            if (it.name.startsWith('.')) continue;
            if (skip.has(it.name)) continue;
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
    const appCfg = {
        ...config.DEFAULT_APP,
        port,
        host: '127.0.0.1',
        username: flags.user || 'admin',
        password: config.hashPassword(password),
        csrfSecret,
        bridgeToken,
        vapid,
        tunnel: { provider, domain: '' },
    };
    config.writeBridge(bridgeCfg);
    config.writeApp(appCfg);

    const folders = await scanFolders(workspace);
    config.writeJsonFile(paths.foldersPath(), { folders });

    console.log('');
    console.log('OpenBridge configurado en ' + home);
    console.log('  workspace : ' + workspace);
    console.log('  puente    : ' + id + ' (' + name + ')');
    console.log('  URL local : http://127.0.0.1:' + port + '/chat.php');
    console.log('  usuario   : ' + appCfg.username);
    console.log('  contrasena: ' + password + (generated ? '  (generada)' : ''));
    console.log('  tunel     : ' + provider);
    console.log('  carpetas  : ' + folders.length + ' en folders.json');
    if (generated) console.log('  -> guarda esta contrasena: no se vuelve a mostrar.');
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

    // Segundo plano: relanza este mismo comando detached y vuelve enseguida.
    if (flags.detach && !process.env.OPENBRIDGE_DETACHED) {
        const bin = process.argv[1];
        const passthrough = argv.filter((a) => a !== '--detach');
        const child = spawn(process.execPath, [bin, 'server', '--no-detach', ...passthrough], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
            env: { ...process.env, OPENBRIDGE_HOME: paths.home(), OPENBRIDGE_DETACHED: '1' },
        });
        child.unref();
        console.log('OpenBridge arrancado en segundo plano (pid ' + child.pid + ').');
        console.log('  estado: openbridge status');
        console.log('  logs  : openbridge logs');
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
        env: { ...process.env, OPENBRIDGE_HOME: paths.home() },
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

async function cmdStatus() {
    const rt = readRuntime();
    if (!rt || !pidAlive(rt.pid)) {
        console.log('OpenBridge: detenido');
        if (paths.exists()) console.log('casa: ' + paths.home());
        return 0;
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
    if (!paths.exists()) {
        console.error('No hay configuracion en ' + paths.home() + '. Corre primero: openbridge init');
        return 1;
    }
    // Permite apuntar a otro hub sin editar config.json a mano.
    const env = { ...process.env, OPENBRIDGE_HOME: paths.home() };
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
    const interactive = !flags.yes && process.stdin.isTTY;
    let password = flags.password || '';
    if (!password && interactive) password = await askHidden('Nueva contrasena (enter = generar): ');
    let generated = false;
    if (!password) {
        password = config.randomToken(12);
        generated = true;
    }
    if (stopRunningServer()) console.log('Habia un server corriendo; lo detuve para aplicar el cambio.');
    app.password = config.hashPassword(password);
    config.writeApp(app);
    console.log('Contrasena actualizada para "' + app.username + '".');
    console.log('  contrasena: ' + password + (generated ? '  (generada)' : ''));
    console.log('  volve a arrancar: openbridge server');
    return 0;
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
    const home = paths.home();
    if (process.platform === 'win32') {
        const ps = [
            '$ws = New-Object -ComObject WScript.Shell;',
            '$sc = $ws.CreateShortcut(' + JSON.stringify(target) + ');',
            '$sc.TargetPath = ' + JSON.stringify(node) + ';',
            '$sc.Arguments = ' + JSON.stringify('"' + bin + '" server --no-tunnel') + ';',
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
            + '<string>' + node + '</string><string>' + bin + '</string><string>server</string><string>--no-tunnel</string>'
            + '</array>'
            + '<key>WorkingDirectory</key><string>' + home + '</string>'
            + '<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>'
            + '</dict></plist>\n';
        fs.writeFileSync(target, plist);
    } else {
        const unit = '[Unit]\nDescription=OpenBridge\nAfter=network-online.target\n\n'
            + '[Service]\nType=simple\n'
            + 'ExecStart=' + node + ' ' + bin + ' server --no-tunnel\n'
            + 'WorkingDirectory=' + home + '\nRestart=on-failure\n\n'
            + '[Install]\nWantedBy=default.target\n';
        fs.writeFileSync(target, unit);
        spawnSync('systemctl', ['--user', 'daemon-reload'], { windowsHide: true });
        spawnSync('systemctl', ['--user', 'enable', '--now', 'openbridge.service'], { windowsHide: true });
    }
    console.log('autostart instalado: ' + target);
    console.log('  (arranca `openbridge server --no-tunnel` en ' + home + ')');
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
function usage() {
    console.log('OpenBridge ' + VERSION + ' — tu opencode en el celular, sin hosting');
    console.log('');
    console.log('Uso: openbridge <comando> [opciones]');
    console.log('');
    console.log('  init      Configura la casa (workspace, contrasena, tunel)');
    console.log('  passwd    Cambia la contrasena de acceso (--password <clave>)');
    console.log('  server    Arranca la app + el puente + el tunel publico');
    console.log('  stop      Detiene el server en segundo plano');
    console.log('  status    Estado del server, puente y chats');
    console.log('  logs      Ultimas lineas de los logs (--follow --server --bridge)');
    console.log('  bridge    Corre solo el puente (--api --token --id --name)');
    console.log('  import    Trae data/ de OpenConex (<data-dir> [--force])');
    console.log('  reset     Borra todos los chats/datos (--session <id> --yes)');
    console.log('  autostart Instala/quita el arranque automatico (install|remove)');
    console.log('  doctor    Verifica Node, opencode, configuracion y puerto');
    console.log('');
    console.log('Opciones comunes: --dir <ruta>  (casa portable; default: directorio actual)');
    console.log('init: --workspace --name --id --port --password --tunnel --yes --force');
    console.log('server: --port --no-tunnel --detach');
}

async function main(argv) {
    const args = argv && argv.length ? argv : ['help'];
    const { flags } = parseArgs(args);
    if (flags.dir) paths.setHome(flags.dir);
    const cmd = args[0];
    switch (cmd) {
        case 'init': return cmdInit(args.slice(1));
        case 'passwd': case 'password': return cmdPasswd(args.slice(1));
        case 'server': case 'start': return cmdServer(args.slice(1));
        case 'stop': return cmdStop();
        case 'status': return cmdStatus();
        case 'logs': return cmdLogs(args.slice(1));
        case 'bridge': return cmdBridge(args.slice(1));
        case 'import': return cmdImport(args.slice(1));
        case 'reset': return cmdReset(args.slice(1));
        case 'autostart': return cmdAutostart(args.slice(1));
        case 'doctor': return cmdDoctor();
        case 'version': case '-v': case '--version': console.log(VERSION); return 0;
        case 'help': case '-h': case '--help': usage(); return 0;
        default:
            console.error('Comando desconocido: ' + cmd);
            usage();
            return 1;
    }
}

module.exports = { main };
