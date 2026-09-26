'use strict';

// End-to-end del puente sin opencode real: un `command` que es un script de
// Node (mock-opencode.js) hace de CLI y un servidor HTTP local hace de hosting.
// Se verifica el ciclo completo: ping -> sync_catalog -> poll -> opencode ->
// respond.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BRIDGE = path.join(__dirname, '..', 'src', 'bridge', 'bridge.js');

// CLI simulado: responde a los subcomandos que usa el puente. Con `run` emite
// un evento JSON de opencode (texto + sessionID) que el puente debe publicar.
const MOCK_OC = [
    "'use strict';",
    "const args = process.argv.slice(2);",
    "const out = (s) => process.stdout.write(s + '\\n');",
    "if (args[0] === 'models' && args[1] === '--verbose') {",
    "    out('mock/model');",
    "    out('{');",
    "    out('  \"capabilities\": { \"input\": { \"image\": true }, \"attachment\": true },');",
    "    out('  \"limit\": { \"context\": 128000 }');",
    "    out('}');",
    "} else if (args[0] === 'models') {",
    "    out('mock/model');",
    "} else if (args[0] === 'run') {",
    "    out(JSON.stringify({ type: 'text', sessionID: 'ses_mock1', part: { id: 'prt_x1', messageID: 'msg_x1', text: 'respuesta mock' } }));",
    "    out(JSON.stringify({ type: 'tool', sessionID: 'ses_mock1', part: { id: 'prt_t1', messageID: 'msg_x1', tool: 'bash', callID: 'call_1', state: { status: 'completed', title: 'echo hola', input: { command: 'echo hola' }, output: 'hola' } } }));",
    "} else if (args[0] === 'export') {",
    "    out(JSON.stringify({ info: { directory: process.cwd(), title: 'mock', cost: 0.001, tokens: { input: 1, output: 2, reasoning: 0 } }, messages: [] }));",
    "} else if (args[0] === 'session' && args[1] === 'list') {",
    "    if (args.indexOf('--format') >= 0 && args.indexOf('json') >= 0) {",
    "        const arr = [];",
    "        for (let i = 1; i <= 6; i++) arr.push({ id: 'ses_cap0000' + i, title: 'cap ' + i, updated: 1789000000000 + i * 1000, directory: process.cwd() });",
    "        arr.push({ id: 'ses_ajeno0001', title: 'ajena', updated: 1789000999999, directory: 'C:/otro/proyecto' });",
    "        out(JSON.stringify(arr));",
    "    } else {",
    "        out('ses_cap00001  cap 1  10:00');",
    "    }",
    "} else if (args[0] === 'mcp') {",
    "    out('• mariadb connected');",
    "    out('• playwright connected');",
    "} else {",
    "    out('mock');",
    "}",
    "process.exit(0);",
    '',
].join('\n');

