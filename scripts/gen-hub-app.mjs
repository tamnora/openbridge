import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import webpush from 'web-push';

/**
 * Genera un `.openbridge/app.json` listo para el hub PHP con secretos NUEVOS.
 *
 *   node scripts/gen-hub-app.mjs --base php/dist [--url https://...] [--password <clave>]
 *
 * Imprime la contrasena del admin. NO uses el app.json de ejemplo en produccion:
 * sus secretos estan en el repo publico y permiten falsificar la sesion.
 */

const args = process.argv.slice(2);
function flag(name, def) {
    const i = args.indexOf('--' + name);
    return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
}

const base = path.resolve(flag('base', process.cwd()));
const baseUrl = String(flag('url', '')).replace(/\/+$/, '');
const password = String(flag('password', '')) || crypto.randomBytes(9).toString('base64url');

const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(password, salt, 64).toString('hex');
const vapid = webpush.generateVAPIDKeys();

const app = {
    port: 8799,
    host: '127.0.0.1',
    baseUrl,
    users: [{
        id: 'u_admin',
        name: 'admin',
        role: 'admin',
        password: { algo: 'scrypt', salt, hash, keylen: 64 },
        pv: 1,
        created: '',
        disabled: false,
    }],
    csrfSecret: crypto.randomBytes(32).toString('base64url'),
    bridgeToken: crypto.randomBytes(32).toString('base64url'),
    vapid: { publicKey: vapid.publicKey, privateKey: vapid.privateKey },
    tunnel: { provider: 'none', domain: '' },
};

const home = path.join(base, '.openbridge');
fs.mkdirSync(path.join(home, 'data'), { recursive: true });
const file = path.join(home, 'app.json');
fs.writeFileSync(file, JSON.stringify(app, null, 2) + '\n');

console.log('app.json generado en ' + file);
console.log('  usuario    : admin');
console.log('  contrasena : ' + password);
if (!baseUrl) {
    console.log('  aviso      : sin --url; edita baseUrl en app.json (lo usa el push).');
}
console.log('  secreto CSRF y bridgeToken: nuevos (rotados).');
