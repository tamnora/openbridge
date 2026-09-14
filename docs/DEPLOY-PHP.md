# Hub PHP en cPanel (openbridge.tamnora.com)

OpenBridge puede correr su **hub** (la app web + API) en un hosting PHP, igual
que OpenConex, y dejar que cada PC corra **solo el puente** (`src/bridge/bridge.js`)
apuntando al hub. Ventajas: URL fija, web siempre arriba y Web Push/PWA estables,
sin tuneles ni puertos abiertos.

```
[Celular] --HTTPS--> openbridge.tamnora.com  (hub PHP en cPanel)
                        |  .openbridge/app.json + data/*.json
[PC]  openbridge bridge/pair  --long-poll-->  api.php  -->  opencode run
```

El hub PHP es un port de `src/web/routes.js` + `src/store` + `src/auth.js`. El
**frontend es el mismo** que el del hub Node (`src/web/assets` y `src/web/templates`):
`scripts/build-php-hub.mjs` lo copia, no se duplica.

## Requisitos

- cPanel con **PHP 8.x**.
- Extension **`sodium`** (recomendada). Si esta, el scrypt de las contrasenas es
  nativo (milisegundos). Si falta, el hub usa un scrypt puro en PHP que funciona
  igual pero tarda ~15 s por login: activala en *cPanel -> Select PHP Version ->
  Extensions*.
- Un subdominio (p. ej. `openbridge.tamnora.com`) con SSL (AutoSSL de cPanel).
- No hace falta Node ni base de datos en el hosting.

## 1. Armar y subir

En la PC:

```bash
node scripts/build-php-hub.mjs      # genera php/dist/ (backend + front compartido)
```

Subi el **contenido** de `php/dist/` a la carpeta del subdominio (en cPanel:
*File Manager* -> `public_html/openbridge` o el docroot del subdominio). Queda:

```
api.php  chat.php  login.php  logout.php  index.php  config.php  lib.php  hub.php
app.js  sw.js  manifest.webmanifest  themes/  icons/  templates/
.htaccess                 (deniega config/lib/hub y activa gzip sin SSE)
.openbridge/
  app.json                (usuarios, bridgeToken, csrfSecret, VAPID, baseUrl)
  .htaccess               (deniega el acceso web a los secretos y datos)
  data/                   (sesiones, mensajes, catalogos, bridges, pairings, push)
```

`data/` (dentro de `.openbridge/`) debe ser **escribible** (0755/0775).

## 2. Configurar `.openbridge/app.json`

Es el **mismo formato** que usa el hub Node (casa portable). Lo podes preparar en
la PC con `openbridge init` + `openbridge users ...` y subir el archivo, o editar
el de ejemplo (`.openbridge.example/app.json`, admin / `openbridge`).

- `baseUrl`: `https://openbridge.tamnora.com` (sin barra final; lo usa el push).
- `users[]`: `{ id, name, role, password:{algo:scrypt,salt,hash,keylen}, pv, disabled }`.
- `csrfSecret`: secreto de la cookie de sesion (32+ bytes random).
- `bridgeToken`: token global legacy (para el hub local / bootstrap). Las PCs
  emparejadas usan **token propio**.
- `vapid`: par P-256 en base64url (formato web-push). El hub lo convierte a PKCS#8
  solo; si esta vacio, los avisos push quedan desactivados.

## 3. Emparejar cada PC (por codigo)

En la PC:

```bash
openbridge pair https://openbridge.tamnora.com --name "PC 1"
```

La PC muestra un codigo (ej. `ABCD-EFGH`) y espera. En la web:

1. Logueate y anda a **Dispositivos -> Agregar PC**.
2. Ingresa el codigo.

La PC recibe su **token propio**, lo guarda en `.openbridge/config.json` y arranca
el puente. Para que arranque sola: `openbridge autostart install`.

El admin ve **todas** las PCs; cada usuario comun ve solo las suyas. Desde
**Dispositivos** se puede **desvincular** una PC (borra su token).

## 4. Datos

El hub arranca con `data/` vacio. El puente re-importa las sesiones del TUI de
opencode en su barrido, asi que el historial se va poblando solo. No subas un
`data/` de otra instalacion si ya hay historial.

## Notas y problemas

- **SSE/long-poll buffereados por el hosting**: el `.htaccess` excluye
  `text/event-stream` de gzip y el server manda `X-Accel-Buffering: no`. La app
  ademas cae a *polling* si no recibe `hello` en unos segundos.
- **Login lento**: falta `sodium`. Activala o cambia a un plan con esa extension.
- **`php -S` local**: sirve para probar, pero es mono-hilo (el long-poll bloquea).
  En el hosting real corre Apache/LiteSpeed con multiples workers.
- **Seguridad**: `.openbridge/` (secretos + datos) y `config.php`/`lib.php`/`hub.php`
  estan bloqueados por `.htaccess`. El hub escucha por HTTPS (cPanel) y usa cookies
  `Secure` detras del proxy.
