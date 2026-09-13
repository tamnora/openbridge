#!/usr/bin/env node
'use strict';

// Release privado de OpenBridge: sube version, changelog, commit, tag y push a
// GitHub, y publica en npm. Solo el dueño (con sus credenciales) puede correrlo:
// el guard verifica `npm whoami` y el remoto de git antes de tocar nada.
//
// Uso:
//   node scripts/release.mjs <patch|minor|major|prerelease|X.Y.Z[-pre]> [opciones]
//   npm run release -- minor
//
// Opciones:
//   --preid <id>     identificador de prerelease (default: beta)
//   --tag <name>     dist-tag de npm (default: el del prerelease, o latest)
//   --notes "<txt>"  notas del changelog (default: commits desde el ultimo tag)
//   --dry-run, -n    muestra el plan sin escribir, commitear ni publicar
//   --skip-tests     no corre npm test
//   --no-push        commitea y taggea local, sin push a GitHub
//   --yes, -y        no pide confirmacion
//   --help, -h       ayuda

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import readline from 'node:readline';

const isWin = process.platform === 'win32';
const NPM = isWin ? 'npm.cmd' : 'npm';
const GH = isWin ? 'gh.exe' : 'gh';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = path.join(root, 'package.json');
const changelogPath = path.join(root, 'CHANGELOG.md');

function fail(msg) {
    console.error('\n  error: ' + msg);
    process.exit(1);
}

function run(cmd, args, { capture = false } = {}) {
    // En Windows los .cmd (npm) requieren shell; git/gh son .exe y no.
    const shell = isWin && /\.(cmd|bat)$/i.test(cmd);
    try {
        return execFileSync(cmd, args, {
            cwd: root,
            encoding: 'utf8',
            shell,
            stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
        });
    } catch (e) {
        if (capture) {
            const err = (e.stderr || e.message || '').toString().trim();
            const out = (e.stdout || '').toString().trim();
            fail('fallo `' + cmd + ' ' + args.join(' ') + '`' + (err || out ? ': ' + (err || out) : ''));
        }
        fail('fallo `' + cmd + ' ' + args.join(' ') + '`');
    }
}

function git(args, opts) {
    return run('git', args, opts);
}

function readPkg() {
    return JSON.parse(readFileSync(pkgPath, 'utf8'));
}

export function parseVersion(v) {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?(?:\+[0-9A-Za-z-.]+)?$/.exec(String(v).trim());
    if (!m) return null;
    return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || null };
}

export function bumpPre(pre, preid) {
    if (!pre) return preid + '.0';
    const parts = pre.split('.');
    const last = parts[parts.length - 1];
    if (/^\d+$/.test(last)) {
        parts[parts.length - 1] = String(Number(last) + 1);
        return parts.join('.');
    }
    return pre + '.0';
}

export function computeVersion(current, spec, preid) {
    const cur = parseVersion(current);
    if (!cur) fail('version actual invalida en package.json: ' + current);
    if (spec === 'patch') return cur.major + '.' + cur.minor + '.' + (cur.patch + 1);
    if (spec === 'minor') return cur.major + '.' + (cur.minor + 1) + '.0';
    if (spec === 'major') return (cur.major + 1) + '.0.0';
    if (spec === 'prerelease' || spec === 'pre') {
        const base = cur.pre ? cur : { major: cur.major, minor: cur.minor, patch: cur.patch + 1, pre: null };
        return base.major + '.' + base.minor + '.' + base.patch + '-' + bumpPre(cur.pre, preid);
    }
    const explicit = parseVersion(spec);
    if (explicit) return spec;
    fail('version o bump invalido: `' + spec + '` (usar patch|minor|major|prerelease|X.Y.Z[-pre])');
}

export function distTagFor(version, override) {
    if (override) return override;
    const v = parseVersion(version);
    if (v && v.pre) return v.pre.split('.')[0];
    return 'latest';
}

function changelogNotes() {
    let last = null;
    try {
        last = execFileSync('git', ['describe', '--tags', '--abbrev=0'], { cwd: root, encoding: 'utf8' }).trim();
    } catch (e) { /* sin tags todavia */ }
    const range = last ? last + '..HEAD' : 'HEAD';
    let out = '';
    try {
        out = execFileSync('git', ['log', range, '--pretty=format:%s', '--no-merges'], { cwd: root, encoding: 'utf8' });
    } catch (e) { out = ''; }
    const lines = out.split('\n').map((s) => s.trim())
        .filter((s) => s && !/^chore\(release\)/i.test(s));
    if (!lines.length) return '- (sin cambios registrados)';
    return lines.map((s) => '- ' + s).join('\n');
}

export function renderChangelog(cl, version, notes, date) {
    const day = date || new Date().toISOString().slice(0, 10);
    const section = '## [' + version + '] - ' + day + '\n\n### Cambios\n\n' + notes + '\n';
    // Inserta antes del primer `## [x.y.z]`, saltando un `## [Unreleased]`.
    const marker = /\n## \[(?!Unreleased\])/;
    const m = marker.exec(cl);
    if (!m) return cl.replace(/\s*$/, '') + '\n\n' + section;
    return cl.slice(0, m.index + 1) + section + '\n' + cl.slice(m.index + 1);
}

function insertChangelog(version, notes) {
    const cl = readFileSync(changelogPath, 'utf8');
    writeFileSync(changelogPath, renderChangelog(cl, version, notes));
}

