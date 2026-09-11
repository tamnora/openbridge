'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const paths = require('../src/paths');

test('migrate: mueve el layout viejo a .openbridge/', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-mig-'));
    fs.writeFileSync(path.join(base, 'config.json'), '{"apiUrl":"x"}');
    fs.writeFileSync(path.join(base, 'app.json'), '{"username":"admin"}');
    fs.writeFileSync(path.join(base, 'folders.json'), '{"folders":[]}');
    fs.mkdirSync(path.join(base, 'data'));
    fs.writeFileSync(path.join(base, 'data', 'sessions.json'), '{"sessions":[]}');
    fs.mkdirSync(path.join(base, 'logs'));
    fs.writeFileSync(path.join(base, 'logs', 'bridge.log'), 'hola');

    paths.setHome(base);
    const moved = paths.migrate();

    const home = path.join(base, '.openbridge');
    assert.ok(moved.includes('config.json'));
    assert.ok(moved.includes('app.json'));
    assert.ok(moved.includes('data'));
    assert.ok(moved.includes('logs'));
    assert.equal(fs.existsSync(path.join(base, 'config.json')), false);
    assert.equal(fs.existsSync(path.join(home, 'config.json')), true);
    assert.equal(fs.existsSync(path.join(home, 'data', 'sessions.json')), true);
    assert.equal(fs.existsSync(path.join(home, 'logs', 'bridge.log')), true);
    assert.equal(paths.exists(), true);

    fs.rmSync(base, { recursive: true, force: true });
});

test('migrate: no toca data/ ajeno sin marcas de OpenBridge', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-mig2-'));
    fs.writeFileSync(path.join(base, 'config.json'), '{"apiUrl":"x"}');
    fs.mkdirSync(path.join(base, 'data'));
    fs.writeFileSync(path.join(base, 'data', 'personal.txt'), 'no tocar');

    paths.setHome(base);
    paths.migrate();

    assert.equal(fs.existsSync(path.join(base, '.openbridge', 'config.json')), true);
    assert.equal(fs.existsSync(path.join(base, 'data', 'personal.txt')), true);
    assert.equal(fs.existsSync(path.join(base, '.openbridge', 'data')), false);

    fs.rmSync(base, { recursive: true, force: true });
});

test('home() apunta a .openbridge dentro de la base', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-home-'));
    paths.setHome(base);
    assert.equal(paths.home(), path.join(base, '.openbridge'));
    assert.equal(paths.dataDir(), path.join(base, '.openbridge', 'data'));
    fs.rmSync(base, { recursive: true, force: true });
});
