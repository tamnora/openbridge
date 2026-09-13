# OpenBridge

[![npm](https://img.shields.io/npm/v/@danieltmn/openbridge.svg)](https://www.npmjs.com/package/@danieltmn/openbridge)
[![CI](https://github.com/tamnora/openbridge/actions/workflows/ci.yml/badge.svg)](https://github.com/tamnora/openbridge/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@danieltmn/openbridge.svg)](LICENSE)

Tu **opencode** en el celular, **sin hosting**: corre la app, el puente y un
túnel público desde tu PC. El celular entra por la URL del túnel y vos manejás
opencode (tus carpetas, modelos y chats) desde donde estés.

> Proyecto nuevo e independiente, portado a **Node** desde OpenConex (PHP).
> Ya no hace falta subir nada a un hosting ni depender de uno.

## Cómo funciona

```
[Celular] ──► URL del túnel ──► App Node en tu PC ──► .openbridge/data/ (JSON)
                                      │
                                      └──► bridge (Node) ──► opencode run
```

- **Un solo runtime: Node 18+.** La app web, la API, los datos y el puente viven
  en el mismo proceso/hogar.
- **opencode** es el único requisito externo (el motor que responde).
- **Túnel** con TunnelMole (gratis, sin cuenta), ngrok o Cloudflare para exponer
  la app a internet.

## Requisitos

- [Node.js](https://nodejs.org) 18 o superior.
- `opencode` instalado y autenticado: `npm i -g opencode-ai`.

## Instalación

```bash
# opción 1: sin instalar nada (npx)
npx @danieltmn/openbridge init      # asistente: workspace, contraseña, túnel, puerto
npx @danieltmn/openbridge server    # arranca en segundo plano y muestra el estado/URL

# opción 2: instalar global
npm i -g @danieltmn/openbridge
openbridge init
openbridge server
```

Al arrancar (queda en segundo plano) imprime el **estado con la URL pública**
(`https://….tunnelmole.net/chat.php`): abríla desde el celular y logueate con el
usuario (`admin`) y la contraseña que elegiste en `init`. Para correrlo en
primer plano usá `openbridge server --stream`; para detenerlo, `openbridge stop`.

### Opciones de `init`

```
--workspace <ruta>   carpeta de trabajo (donde están tus proyectos)
--name "PC 1"        nombre visible de esta computadora
--id pc1             identificador corto (default: derivado del nombre)
--port 8799          puerto local
--password <clave>   contraseña de acceso
--tunnel <prov>      tunnelmole | ngrok | cloudflare | none
--domain <host>      dominio fijo del túnel (ngrok)
--yes                sin preguntas (usa defaults)
--force              reconfigura aunque ya exista
--dir <ruta>         casa portable (default: directorio actual)
```

## Comandos

| Comando | Qué hace |
|---|---|
| `openbridge init` | Configura la casa (workspace, contraseña, túnel, puerto) |
| `openbridge passwd` | Cambia la contraseña de acceso (detiene el server si corre) |
| `openbridge server` | Arranca app + puente + túnel en **segundo plano** y muestra el estado (`--stream` = primer plano) |
| `openbridge stop` | Detiene el server y su árbol de procesos |
| `openbridge status` | Estado, URL, puente en línea y chats |
| `openbridge qr` | Muestra la URL (pública o local) como QR para escanear desde el celular |
| `openbridge tunnel` | Muestra o cambia el proveedor de túnel y su dominio fijo (`--domain`) |
| `openbridge logs` | Logs (`--follow`, `--server`, `--bridge`) |
| `openbridge bridge` | Corre **solo** el puente (`--api --token --id --name`) |
| `openbridge import` | Trae `data/` de OpenConex (`<data-dir> [--force]`) |
| `openbridge reset` | Borra chats/datos (`--session <id>`, `--yes`) |
| `openbridge autostart` | Arranque automático (`install`/`remove`) |
| `openbridge doctor` | Verifica Node, opencode, configuración y puerto |

## Casa portable

Todo vive dentro de **`.openbridge/`** en el directorio donde corrés `init`
(o `--dir` / `OPENBRIDGE_HOME`):

```
.openbridge/
  config.json    config del puente (apiUrl, token, workspace, bridgeId…)
  app.json       config de la app (usuario, contraseña, VAPID, puerto, túnel)
  folders.json   lista blanca de carpetas que se ven desde el celular
  data/          sesiones, mensajes, catálogo, registro de puentes, push
  logs/          server.log y bridge.log
```

Movés la carpeta a donde quieras y sigue funcionando (es portable). Si venías
de una versión anterior con los archivos sueltos, se **migran solos** a
`.openbridge/` la primera vez que corras un comando.

## Varias computadoras

El hub (la PC con la app) puede atender **varias PCs** a la vez:

- En la PC "hub": `openbridge init` + `openbridge server` (queda la app + túnel).
- En otra PC: `openbridge init` y luego `openbridge bridge --api <url-del-hub>
  --token <token> --id pc2 --name "PC 2"` (sin editar `config.json` a mano).

En el sidebar de la web elegís qué PC usar y ves sus proyectos y chats.

## Túnel y URL estable

Proveedores soportados (`--tunnel`): `tunnelmole` (gratis, sin cuenta),
`ngrok` (cuenta + authtoken; admite dominio fijo con `--domain` en
`app.json`) y `cloudflare` (quick tunnel de `cloudflared`). Con URL
**aleatoria**, la suscripción push no persiste entre reinicios (el push está
atado al origen). Para PWA/push estables conviene ngrok con dominio fijo o
Cloudflare con dominio propio.

## Avisos push

Las claves VAPID se generan solas en `init`. Con URL de túnel **aleatoria**, la
suscripción push no persiste entre reinicios (el push está atado al origen). Para
una URL fija hace falta un proveedor con dominio estable (ngrok/Cloudflare).

## Seguridad

- La app escucha solo en `127.0.0.1`; el túnel la expone.
- Login con contraseña (scrypt) + CSRF y rate limit (5 intentos); token del
  puente autogenerado.
- El túnel es **público mientras corre**: detenelo (`openbridge stop`) cuando no
  lo uses.

## Estado

Proyecto en desarrollo. Ya funciona: `init`, `server` (segundo plano; `--stream`
en primer plano), `stop`, `status`, `logs` (`--follow`), `bridge` (con flags),
`passwd`, `import`, `reset`, `autostart`, `doctor`, login con rate limit, API
completa, SSE, catálogo por PC, Web Push y túnel (TunnelMole/ngrok/cloudflare).
Tests en `npm test`. Pendiente: re-suscripción push al cambiar la URL y más
cobertura end-to-end.

## Licencia

MIT.
