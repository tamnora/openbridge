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
- Deploy del hub al hosting (solo el dueno): `npm run deploy:hub -- status|sync|push`.
  Credenciales en `.deploy.env` (gitignored). Ver mas abajo.

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
- Deploy del hub: `scripts/deploy-php-hub.mjs` (fuera del paquete npm) ·
  credenciales `.deploy.env` · manifiesto `.deploy-cache/` · backups `backups/`

## Reglas

- No commitear `.openbridge/` ni los archivos legacy (`config.json`, `app.json`,
  `data/`, `logs/`); estan en `.gitignore`.
- El frontend del hub PHP **se copia** desde `src/web/assets` y `src/web/templates`
  (no duplicar `app.js`/`chat.html`): editar en `src/web` y correr
  `node scripts/build-php-hub.mjs`. `php/dist/` esta en `.gitignore`.
- El deploy del hub **nunca** pisa `.openbridge/app.json` ni `.openbridge/data/**`
  del server salvo `--data`/`--data-all`. Subir siempre por trozos + verificar
  tamano + rename (el hosting aborta transferencias grandes con `451`).
- No commitear `.deploy.env`, `.deploy-cache/` ni `backups/` (gitignored).
- Mantener `TODO.md` y `CHANGELOG.md` al dia cuando cierres un pendiente.
- **Version del hub = version de `package.json`**: cada vez que se bumpea la
  version del paquete (release), rearmar `php/dist` con
  `node scripts/build-php-hub.mjs` (regenera `version.txt`) y **desplegar el hub**
  (`npm run deploy:hub -- sync`) para que el hosting muestre la misma version.
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

Al bumpear la version hay que actualizar **tambien el hub**: `build-php-hub`
regenera `php/dist/version.txt` desde `package.json`, asi que rearmar
(`node scripts/build-php-hub.mjs`) y desplegar (`npm run deploy:hub -- sync`)
para que el hosting muestre la version del paquete.

## Deploy del hub (privado)

`scripts/deploy-php-hub.mjs` (no se incluye en el paquete npm) sube `php/dist/`
al hosting por FTPS con `curl`, sin dependencias. Credenciales en `.deploy.env`
(gitignored; ver `.deploy.env.example`): `DEPLOY_HOST`, `DEPLOY_USER`,
`DEPLOY_PASS`, `DEPLOY_PROTOCOL=ftps`, `DEPLOY_PORT=21`, `DEPLOY_REMOTE=/`,
`DEPLOY_LOCAL=php/dist`, `DEPLOY_INSECURE=1`.

- `npm run deploy:hub -- status`: diferencias local vs server (no toca nada).
- `npm run deploy:hub -- sync`: sube nuevos, actualiza cambiados y borra
  obsoletos gestionados.
- `npm run deploy:hub -- push <archivo...>`: sube **solo** esos archivos
  (relativos a `php/dist`), ideal para probar un cambio puntual.
- `backup` / `restore <carpeta>`: baja o repone `.openbridge/app.json` +
  `.openbridge/data/**` (`backup --all` = docroot completo).
- `reset [--keep-data|--wipe-data] --yes`: backup, wipe total y re-sube.
- `prune`, `chmod`, `init`: limpieza, permisos y primer deploy.

Por defecto **no toca** `.openbridge/app.json` ni `.openbridge/data/**`; para
incluirlos usar `--data` (solo `app.json`) o `--data-all` (ademas `data/**`).
`clean --wipe-data` (o `reset --wipe-data`) vacia la data y deja un marcador
`.openbridge/data/.reset` para que el puente desconecte los proyectos y el hub
quede en blanco; `--no-reset-bridge` evita el marcador.
Flags globales: `--dry-run`, `--yes`, `--no-build`, `--host <h>`.

Cada archivo se sube **por trozos a un nombre temporal**, se verifica el tamano
y recien se renombra al destino: un `451` del hosting (que en transferencias
grandes dejaba el archivo en 0 bytes) no rompe el sitio. Ver `docs/DEPLOY-PHP.md`.