function startMockApi(workspace) {
    const state = { sent: false, respond: null, resolveRespond: null, command: null, resolveCommand: null, proc: null, resolveProc: null, procById: {}, waitProc: {}, import: null, resolveImport: null, index: null, resolveIndex: null, seen: [], workspace };
    const responded = new Promise((resolve) => { state.resolveRespond = resolve; });
    const commanded = new Promise((resolve) => { state.resolveCommand = resolve; });
    const procced = new Promise((resolve) => { state.resolveProc = resolve; });
    const imported = new Promise((resolve) => { state.resolveImport = resolve; });
    const indexed = new Promise((resolve) => { state.resolveIndex = resolve; });
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            let u;
            try { u = new URL(req.url, 'http://localhost'); } catch (e) { u = new URL('http://localhost/'); }
            const action = u.searchParams.get('action') || '';
            state.seen.push(action);
            let json = { ok: true };
            if (action === 'ping') {
                json = { ok: true, now: new Date().toISOString() };
            } else if (action === 'sync_catalog') {
                json = { ok: true, folders: 0, models: 1, agents: 2 };
            } else if (action === 'poll') {
                if (!state.sent) {
                    state.sent = true;
                    json = {
                        ok: true,
                        known_oc: [],
                        messages: [{
                            id: 7,
                            session_id: 'c1',
                            text: 'hola mock',
                            session: { folder: workspace, model: 'mock/model', agent: 'build' },
                        }],
                        commands: [
                            { id: 9, name: 'mcp_list', args: [] },
                            { id: 10, name: 'proc_detect', args: [path.join(workspace, 'proj')] },
                            { id: 11, name: 'session_sync', args: ['ses_mock1', workspace] },
                        ],
                    };
                } else if (state.syncDone && !state.moreSent) {
                    // Ya terminaron los comandos iniciales: pide "Ver mas
                    // sesiones" (folder_more) para probar el paginado. Los otros
                    // proc_detect (pnpm/yarn/bun) van acá para no alterar el
                    // timing del primer index_sync (que corta a 4).
                    state.moreSent = true;
                    json = {
                        ok: true, known_oc: [], messages: [], commands: [
                            { id: 12, name: 'folder_more', args: [workspace, '4'] },
                            { id: 20, name: 'proc_detect', args: [path.join(workspace, 'proj-pnpm')] },
                            { id: 21, name: 'proc_detect', args: [path.join(workspace, 'proj-yarn')] },
                            { id: 22, name: 'proc_detect', args: [path.join(workspace, 'proj-bun')] },
                        ],
                    };
                } else {
                    json = { ok: true, known_oc: [], messages: [], commands: [], folders: [] };
                }
            } else if (action === 'respond') {
                try { state.respond = JSON.parse(raw || '{}'); } catch (e) { state.respond = {}; }
                if (state.resolveRespond) state.resolveRespond(state.respond);
            } else if (action === 'command_done') {
                try { state.command = JSON.parse(raw || '{}'); } catch (e) { state.command = {}; }
                if (state.command && state.command.id === 11) state.syncDone = true;
                if (state.resolveCommand) state.resolveCommand(state.command);
            } else if (action === 'proc_result') {
                try { state.proc = JSON.parse(raw || '{}'); } catch (e) { state.proc = {}; }
                if (state.proc && state.proc.id != null) state.procById[state.proc.id] = state.proc;
                if (state.resolveProc) state.resolveProc(state.proc);
                if (state.proc && state.waitProc[state.proc.id]) {
                    state.waitProc[state.proc.id](state.proc);
                    delete state.waitProc[state.proc.id];
                }
            } else if (action === 'session_import') {
                try { state.import = JSON.parse(raw || '{}'); } catch (e) { state.import = {}; }
                if (state.resolveImport) state.resolveImport(state.import);
                json = { ok: true, session_id: 1, created: true, added: 1 };
            } else if (action === 'index_sync') {
                try { state.index = JSON.parse(raw || '{}'); } catch (e) { state.index = {}; }
                if (state.resolveIndex) state.resolveIndex(state.index);
                json = { ok: true, count: (state.index.sessions || []).length };
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(json));
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            state.port = server.address().port;
            state.server = server;
            state.responded = responded;
            state.commanded = commanded;
            state.procced = procced;
            state.imported = imported;
            state.indexed = indexed;
            resolve(state);
        });
    });
}

// Espera el proc_result de un id concreto (varios proc_detect en el mismo tick).
function waitProc(api, id, timeoutMs) {
    if (api.procById[id]) return Promise.resolve(api.procById[id]);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout esperando "proc_result" #' + id)), timeoutMs || 15000);
        api.waitProc[id] = (p) => { clearTimeout(timer); resolve(p); };
    });
}

function killTree(pid) {
    if (!pid) return;
    try {
        if (process.platform === 'win32') {
            spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
        } else {
            try { process.kill(-pid, 'SIGKILL'); } catch (e) { /* sin grupo */ }
            try { process.kill(pid, 'SIGKILL'); } catch (e) { /* ya no esta */ }
        }
    } catch (e) { /* nada */ }
}

