'use strict';

/**
 * Proxy sin historial en el hosting: indice liviano de sesiones y entrega
 * efimera del historial (se toma una vez y se borra).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const paths = require('../src/paths');
const store = require('../src/store');

test('sessionIndexSync/List: guarda metadatos y filtra ids invalidos', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-proxy-'));
    paths.setBase(dir);
    paths.ensureDirs();
    try {
        const n = await store.sessionIndexSync('pc1', [
            { id: 'ses_abc12345', title: 'Hola', folder: 'C:/p', updated: '10:00' },
            { id: 'no-valido', title: 'x' },
            { id: 'ses_def67890', title: 'Otro', folder: 'C:/q', updated: '11:00' },
        ]);
        assert.equal(n, 2);
        const list = await store.sessionIndexList('pc1');
        assert.equal(list.length, 2);
        assert.equal(list[0].id, 'ses_abc12345');
        assert.equal(list[1].title, 'Otro');
        // Otro puente no ve el indice de pc1.
        assert.equal((await store.sessionIndexList('pc2')).length, 0);
    } finally {
        paths.setBase('');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('historyReady/historyTake: entrega una vez y borra', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-proxy-'));
    paths.setBase(dir);
    paths.ensureDirs();
    try {
        await store.historyReady(42, {
            id: 42,
            messages: [{ role: 'user', parts: [{ type: 'text', text: 'hola' }] }],
        });
        const got = await store.historyTake(42);
        assert.equal(got.id, 42);
        assert.equal(got.messages[0].parts[0].text, 'hola');
        // Segunda vez: ya no esta.
        assert.equal(await store.historyTake(42), null);
    } finally {
        paths.setBase('');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('sessionIndexSync: da de alta las sesiones de opencode en el registro', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-proxy-'));
    paths.setBase(dir);
    paths.ensureDirs();
    try {
        await store.sessionIndexSync('pc1', [
            { id: 'ses_abc12345', title: 'Mi chat', folder: 'C:/p', updated: '10:00' },
        ]);
        let list = await store.sessionsListFull();
        assert.equal(list.length, 1);
        assert.equal(list[0].opencode_session, 'ses_abc12345');
        assert.equal(list[0].name, 'Mi chat');
        // Reindexar no duplica y actualiza el titulo (manda opencode).
        await store.sessionIndexSync('pc1', [
            { id: 'ses_abc12345', title: 'Titulo nuevo', folder: 'C:/p', updated: '11:00' },
        ]);
        list = await store.sessionsListFull();
        assert.equal(list.length, 1);
        assert.equal(list[0].name, 'Titulo nuevo');
    } finally {
        paths.setBase('');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('catalogSetModels: favoritos y predeterminado (cae al primero)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-proxy-'));
    paths.setBase(dir);
    paths.ensureDirs();
    try {
        const file = paths.bridgeCatalogFile('pc1');
        await store.catalogSetModels(['a/uno', 'b/dos'], 'b/dos', file);
        let cat = await store.catalogRead(file);
        assert.deepEqual(cat.favorites, ['a/uno', 'b/dos']);
        assert.equal(cat.default_model, 'b/dos');
        // Un predeterminado que no esta en favoritos cae al primero.
        await store.catalogSetModels(['a/uno'], 'z/no', file);
        cat = await store.catalogRead(file);
        assert.equal(cat.default_model, 'a/uno');
    } finally {
        paths.setBase('');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('queue: alta, reclamo, cancelacion y bajas', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-proxy-'));
    paths.setBase(dir);
    paths.ensureDirs();
    try {
        const id1 = await store.queueAdd('pc1', { session: 7, text: 'hola' });
        const id2 = await store.queueAdd('pc1', { session: 7, text: 'segundo' });
        assert.equal(id1, 1);
        assert.equal(id2, 2);
        // Reclama los dos y los deja en processing.
        const claimed = await store.queueClaim('pc1', 600000);
        assert.equal(claimed.length, 2);
        // Cancelar el 2 (processing) y quitarlo al responder.
        await store.queueCancel('pc1', id2);
        const pend = await store.queueForSession('pc1', 7);
        assert.ok(pend.some((it) => it.cancel_requested));
        await store.queueRemove('pc1', id2);
        assert.equal((await store.queueForSession('pc1', 7)).length, 1);
    } finally {
        paths.setBase('');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('inflight: set, get y clear', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-proxy-'));
    paths.setBase(dir);
    paths.ensureDirs();
    try {
        assert.equal(await store.inflightGet('pc1'), null);
        await store.inflightSet('pc1', { session_id: 7, status: 'streaming', parts: [{ type: 'tool' }] });
        const inf = await store.inflightGet('pc1');
        assert.equal(inf.session_id, 7);
        assert.equal(inf.parts[0].type, 'tool');
        await store.inflightClear('pc1');
        assert.equal(await store.inflightGet('pc1'), null);
    } finally {
        paths.setBase('');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('sessionIndexSync: poda las importadas que ya no vienen en el indice', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-proxy-'));
    paths.setBase(dir);
    paths.ensureDirs();
    try {
        await store.sessionIndexSync('pc1', [
            { id: 'ses_aaa11111', title: 'Uno', folder: 'C:/p', updated: '2026-09-18T10:00:00.000Z' },
            { id: 'ses_bbb22222', title: 'Dos', folder: 'C:/p', updated: '2026-09-18T11:00:00.000Z' },
        ]);
        let list = await store.sessionsListFull();
        assert.equal(list.length, 2);
        const gone = list.find((s) => s.opencode_session === 'ses_aaa11111');
        await store.messagesUpdate(gone.id, (data) => { data.messages.push({ role: 'user', text: 'x' }); });
        // El indice nuevo solo trae la segunda: la primera se poda.
        await store.sessionIndexSync('pc1', [
            { id: 'ses_bbb22222', title: 'Dos', folder: 'C:/p', updated: '2026-09-18T11:00:00.000Z' },
        ]);
        list = await store.sessionsListFull();
        assert.equal(list.length, 1);
        assert.equal(list[0].opencode_session, 'ses_bbb22222');
        // El historial de la podada tambien se limpia.
        const msgs = await store.messagesRead(gone.id);
        assert.equal((msgs.messages || []).length, 0);
    } finally {
        paths.setBase('');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('sessionIndexSync: guarda totales por carpeta; sessionPruneFolder borra las de una carpeta', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-proxy-'));
    paths.setBase(dir);
    paths.ensureDirs();
    try {
        await store.sessionIndexSync('pc1', [
            { id: 'ses_aaa11111', title: 'Uno', folder: 'C:/p', updated: '2026-09-18T10:00:00.000Z' },
            { id: 'ses_bbb22222', title: 'Dos', folder: 'C:/q', updated: '2026-09-18T11:00:00.000Z' },
        ], { 'C:/p': 9, 'C:/q': 3 });
        const totals = await store.sessionIndexTotals('pc1');
        assert.equal(totals['C:/p'], 9);
        assert.equal(totals['C:/q'], 3);
        // Desconectar C:/p borra solo sus importadas.
        const pruned = await store.sessionPruneFolder('C:/p', 'pc1');
        assert.equal(pruned, 1);
        const list = await store.sessionsListFull();
        assert.equal(list.length, 1);
        assert.equal(list[0].opencode_session, 'ses_bbb22222');
    } finally {
        paths.setBase('');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('bridgeReset: marcador de reset (pending/request/clear) y pollPeekWork', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-proxy-'));
    paths.setBase(dir);
    paths.ensureDirs();
    try {
        assert.equal(await store.bridgeResetPending(), false);
        assert.equal(await store.pollPeekWork(Date.now(), 'pc1'), false);
        await store.bridgeResetRequest();
        assert.equal(await store.bridgeResetPending(), true);
        // El marcador despierta el long-poll del puente.
        assert.equal(await store.pollPeekWork(Date.now(), 'pc1'), true);
        await store.bridgeResetClear();
        assert.equal(await store.bridgeResetPending(), false);
        assert.equal(await store.pollPeekWork(Date.now(), 'pc1'), false);
    } finally {
        paths.setBase('');
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
