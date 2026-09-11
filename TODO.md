# TODO — OpenBridge

Registro de lo pendiente del proyecto **OpenBridge** (`C:\Users\tamno\trabajos\openbridge`).

Proyecto nuevo e independiente: app + puente + túnel en Node, **sin hosting**.
Formato: `- [ ]` pendiente · `- [x]` hecho.

## Estado actual (hecho)

- CLI: `init`, `passwd`, `server`/`start` (segundo plano; `--stream` en primer
  plano), `stop`, `status`, `logs` (`--follow`), `bridge` (`--api --token --id --name`),
  `import`, `reset`, `autostart install|remove`, `doctor`, `version`, `help`.
- Casa portable (`paths.js`): todo en `<base>/.openbridge/` (`config.json`, `app.json`,
  `folders.json`, `data/`, `logs/`) con migración automática del layout viejo.
- Store (`src/store/`): port de `lib.php` con mutex por archivo y escritura atómica.
- Auth: cookie firmada, CSRF, remember-me, token del puente (scrypt), **rate limit de login**.
- Server web (`src/web/`): router + templates, estáticos y SSE; logs reales a `logs/server.log`.
- API completa compatible con `app.js` y `bridge.js`.
- Push (`src/push.js`): VAPID + envío con `web-push`.
- Túnel (`src/tunnel/`): `tunnelmole`, **ngrok** y **cloudflare** tras interfaz común.
- `bridge.js` parametrizado para la casa portable, con overrides por entorno.
- Tests (`node --test`): smoke, auth, API, `safeJoinWorkspace` y migración (15/15).
  CI Windows/Linux/macOS.
- `docs/ARCHITECTURE.md`, `CHANGELOG.md`, `AGENTS.md`, README, LICENSE, `.gitignore`.
- Verificado: `init`+`doctor`, `server` (segundo plano + status), login, `chat.php`,
  `bootstrap`, SSE por túnel real y `ping` público. Nombre npm `openbridge` **libre**.

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
- [x] **Login solo con contrasena** (sin campo de usuario).
- [x] Ver **tokens consumidos y capacidad de contexto** por sesion (sidebar, encabezado, statusbar y franja de trabajo).
- [x] Indicador **KITT** con bordes y estela luminosa.

## 2. Túnel y URL estable (PWA / Web Push)

- [ ] **URL fija**: TunnelMole da URL aleatoria por arranque → se rompe la PWA y las
      suscripciones Web Push (atadas al origen). Opciones:
  - [x] **ngrok** (implementado; requiere cuenta + authtoken; admite `--domain`).
  - [x] **Cloudflare** quick tunnel (`cloudflared`; falta dominio propio/named tunnel).
  - [ ] TunnelMole con subdominio pago, o autoalbergar `tunnelmole-service`.
- [x] Proveedores de túnel enchufables: `tunnelmole`, `ngrok`, `cloudflare`.
- [ ] `openbridge tunnel` (estado/cambio de proveedor) y guardar el dominio en `app.json`.
- [ ] Re-suscripción push automática cuando cambia la URL.
- [ ] `trust proxy` explícito (hoy `isSecure` mira `X-Forwarded-Proto` directo).

## 3. CLI / ciclo de vida

- [x] **`autostart install|remove`** multiplataforma (Windows/Linux/macOS).
- [x] **`server`** corre en segundo plano por defecto (muestra el status al levantar); `--stream` para primer plano.
- [x] Chequear **instancia ya corriendo** al hacer `server` (no arranca otra; muestra el estado).
- [x] **`stop` robusto**: mata el árbol completo (Windows `taskkill /T`; POSIX grupo detached).
- [x] **`passwd`**: cambia la contraseña y detiene el server en ejecución.
- [x] `init --force`/`passwd` detienen el server antes de reescribir la config.
- [ ] `openbridge update` (auto-actualización) — opcional.

## 4. Multi-PC (hub + remotas)

- [x] `openbridge bridge` con flags **`--api`, `--token`, `--id`, `--name`**.
- [ ] Documentar el flujo hub/remoto en README con un ejemplo concreto.
- [ ] Probar el selector PC1/PC2 de la web con dos puentes reales contra el mismo hub.
- [ ] Evaluar comando `openbridge join <url>` para vincular una PC nueva al hub.

## 5. Datos / migración

- [x] **`openbridge import <data-dir>`**: traer `data/` de OpenConex (PHP).
- [ ] Test de **ida y vuelta** del esquema contra la versión PHP (compatibilidad).
- [x] Comando para **resetear** (`reset --session <id>` / `reset --yes`).

## 6. Seguridad

- [x] **Rate limit / lockout** en login (5 intentos, 15 min).
- [x] Advertir en la consola que el túnel es **público mientras corre**.
- [x] Revisar cookies (`HttpOnly`, `SameSite`, `Secure` detrás del túnel).
- [x] Bind solo a `127.0.0.1` (default) y no exponer LAN.
- [x] Test de `safeJoinWorkspace` (traversal, límite de profundidad).

## 7. Pruebas / calidad

- [x] Tests de rutas/API con `node:test` + `http` (login, sessions, send, bootstrap, CSRF).
- [x] Tests de auth (firma de cookie, expiración, CSRF, rate limit, token del puente).
- [x] Test de seguridad de `safeJoinWorkspace`.
- [ ] Test end-to-end con opencode (mockeando el CLI).
- [ ] `npm run lint` (a definir; hoy no hay linter).

## 8. Empaquetado / publicación

- [x] Completar `package.json`: `author`, `repository`, `homepage`, `keywords`, `bugs`.
- [ ] Publicar en **npm público** como `openbridge` (nombre libre).
- [ ] Crear repo en **GitHub** (`tamnora/openbridge`) y pushear.
- [x] `openbridge version`.
- [x] CI (GitHub Actions): `npm test` en Windows/Linux/macOS.
- [x] `CHANGELOG.md` (falta guía de contribución).

## 9. Deuda técnica / detalles

- [ ] Branding: quedan claves `ocx_*`/`OPENCONEX_HOME` y el alias `openconex` (funcional; unificar a `ob_`/`openbridge`).
- [ ] Revisar `web/assets/sw.js` (nombre de caché, fallback offline) y `manifest.webmanifest`.
- [ ] Decidir si se mantiene el comando `mode` (local/remoto/dual) o se elimina.
- [x] `docs/ARCHITECTURE.md` con arquitectura y decisiones.
- [x] Guardar todo en `<base>/.openbridge/` con migración automática del layout viejo.
- [ ] Revisar manejo de errores del server (500) y logs.
- [ ] Unificar/limpiar comentarios y textos en español.

---

### Cómo probar en el celular (cuando haya workspace con carpetas)

1. En la PC: `openbridge init` (elegir workspace con proyectos) y `openbridge server`.
2. Copiar la **URL pública** del status y abrirla en el celular.
3. Loguearse con el usuario (`admin`) y la contraseña elegida en `init`.
4. Tocar **+ nueva sesión** → elegir carpeta, modelo y agente → escribir y enviar.
5. Ver la respuesta (streaming) y probar **detener**; opcional: instalar la PWA y activar 🔔.
