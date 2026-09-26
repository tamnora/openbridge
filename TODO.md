# TODO — OpenBridge

Registro de lo pendiente del proyecto **OpenBridge** (`C:\Users\tamno\trabajos\openbridge`).

Proyecto nuevo e independiente: app + puente + túnel en Node, **sin hosting**.
Formato: `- [ ]` pendiente · `- [x]` hecho.

## Estado actual (hecho)

- CLI: `init`, `passwd` (`--user`), `users`
  (`list`/`add`/`remove`/`passwd`/`role`/`disable`/`enable`), `server`/`start`
  (segundo plano; `--stream`), `stop`, `status`, `qr`, `tunnel`, `logs`
  (`--follow`), `bridge` (`--background`/`--stop`/`--status`), `join`, `pair`,
  `import`, `reset`, `autostart install|remove`, `doctor`, `version`, `help`.
- Casa portable (`paths.js`): todo en `<base>/.openbridge/` (`config.json`, `app.json`,
  `folders.json`, `data/`, `logs/`) con migración automática del layout viejo.
- Store (`src/store/`): port de `lib.php` con mutex por archivo y escritura atómica.
- Auth: cookie firmada, CSRF, remember-me, **multiusuario con roles `admin`/`user`**,
  rate limit por IP+usuario y token del puente (scrypt).
- Server web (`src/web/`): router + templates, estáticos y SSE; **CSP** y cabeceras
  de seguridad; logs reales a `logs/server.log`.
- API completa compatible con `app.js` y `bridge.js`.
- Push (`src/push.js`): VAPID + envío con `web-push`.
- Túnel (`src/tunnel/`): `tunnelmole`, **ngrok** y **cloudflare** tras interfaz común;
  `openbridge tunnel` y `init --domain`.
- QR propio (`src/qr.js`, sin dependencias): en `init`/`status`/`server` y `openbridge qr`.
- `bridge.js` parametrizado para la casa portable, con overrides por entorno.
- Tests (`node --test`): **63/63** (smoke, auth/roles, API + SSE, QR, release, bridge
  end-to-end con opencode mockeado, CLI, store/import, `safeJoinWorkspace`,
  migración, hub PHP end-to-end con `php -S`). CI Windows/Linux/macOS.
- Release privado (`scripts/release.mjs`): guard de dueño, semver/prerelease y dist-tags.
- Web: chat con streaming, adjuntar imagen, dictado por voz, plantillas de prompts,
  tokens/contexto y **costo**, archivos, **cambios** (git status/diff) con **revertir**,
  búsqueda global, sesiones de opencode y **autor** en cada mensaje.
- Vista tipo TUI: los mensajes guardan sus `parts` (texto, razonamiento,
  tarjetas de tool colapsables) y se ven en vivo. Proxy sin historial en el
  hosting: el puente publica un indice liviano (`index_sync`) y la web pide el
  historial a opencode on demand (`session_history`). Modelos: favoritos y
  predeterminado por puente desde el hub (`models_update`). Sin autor por
  mensaje (etiquetas fijas usuario/agente).
- Web: **pestañas de sesiones abiertas** (persistidas en `localStorage`,
  cambia/cierra, punto de estado) y **markdown ampliado** (tablas con
  alineacion, autolinks, imagenes, listas anidadas y `- [ ]`, h5/h6, mejor
  espaciado). Las tool cards muestran el **diff** de las ediciones + ruta y
  duracion; cada turno su **duracion**; el medidor de contexto incluye tokens de
  **cache** en el detalle.
- `docs/ARCHITECTURE.md`, `CHANGELOG.md`, `AGENTS.md`, README, LICENSE, `.gitignore`.
- Hub en blanco por defecto: los proyectos se **conectan a mano** (vista
  `proyectos`); el puente solo publica el indice de las carpetas `active`,
  cortado a las ultimas `sessionIndexLimit` sesiones (default 4) por proyecto y
  **filtrado por carpeta** (`opencode session list` es global). **Ver mas
  sesiones** pide 4 mas por proyecto (`folder_more`, con el total por carpeta en
  el indice); el boton **quitar** desconecta y poda al instante. `index_sync`
  **poda** las importadas que ya no vienen, y `deploy:hub clean|reset
  --wipe-data` deja un marcador `.reset` para que el puente desconecte los
  proyectos.

---

## 1. Producto / UX

- [ ] **Probar end-to-end real con opencode desde el celular**: abrir la URL del túnel, loguearse,
      crear un chat en una carpeta, elegir modelo/agente, enviar y ver la respuesta.
