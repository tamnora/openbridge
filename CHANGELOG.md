# Changelog

Todos los cambios relevantes de OpenBridge. Formato basado en
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y
[Versionado Semantico](https://semver.org/lang/es/).

## [0.6.4] - 2026-09-16

### Cambiado

- **Color por proyecto** en la lista de sesiones y en el sidebar (hash estable
  de la ruta) para distinguir los proyectos de un vistazo, y nombre un poco mas
  grande.

## [0.6.3] - 2026-09-15

### Agregado

- **Sincronizacion casi en tiempo real**: el puente vigila la base de opencode
  (`opencode.db`/`-wal`) y dispara un barrido tras ~8 s de calma, en vez de
  esperar 15 min (que queda como respaldo cada 3 min).

### Corregido

- El barrido ya **no se pierde** cuando opencode esta ocupado: se marca pendiente
  y corre al terminar el mensaje (antes se salteaba el tick entero).
- **Mensajes del TUI en sesiones web**: las sesiones vinculadas a la web ya no
  quedan solo con refresco de tokens; se importan los mensajes nuevos.
- **Sin duplicados**: el merge deduplica por el id de mensaje de opencode
  (`oc_msg`) y "adopta" el mensaje optimista que publico la web. Paridad en el
  hub Node (`store.sessionImport`) y en el PHP.

## [0.6.2] - 2026-09-14

### Corregido

- **Tunel en Windows**: los shims `.cmd` (p. ej. `tmole`) se lanzaban con doble
  cita (`cmd.exe /d /s /c "\"ruta\""`) y fallaban con "no se reconoce como un
  comando". Ahora se usa `windowsVerbatimArguments` y, si `tmole` falla, el
  puente **reintenta con `npx --yes tunnelmole`** (antes solo lo intentaba si
  `tmole` no estaba en el PATH). Timeout del tunel: 85 s.

## [0.6.1] - 2026-09-14

### Agregado

- `openbridge bridge --background` (segundo plano; sobrevive al cierre de la
  consola), `--stop` y `--status`. `openbridge pair`/`join` aceptan `--background`.

### Corregido

- `autostart` corre solo el puente cuando la PC pertenece a un hub remoto
  (`join`/`pair`), en vez del server local.

## [0.6.0] - 2026-09-14

### Agregado

- **Hub PHP** para correr la app en un hosting (cPanel) con URL fija, sin tunel
  (`php/app` + `scripts/build-php-hub.mjs`; comparte el frontend con el hub Node).
  Auth multiusuario con scrypt compatible con Node (usa `sodium`; si falta, scrypt
  puro en PHP), roles, cookie de sesion firmada, rate limit y CSP.
- **Emparejamiento por codigo** (`openbridge pair <url>`): la PC muestra un codigo,
  el usuario lo ingresa en la web (Dispositivos) y la PC recibe su **token propio**
  y revocable. Cada usuario ve solo sus PCs; el admin, todas.
- Comando `openbridge pair` y vista **Dispositivos** en la web (solo en el hub PHP,
  gateada por `features.pairing`).
- `docs/DEPLOY-PHP.md`: guia de despliegue del hub PHP.

## [0.5.2] - 2026-09-14

### Corregido

- Diagnostico de puerto ocupado: `status` y `server` muestran que **PID** usa el
  puerto (suele ser otra casa con otro `--dir`) y, si el arranque en segundo plano
  muere, se muestran las ultimas lineas de `server.log`.
- `store`: reintentos con backoff en el `rename` atomico (EPERM/EACCES/EBUSY en
  Windows) y limpieza del `.tmp` si no se puede.

## [0.5.1] - 2026-09-14

### Corregido

- `openbridge join` normaliza la URL del hub a `/api.php` (antes, pasar la base
  o `/chat.php` apuntaba a `/` y el puente se quedaba sin trabajo).

## [0.5.0] - 2026-09-14

### Agregado

- Comando `openbridge update` (compara con npm; `--yes` actualiza la instalacion
  global).
- Comando `openbridge join <url>` para sumar una PC como puente de un hub:
  persiste `apiUrl`/`apiToken`/`bridgeId` y arranca el puente (`--no-start` solo
  guarda).
- `npm run lint` (`scripts/lint.mjs`): `node --check` sobre todo el JS; corre en
  CI.
- Test end-to-end del puente con `opencode` mockeado (`test/bridge.test.js`) y
  tests del CLI (`test/cli.test.js`).
- **MCP**: vista en la web y comando de chat `/mcp` que muestran los servidores
  MCP de opencode y su estado (`opencode mcp list`); comando de puente
  `mcp_list`.
- `CONTRIBUTING.md`.

### Cambiado

- Claves internas `ocx_*` renombradas a `ob_*` con migracion automatica
  (localStorage y cookie de tema). Se mantienen como compatibilidad el env
  `OPENCONEX_HOME` y el bin `openconex` (deprecados).
- `config.command` puede apuntar a un script de Node (`.js`/`.mjs`/`.cjs`): se
  ejecuta con el `node` actual (wrappers propios y pruebas con CLI simulado).

## [0.4.0] - 2026-09-14

### Agregado

- **Multiusuario** con roles `admin`/`user`: login con usuario + contrasena,
  sesion ligada al usuario y a la version de contrasena, rate limit por
  IP+usuario, y comando CLI `users`
  (`list`/`add`/`remove`/`passwd`/`role`/`disable`/`enable`); `passwd --user`.
- Gate server-side: `session_delete` y los comandos mutantes del puente
  (procesos, tuneles, revertir) solo para `admin`; la web oculta esos controles.
- **Autor** en cada mensaje (auditoria) y muestra del usuario en el sidebar.
- **Content-Security-Policy** y `Secure` de cookie solo desde loopback
  (`trust proxy` explicito).

### Cambiado

- La sesion se invalida al cambiar la contrasena (`pv`); los usuarios
  deshabilitados no pueden entrar.
- `app.json` migra el `username`/`password` legado a `users[]`.

## [0.3.0] - 2026-09-13

### Cambios

- web: revertir un archivo puntual desde la vista cambios
- cli: comando tunnel (estado/cambio de proveedor y dominio fijo)
- web: plantillas de prompts y boton de revertir cambios
- web: vista de cambios del proyecto (git status/diff) via el puente
- release: recupera flags que npm se queda (--yes, --tag, --dry-run, --preid)

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
