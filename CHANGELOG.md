# Changelog

Todos los cambios relevantes de OpenBridge. Formato basado en
[Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y
[Versionado Semantico](https://semver.org/lang/es/).

## [Unreleased]

### Agregado

- **Medidor de contexto** de la sesion activa en la barra de estado: barra y `%`
  coloreados por nivel (verde <25%, amarillo <50%, naranja <75%, rojo >=75%).
  En movil se oculta la barra y queda solo el `%` coloreado.
- Animacion de **"cargando"** tipo KITT (rejilla segmentada + haz que rebota) en
  el chat, el diff y el arbol del panel; respeta `prefers-reduced-motion`.

### Cambiado

- Header mas limpio: solo **titulo + proyecto**. El modelo/agente, el consumo y
  el costo se movieron a la barra de estado para no repetir datos.
- La barra de estado muestra **solo la sesion activa**: se quito el texto
  `conectado` (queda el punto de estado) y los totales del proyecto (`N chats` y
  costo total).
- Iconos del header con el **mismo tamano** (34x34) y alineados; el nombre de la
  tool (`glob`, etc.) ya no se parte en pantallas angostas.

## [0.12.0] - 2026-09-19


### Agregado

- Hub en blanco por defecto: los proyectos se **conectan a mano** desde la
  vista **proyectos** del sidebar (admin). El puente solo publica el indice de
  las carpetas conectadas (`active` en `folders.json`), cortado a las
  `sessionIndexLimit` sesiones mas recientes (default 4) por proyecto, usando
  `opencode session list --format json` (agrupa por proyecto real).
- Comandos `folder_attach`/`folder_detach` (web -> puente) y acciones
  `folder_attach`/`folder_detach` en el hub. Crear un chat o una carpeta
  conecta el proyecto automaticamente.
- **Ver mas sesiones**: el home muestra las sesiones que el hub tiene del
  proyecto y el boton `Ver mas sesiones · N` pide 4 mas (comando `folder_more`,
  que sube el `limit` de esa carpeta en `folders.json` y republica el indice).
  El indice informa el total de sesiones por carpeta.
- Boton **quitar** en el encabezado de cada proyecto del sidebar: desconecta la
  carpeta y el hub poda al instante sus sesiones importadas.
- Marcador de reset (`.openbridge/data/.reset`): `deploy:hub clean|reset
  --wipe-data` lo escribe, el puente lo ve en el poll, desconecta los proyectos
  y confirma con `reset_ack` (`--no-reset-bridge` para omitirlo).

### Cambiado

- El indice filtra por carpeta: `opencode session list` es **global**, asi que
  el puente descarta las sesiones cuyo `directory` no es la carpeta conectada.
  Antes se colaban las sesiones mas recientes de todo el equipo.
- `index_sync` ahora **poda**: las sesiones importadas de un puente que ya no
  vienen en el indice se borran (con su historial), para que el sidebar refleje
  la PC y no acumule sesiones fantasma. Tambien usa el `updated` de opencode
  para `last_ts`.
- El catalogo guarda el flag `active` por carpeta (PHP y Node).
- Las sesiones importadas ya no muestran el menu de borrar (el sidebar es un
  espejo de los proyectos conectados; se ocultan desconectando el proyecto).

## [0.11.0] - 2026-09-19

### Cambios

- (sin cambios registrados)

## [0.10.0] - 2026-09-19


### Agregado

- Vista tipo TUI: las respuestas del agente se guardan y muestran con sus
  `parts` (texto, razonamiento y tarjetas de tool colapsables con animacion),
  en vivo durante la ejecucion.
- Proxy sin historial en el hosting: el puente publica un indice liviano de
  sesiones (`index_sync`) y la web pide el historial a opencode on demand
  (`session_history` + fetch efimero que se borra al consumir). El hub ya no
  guarda conversaciones: los mensajes salientes van a una cola transitoria
  (`queue-<puente>.json`) y el turno en curso a `inflight-<puente>.json`, que se
  limpian al terminar. La web compone historial (proxy) + cola + inflight.
- Gestion de modelos desde el hub: favoritos y modelo predeterminado por puente
  (`models_update`), con lista agrupada por proveedor.
- Se elimino el autor por mensaje; las etiquetas son fijas (usuario/agente).

### Cambiado

- El titulo de la sesion lo manda opencode (el nombre elegido en la web se pasa
  como `--title` en el primer `run`); el hub lo espeja.
- `/new` arranca un chat limpio, como en opencode.
- El puente captura `part.messageID` (antes leia `ev.messageID` y nunca
  publicaba el id del mensaje del agente).

### Corregido

- Importacion de sesiones de opencode: se normaliza el texto (comillas y
  preludio de adjunto) para que la adopcion no duplique los mensajes del usuario,
  y no se duplica la respuesta partida en pasos/tools.

## [0.9.0] - 2026-09-18


### Corregido

- Autostart en Windows: el acceso directo se generaba con `\"` (escapado de
  JSON) que PowerShell no parsea, asi que `autostart install` fallaba. Ahora usa
  literales validos.
- **Bug critico del puente**: `liteTimer` se declaraba dentro del `try` de
  `tick()` y se usaba en el `finally`; el `ReferenceError` resultante saltaba el
  `busy = false`, dejaba el barrido de sesiones pausado para siempre y filtraba
  intervalos de poll contra el hosting (de ahi los `fetch failed` y el costo/
  tokens congelados por sesion). Ahora se declara fuera del `try` y el cleanup
  corre siempre.
- Marcador del barrido normalizado con fecha: `opencode session list` muestra
  solo `HH:MM` para las sesiones de hoy, lo que hacia colisionar el marcador
  entre dias y salteaba reimportaciones.

### Agregado

- **Un solo puente garantizado**: `openbridge server` detiene cualquier puente
  suelto (de `bridge --background`/`--reload`/autostart) y arranca el suyo; un
  segundo `bridge` se rechaza por el lock. `openbridge stop` cierra **todo**
  (server + puente suelto), no solo el arbol del server.
- `openbridge monitor`: estado en vivo (server, puente, chats) que avisa si hay
  un puente duplicado (`--interval <s>`).
- `openbridge bridge --reload`: detiene el puente que este corriendo y arranca
  uno nuevo con el codigo/config actuales, sin `--stop` manual. Reinicia en
  **segundo plano** por defecto (usar `--foreground`/`--stream` para verlo).
- Sincronizacion manual desde la web: boton **sincronizar** en la sesion abierta
  (`session_sync`: fuerza el export/import y propaga el titulo de opencode) y
  **sync total** (solo admin, en la vista "sesiones opencode") que reimporta todo
  ignorando el estado local y reconcilia bajas (`session_sync_all` +
  `session_reconcile`). Con la PC como fuente de verdad, borra en el hub las
  sesiones importadas que ya no existen en la PC y cuya carpeta fue escaneada.
- Limpieza de `data/*.tmp` huerfanos al arrancar el server.

### Cambiado

- `openbridge status` ahora reporta el puente tambien en modo remoto (sin server
  local) y avisa si hay un puente extra; `openbridge doctor` verifica "puente
  unico". `bridge --reload` se niega si hay un server corriendo (el puente lo
  maneja el server) y sugiere `openbridge stop && openbridge server`.
- Autostart: en Windows lanza el puente detached (`bridge --background`) via un
  `.vbs` oculto, sin dejar consola abierta; en macOS/Linux sigue en primer plano
  porque launchd/systemd supervisan el proceso.
- `session_import` acepta `rename` (solo lo manda el sync forzado) para que el
  titulo de opencode pise el nombre del hub, salvo placeholders (`New session - ...`).

## [0.8.0] - 2026-09-18


### Agregado

- `scripts/deploy-php-hub.mjs`: deploy del hub PHP al hosting por FTPS con
  subida incremental (manifiesto con hash), `push <archivos>` para subir solo
  archivos puntuales, y comandos `status`, `backup`, `restore`, `reset`, `prune`,
  `chmod` e `init`. Credenciales en `.deploy.env` (gitignored).
- Subida blindada: cada archivo va por trozos a un nombre temporal, se verifica
  el tamano y recien se renombra al destino; un fallo del hosting (`451`) ya no
  deja el archivo en 0 bytes.
- Sidebar: la version que se muestra (antes `v3` fija) ahora sale de
  `package.json` (hub Node y hub PHP via `version.txt`).

### Corregido

- El `451` del hosting al subir por FTPS truncaba archivos grandes; la subida por
  trozos con verificacion y rename evita romper el sitio.

## [0.7.2] - 2026-09-18


### Agregado

- Hub PHP: `?action=diag` (solo admin) con memoria del request, si hay `sodium` y
  resumen de `data/` (tamano por archivo, sesiones, mensajes, puentes, suscripciones
  y bytes de la cola de comandos). Log de requests lentos en `data/.diag.log`
  (se activa con `app.json.diag=true` o `OPENBRIDGE_DIAG=1`).
- `scripts/hub-budget.mjs`: estima el peso de `php/dist` y de `data/` sin tocar el
  hosting. `docs/INFORME-HOSTING.md` con el analisis de seguridad y consumo.

### Corregido

- Hub PHP, aislamiento entre inquilinos: `respond`, `respond_partial`,
  `cancel_status`, `session_import` y `session_tokens` ahora exigen que la sesion
  pertenezca al puente que firma (o sea legacy sin dueno de su catalogo).
- Hub PHP: la cookie **remember-me** incluye `pv` en la firma, asi cambiar la
  contrasena invalida tambien el auto-login (antes sobrevivia).
- Hub PHP: el push guarda el **dueno** de cada suscripcion y solo avisa a quienes
  pueden ver ese puente; el envio se posterga al cierre del request
  (`fastcgi_finish_request` si esta) y se limita a 20 dispositivos.
- Hub PHP: rate limit con mutex y poda (`.login-lock.json`, `.pair-rate.json`) y
  limite global por IP en el login.

### Cambiado

- Hub PHP, performance: el SSE usa firmas `mtime+size` (no lee los JSON enteros),
  vuelve cada 1 s y muestrea mensajes cada 2 s; el long-poll del puente se despierta
  por una marca (`data/.wake`) en vez de releer todos los `messages-*.json` cada
  500 ms; `poll` no reescribe `sessions.json`/`catalogo` ni `bridges.json` si no
  cambio nada; la version del catalogo se cachea en disco (`catalog*.json.ver`); la
  cola de comandos se acota por bytes (tope 2 MB) ademas de por cantidad.
- Hub PHP, performance: cache por request del catalogo y del registro de puentes
  (antes `bridges_summary` los releia O(P^2)); y cache persistente del resumen de
  sesiones (`data/.preview.json`) para no releer todos los `messages-*.json` en
  cada `sessions`/`bootstrap` (el polling de la web cae ahi cada pocos segundos).
- Panel derecho: boton **abrir ↗** para abrir la vista previa en una pestana nueva,
  y el resizer de los paneles laterales con limites mas amplios.
- **procs**: boton **reconsultar** (busca los procesos de la app una vez al entrar y
  a demanda) y **detener todo** (corta todos los dev servers y cierra los tuneles).

## [0.7.1] - 2026-09-17


### Corregido

- `processes.allow` con el default viejo (`npm`/`node`/`npx`) se actualiza solo al
  actualizar OpenBridge, asi `php`/`python`/`composer` quedan permitidos sin editar
  la config a mano. Los `allow` personalizados se respetan.

## [0.7.0] - 2026-09-17


### Agregado

- **Panel del proyecto (escritorio)**: panel derecho colapsable con pestañas
  **estructura** (arbol de carpetas/archivos del proyecto de la sesion) y **preview**
  (iframe del dev server: `localhost`/LAN o la URL del tunel). Oculto en movil.
- **Dev run por proyecto**: el puente detecta como correrlo (`proc_detect`: scripts de
  `package.json`, `composer.json`/`artisan` y entrypoints PHP) y los muestra como chips
  en **procs**; recuerda el ultimo comando por carpeta. `processes.bins` permite mapear
  binarios fuera del PATH (p. ej. `php`) y `allow` suma `php`/`python`/`composer`.

### Cambiado

- CSP: se agrega `frame-src 'self' http: https:` para embeber la vista previa.

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
