'use strict';

/**
 * Generador de QR minimo (ISO/IEC 18004, Model 2) sin dependencias.
 *
 * Soporta modo byte (UTF-8) con correccion de errores nivel L, versiones 1 a 5
 * (hasta 106 bytes, de sobra para una URL de tunel) y un solo bloque RS. La
 * mascara es fija (0): cualquier mascara es valida y la info de formato la
 * declara, asi que el resultado es escaneable.
 */

// dataCodewords, eccCodewords y centros de patrones de alineacion por version.
const VERSIONS = {
    1: { data: 19, ecc: 7, align: [] },
    2: { data: 34, ecc: 10, align: [6, 18] },
    3: { data: 55, ecc: 15, align: [6, 22] },
    4: { data: 80, ecc: 20, align: [6, 26] },
    5: { data: 108, ecc: 26, align: [6, 30] },
};

const MASK = 0;
const ECC_FORMAT_BITS = 1; // nivel L -> 01

function gfMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
        z = (z << 1) ^ ((z >>> 7) * 0x11d);
        z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
}

function rsDivisor(degree) {
    const result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
        for (let j = 0; j < result.length; j++) {
            result[j] = gfMul(result[j], root);
            if (j + 1 < result.length) result[j] ^= result[j + 1];
        }
        root = gfMul(root, 0x02);
    }
    return result;
}

function rsRemainder(data, divisor) {
    const result = divisor.map(() => 0);
    for (const b of data) {
        const factor = b ^ result.shift();
        result.push(0);
        for (let i = 0; i < divisor.length; i++) result[i] ^= gfMul(divisor[i], factor);
    }
    return result;
}

function getBit(x, i) {
    return ((x >>> i) & 1) !== 0;
}

function chooseVersion(byteLen) {
    for (let v = 1; v <= 5; v++) {
        if (byteLen <= VERSIONS[v].data - 2) return v;
    }
    return 0;
}

function dataCodewords(bytes, version) {
    const cap = VERSIONS[version].data;
    const bits = [];
    const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    push(0b0100, 4);            // modo byte
    push(bytes.length, 8);      // conteo (v1-9: 8 bits)
    for (const b of bytes) push(b, 8);
    for (let i = 0; i < 4 && bits.length < cap * 8; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);
    const out = [];
    for (let i = 0; i < bits.length; i += 8) {
        let b = 0;
        for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
        out.push(b);
    }
    const pad = [0xec, 0x11];
    let k = 0;
    while (out.length < cap) out.push(pad[k++ % 2]);
    return out;
}

function buildMatrix(version, codewords) {
    const size = version * 4 + 17;
    const modules = Array.from({ length: size }, () => new Array(size).fill(false));
    const isFn = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (x, y, dark) => { modules[y][x] = dark; isFn[y][x] = true; };

    // Patrones de sincronizacion.
    for (let i = 0; i < size; i++) {
        set(6, i, i % 2 === 0);
        set(i, 6, i % 2 === 0);
    }

    // Localizadores (finder) + separadores.
    const drawFinder = (cx, cy) => {
        for (let dy = -4; dy <= 4; dy++) {
            for (let dx = -4; dx <= 4; dx++) {
                const x = cx + dx, y = cy + dy;
                if (x < 0 || x >= size || y < 0 || y >= size) continue;
                const dist = Math.max(Math.abs(dx), Math.abs(dy));
                set(x, y, dist !== 2 && dist !== 4);
            }
        }
    };
    drawFinder(3, 3);
    drawFinder(size - 4, 3);
    drawFinder(3, size - 4);

    // Patrones de alineacion.
    const pos = VERSIONS[version].align;
    for (const cy of pos) {
        for (const cx of pos) {
            if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue;
            for (let dy = -2; dy <= 2; dy++) {
                for (let dx = -2; dx <= 2; dx++) {
                    set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
                }
            }
        }
    }

    // Reserva la info de formato (se reescribe abajo) y el modulo oscuro.
    drawFormatBits(size, modules, isFn, 0);

    // Colocacion de datos en zigzag.
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let vert = 0; vert < size; vert++) {
            for (let j = 0; j < 2; j++) {
                const x = right - j;
                const upward = ((right + 1) & 2) === 0;
                const y = upward ? size - 1 - vert : vert;
                if (isFn[y][x] || i >= codewords.length * 8) continue;
                modules[y][x] = getBit(codewords[i >>> 3], 7 - (i & 7));
                i++;
            }
        }
    }

    // Mascara fija.
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            if (!isFn[y][x] && (x + y) % 2 === 0) modules[y][x] = !modules[y][x];
        }
    }

    drawFormatBits(size, modules, isFn, MASK);
    return { size, modules };
}

function drawFormatBits(size, modules, isFn, mask) {
    const data = (ECC_FORMAT_BITS << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const put = (x, y, dark) => { modules[y][x] = dark; isFn[y][x] = true; };

    for (let i = 0; i <= 5; i++) put(8, i, getBit(bits, i));
    put(8, 7, getBit(bits, 6));
    put(8, 8, getBit(bits, 7));
    put(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) put(14 - i, 8, getBit(bits, i));

    for (let i = 0; i < 8; i++) put(size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) put(8, size - 15 + i, getBit(bits, i));
    put(8, size - 8, true);
}

// Devuelve { size, modules } o null si el texto no entra (URL muy larga).
function qrMatrix(text) {
    const bytes = Buffer.from(String(text), 'utf8');
    const version = chooseVersion(bytes.length);
    if (!version) return null;
    const data = dataCodewords(bytes, version);
    const ecc = rsRemainder(data, rsDivisor(VERSIONS[version].ecc));
    return buildMatrix(version, data.concat(ecc));
}

// QR para terminal con medios bloques (cuadrado en consolas 1:2).
function qrTerminal(text, quiet) {
    const qr = qrMatrix(text);
    if (!qr) return '';
    const q = quiet === undefined ? 2 : quiet;
    const size = qr.size;
    const at = (x, y) => (x >= 0 && x < size && y >= 0 && y < size) && qr.modules[y][x];
    const lines = [];
    for (let y = -q; y < size + q; y += 2) {
        let line = '';
        for (let x = -q; x < size + q; x++) {
            const top = at(x, y), bot = at(x, y + 1);
            line += top && bot ? '\u2588' : top ? '\u2580' : bot ? '\u2584' : ' ';
        }
        lines.push(line);
    }
    return lines.join('\n');
}

// QR como SVG (para la web o para guardar).
function qrSvg(text, quiet) {
    const qr = qrMatrix(text);
    if (!qr) return '';
    const q = quiet === undefined ? 4 : quiet;
    const size = qr.size;
    let path = '';
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            if (qr.modules[y][x]) path += 'M' + (x + q) + ' ' + (y + q) + 'h1v1h-1z';
        }
    }
    const total = size + q * 2;
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + total + ' ' + total
        + '" shape-rendering="crispEdges"><rect width="' + total + '" height="' + total
        + '" fill="#fff"/><path d="' + path + '" fill="#000"/></svg>';
}

module.exports = { qrMatrix, qrTerminal, qrSvg };
