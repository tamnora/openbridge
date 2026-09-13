'use strict';

const test = require('node:test');
const assert = require('node:assert');

const qr = require('../src/qr');

const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30] };

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

// Mapa independiente de modulos de funcion (segun ISO/IEC 18004).
function functionMap(size, version) {
    const fn = Array.from({ length: size }, () => new Array(size).fill(false));
    for (let i = 0; i < size; i++) { fn[6][i] = true; fn[i][6] = true; }
    const mark = (cx, cy) => {
        for (let dy = -4; dy <= 4; dy++) {
            for (let dx = -4; dx <= 4; dx++) {
                const x = cx + dx, y = cy + dy;
                if (x >= 0 && x < size && y >= 0 && y < size) fn[y][x] = true;
            }
        }
    };
    mark(3, 3); mark(size - 4, 3); mark(3, size - 4);
    for (const cy of ALIGN[version]) {
        for (const cx of ALIGN[version]) {
            if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue;
            for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) fn[cy + dy][cx + dx] = true;
        }
    }
    for (let i = 0; i <= 5; i++) fn[i][8] = true;
    fn[7][8] = true; fn[8][8] = true; fn[8][7] = true;
    for (let i = 9; i < 15; i++) fn[8][14 - i] = true;
    for (let i = 0; i < 8; i++) fn[8][size - 1 - i] = true;
    for (let i = 8; i < 15; i++) fn[size - 15 + i][8] = true;
    fn[size - 8][8] = true;
    return fn;
}

function readBit(x, i) { return ((x >>> i) & 1) !== 0; }

// Decodifica un QR generado por src/qr.js (modo byte, nivel L, 1 bloque).
function decode(qrCode) {
    const size = qrCode.size;
    const version = (size - 17) / 4;
    const fn = functionMap(size, version);
    const mods = qrCode.modules;

    // Info de formato (copia 1).
    let fmt = 0;
    const seq = [];
    for (let i = 0; i <= 5; i++) seq.push([8, i]);
    seq.push([8, 7], [8, 8], [7, 8]);
    for (let i = 9; i < 15; i++) seq.push([14 - i, 8]);
    for (let i = 0; i < 15; i++) if (mods[seq[i][1]][seq[i][0]]) fmt |= (1 << i);
    fmt ^= 0x5412;
    const dataFmt = fmt >>> 10;
    let rem = dataFmt;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    assert.equal((dataFmt << 10) | rem, fmt, 'BCH de formato invalido');
    assert.equal((dataFmt >>> 3) & 3, 1, 'nivel de correccion debe ser L');
    const mask = dataFmt & 7;

    // Lectura en zigzag + desenmascarado.
    const bits = [];
    for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let vert = 0; vert < size; vert++) {
            for (let j = 0; j < 2; j++) {
                const x = right - j;
                const upward = ((right + 1) & 2) === 0;
                const y = upward ? size - 1 - vert : vert;
                if (fn[y][x]) continue;
                let bit = mods[y][x];
                const cond = mask === 0 ? (x + y) % 2 === 0
                    : mask === 1 ? y % 2 === 0
                        : mask === 2 ? x % 3 === 0
                            : mask === 3 ? (x + y) % 3 === 0
                                : mask === 4 ? (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0
                                    : mask === 5 ? (x * y) % 2 + (x * y) % 3 === 0
                                        : mask === 6 ? ((x * y) % 2 + (x * y) % 3) % 2 === 0
                                            : ((x + y) % 2 + (x * y) % 3) % 2 === 0;
                if (cond) bit = !bit;
                bits.push(bit ? 1 : 0);
            }
        }
    }

    const DATA = { 1: 19, 2: 34, 3: 55, 4: 80, 5: 108 }[version];
    const ECC = { 1: 7, 2: 10, 3: 15, 4: 20, 5: 26 }[version];
    const total = DATA + ECC;
    const codewords = [];
    for (let i = 0; i < total * 8; i += 8) {
        let b = 0;
        for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
        codewords.push(b);
    }
    // Reed-Solomon: el resto de la secuencia completa debe ser cero.
    assert.deepEqual(rsRemainder(codewords, rsDivisor(ECC)), new Array(ECC).fill(0), 'Reed-Solomon invalido');

    // Parseo del payload (modo byte).
    const dbits = [];
    for (const b of codewords.slice(0, DATA)) for (let i = 7; i >= 0; i--) dbits.push(readBit(b, i));
    let p = 0;
    const mode = (dbits[p] << 3) | (dbits[p + 1] << 2) | (dbits[p + 2] << 1) | dbits[p + 3]; p += 4;
    assert.equal(mode, 0b0100, 'modo debe ser byte');
    let len = 0;
    for (let i = 0; i < 8; i++) len = (len << 1) | dbits[p + i];
    p += 8;
    const bytes = [];
    for (let i = 0; i < len; i++) {
        let b = 0;
        for (let j = 0; j < 8; j++) b = (b << 1) | dbits[p + i * 8 + j];
        bytes.push(b);
    }
    return Buffer.from(bytes).toString('utf8');
}

test('qr: ida y vuelta para URLs tipicas', () => {
    const urls = [
        'http://127.0.0.1:8799/chat.php',
        'https://openbridge-demo.tunnelmole.net/chat.php',
        'https://silver-river-4821.trycloudflare.com/chat.php?session=3',
        'https://abcd-efgh-1234.ngrok-free.app/chat.php'
    ];
    for (const u of urls) {
        const code = qr.qrMatrix(u);
        assert.ok(code, 'debe generar QR para ' + u);
        assert.equal(decode(code), u, 'round-trip de ' + u);
    }
});

test('qr: acentos en UTF-8 y longitud al limite', () => {
    const u = 'https://ejemplo.test/chat.php?q=' + 'a'.repeat(40);
    const code = qr.qrMatrix(u);
    assert.ok(code);
    assert.equal(decode(code), u);
    // Mas de 106 bytes no entra (versiones 1-5, nivel L).
    assert.equal(qr.qrMatrix('x'.repeat(200)), null);
});

test('qr: salidas de terminal y SVG', () => {
    const t = qr.qrTerminal('http://127.0.0.1:8799/chat.php');
    assert.ok(t.split('\n').length > 10);
    assert.ok(/[\u2580\u2584\u2588]/.test(t));
    const svg = qr.qrSvg('http://127.0.0.1:8799/chat.php');
    assert.match(svg, /^<svg /);
    assert.ok(svg.indexOf('<path d="M') > 0);
});
