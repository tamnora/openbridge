'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const paths = require('../src/paths');
const store = require('../src/store');
const config = require('../src/config');
const { parseTunnelmoleUrls } = require('../src/tunnel');

test('parsea las URLs de tunnelmole', () => {
    const out = parseTunnelmoleUrls('http://abc123.tunnelmole.net is forwarding\nhttps://abc123.tunnelmole.net');
    assert.equal(out.https, 'https://abc123.tunnelmole.net');
    assert.equal(out.http, 'http://abc123.tunnelmole.net');
});

test('hash y verificacion de contrasena', () => {
    const h = config.hashPassword('secreta');
    assert.equal(config.verifyPassword('secreta', h), true);
    assert.equal(config.verifyPassword('otra', h), false);
});

test('store: crear sesion, dueño y listado', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-'));
    paths.setHome(dir);
    paths.ensureDirs();
    const id = await store.addSession('Hola', 'C:\\proj', 'm/a', 'build', null, 'pc1');
    assert.ok(id > 0);
    await store.addMessage(id, 'user', 'primer mensaje', 'pending', { agent: 'build' });
    const list = await store.sessionsListFull();
    assert.equal(list.length, 1);
    assert.equal(list[0].bridge, 'pc1');
    assert.equal(list[0].state, 'waiting');
    assert.equal(list[0].preview, 'primer mensaje');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('store: catalogo por puente', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-'));
    paths.setHome(dir);
    paths.ensureDirs();
    await store.syncCatalog([{ name: 'proj', path: 'C:\\proj' }], ['m/a'], 'C:\\', true, ['build', 'plan'], {}, [], {}, paths.bridgeCatalogFile('pc2'));
    assert.notEqual(await store.folderPathInCatalog('C:\\proj', paths.bridgeCatalogFile('pc2')), null);
    assert.equal(await store.folderPathInCatalog('C:\\proj', paths.bridgeCatalogFile('pc1')), null);
    assert.equal(await store.modelInCatalog('m/a', paths.bridgeCatalogFile('pc2')), true);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('store: ventana de contexto por modelo', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-'));
    paths.setHome(dir);
    paths.ensureDirs();
    await store.syncCatalog([], ['m/a'], '', false, ['build'], {}, [], { 'm/a': 200000 }, paths.catalogFile());
    assert.equal(await store.modelContext('m/a', paths.catalogFile()), 200000);
    assert.equal(await store.modelContext('m/desconocido', paths.catalogFile()), 0);
    fs.rmSync(dir, { recursive: true, force: true });
});
