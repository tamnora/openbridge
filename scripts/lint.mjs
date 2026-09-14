#!/usr/bin/env node
// Chequeo sintactico (node --check) de todo el JS del repo. No reemplaza a un
// linter con reglas: es la red minima para que un archivo roto no llegue a CI.
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const SKIP = new Set(['node_modules', '.git', '.openbridge', 'preview', '.playwright-mcp', '.cache']);

const files = [];
function walk(dir) {
    let names;
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
        if (SKIP.has(name)) continue;
        const full = join(dir, name);
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) walk(full);
        else if (/\.(c|m)?js$/.test(name)) files.push(full);
    }
}
walk(root);
files.sort();

let bad = 0;
for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) {
        bad++;
        process.stderr.write('FALLA ' + relative(root, f) + '\n' + (r.stderr || '') + '\n');
    }
}
console.log('lint: ' + files.length + ' archivos, ' + bad + ' con errores');
process.exit(bad ? 1 : 0);
