import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Presupuesto del hub PHP: cuanto pesa lo que se sube al hosting (`php/dist`)
 * y cuanto ocupa `data/`, sin tocar el server. Util para estimar el plan de
 * cPanel y el crecimiento.
 *
 *   node scripts/hub-budget.mjs
 *   node scripts/hub-budget.mjs --base php/dist --data php/app/.openbridge/data
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, def) {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const base = path.resolve(root, arg('--base', 'php/dist'));
const data = path.resolve(root, arg('--data', 'php/app/.openbridge/data'));

function fmt(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

function walk(dir) {
    const out = [];
    let total = 0;
    const stack = [dir];
    while (stack.length) {
        const cur = stack.pop();
        let entries;
        try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { continue; }
        for (const e of entries) {
            const p = path.join(cur, e.name);
            if (e.isDirectory()) { stack.push(p); continue; }
            let sz = 0;
            try { sz = fs.statSync(p).size; } catch (err) { continue; }
            total += sz;
            out.push({ path: path.relative(dir, p), size: sz });
        }
    }
    out.sort((a, b) => b.size - a.size);
    return { total, files: out };
}

console.log('OpenBridge · presupuesto del hub PHP\n');

if (fs.existsSync(base)) {
    const r = walk(base);
    console.log('Subida a cPanel (' + path.relative(root, base) + '): ' + fmt(r.total));
    for (const f of r.files.slice(0, 12)) {
        console.log('  ' + fmt(f.size).padStart(9) + '  ' + f.path);
    }
    console.log('');
} else {
    console.log('No existe ' + base + ' (corre `node scripts/build-php-hub.mjs`).\n');
}

if (fs.existsSync(data)) {
    const r = walk(data);
    const msgs = r.files.filter((f) => /^messages-\d+\.json$/.test(f.path));
    const cats = r.files.filter((f) => /^catalog.*\.json$/.test(f.path));
    const msgBytes = msgs.reduce((a, f) => a + f.size, 0);
    const catBytes = cats.reduce((a, f) => a + f.size, 0);
    console.log('Datos (' + path.relative(root, data) + '): ' + fmt(r.total));
    console.log('  messages: ' + msgs.length + ' archivo(s), ' + fmt(msgBytes));
    console.log('  catalogos: ' + cats.length + ' archivo(s), ' + fmt(catBytes));
    for (const f of r.files.slice(0, 12)) {
        console.log('  ' + fmt(f.size).padStart(9) + '  ' + f.path);
    }
    console.log('');
    console.log('Aviso: cada poll del puente reescribe sessions/catalogo y el SSE');
    console.log('mantiene un worker ocupado; el costo crece con estos tamanos.');
} else {
    console.log('No existe ' + data + ' (todavia no hay datos locales).');
}
