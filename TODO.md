# TODO — OpenBridge

Registro de lo pendiente del proyecto **OpenBridge** (`C:\Users\tamno\trabajos\openbridge`).

Proyecto nuevo e independiente: app + puente + túnel en Node, **sin hosting**.
Formato: `- [ ]` pendiente · `- [x]` hecho.

## Estado actual (hecho)

- CLI: `init`, `passwd` (`--user`), `users`
  (`list`/`add`/`remove`/`passwd`/`role`/`disable`/`enable`), `server`/`start`
  (segundo plano; `--stream`), `stop`, `status`, `qr`, `tunnel`, `logs`
  (`--follow`), `bridge` (`--api --token --id --name`), `import`, `reset`,
  `autostart install|remove`, `doctor`, `version`, `help`.
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
- Tests (`node --test`): **33/33** (smoke, auth/roles, API, QR, release, bridge
  end-to-end con opencode mockeado, CLI, `safeJoinWorkspace`, migración).
  CI Windows/Linux/macOS.
- Release privado (`scripts/release.mjs`): guard de dueño, semver/prerelease y dist-tags.
- Web: chat con streaming, adjuntar imagen, dictado por voz, plantillas de prompts,
  tokens/contexto y **costo**, archivos, **cambios** (git status/diff) con **revertir**,
  búsqueda global, sesiones de opencode y **autor** en cada mensaje.
- `docs/ARCHITECTURE.md`, `CHANGELOG.md`, `AGENTS.md`, README, LICENSE, `.gitignore`.

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
- [x] Ver **tokens consumidos y capacidad de contexto** por sesion (sidebar, encabezado, statusbar y franja de trabajo).
- [x] Indicador **KITT** con bordes y estela luminosa.
- [x] **Dictado por voz** en el compositor (Web Speech API; se oculta si el navegador no la soporta).
- [x] **QR** de la URL en `init`/`status`/`server` y comando `openbridge qr` (generador propio, sin dependencias).
- [x] **Costo acumulado** (USD) por sesion y total en el sidebar, encabezado y statusbar.
- [x] Vista **"cambios"** (git status + diff) del proyecto de la sesion, via el puente (funciona local y remoto).
- [x] Boton **revertir** cambios rastreados desde la vista "cambios" (con confirmacion; no toca archivos nuevos).
- [x] **Plantillas de prompts** guardadas en el navegador (insertar/borrar/guardar lo escrito).
- [x] **Multiusuario** con roles `admin`/`user`: login usuario+contrasena, CLI `users`, gate server-side y **autor** en cada mensaje.

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

## 3. CLI / ciclo de vida

- [x] **`autostart install|remove`** multiplataforma (Windows/Linux/macOS).
- [x] **`server`** corre en segundo plano por defecto (muestra el status al levantar); `--stream` para primer plano.
- [x] Chequear **instancia ya corriendo** al hacer `server` (no arranca otra; muestra el estado).
- [x] **`stop` robusto**: mata el árbol completo (Windows `taskkill /T`; POSIX grupo detached).
- [x] **`passwd`**: cambia la contraseña y detiene el server en ejecución.
- [x] `init --force`/`passwd` detienen el server antes de reescribir la config.
- [x] `openbridge update` (auto-actualización): compara con npm y con `--yes` corre `npm i -g`.

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
