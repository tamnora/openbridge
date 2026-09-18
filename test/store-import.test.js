'use strict';

/**
 * Paridad del merge de importacion (hub Node): identidad por `oc_msg` de
 * opencode y "adopcion" del mensaje optimista que creo la web, para no
 * duplicar cuando la misma sesion se sincroniza desde el TUI.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const paths = require('../src/paths');
const store = require('../src/store');

test('sessionImport: dedupe por oc_msg y adopcion del mensaje optimista', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-store-'));
    paths.setBase(dir);
    paths.ensureDirs();
    try {
        const r1 = await store.sessionImport('ses_test0001', 'Chat', 'C:/proj', '', 'build', '', [
            { role: 'assistant', text: 'hola', ts: '2026-01-01T00:00:00Z', oc_msg: 'msg_a1' },
        ], 0, 0, 'pc1');
        assert.equal(r1.ok, true);
        assert.equal(r1.added, 1);
        const sid = r1.session_id;

        // Reimportar el mismo mensaje (mismo oc_msg, distinto ts): no duplica.
        const r2 = await store.sessionImport('ses_test0001', 'Chat', 'C:/proj', '', 'build', '', [
            { role: 'assistant', text: 'hola', ts: '2026-01-01T00:00:05Z', oc_msg: 'msg_a1' },
        ], 0, 0, 'pc1');
        assert.equal(r2.added, 0);

        // Mensaje optimista de la web (sin oc_msg).
        await store.addMessage(sid, 'user', 'dale', 'pending', {});
        // Llega de opencode con oc_msg: se adopta, no se duplica.
        const r3 = await store.sessionImport('ses_test0001', 'Chat', 'C:/proj', '', 'build', '', [
            { role: 'user', text: 'dale', ts: '2026-01-01T00:01:00Z', oc_msg: 'msg_u1' },
        ], 0, 0, 'pc1');
        assert.equal(r3.added, 0);
        const data = await store.messagesRead(sid);
        const users = data.messages.filter((m) => m.role === 'user');
        assert.equal(users.length, 1);
        assert.equal(users[0].oc_msg, 'msg_u1');

        // Un mensaje nuevo del TUI (otro oc_msg) si se agrega.
        const r4 = await store.sessionImport('ses_test0001', 'Chat', 'C:/proj', '', 'build', '', [
            { role: 'user', text: 'otra cosa', ts: '2026-01-01T00:02:00Z', oc_msg: 'msg_u2' },
        ], 0, 0, 'pc1');
        assert.equal(r4.added, 1);
    } finally {
        paths.setBase('');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('sessionImport: rename forzado pisa el nombre (salvo placeholder)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-store-'));
    paths.setBase(dir);
    paths.ensureDirs();
    try {
        const r = await store.sessionImport('ses_r1', 'Nombre del hub', 'C:/proj', '', 'build', '', [
            { role: 'user', text: 'x', ts: '2026-01-01T00:00:00Z', oc_msg: 'm1' },
        ], 0, 0, 'pc1');
        // Sin `rename`, el nombre util del hub no se pisa.
        await store.sessionImport('ses_r1', 'otro', 'C:/proj', '', 'build', '', [], 0, 0, 'pc1');
        assert.equal((await store.getSession(r.session_id)).name, 'Nombre del hub');
        // Con `rename`, gana el titulo de opencode.
        await store.sessionImport('ses_r1', 'bridge-24', 'C:/proj', '', 'build', '', [], 0, 0, 'pc1', true);
        assert.equal((await store.getSession(r.session_id)).name, 'bridge-24');
        // Un placeholder de opencode no pisa el nombre.
        await store.sessionImport('ses_r1', 'New session - 2026-01-01', 'C:/proj', '', 'build', '', [], 0, 0, 'pc1', true);
        assert.equal((await store.getSession(r.session_id)).name, 'bridge-24');
    } finally {
        paths.setBase('');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('sessionReconcile: borra huerfanos del puente solo en carpetas escaneadas', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-store-'));
    paths.setBase(dir);
    paths.ensureDirs();
    try {
        const a = await store.sessionImport('ses_a', 'A', 'C:/proj', '', 'build', '', [], 0, 0, 'pc1');
        const b = await store.sessionImport('ses_b', 'B', 'C:/other', '', 'build', '', [], 0, 0, 'pc1');
        const c = await store.sessionImport('ses_c', 'C', 'C:/proj', '', 'build', '', [], 0, 0, 'pc2');
        const d = await store.sessionImport('ses_d', 'D', 'C:/proj', '', 'build', '', [], 0, 0, 'pc1');
        // pc1 ve solo ses_a y escaneó C:/proj: ses_d es huérfana; ses_b (otra
        // carpeta) y ses_c (otro puente) se conservan.
        const res = await store.sessionReconcile(['ses_a'], ['C:/proj'], 'pc1');
        assert.equal(res.deleted, 1);
        assert.equal(await store.getSession(d.session_id), null);
        assert.ok(await store.getSession(a.session_id));
        assert.ok(await store.getSession(b.session_id));
        assert.ok(await store.getSession(c.session_id));
    } finally {
        paths.setBase('');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
