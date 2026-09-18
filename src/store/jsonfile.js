'use strict';

/**
 * Lectura/escritura de JSON con serializacion por archivo.
 *
 * El server Node es el unico escritor de `data/` (el puente habla por HTTP, no
 * toca los archivos), asi que un mutex en memoria alcanza. La escritura va a un
 * .tmp y rename() para que los lectores nunca vean un archivo a medio escribir.
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const locks = new Map();

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// En Windows, rename() puede fallar con EPERM/EACCES si otro proceso (antivirus,
// indexador) tiene el archivo abierto un instante. Reintentamos con backoff y,
// si no hay forma, limpiamos el .tmp.
async function renameWithRetry(from, to, tries = 5) {
    for (let i = 0; ; i++) {
        try {
            await fs.rename(from, to);
            return;
        } catch (e) {
            const transient = e && (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EBUSY');
            if (!transient || i >= tries - 1) {
                try { await fs.unlink(from); } catch (e2) { /* nada */ }
                throw e;
            }
            await delay(20 * (i + 1));
        }
    }
}

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
    await renameWithRetry(tmp, file);
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

// Borra los .tmp que quedaron de una escritura interrumpida (crash/kill). Se
// llama al arrancar el server: evita que se acumulen cientos de archivos.
async function purgeTmpDir(dir) {
    let names = [];
    try { names = await fs.readdir(dir); } catch (e) { return 0; }
    let n = 0;
    for (const name of names) {
        if (!name.endsWith('.tmp')) continue;
        try { await fs.unlink(path.join(dir, name)); n++; } catch (e) { /* nada */ }
    }
    return n;
}

module.exports = { withLock, readJson, writeAtomic, update, purgeTmpDir };
