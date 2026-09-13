# Changelog

Todos los cambios relevantes de OpenBridge. Formato basado en
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y
[Versionado Semantico](https://semver.org/lang/es/).

## [0.2.0] - 2026-09-13

### Cambios

- web: muestra el costo acumulado por sesion y total
- cli: QR de la URL (init/status/server y comando qr)
- web: dictado por voz en el compositor (Web Speech API)
- release: exporta logica de version/changelog y agrega tests
- release: proceso privado con guard de dueno, semver y dist-tags
- UI: porcentaje de contexto, boton ver archivos y badge plan; refresco de tokens al responder

## [0.1.0] - 2026-09-11

Primera version publicada. Paquete npm **`@danieltmn/openbridge`** y repo
**`tamnora/openbridge`** en GitHub (el nombre `openbridge` a secas esta bloqueado
por npm por similitud con `open-bridge`).

### Agregado

- CLI: `init`, `passwd`, `server`, `stop`, `status`, `logs`, `bridge`, `import`,
  `reset`, `autostart`, `doctor`, `version`, `help`.
- Casa portable en `<base>/.openbridge/` (`config.json`, `app.json`,
  `folders.json`, `data/`, `logs/`), con **migracion automatica** del layout
  viejo.
- Store JSON (`src/store/`) con mutex por archivo y escritura atomica.
- Auth: cookie de sesion firmada, CSRF, remember-me, token del puente (scrypt) y
  **rate limit / lockout** de login (5 intentos, 15 min).
- Server web (`src/web/`): router, templates, estaticos, SSE y API completa
  compatible con `app.js`/`bridge.js`; logs reales a `logs/server.log`.
- Web Push (`src/push.js`): VAPID + `web-push`.
- Tuneles enchufables: `tunnelmole`, `ngrok` y `cloudflare`.
- `openbridge server` en segundo plano (muestra el estado al levantar);
  `--stream` para primer plano. `--detach` se mantiene como alias.
- `bridge --api --token --id --name` para apuntar a otro hub sin editar
  `config.json`.
- `import <data-dir>` (trae `data/` de OpenConex), `reset`
  (`--session <id>` / `--yes`) y `autostart install|remove` (Windows/Linux/macOS).
- `logs --follow`, `logs --server` y `logs --bridge`.
- Consumo de **tokens y capacidad de contexto** por sesion (sidebar, encabezado,
  statusbar y franja de trabajo); el puente sincroniza `models_ctx` desde
  `opencode models --verbose`.
- Indicador KITT con bordes y estela luminosa.
- Guard de Node < 18 con mensaje amigable.
- Tests con `node --test` (store, auth, API, `safeJoinWorkspace`, migracion) y
  CI en Windows/Linux/macOS.
- `docs/ARCHITECTURE.md`, `CHANGELOG.md`, `AGENTS.md`, README y LICENSE.

### Cambiado

- **Login solo con contrasena**: se quito el campo de usuario (es un unico
  `admin`).
- `init --force` y `passwd` detienen un server en ejecucion antes de reescribir
  la config, para no dejar la contrasena vieja en memoria.
- `init`: contrasena oculta al escribir, resumen con credenciales/URL, validacion
  del proveedor de tunel y exclusion de `.openbridge/` en el escaneo.
- `status`: muestra puente en linea y cantidad de chats.
- `stop`: mata el arbol completo de procesos (Windows `taskkill /T`; POSIX grupo
  detached).
- Mensaje claro cuando el puerto esta ocupado.

### Corregido

- El servidor ya no falla en silencio: los errores y los 4xx/5xx van a
  `logs/server.log`.
- Evita anidar `.openbridge/.openbridge` y valida la instancia ya corriendo.
