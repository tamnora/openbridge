# Arquitectura de OpenBridge

## Vision general

```
[Celular] -- HTTPS --> [Tunel] --> [App Node: src/web] -- JSON --> [data/]
                                        |
                                        +--> [Puente: src/bridge] -- CLI --> [opencode]
```

Un unico runtime (**Node 18+**). La app web, la API y los datos viven en el
mismo proceso; el puente es un proceso hijo que ejecuta `opencode run` en las
carpetas del workspace. El tunel (TunnelMole/ngrok/cloudflared) expone la app
local a internet.

## Modulos

| Ruta | Responsabilidad |
|---|---|
| `bin/openbridge.js` | Entrada CLI + guard de Node. |
| `src/cli.js` | Comandos (`init`, `passwd`, `server`, `stop`, `status`, `logs`, `bridge`, `import`, `reset`, `autostart`, `doctor`). |
| `src/paths.js` | Casa portable: ubicacion de `config.json`, `app.json`, `data/`, `logs/`. |
| `src/config.js` | Lectura/escritura de config, hash scrypt, VAPID. |
| `src/auth.js` | Cookie de sesion firmada, CSRF, remember-me, rate limit, token del puente. |
| `src/log.js` | Log a consola + `logs/server.log`. |
| `src/push.js` | Web Push (VAPID + `web-push`). |
| `src/tunnel/` | Proveedores de tunel enchufables. |
| `src/web/server.js` | Servidor HTTP, estaticos, seguridad. |
| `src/web/routes.js` | Router de paginas y API (`?action=...`), compatible con `app.js`/`bridge.js`. |
| `src/web/assets/` | Frontend (`app.js`, temas, iconos, service worker, manifest). |
| `src/store/` | Store JSON con mutex por archivo y escritura atomica. |
| `src/bridge/bridge.js` | Puente: sincroniza catalogo, hace poll y ejecuta opencode. |

## Casa portable

Todo vive en el directorio de `init` (o `--dir` / `OPENBRIDGE_HOME`):

```
config.json    config del puente
app.json       config de la app (password, token, VAPID, puerto, tunel)
folders.json   lista blanca de carpetas
data/          sesiones, mensajes, catalogos por PC, registro de puentes, push
logs/          server.log, bridge.log
runtime.json   estado del server en ejecucion (pid, URL, hijos)
```

## Flujo de un mensaje

1. El celular envia `?action=send` (con CSRF) -> `src/web/routes.js`.
2. El mensaje queda `pending` en `data/messages-<id>.json`.
3. El puente hace `poll`, reclama el mensaje y corre
   `opencode run --model <m> [--session <id>]`.
4. La salida se publica con `respond_partial` (streaming) y `respond`.
5. El server empuja un Web Push y el celular refresca por SSE/poll.

## Multi-PC

El hub corre la app; cada PC corre `openbridge bridge` apuntando al hub
(`apiUrl` + `apiToken` + `bridgeId`). El catalogo se guarda por PC
(`data/catalog-<id>.json`) y el sidebar permite elegir que PC usar.

## Decisiones

- **Stateless sessions**: la cookie se firma con HMAC; no hay store de sesiones.
- **Escritura atomica + mutex**: `tmp` + `rename` y una cola por archivo evitan
  corrupciones con polls concurrentes.
- **Sin dependencias de framework**: HTTP nativo de Node; la unica dependencia
  es `web-push`.
- **Proveedores de tunel detras de una interfaz**: `startTunnel(port, provider)`
  devuelve `{ url, provider, pid, stop }`.
