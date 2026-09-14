# Arquitectura de OpenBridge

## Vision general

```
[Celular] -- HTTPS --> [Tunel] --> [App Node: src/web] -- JSON --> [.openbridge/data/]
                                        |
                                        +--> [Puente: src/bridge] -- CLI --> [opencode]
```

Un unico runtime (**Node 18+**). La app web, la API y los datos viven en el
mismo proceso; el puente es un proceso hijo que ejecuta `opencode run` en las
carpetas del workspace. El tunel (TunnelMole/ngrok/cloudflared) expone la app
local a internet. `openbridge server` arranca todo en segundo plano (y muestra
el estado); `--stream` lo deja en primer plano.

## Modulos

| Ruta | Responsabilidad |
|---|---|
| `bin/openbridge.js` | Entrada CLI + guard de Node. |
| `src/cli.js` | Comandos (`init`, `passwd`, `users`, `server`, `stop`, `status`, `qr`, `tunnel`, `logs`, `bridge`, `join`, `import`, `reset`, `autostart`, `doctor`, `update`). |
| `src/paths.js` | Casa portable: ubicacion de `config.json`, `app.json`, `data/`, `logs/`. |
| `src/config.js` | Lectura/escritura de config, hash scrypt, **usuarios/roles**, VAPID. |
| `src/auth.js` | Cookie de sesion firmada, CSRF, remember-me, **roles**, rate limit, token del puente. |
| `src/log.js` | Log a consola + `logs/server.log`. |
| `src/push.js` | Web Push (VAPID + `web-push`). |
| `src/qr.js` | Generador QR propio (terminal/SVG), sin dependencias. |
| `src/tunnel/` | Proveedores de tunel enchufables. |
| `src/web/server.js` | Servidor HTTP, estaticos, cabeceras de seguridad (CSP). |
| `src/web/routes.js` | Router de paginas y API (`?action=...`), gate de roles, compatible con `app.js`/`bridge.js`. |
| `src/web/assets/` | Frontend (`app.js`, temas, iconos, service worker, manifest). |
| `src/store/` | Store JSON con mutex por archivo y escritura atomica. |
| `src/bridge/bridge.js` | Puente: sincroniza catalogo, hace poll y ejecuta opencode; comandos fs/proc/tunel/git. |
| `scripts/release.mjs` | Release local (fuera del paquete npm): version, changelog, tag, push y publish. |

## Casa portable

La "base" es el directorio de `init` (o `--dir` / `OPENBRIDGE_HOME`). Todos los
archivos de OpenBridge viven dentro de `<base>/.openbridge/`:

```
config.json    config del puente
app.json       config de la app (password, token, VAPID, puerto, tunel)
folders.json   lista blanca de carpetas
data/          sesiones, mensajes, catalogos por PC, registro de puentes, push
logs/          server.log, bridge.log
runtime.json   estado del server en ejecucion (pid, URL, hijos)
```

`paths.migrate()` mueve automaticamente el layout viejo (archivos sueltos en la
base) a `.openbridge/`; `data/` y `logs/` solo se mueven si tienen marcas de
OpenBridge. La CLI pasa la **base** (`--dir`/cwd) al puente via
`OPENBRIDGE_HOME`, y el puente le agrega `.openbridge`.

## Flujo de un mensaje

1. El celular envia `?action=send` (con CSRF) -> `src/web/routes.js`; el mensaje
   se guarda con el **autor** de la sesion.
2. El mensaje queda `pending` en `data/messages-<id>.json`.
3. El puente hace `poll`, reclama el mensaje y corre
   `opencode run --model <m> [--session <id>]`.
4. La salida se publica con `respond_partial` (streaming) y `respond`.
5. El server empuja un Web Push y el celular refresca por SSE/poll.

## Multi-PC

El hub corre la app; cada PC corre `openbridge bridge` (o `openbridge join <url>`,
que persiste `apiUrl` + `apiToken` + `bridgeId`) apuntando al hub. El catalogo se
guarda por PC (`data/catalog-<id>.json`) y el sidebar permite elegir que PC usar.

`config.command` es el CLI a ejecutar (default `opencode`). Si apunta a un script
de Node (`.js`/`.mjs`/`.cjs`) el puente lo corre con el `node` actual, lo que
permite wrappers propios y las pruebas con un opencode simulado.

## Usuarios y roles

`app.json` guarda `users[]` (`id`, `name`, `role`, `password` scrypt, `pv`,
`disabled`). El modelo viejo de un `username`/`password` se migra solo a
`users[0]` (admin).

- La sesion (cookie firmada) guarda el `id` del usuario y su `pv`; el **rol se lee
  siempre del server** en cada request. Cambiar la contrasena sube `pv` e invalida
  las sesiones abiertas; un usuario `disabled` no entra.
- Roles: `admin` (todo) y `user` (chat/lectura). El gate es **server-side** en
  `routes.js`; la UI solo oculta los controles.
- Rate limit de login por IP+usuario y error generico (no filtra si el usuario
  existe; corre scrypt igual contra un hash dummy).
- Cada mensaje guarda `author` (quien lo envio); la respuesta hereda el autor del
  pedido.

## Comandos del puente

La web encola comandos (`?action=run_oc`) que el puente reclama por el poll y
resuelve (los resultados vuelven por `command_done`/`fs_result`). Sirve tanto en
local como en remoto:

- Lectura: `models`, `session_list`, `session_info`, `opencode_version`,
  `fs_list`, `fs_read`, `proc_list`, `proc_log`, `tunnel_list`, `git_status`,
  `git_diff`.
- Mutantes (solo `admin`): `proc_start`, `proc_stop`, `tunnel_start`,
  `tunnel_stop`, `git_checkout`.

Las rutas se validan contra el workspace (`procResolveFolder`/`resolveInWorkspace`)
y los argumentos con una whitelist (`OC_ALLOWED`).

## Decisiones

- **Stateless sessions**: la cookie se firma con HMAC; no hay store de sesiones.
  El `id`+`pv` del usuario van en el payload y el rol se resuelve en cada request.
- **Multiusuario con roles**: `admin`/`user`, gate server-side; el ultimo admin no
  se puede borrar, degradar ni deshabilitar.
- **Escritura atomica + mutex**: `tmp` + `rename` y una cola por archivo evitan
  corrupciones con polls concurrentes.
- **Sin dependencias de framework**: HTTP nativo de Node; la unica dependencia
  es `web-push`. El QR se genera con codigo propio (`src/qr.js`).
- **Cabeceras de seguridad**: CSP restrictiva; permite scripts/estilos inline
  porque los templates los usan.
- **Cola de comandos del puente**: un solo canal (poll) para fs, procesos,
  tuneles y git, valido igual en local y remoto.
- **Proveedores de tunel detras de una interfaz**: `startTunnel(port, provider)`
  devuelve `{ url, provider, pid, stop }`.
