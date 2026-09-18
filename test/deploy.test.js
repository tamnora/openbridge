'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mod = () => import('../scripts/deploy-php-hub.mjs');

test('deploy: parseArgs reconoce comandos y flags', async () => {
    const { parseArgs } = await mod();

    let o = parseArgs([]);
    assert.equal(o.cmd, null);
    assert.equal(o.data, false);

    o = parseArgs(['sync', '--data-all', '--dry-run']);
    assert.equal(o.cmd, 'sync');
    assert.equal(o.data, true);
    assert.equal(o.dataAll, true);
    assert.equal(o.dryRun, true);

    o = parseArgs(['reset', '--wipe-data', '--yes']);
    assert.equal(o.cmd, 'reset');
    assert.equal(o.wipeData, true);
    assert.equal(o.keepData, false);
    assert.equal(o.yes, true);

    o = parseArgs(['restore', 'backups/host/2026']);
    assert.equal(o.cmd, 'restore');
    assert.deepEqual(o.positional, ['backups/host/2026']);

    o = parseArgs(['push', 'templates/chat.html', 'version.txt']);
    assert.equal(o.cmd, 'push');
    assert.deepEqual(o.positional, ['templates/chat.html', 'version.txt']);

    o = parseArgs(['-h']);
    assert.equal(o.cmd, 'help');
});

test('deploy: includeFile protege datos por defecto', async () => {
    const { includeFile } = await mod();
    const def = {};

    assert.equal(includeFile('api.php', def), true);
    assert.equal(includeFile('.openbridge/.htaccess', def), true);
    assert.equal(includeFile('.openbridge/app.json', def), false);
    assert.equal(includeFile('.openbridge/data/messages-1.json', def), false);
    assert.equal(includeFile('.ftpquota', def), false);

    assert.equal(includeFile('.openbridge/app.json', { data: true }), true);
    assert.equal(includeFile('.openbridge/data/messages-1.json', { data: true }), false);
    assert.equal(includeFile('.openbridge/data/messages-1.json', { dataAll: true }), true);
});

test('deploy: isProtectedDelete sigue las flags', async () => {
    const { isProtectedDelete } = await mod();

    assert.equal(isProtectedDelete('.openbridge/app.json', {}), true);
    assert.equal(isProtectedDelete('.openbridge/data/sessions.json', {}), true);
    assert.equal(isProtectedDelete('api.php', {}), false);
    assert.equal(isProtectedDelete('.ftpquota', {}), true);

    assert.equal(isProtectedDelete('.openbridge/app.json', { data: true }), false);
    assert.equal(isProtectedDelete('.openbridge/data/sessions.json', { data: true }), true);
    assert.equal(isProtectedDelete('.openbridge/data/sessions.json', { dataAll: true }), false);
});

test('deploy: diffManifest detecta nuevos, cambiados y obsoletos', async () => {
    const { diffManifest } = await mod();

    const local = new Map([
        ['a.php', { sha256: 'aaa' }],
        ['b.php', { sha256: 'bbb' }],
    ]);
    const manifest = { files: { 'a.php': { sha256: 'aaa' }, 'c.php': { sha256: 'ccc' } } };
    const d = diffManifest(local, manifest, {});
    assert.deepEqual(d.added, ['b.php']);
    assert.deepEqual(d.changed, []);
    assert.deepEqual(d.obsolete, ['c.php']);

    const local2 = new Map([['a.php', { sha256: 'otro' }]]);
    const d2 = diffManifest(local2, manifest, {});
    assert.deepEqual(d2.changed, ['a.php']);

    // Un obsoleto protegido no se marca para borrar.
    const manifest3 = { files: { '.openbridge/app.json': { sha256: 'x' } } };
    const d3 = diffManifest(new Map(), manifest3, {});
    assert.deepEqual(d3.obsolete, []);
    const d4 = diffManifest(new Map(), manifest3, { data: true });
    assert.deepEqual(d4.obsolete, ['.openbridge/app.json']);
});

test('deploy: parseList lee el LIST estilo Unix', async () => {
    const { parseList } = await mod();
    const out = parseList([
        'drwxr-xr-x    6 tamnorac   65534            4096 Sep 18 09:45 .',
        'drwxr-xr-x    6 tamnorac   65534            4096 Sep 18 09:45 ..',
        '-rw-r--r--    1 tamnorac   tamnorac       208228 Sep 17 12:42 app.js',
        'drwxrwxrwx    2 tamnorac   tamnorac         4096 Sep 17 12:51 icons',
    ].join('\n'));

    assert.equal(out.length, 4);
    assert.deepEqual(out[2], { type: 'f', size: 208228, name: 'app.js' });
    assert.equal(out[3].type, 'd');
    assert.equal(out[3].name, 'icons');
});

test('deploy: remoteAbs respeta DEPLOY_REMOTE', async () => {
    const { remoteAbs } = await mod();

    assert.equal(remoteAbs({ remote: '/' }, ''), '/');
    assert.equal(remoteAbs({ remote: '/' }, 'api.php'), '/api.php');
    assert.equal(remoteAbs({ remote: '/' }, '/a/b/'), '/a/b');
    assert.equal(remoteAbs({ remote: '/public_html/ob' }, 'x/y.php'), '/public_html/ob/x/y.php');
});

test('deploy: loadEnvFile parsea KEY=VALUE con comillas', async () => {
    const { loadEnvFile } = await mod();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-deploy-'));
    const file = path.join(dir, '.deploy.env');
    fs.writeFileSync(file, [
        '# comentario',
        'DEPLOY_HOST=ftp.example.com',
        'DEPLOY_PASS="clave con espacios"',
        "DEPLOY_USER='update@example.com'",
        '',
    ].join('\n'));

    const env = loadEnvFile(file);
    assert.equal(env.DEPLOY_HOST, 'ftp.example.com');
    assert.equal(env.DEPLOY_PASS, 'clave con espacios');
    assert.equal(env.DEPLOY_USER, 'update@example.com');

    fs.rmSync(dir, { recursive: true, force: true });
});
