'use strict';

/**
 * Lectura/escritura de JSON con serializacion por archivo.
 *
 * El server Node es el unico escritor de `data/` (el puente habla por HTTP, no
 * toca los archivos), asi que un mutex en memoria alcanza. La escritura va a un
 * .tmp y rename() para que los lectores nunca vean un archivo a medio escribir.
 */

const fs = require('node:fs/promises');

const locks = new Map();

function withLock(key, fn) {
    const prev = locks.get(key) || Promise.resolve();
    const run = prev.then(fn, fn);
    // La cadena no debe romperse por un error de un eslabon.
    locks.set(key, run.then(() => {}, () => {}));
    return run;
}

async function readJson(file, fallback) {
    try {
        const raw = await fs.readFile(file, 'utf8');
        const data = JSON.parse(raw);
        return (data && typeof data === 'object') ? data : structuredClone(fallback);
    } catch (e) {
        return structuredClone(fallback);
    }
}

async function writeAtomic(file, data) {
    const tmp = file + '.' + process.pid + '.' + Math.random().toString(36).slice(2) + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(data, null, 2));
    await fs.rename(tmp, file);
}

/**
 * Lee, deja modificar con fn(data) y guarda. Si fn devuelve false, no guarda.
 * Si fn devuelve un objeto, ese objeto reemplaza al leido.
 */
async function update(file, fallback, fn) {
    return withLock(file, async () => {
        let data = await readJson(file, fallback);
        const res = await fn(data);
        if (res === false) return false;
        if (res && typeof res === 'object') data = res;
        await writeAtomic(file, data);
        return data;
    });
}

module.exports = { withLock, readJson, writeAtomic, update };