test('bridge e2e: mensaje -> opencode mock -> respond', async (t) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-bridge-'));
    const home = path.join(base, '.openbridge');
    const ws = path.join(base, 'ws');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(ws, { recursive: true });
    const proj = path.join(ws, 'proj');
    fs.mkdirSync(path.join(proj, 'public'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'demo', scripts: { dev: 'vite' } }, null, 2));
    fs.writeFileSync(path.join(proj, 'public', 'index.php'), '<?php echo 1;');
    // Gestores alternativos: lockfile (pnpm/bun) y campo packageManager (yarn,
    // que ademas gana sobre un lockfile de otro gestor presente).
    const projPnpm = path.join(ws, 'proj-pnpm');
    fs.mkdirSync(projPnpm, { recursive: true });
    fs.writeFileSync(path.join(projPnpm, 'package.json'), JSON.stringify({ name: 'pnpm-demo', scripts: { dev: 'vite' } }, null, 2));
    fs.writeFileSync(path.join(projPnpm, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    const projYarn = path.join(ws, 'proj-yarn');
    fs.mkdirSync(projYarn, { recursive: true });
    fs.writeFileSync(path.join(projYarn, 'package.json'), JSON.stringify({ name: 'yarn-demo', packageManager: 'yarn@4.1.0', scripts: { dev: 'vite' } }, null, 2));
    fs.writeFileSync(path.join(projYarn, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    const projBun = path.join(ws, 'proj-bun');
    fs.mkdirSync(projBun, { recursive: true });
    fs.writeFileSync(path.join(projBun, 'package.json'), JSON.stringify({ name: 'bun-demo', scripts: { start: 'bun run index.ts' } }, null, 2));
    fs.writeFileSync(path.join(projBun, 'bun.lockb'), 'bun\n');

    const mock = path.join(base, 'mock-opencode.js');
    fs.writeFileSync(mock, MOCK_OC);

    const api = await startMockApi(ws);
    const cfg = {
        apiUrl: 'http://127.0.0.1:' + api.port,
        command: mock,
        workspace: ws,
        models: ['mock/model'],
        agents: ['build', 'plan'],
        pollIntervalMs: 200,
        opencodeTimeoutMs: 20000,
    };
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg, null, 2));
    // Un proyecto conectado: el puente publica solo sus sesiones, cortadas a
    // las 4 mas recientes (config sessionIndexLimit default).
    fs.writeFileSync(path.join(home, 'folders.json'), JSON.stringify({ folders: [{ name: 'ws', path: ws, active: true }] }, null, 2));

    let logs = '';
    const bridge = spawn(process.execPath, [BRIDGE], {
        cwd: base,
        env: Object.assign({}, process.env, { OPENBRIDGE_HOME: base }),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    bridge.stdout.on('data', (d) => { logs += d; });
    bridge.stderr.on('data', (d) => { logs += d; });

    t.after(() => {
        killTree(bridge.pid);
        try { api.server.close(); } catch (e) { /* nada */ }
        try { fs.rmSync(base, { recursive: true, force: true }); } catch (e) { /* nada */ }
    });

    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout esperando "respond". Log del puente:\n' + logs)), 30000);
    });
    let payload;
    try {
        payload = await Promise.race([api.responded, timeout]);
    } finally {
        clearTimeout(timer);
    }

    assert.equal(payload.session_id, 'c1');
    assert.equal(payload.user_id, 7);
    assert.match(payload.text, /respuesta mock/);
    assert.ok(Array.isArray(payload.parts), 'el respond incluye las partes (vista tipo TUI)');
    assert.ok(payload.parts.some((p) => p.type === 'tool' && p.tool === 'bash'), 'incluye la parte de tool');
    assert.ok(payload.parts.some((p) => p.type === 'text' && /respuesta mock/.test(p.text)), 'incluye la parte de texto');
    assert.equal(payload.opencode_session, 'ses_mock1');
    assert.ok(api.seen.includes('ping'), 'el puente debe hacer ping al arrancar');
    assert.ok(api.seen.includes('sync_catalog'), 'el puente debe sincronizar el catalogo');

    // El primer poll también encoló un `mcp_list`: el puente lo resuelve y
    // devuelve la salida de `opencode mcp list` en JSON.
    let cmdTimer = null;
    const cmdTimeout = new Promise((_, reject) => {
        cmdTimer = setTimeout(() => reject(new Error('timeout esperando "command_done" (mcp_list)')), 15000);
    });
    let done;
    try {
        done = await Promise.race([api.commanded, cmdTimeout]);
    } finally {
        clearTimeout(cmdTimer);
    }
    assert.equal(done.id, 9);
    assert.equal(done.ok, true);
    const out = JSON.parse(done.text);
    assert.match(out.output, /mariadb connected/);
    assert.match(out.output, /playwright connected/);

    // proc_detect: el puente inspecciona el proyecto y sugiere cómo correrlo.
    let procTimer = null;
    const procTimeout = new Promise((_, reject) => {
        procTimer = setTimeout(() => reject(new Error('timeout esperando "proc_result" (proc_detect)')), 15000);
    });
    let procDone;
    try {
        procDone = await Promise.race([api.procced, procTimeout]);
    } finally {
        clearTimeout(procTimer);
    }
    assert.equal(procDone.id, 10);
    assert.equal(procDone.ok, true);
    const det = JSON.parse(procDone.text);
    assert.ok(det.suggestions.some((s) => s.cmd === 'npm run dev'), 'detecta npm run dev');
    assert.ok(det.suggestions.some((s) => s.cmd.indexOf('php -S') === 0), 'detecta php -S');

    // proc_detect con otros gestores: lockfile -> pnpm/bun, packageManager ->
    // yarn (y le gana al lockfile pnpm que hay en ese proyecto).
    const detPnpm = JSON.parse((await waitProc(api, 20)).text);
    assert.ok(detPnpm.suggestions.some((s) => s.cmd === 'pnpm run dev'), 'pnpm-lock.yaml detecta pnpm run dev');
    const detYarn = JSON.parse((await waitProc(api, 21)).text);
    assert.ok(detYarn.suggestions.some((s) => s.cmd === 'yarn run dev'), 'packageManager gana sobre el lockfile');
    const detBun = JSON.parse((await waitProc(api, 22)).text);
    assert.ok(detBun.suggestions.some((s) => s.cmd === 'bun start'), 'bun.lockb detecta bun start');

    // session_sync: el comando de la web fuerza el export/import de una sesión.
    let impTimer = null;
    const impTimeout = new Promise((_, reject) => {
        impTimer = setTimeout(() => reject(new Error('timeout esperando "session_import"')), 15000);
    });
    let imp;
    try {
        imp = await Promise.race([api.imported, impTimeout]);
    } finally {
        clearTimeout(impTimer);
    }
    assert.equal(imp.opencode_session, 'ses_mock1');
    assert.equal(imp.rename, true, 'el sync manual propaga el titulo de opencode');

    // Regresión: el finally de tick() debe correr sin ReferenceError. Antes
    // `liteTimer` se declaraba dentro del try y rompía el cleanup: `busy`
    // quedaba en true y el barrido de sesiones no volvía a correr.
    await new Promise((r) => setTimeout(r, 1200));
    assert.ok(!/liteTimer is not defined/.test(logs), 'no debe romper el finally de tick:\n' + logs);
    assert.ok(!/barrido de sesiones pausado/.test(logs), 'el barrido no debe quedar pausado por busy');

    // index_sync: solo el proyecto conectado y a lo sumo 4 sesiones.
    let idxTimer = null;
    const idxTimeout = new Promise((_, reject) => {
        idxTimer = setTimeout(() => reject(new Error('timeout esperando "index_sync"')), 15000);
    });
    let idx;
    try {
        idx = await Promise.race([api.indexed, idxTimeout]);
    } finally {
        clearTimeout(idxTimer);
    }
    assert.equal(idx.sessions.length, 4, 'corta a las 4 mas recientes');
    assert.ok(idx.sessions.every((s) => s.folder === ws), 'solo la carpeta conectada');
    assert.deepEqual(idx.sessions.map((s) => s.id), ['ses_cap00006', 'ses_cap00005', 'ses_cap00004', 'ses_cap00003']);
    assert.equal(idx.totals[ws], 6, 'reporta el total de sesiones de la carpeta (sin contar las ajenas)');

    // folder_more: el puente sube el limite de esa carpeta y republica con mas
    // sesiones (la ajena de otra carpeta sigue afuera).
    let moreIdx = null;
    for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 200));
        if (api.index && Array.isArray(api.index.sessions) && api.index.sessions.length === 6) { moreIdx = api.index; break; }
    }
    assert.ok(moreIdx, 'folder_more republica con mas sesiones. Log:\n' + logs);
    assert.ok(moreIdx.sessions.every((s) => s.folder === ws), 'folder_more no mete carpetas ajenas');
    assert.equal(moreIdx.totals[ws], 6, 'el total sigue siendo el de la carpeta');
});
