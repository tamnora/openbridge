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
(`https://….tunnelmole.net/chat.php`): abríla desde el celular y logueate con tu
usuario y contraseña. Para correrlo en primer plano usá
`openbridge server --stream`; para detenerlo, `openbridge stop`.

### Opciones de `init`

```
--workspace <ruta>   carpeta de trabajo (donde están tus proyectos)
--name "PC 1"        nombre visible de esta computadora
--id pc1             identificador corto (default: derivado del nombre)
--port 8799          puerto local
--password <clave>   contraseña del admin inicial
--user <nombre>      nombre del admin inicial (default: admin)
--tunnel <prov>      tunnelmole | ngrok | cloudflare | none
--domain <host>      dominio fijo del túnel (ngrok)
--yes                sin preguntas (usa defaults)
--force              reconfigura aunque ya exista
--dir <ruta>         casa portable (default: directorio actual)
```

## Actualizar

```bash
npm i -g @danieltmn/openbridge@latest     # o: npx @danieltmn/openbridge@latest …
```

La configuración y los datos en `.openbridge/` se **migran solos**: el layout
viejo (archivos sueltos) pasa a `.openbridge/`, y el `username`/`password` de una
instalación de un solo usuario se convierte en el **primer admin** de `users[]`
(con la misma contraseña). Por el cambio de formato de sesión, **hay que volver a
iniciar sesión** una vez; los chats, carpetas, túnel y push se conservan.

## Comandos

| Comando | Qué hace |
|---|---|
| `openbridge init` | Configura la casa (workspace, contraseña, túnel, puerto) |
| `openbridge passwd` | Cambia la contraseña de acceso (`--user <nombre>`; detiene el server si corre) |
| `openbridge users` | Usuarios y roles: `list`, `add`, `remove`, `passwd`, `role`, `disable`, `enable` |
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
  app.json       config de la app (usuarios, token, VAPID, puerto, túnel)
  folders.json   lista blanca de carpetas que se ven desde el celular
  data/          sesiones, mensajes, catálogo, registro de puentes, push
  logs/          server.log y bridge.log
```

Movés la carpeta a donde quieras y sigue funcionando (es portable). Si venías
de una versión anterior con los archivos sueltos, se **migran solos** a
`.openbridge/` la primera vez que corras un comando.

## Varias computadoras (hub + remotas)

La PC **hub** corre la app y el túnel; las demás PCs corren solo el **puente** y
apuntan al hub. En el sidebar de la web elegís qué PC usar y ves sus proyectos y
chats.

Ejemplo concreto:

1. En el **hub** (tiene la app y la URL pública):
   ```bash
   openbridge init
   openbridge server        # muestra estado, URL y QR
   openbridge status        # volvés a ver la URL cuando quieras
   ```
2. Copiá el **token del puente** del hub: `.openbridge/app.json` → `bridgeToken`.
3. En la **PC 2** (remota):
   ```bash
   openbridge init --tunnel none        # no necesita túnel propio
   openbridge bridge --api https://tu-url-publica/api.php \
     --token <bridgeToken> --id pc2 --name "PC 2"
   ```
4. Abrí la URL del hub desde el celular: en el sidebar aparecen **PC 1** y
   **PC 2** para alternar.

El puente remoto solo necesita salida a internet hacia el hub; no abre puertos ni
túnel propio. Para que arranque solo en cada PC: `openbridge autostart install`.

## Túnel y URL estable

Proveedores (`--tunnel` o `openbridge tunnel <prov>`): `tunnelmole` (gratis, sin
cuenta), `ngrok` (cuenta + authtoken; admite **dominio fijo**) y `cloudflare`
(quick tunnel). Ver/cambiar sin reconfigurar todo:

```bash
openbridge tunnel                                   # estado actual
openbridge tunnel ngrok --domain mi-pc.ngrok.app    # URL fija (recomendado)
openbridge stop && openbridge server                # reiniciar para aplicar
```

Con URL **aleatoria** la PWA y el push no persisten entre reinicios (están atados
al origen). Para una URL estable usá ngrok con dominio fijo (o un named tunnel de
Cloudflare). Escaneá el QR de `openbridge status`/`openbridge qr` para abrirla en
el celular.

## Avisos push

Las claves VAPID se generan solas en `init`. Con URL de túnel aleatoria la
suscripción no persiste entre reinicios (el push está atado al origen); la app la
vuelve a registrar cuando la abrís en la URL nueva. Para que sea estable, usá una
URL fija (ngrok con `--domain`).

## Seguridad

- La app escucha **solo en `127.0.0.1`**; el túnel la expone a internet.
- Login con **usuario y contraseña** (scrypt), cookie firmada `HttpOnly` +
  `SameSite=Lax`, **CSRF** y **rate limit** (5 intentos / 15 min por IP+usuario);
  token del puente autogenerado.
- La cookie usa `Secure` cuando el pedido llega por HTTPS **desde loopback** (el
  túnel); no se confía en `X-Forwarded-Proto` de otros orígenes.
- Respuestas con `Content-Security-Policy` (orígenes externos, frames y objetos
  bloqueados), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` y
  `Referrer-Policy: no-referrer`.
- El túnel es **público mientras corre**: detenelo (`openbridge stop`) cuando no
  lo uses y mantené la contraseña fuerte.

## Usuarios y roles

Cada persona entra con **usuario y contraseña**. Hay dos roles:

- **admin**: todo (crear/borrar chats, revertir cambios, procesos, túneles y
  administrar usuarios).
- **user**: chat, archivos, cambios y búsqueda; no puede borrar chats, revertir
  cambios ni correr procesos/túneles.

Se administran desde la PC con la CLI (los cambios requieren reiniciar el server):

```bash
openbridge users list
openbridge users add ana --role user --password <clave>
openbridge users passwd ana
openbridge users role ana admin
openbridge users disable ana      # enable para reactivar
openbridge users remove ana
openbridge passwd --user admin    # cambia la clave de un usuario
```

`init --user <nombre>` crea el admin inicial. La contraseña se guarda con scrypt,
y cambiar una clave **invalida las sesiones abiertas** de ese usuario. El último
admin no se puede borrar, degradar ni deshabilitar. Cada mensaje guarda **quién
lo envió** (se ve en el chat).

## Estado

Proyecto en desarrollo. Ya funciona: `init`, `server` (segundo plano; `--stream`
en primer plano), `stop`, `status`, `qr`, `tunnel`, `logs` (`--follow`), `bridge`
(con flags), `passwd`, `users`, `import`, `reset`, `autostart`, `doctor`; login
**multiusuario** con roles `admin`/`user` y rate limit; API completa y SSE;
catálogo por PC; Web Push; túnel (TunnelMole/ngrok/cloudflare); y en la web: chat
con streaming, adjuntar imagen, dictado por voz, plantillas de prompts,
tokens/contexto y **costo** por sesión, vista de archivos, vista de **cambios**
(git status/diff) con **revertir**, búsqueda global, sesiones de opencode y
**autor** en cada mensaje. Tests en `npm test` (28).

## Licencia

MIT.
