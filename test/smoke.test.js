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

test('usuarios: migracion del admin legado y helpers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-users-'));
    paths.setHome(dir);
    paths.ensureDirs();
    // Layout legado: un solo username/password.
    config.writeJsonFile(paths.appConfigPath(), { username: 'jefe', password: config.hashPassword('clave') });
    const app = config.readApp();
    assert.equal(app.users.length, 1);
    assert.equal(app.users[0].name, 'jefe');
    assert.equal(app.users[0].role, 'admin');
    assert.ok(config.findUser(app, 'JEFE'));
    assert.equal(config.verifyUserPassword(config.findUser(app, 'jefe'), 'clave'), true);
    assert.equal(config.verifyUserPassword(config.findUser(app, 'jefe'), 'mala'), false);
    assert.equal(config.adminCount(app), 1);
    // Al persistir se limpia el legado.
    config.writeApp(app);
    const raw = JSON.parse(fs.readFileSync(paths.appConfigPath(), 'utf8'));
    assert.equal(raw.username, undefined);
    assert.ok(Array.isArray(raw.users));
    // Nombres validos.
    assert.equal(config.userValidName('ana-1'), true);
    assert.equal(config.userValidName('a b'), false);
    assert.equal(config.userValidName(''), false);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('store: crear sesion, dueño y listado', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-'));
    paths.setHome(dir);
    paths.ensureDirs();
    const id = await store.addSession('Hola', 'C:\\proj', 'm/a', 'build', null, 'pc1');
    assert.ok(id > 0);
    await store.addMessage(id, 'user', 'primer mensaje', 'pending', { agent: 'build', author: 'ana' });
    const list = await store.sessionsListFull();
    assert.equal(list.length, 1);
    assert.equal(list[0].bridge, 'pc1');
    assert.equal(list[0].state, 'waiting');
    assert.equal(list[0].preview, 'primer mensaje');
    const mdata = await store.messagesRead(id);
    assert.equal(mdata.messages[0].author, 'ana');
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
