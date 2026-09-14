# AGENTS.md — OpenBridge

Guia para agentes que trabajen en este repo.

## Comandos

- Instalar deps: `npm install`
- Tests: `npm test` (usa `node --test`; debe pasar en Windows/Linux/macOS)
- Lint: `npm run lint` (`node --check` sobre todo el JS; corre en CI)
- Correr la app: `node bin/openbridge.js init --yes --dir <casa>` y
  `node bin/openbridge.js server --no-tunnel` (segundo plano; `--stream` para
  primer plano). Detener: `node bin/openbridge.js stop --dir <casa>`
- Estado/logs: `node bin/openbridge.js status` / `logs --follow`
- Usuarios: `node bin/openbridge.js users list|add|remove|passwd|role|disable|enable`
  (roles `admin`/`user`; los cambios requieren reiniciar el server).
- Release (solo el dueno): `npm run release -- <patch|minor|major|prerelease|X.Y.Z>`
  (ver mas abajo).
- Hub PHP (opcional, para hosting): `node scripts/build-php-hub.mjs` arma
  `php/dist/` (backend + front compartido). Probar: `php -S 127.0.0.1:8799 -t php/dist`.

No hay linter con reglas todavia (`npm run lint` solo hace `node --check`).
Antes de cerrar un cambio, corre `npm test` y `npm run lint`.

## Convenciones

- **CommonJS**, `'use strict'` al inicio, 4 espacios, comillas simples.
- Comentarios y textos de usuario **en espanol, sin tildes** (el proyecto los
  evita por compatibilidad de consola).
- No agregar dependencias salvo que sea imprescindible; el runtime usa APIs
  nativas de Node.
- La API mantiene el contrato de la version PHP (`?action=...`) para no romper
  `src/web/assets/app.js` ni `src/bridge/bridge.js`.
- Escritura de datos siempre via `src/store` (mutex + escritura atomica).

## Mapa rapido

- CLI: `src/cli.js` (comandos) · `bin/openbridge.js` (entrada)
- Web: `src/web/server.js` (HTTP) · `src/web/routes.js` (API/paginas) ·
  `src/web/assets/app.js` (frontend) y `templates/`
- Auth: `src/auth.js` (sesion/roles) · Config y usuarios: `src/config.js`
- Store: `src/store/index.js` · QR: `src/qr.js`
- Tunel: `src/tunnel/index.js` · Push: `src/push.js`
- Puente: `src/bridge/bridge.js`
- Docs: `docs/ARCHITECTURE.md` · Pendientes: `TODO.md`
- Release (local): `scripts/release.mjs` (fuera del paquete npm)
- Hub PHP (hosting): `php/app/` (`api.php`, `lib.php`, `hub.php`) ·
  `scripts/build-php-hub.mjs` · `docs/DEPLOY-PHP.md`

## Reglas

- No commitear `.openbridge/` ni los archivos legacy (`config.json`, `app.json`,
  `data/`, `logs/`); estan en `.gitignore`.
- El frontend del hub PHP **se copia** desde `src/web/assets` y `src/web/templates`
  (no duplicar `app.js`/`chat.html`): editar en `src/web` y correr
  `node scripts/build-php-hub.mjs`. `php/dist/` esta en `.gitignore`.
- Mantener `TODO.md` y `CHANGELOG.md` al dia cuando cierres un pendiente.
- No hacer commit ni push salvo que el usuario lo pida.

## Release (privado)

El proceso vive en `scripts/release.mjs` (no se incluye en el paquete npm). Solo
el dueno puede correrlo: el guard exige `npm whoami` = `danieltmn`, remoto
`origin` = `tamnora/openbridge` y (si hay `gh`) la cuenta `tamnora`. Sin esas
credenciales aborta.

- `npm run release -- patch|minor|major`: version estable, publica con dist-tag
  `latest`.
- `npm run release -- prerelease`: genera `X.Y.Z-beta.N` y publica con tag
  `beta` (no pisa `latest`). `--preid next` cambia el identificador.
- `npm run release:dry -- minor`: muestra el plan sin escribir ni publicar.
- Version explicita: `npm run release -- 0.3.0`.
- Opciones: `--notes "..."`, `--tag <name>`, `--skip-tests`, `--no-push`,
  `--yes`.

Actualiza `package.json` y `CHANGELOG.md`, commitea `chore(release): vX.Y.Z`,
taggea `vX.Y.Z`, hace push a GitHub y publica en npm. Para promover un
prerelease a produccion:
`npm dist-tag add @danieltmn/openbridge@X.Y.Z latest`.