function parseArgs(argv) {
    const o = {
        bump: null, preid: 'beta', tag: null, notes: null,
        dryRun: false, yes: false, skipTests: false, noPush: false, help: false
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run' || a === '-n') o.dryRun = true;
        else if (a === '--yes' || a === '-y') o.yes = true;
        else if (a === '--skip-tests') o.skipTests = true;
        else if (a === '--no-push') o.noPush = true;
        else if (a === '--help' || a === '-h') o.help = true;
        else if (a === '--preid') o.preid = argv[++i];
        else if (a === '--tag') o.tag = argv[++i];
        else if (a === '--notes') o.notes = argv[++i];
        else if (a.startsWith('-')) fail('opcion desconocida: ' + a);
        else if (!o.bump) o.bump = a;
        else fail('sobra un argumento: ' + a);
    }
    return o;
}

function usage() {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8')
        .split('\n').filter((l) => l.startsWith('//')).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}

function confirm(question) {
    if (!process.stdin.isTTY) fail('sin terminal interactiva: usar --yes para confirmar');
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question + ' [s/N] ', (a) => {
            rl.close();
            resolve(/^(s|si|y|yes)$/i.test(a.trim()));
        });
    });
}

function guard(pkg) {
    const cfg = pkg.release || {};
    const owner = cfg.npmOwner || 'danieltmn';
    const remote = cfg.gitRemote || 'tamnora/openbridge';
    const branch = cfg.branch || 'master';

    let who = '';
    try {
        who = execFileSync(NPM, ['whoami'], {
            cwd: root, encoding: 'utf8', shell: isWin, stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
    } catch (e) {
        fail('no estas logueado en npm (`npm login`). Solo el dueno puede publicar.');
    }
    if (who !== owner) fail('estas como `' + who + '` en npm; el dueno es `' + owner + '`. Release abortado.');

    const url = git(['remote', 'get-url', 'origin'], { capture: true }).trim();
    if (!url.includes(remote)) fail('el remoto origin no es `' + remote + '` (es `' + url + '`). Release abortado.');

    if (cfg.gitOwner) {
        try {
            const login = execFileSync(GH, ['api', 'user', '--jq', '.login'], {
                cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
            }).trim();
            if (login && login !== cfg.gitOwner) {
                fail('estas como `' + login + '` en GitHub; se espera `' + cfg.gitOwner + '`. Release abortado.');
            }
        } catch (e) { /* gh no disponible: el push usara la clave SSH configurada */ }
    }

    return { owner, remote, branch };
}

async function main() {
    const o = parseArgs(process.argv.slice(2));
    if (o.help || !o.bump) { usage(); process.exit(o.bump ? 0 : 1); }

    const pkg = readPkg();
    const version = computeVersion(pkg.version, o.bump, o.preid);
    const tag = distTagFor(version, o.tag);
    const notes = o.notes != null ? o.notes : changelogNotes();

    console.log('\n  OpenBridge release');
    console.log('  ------------------');
    console.log('  version : ' + pkg.version + '  ->  ' + version);
    console.log('  dist-tag: ' + tag + (tag === 'latest' ? '  (produccion)' : '  (no pisa latest)'));
    console.log('  remoto  : origin (' + (pkg.release && pkg.release.gitRemote || 'tamnora/openbridge') + ')');
    console.log('  modo    : ' + (o.dryRun ? 'DRY-RUN (no escribe ni publica)' : 'real'));
    console.log('');

    const { branch } = guard(pkg);

    const dirty = git(['status', '--porcelain'], { capture: true }).trim();
    if (dirty) fail('el arbol de git no esta limpio; commitea o stashea antes de releasear.');

    const cur = git(['rev-parse', '--abbrev-ref', 'HEAD'], { capture: true }).trim();
    if (cur !== branch) fail('estas en la rama `' + cur + '`; el release va en `' + branch + '`.');

    if (!o.skipTests) {
        console.log('  > npm test');
        run(NPM, ['test']);
    }

    console.log('\n  changelog:');
    console.log(notes.split('\n').map((l) => '    ' + l).join('\n'));
    console.log('');

    if (o.dryRun) {
        console.log('  dry-run: nada cambió. Comandos que se ejecutarian:');
        console.log('    package.json: version -> ' + version);
        console.log('    CHANGELOG.md: nueva seccion [' + version + ']');
        console.log('    git add package.json CHANGELOG.md');
        console.log('    git commit -m "chore(release): v' + version + '"');
        console.log('    git tag -a v' + version + ' -m "v' + version + '"');
        if (!o.noPush) console.log('    git push origin ' + branch + ' --tags');
        console.log('    npm publish --tag ' + tag);
        console.log('');
        return;
    }

    if (!o.yes) {
        const ok = await confirm('  Confirmas publicar v' + version + ' (' + tag + ')?');
        if (!ok) fail('cancelado por el usuario.');
    }

    pkg.version = version;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    insertChangelog(version, notes);

    git(['add', 'package.json', 'CHANGELOG.md']);
    git(['commit', '-m', 'chore(release): v' + version]);
    git(['tag', '-a', 'v' + version, '-m', 'v' + version]);

    if (!o.noPush) {
        console.log('\n  > git push origin ' + branch + ' --tags');
        git(['push', 'origin', branch, '--tags']);
    } else {
        console.log('\n  (--no-push: commit y tag quedaron locales)');
    }

    console.log('\n  > npm publish --tag ' + tag);
    run(NPM, ['publish', '--tag', tag]);

    console.log('\n  listo: v' + version + ' publicado con tag `' + tag + '`.');
    if (tag !== 'latest') {
        console.log('  para promover a produccion: npm dist-tag add ' + pkg.name + '@' + version + ' latest');
    }
    console.log('');
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
    main().catch((e) => fail(e && e.message ? e.message : String(e)));
}
