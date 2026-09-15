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
