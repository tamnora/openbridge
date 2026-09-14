'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const BIN = path.join(__dirname, '..', 'bin', 'openbridge.js');

function run(args) {
    return spawnSync(process.execPath, [BIN].concat(args), { encoding: 'utf8', windowsHide: true });
}

test('cli join: guarda la config del puente en la casa portable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-cli-'));
    try {
        const r = run(['join', 'https://hub.example.com/', '--token', 'tok', '--id', 'pc9', '--name', 'PC nueve', '--no-start', '--dir', dir]);
        assert.equal(r.status, 0, r.stderr);
        const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.openbridge', 'config.json'), 'utf8'));
        assert.equal(cfg.apiUrl, 'https://hub.example.com/api.php');
        assert.equal(cfg.apiToken, 'tok');
        assert.equal(cfg.bridgeId, 'pc9');
        assert.equal(cfg.bridgeName, 'PC nueve');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('cli join: normaliza la URL del hub a /api.php', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-cli-'));
    try {
        for (const input of ['https://hub.example.com', 'https://hub.example.com/chat.php', 'https://hub.example.com/api.php']) {
            run(['join', input, '--no-start', '--dir', dir]);
            const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.openbridge', 'config.json'), 'utf8'));
            assert.equal(cfg.apiUrl, 'https://hub.example.com/api.php', input);
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('cli join: rechaza una URL invalida', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ob-cli-'));
    try {
        const r = run(['join', 'no-es-url', '--dir', dir]);
        assert.equal(r.status, 1);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('cli help: lista los comandos nuevos', () => {
    const r = run(['help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /join/);
    assert.match(r.stdout, /update/);
});
