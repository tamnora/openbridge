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
    "    out(JSON.stringify({ type: 'text', sessionID: 'ses_mock1', part: { text: 'respuesta mock' } }));",
    "} else if (args[0] === 'export') {",
    "    out(JSON.stringify({ info: { directory: process.cwd(), title: 'mock', cost: 0.001, tokens: { input: 1, output: 2, reasoning: 0 } }, messages: [] }));",
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
    const state = { sent: false, respond: null, resolveRespond: null, command: null, resolveCommand: null, proc: null, resolveProc: null, seen: [], workspace };
    const responded = new Promise((resolve) => { state.resolveRespond = resolve; });
    const commanded = new Promise((resolve) => { state.resolveCommand = resolve; });
    const procced = new Promise((resolve) => { state.resolveProc = resolve; });
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
                if (state.resolveCommand) state.resolveCommand(state.command);
            } else if (action === 'proc_result') {
                try { state.proc = JSON.parse(raw || '{}'); } catch (e) { state.proc = {}; }
                if (state.resolveProc) state.resolveProc(state.proc);
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
            resolve(state);
        });
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
});