- [x] **Password oculto al escribir** en `init`.
- [x] `init`: mostrar **credenciales y URL** en el resumen final.
- [x] `init`: el escaneo de carpetas ignora `.openbridge/` (y cualquier carpeta con punto).
- [x] `status` más rico: puente en línea, cantidad de sesiones, URL.
- [x] `logs --follow` y `logs --bridge`/`--server`.
- [x] Mensaje claro cuando el **puerto está ocupado**.
- [x] Guard de **Node < 18** con mensaje amigable.
- [x] ~~**Login solo con contrasena**~~: se volvio a **usuario + contrasena** al sumar multiusuario.
- [x] Ver **tokens consumidos y capacidad de contexto** por sesion (sidebar y barra de estado, solo la sesion activa; la franja de trabajo muestra el estado).
- [x] **Medidor de contexto** con color por nivel: verde <25%, amarillo <50%, naranja <75%, rojo >=75% (barra + % en la barra de estado; en movil solo el %).
- [x] Indicador **KITT** con bordes y estela luminosa; tambien como animacion de "cargando" (scanner con rejilla segmentada).
- [x] Ajustes de UI (movil): el nombre de la tool no se parte, iconos del header del mismo tamano, y header/footer sin repetir datos (header = titulo + proyecto; footer = consumo de la sesion activa).
- [x] **Dictado por voz** en el compositor (Web Speech API; se oculta si el navegador no la soporta).
- [x] **QR** de la URL en `init`/`status`/`server` y comando `openbridge qr` (generador propio, sin dependencias).
- [x] **Costo acumulado** (USD) por sesion en el sidebar y la barra de estado.
- [x] Vista **"cambios"** (git status + diff) del proyecto de la sesion, via el puente (funciona local y remoto).
- [x] Boton **revertir** cambios rastreados desde la vista "cambios" (con confirmacion; no toca archivos nuevos).
- [x] **Plantillas de prompts** guardadas en el navegador (insertar/borrar/guardar lo escrito).
- [x] **Streaming en vivo fiel**: el SSE emite `inflight` con cada parcial del puente (hub Node y PHP), el chat refresca a ~200 ms mientras corre, parciales cada 300 ms y firma de partes fiel (tools intermedias incluidas).
- [x] **Multiusuario** con roles `admin`/`user`: login usuario+contrasena, CLI `users`, gate server-side y **autor** en cada mensaje.

## 1b. Panel del proyecto y dev run (escritorio)

- [x] **Panel derecho** en escritorio (colapsable, con resizer): pestaña **estructura**
      (arbol de carpetas/archivos del proyecto de la sesion) y **preview** (iframe del
      dev server: `localhost`/LAN o la URL del tunel). Oculto en movil.
- [x] **Deteccion de dev run** por proyecto (`proc_detect` en el puente): mira
      `package.json` (scripts dev/start/serve/preview), `composer.json`/`artisan` y
      entrypoints PHP (`public/index.php`, `backend/public/index.php`, `index.php`),
      y devuelve chips de comandos en **procs**. El gestor Node se detecta por el
      campo `packageManager` y, si no, por el lockfile (`pnpm-lock.yaml`,
      `yarn.lock`, `bun.lockb`/`bun.lock`; default `npm`). Recuerda el ultimo
      comando por carpeta.
- [x] `processes.bins` en `bridge/config.json` (mapa nombre -> ruta, p. ej. `php` fuera
      del PATH) y `allow` con `php`/`python`/`composer` y `pnpm`/`yarn`/`bun` por defecto.
- [x] `processes.allow` con un default viejo (`npm`/`node`/`npx`, o el que sumo
      `php`/`python`/`composer`, o el que sumo `pnpm`/`yarn`) se actualiza solo al
      actualizar OpenBridge; los `allow` personalizados se respetan.
- [ ] Llevar el panel al movil (hoy es solo escritorio; se usan las vistas full `archivos`/`preview`).


## 2. Túnel y URL estable (PWA / Web Push)

- [ ] **URL fija**: TunnelMole da URL aleatoria por arranque → se rompe la PWA y las
      suscripciones Web Push (atadas al origen). Opciones:
  - [x] **ngrok** (implementado; requiere cuenta + authtoken; admite `--domain`).
  - [x] **Cloudflare** quick tunnel (`cloudflared`; falta dominio propio/named tunnel).
  - [ ] TunnelMole con subdominio pago, o autoalbergar `tunnelmole-service`.
- [x] Proveedores de túnel enchufables: `tunnelmole`, `ngrok`, `cloudflare`.
- [x] `openbridge tunnel` (estado/cambio de proveedor) y guardar el dominio en `app.json`; `init --domain`.
- [x] Re-suscripción push automática al reabrir la app en la URL nueva (`pushSync`).
- [x] `trust proxy` explícito: la cookie usa `Secure` con `X-Forwarded-Proto` solo desde loopback.

