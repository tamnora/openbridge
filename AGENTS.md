# AGENTS.md — OpenBridge

Guia para agentes que trabajen en este repo.

## Comandos

- Instalar deps: `npm install`
- Tests: `npm test` (usa `node --test`; debe pasar en Windows/Linux/macOS)
- Correr la app: `node bin/openbridge.js init --yes --dir <casa>` y
  `node bin/openbridge.js server --no-tunnel`
- Estado/logs: `node bin/openbridge.js status` / `logs --follow`

No hay linter todavia. Antes de cerrar un cambio, corre `npm test` y
`node --check` sobre los archivos JS tocados.

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
- Web: `src/web/server.js` (HTTP) · `src/web/routes.js` (API/paginas)
- Auth: `src/auth.js` · Store: `src/store/index.js`
- Tunel: `src/tunnel/index.js` · Push: `src/push.js`
- Puente: `src/bridge/bridge.js`
- Docs: `docs/ARCHITECTURE.md` · Pendientes: `TODO.md`

## Reglas

- No commitear `config.json`, `app.json`, `data/`, `logs/` (estan en
  `.gitignore`).
- Mantener `TODO.md` y `CHANGELOG.md` al dia cuando cierres un pendiente.
- No hacer commit ni push salvo que el usuario lo pida.
