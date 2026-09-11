'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const paths = require('../src/paths');
const store = require('../src/store');

test('safeJoinWorkspace: permite dentro y bloquea traversal', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-home-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-ws-'));
    paths.setHome(home);
    paths.ensureDirs();
    fs.mkdirSync(path.join(root, 'proj'));
    fs.writeFileSync(path.join(root, 'proj', 'a.txt'), 'hola');

    await store.syncCatalog(
        [{ name: 'proj', path: path.join(root, 'proj') }],
        ['m/a'], root, true, ['build'], {}, [], {}, paths.catalogFile()
    );

    const file = paths.catalogFile();
    const rootReal = await fs.promises.realpath(root);
    const expected = await fs.promises.realpath(path.join(root, 'proj'));
    assert.equal(await store.safeJoinWorkspace('proj', 4, file), expected);
    assert.equal(await store.safeJoinWorkspace('proj/a.txt', 4, file), await fs.promises.realpath(path.join(root, 'proj', 'a.txt')));
    // '' y '.' devuelven la raiz del workspace.
    assert.equal(await store.safeJoinWorkspace('', 4, file), rootReal);
    assert.equal(await store.safeJoinWorkspace('.', 4, file), rootReal);

    // Nada escapa de la raiz (los '..' se descartan y realpath no sale).
    assert.equal(await store.safeJoinWorkspace('proj/../../fuera', 4, file), null);
    assert.equal(await store.safeJoinWorkspace('proj/../secret', 4, file), null);
    assert.equal(await store.safeJoinWorkspace('a/b/c/d/e', 4, file), null);

    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
});