## 2c. Hub PHP (hosting)

- [x] Port del hub a PHP (`php/app`: api.php, lib.php, hub.php, paginas) con el
      mismo contrato `?action=...` y el frontend compartido (se copia en el build).
- [x] Auth multiusuario en PHP: scrypt compatible con Node (`sodium` + fallback
      puro), cookie `ob_session` firmada, roles, rate limit y CSP.
- [x] Emparejamiento por codigo (`openbridge pair`): device code, token por PC y
      dueño (`owner`) en `bridges.json`; vista **Dispositivos** (gateada por
      `features.pairing`); aislamiento entre usuarios (admin ve todo).
- [x] `scripts/build-php-hub.mjs` (arma `php/dist`) y `docs/DEPLOY-PHP.md`.
- [x] Analisis de seguridad y consumo del hosting (`docs/INFORME-HOSTING.md`) con
      `?action=diag`, log de requests lentos y `scripts/hub-budget.mjs`.
- [x] Performance/seguridad del hub PHP: SSE con firmas `mtime+size`, long-poll
      despertado por marca, `poll` sin escrituras ociosas, version de catalogo
      cacheada, cache por request (catalogo/puentes) y resumen de sesiones
      (`data/.preview.json`), cola de comandos acotada por bytes, aislamiento
      entre inquilinos (`respond`/`session_import`/`session_tokens`), remember-me
      con `pv` y push por dueno.
- [x] **Desplegar** en cPanel (subdominio + SSL, subir `php/dist`, `data/` 0755/0775).
      El hub corre en `https://openbridge.tamnora.com`.
- [x] Deploy automatizado por FTPS (`scripts/deploy-php-hub.mjs`): `status`, `sync`,
      `push <archivos>`, `backup`/`restore`, `reset`, `prune`, `chmod`, `init`;
      subida por trozos con verificacion + rename (evita dejar archivos en 0 ante
      el `451` del hosting). Credenciales en `.deploy.env` (gitignored).
- [ ] Emparejar las PCs reales contra el hub y confirmar que el hosting tenga `sodium`.
- [ ] Backport del pairing/dueno al hub Node (paridad; hoy solo PHP).
- [ ] Backport al hub Node de las mejoras del informe (aislamiento en `respond`,
      push por dueno, remember con `pv`) para mantener paridad de comportamiento.

## 2d. Sincronizacion (historial unico)

- [x] Watcher de `opencode.db`/`-wal` para barrer a los segundos (no cada 15 min).
- [x] El barrido no se pierde si opencode esta ocupado (`sweepPending`).
- [x] Importar mensajes del TUI tambien en sesiones creadas desde la web.
- [x] Dedupe por `oc_msg` (id de mensaje de opencode) + adopcion del optimista
      de la web, en el hub PHP y Node.
- [x] Fix del `liteTimer` en `tick()`: el `ReferenceError` en el `finally`
      dejaba `busy=true` para siempre (barrido pausado) y filtraba intervalos de
      poll contra el hosting.
- [x] Marcador del barrido con fecha (evita colisiones `HH:MM` entre dias).
- [x] Sync manual desde la web: boton **sincronizar** por sesion (`session_sync`)
      y **sync total** admin (`session_sync_all`) con reconciliacion de bajas
      (`session_reconcile`), para recuperar hubs que perdieron datos.
- [ ] Validar en uso real la latencia TUI -> hub y el caso web+TUI.

## 3. CLI / ciclo de vida

- [x] **`autostart install|remove`** multiplataforma (Windows/Linux/macOS).
- [x] **`server`** corre en segundo plano por defecto (muestra el status al levantar); `--stream` para primer plano.
- [x] Chequear **instancia ya corriendo** al hacer `server` (no arranca otra; muestra el estado).
- [x] **`stop` robusto**: mata el árbol completo (Windows `taskkill /T`; POSIX grupo detached).
- [x] **`passwd`**: cambia la contraseña y detiene el server en ejecución.
- [x] `init --force`/`passwd` detienen el server antes de reescribir la config.
- [x] `openbridge update` (auto-actualización): compara con npm y con `--yes` corre `npm i -g`.
- [x] Un solo puente por casa: lock `.bridge.pid`; `server` detiene un puente
      suelto y arranca el suyo; `stop` cierra server + puente; `bridge --reload`
      (segundo plano) se niega si hay server; `status`/`doctor` avisan de
      duplicados y `monitor` muestra el estado en vivo.

