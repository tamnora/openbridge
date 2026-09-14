import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Arma `php/dist/` con el hub PHP + el frontend compartido del hub Node.
 *
 *   php/app/*.php        -> php/dist/*.php        (backend, a mano)
 *   src/web/assets/*     -> php/dist/*            (app.js, sw.js, themes, icons)
 *   src/web/templates/*  -> php/dist/templates/*  (chat.html, login.html)
 *
 * El front es UNA sola fuente (src/web) para que Node y PHP no diverjan.
 * `php/dist/` esta en .gitignore: se genera y se sube a cPanel.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDir = path.join(root, 'php', 'app');
const distDir = path.join(root, 'php', 'dist');
const assetsDir = path.join(root, 'src', 'web', 'assets');
const tplDir = path.join(root, 'src', 'web', 'templates');

function copyInto(src, dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
}

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

// Backend PHP (todo menos lo que se regenera).
for (const entry of fs.readdirSync(appDir)) {
    if (entry === 'assets' || entry === 'templates' || entry === '.openbridge.example' || entry === 'htaccess-deny') continue;
    copyInto(path.join(appDir, entry), path.join(distDir, entry));
}

// Frontend compartido.
for (const entry of fs.readdirSync(assetsDir)) {
    copyInto(path.join(assetsDir, entry), path.join(distDir, entry));
}
copyInto(tplDir, path.join(distDir, 'templates'));

// .openbridge de ejemplo si no hay uno real (config + data vacia), protegido
// por .htaccess (contiene secretos y datos).
const obHome = path.join(distDir, '.openbridge');
fs.mkdirSync(path.join(obHome, 'data'), { recursive: true });
fs.copyFileSync(path.join(appDir, 'htaccess-deny'), path.join(obHome, '.htaccess'));
if (!fs.existsSync(path.join(obHome, 'app.json'))) {
    fs.copyFileSync(path.join(appDir, '.openbridge.example', 'app.json'), path.join(obHome, 'app.json'));
}

console.log('php/dist listo en ' + distDir);
