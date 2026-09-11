# Changelog

Todos los cambios relevantes de OpenBridge. Formato basado en
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y
[Versionado Semantico](https://semver.org/lang/es/).

## [No publicado]

### Agregado

- Comandos `import <data-dir>` (trae `data/` de OpenConex), `reset`
  (`--session <id>`, `--yes`) y `autostart install|remove`.
- `server --detach` para correr en segundo plano.
- `logs --follow`, `logs --server` y `logs --bridge`.
- `bridge --api --token --id --name` para apuntar a otro hub sin editar
  `config.json`.
- Proveedores de tunel `ngrok` y `cloudflare` (ademas de `tunnelmole`).
- Rate limit / lockout de login (5 intentos, 15 min).
- Guard de Node < 18 con mensaje amigable.
- `src/log.js` ahora escribe `logs/server.log` de verdad.
- Tests de auth, API y `safeJoinWorkspace`; CI en Windows/Linux/macOS.
- `docs/ARCHITECTURE.md`, `CHANGELOG.md` y `AGENTS.md`.
- Consumo de tokens y **capacidad de contexto** por sesion (el puente sincroniza
  `models_ctx` desde `opencode models --verbose`; el sidebar y el encabezado
  muestran `consumidos/capacidad`).
- Comando `passwd` (alias `password`) para cambiar la contrasena sin reconfigurar todo.

### Cambiado

- **Login solo con contrasena**: se quito el campo de usuario (es un unico
  `admin`); la pagina pide unicamente la contrasena.
- `init --force` y `passwd` **detienen un server en ejecucion** antes de
  reescribir la config, para no dejar un proceso con la contrasena vieja en
  memoria (causa de "Contrasena incorrecta" tras reconfigurar).
- `init`: contrasena oculta al escribir, resumen con credenciales/URL, y
  validacion del proveedor de tunel. El escaneo de carpetas excluye `data/` y
  `logs/` cuando el workspace es la propia casa.
- `status`: muestra puente en linea y cantidad de chats.
- `stop`: mata el arbol completo de procesos (hijos detached en POSIX).
- Mensaje claro cuando el puerto esta ocupado.
- `package.json` con `author`, `repository`, `homepage`, `bugs`, `keywords`.

### Corregido

- El servidor ya no falla en silencio: los errores y los 4xx/5xx van a
  `logs/server.log`.

## [0.1.0]

- Version inicial: CLI (`init`, `server`, `stop`, `status`, `logs`, `bridge`,
  `doctor`), casa portable, store JSON, auth, API, SSE, Web Push y tunel
  TunnelMole.