## 4. Multi-PC (hub + remotas)

- [x] `openbridge bridge` con flags **`--api`, `--token`, `--id`, `--name`**.
- [x] Documentar el flujo hub/remoto en README con un ejemplo concreto.
- [ ] Probar el selector PC1/PC2 de la web con dos puentes reales contra el mismo hub.
- [x] `openbridge join <url>`: vincula una PC nueva al hub (persiste `apiUrl`/`apiToken`/`bridgeId` y arranca el puente).

## 5. Datos / migración

- [x] **`openbridge import <data-dir>`**: traer `data/` de OpenConex (PHP).
- [ ] Test de **ida y vuelta** del esquema contra la versión PHP (compatibilidad).
- [x] Comando para **resetear** (`reset --session <id>` / `reset --yes`).

## 6. Seguridad

- [x] **Rate limit / lockout** en login (5 intentos, 15 min **por IP+usuario**).
- [x] **Multiusuario** con roles `admin`/`user` y gate server-side de las acciones sensibles.
- [x] Advertir en la consola que el túnel es **público mientras corre**.
- [x] Revisar cookies (`HttpOnly`, `SameSite`, `Secure` detrás del túnel).
- [x] Bind solo a `127.0.0.1` (default) y no exponer LAN.
- [x] Cabeceras de seguridad (`CSP`, `nosniff`, `X-Frame-Options`, `Referrer-Policy`) y `Secure` solo desde loopback.
- [x] Test de `safeJoinWorkspace` (traversal, límite de profundidad).

## 7. Pruebas / calidad

- [x] Tests de rutas/API con `node:test` + `http` (login, sessions, send, bootstrap, CSRF).
- [x] Tests de auth (firma de cookie, expiración, CSRF, `pv`/disabled, rate limit por IP+usuario, token del puente).
- [x] Tests de **roles** (`user` recibe 403 al borrar/correr) y de **migración** del admin legado.
- [x] Tests del generador **QR** (ida y vuelta) y de la lógica de **release**.
- [x] Test de seguridad de `safeJoinWorkspace`.
- [x] Test end-to-end con opencode (mockeando el CLI): `test/bridge.test.js` corre el puente real contra un hosting y un `opencode` simulados.
- [x] `npm run lint` (`scripts/lint.mjs`: `node --check` sobre todo el JS; corre en CI).

## 8. Empaquetado / publicación

- [x] Completar `package.json`: `author`, `repository`, `homepage`, `keywords`, `bugs`.
- [x] Publicar en **npm** como `@danieltmn/openbridge` (`openbridge` a secas está bloqueado por similitud con `open-bridge`).
- [x] Crear repo en **GitHub** (`tamnora/openbridge`) y pushear.
- [x] `openbridge version`.
- [x] Proceso de **release privado** (`scripts/release.mjs`): bump semver/prerelease,
      changelog, commit, tag, push a GitHub y publish con dist-tag; guard de dueno.
- [x] CI (GitHub Actions): `npm test` en Windows/Linux/macOS.
- [x] `CHANGELOG.md` y guía de contribución (`CONTRIBUTING.md`).

## 9. Deuda técnica / detalles

- [x] Branding: claves internas `ocx_*` renombradas a `ob_*` con migración automática (localStorage y cookie de tema). Se mantienen como compatibilidad el env `OPENCONEX_HOME` y el bin `openconex` (deprecados).
- [x] Revisar `web/assets/sw.js` (nombre de caché, fallback offline) y `manifest.webmanifest` (id/lang).
- [x] Decisión sobre el comando `mode`: se mantiene como config del puente (`mode.txt`/`config.mode` con `local|remoto|dual`), sin comando CLI propio.
- [x] `docs/ARCHITECTURE.md` con arquitectura y decisiones.
- [x] Guardar todo en `<base>/.openbridge/` con migración automática del layout viejo.
- [x] Revisar manejo de errores del server (500) y logs: `server.js` responde 500 genérico y registra el stack; las respuestas >=400 se loguean.
- [ ] Unificar/limpiar comentarios y textos en español.

---

### Cómo probar en el celular (cuando haya workspace con carpetas)

1. En la PC: `openbridge init` (elegir workspace con proyectos) y `openbridge server`.
2. Copiar la **URL pública** del status (o escanear el QR) y abrirla en el celular.
3. Loguearse con **usuario y contraseña** (el admin creado en `init`).
4. Tocar **+ nueva sesión** → elegir carpeta, modelo y agente → escribir y enviar.
5. Ver la respuesta (streaming) y probar **detener**; opcional: instalar la PWA y activar 🔔.
