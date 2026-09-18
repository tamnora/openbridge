# Informe: seguridad y consumo de recursos del hub PHP (hosting)

Fecha: 2026-09-17. Alcance: lo que se sube a cPanel desde `php/dist` (backend
`php/app/*.php` + frontend compartido) y su comportamiento en el hosting. Es un
**informe**; las correcciones se hacen despues.

Referencias de codigo: `php/app/api.php`, `php/app/lib.php`, `php/app/hub.php`,
`php/app/config.php`, `scripts/build-php-hub.mjs`, `src/web/assets/app.js`,
`src/bridge/bridge.js`.

---

## 1. Que se sube y cuanto pesa

`node scripts/build-php-hub.mjs` copia `php/app` (todo menos
`assets/templates/.openbridge.example/htaccess-deny`) y el front de
`src/web/assets` + `src/web/templates`.

Medido en `php/dist` (local, v0.7.1):

| Archivo | Peso |
|---|---|
| `app.js` | 203.3 KB |
| `templates/chat.html` | 82.0 KB |
| `lib.php` | 71.8 KB |
| `api.php` | 58.1 KB |
| iconos (8 PNG) | ~113 KB |
| `hub.php` | 24.1 KB |
| `templates/login.html` | 7.4 KB |
| `config.php` | 5.1 KB |
| `sw.js` | 3.1 KB |
| resto (temas, manifest, paginas, `.htaccess`) | ~7 KB |
| **Total** | **~561 KB** |

Nota: `.openbridge/app.json` y `data/` no se versionan (`php/dist` esta en
`.gitignore`), pero **si se suben** con secretos y datos reales.

---

## 2. Consumo de recursos

### 2.1 Datos locales de referencia

`<base>/.openbridge/data/` de esta maquina:

| Archivo | Peso |
|---|---|
| `messages-1.json` | 236.9 KB |
| `catalog-Notebook.json` | 64.6 KB |
| `messages-3.json` | 34.0 KB |
| `messages-2.json` | 5.3 KB |
| `sessions.json` | 1.3 KB |
| `bridges.json` | 0.2 KB |
| **Total** | **~342 KB** |

Con 3 sesiones y 1 puente. El peso crece de forma lineal con el historial (ver
2.6 y 2.7).

### 2.2 Costo por request web (sin SSE)

Cada `?action=catalog` / `bootstrap` / `sessions` hace **varias lecturas del
mismo archivo** y un `json_encode` completo:

- `catalog_read($file)` (`lib.php:986`) lee el catalogo.
- `catalog_version()` (`lib.php:928`) hace `md5(json_encode($cat))` de **todo**
  el catalogo.
- `bridges_summary()` (`lib.php:229`) llama `bridges_map()` y despues, por cada
  puente, `bridge_online_live()` y `bridge_busy_session()`, que vuelven a leer
  `bridges.json` (`bridge_registry_get` -> `bridges_map`). Es O(P^2) de lecturas.
- `bridge_live_overlay()` (`lib.php:267`) lee `bridges.json` otra vez.
- `bootstrap`/home ademas ejecuta `sessions_list_full()` (`lib.php:670`), que
  **lee cada `messages-*.json`** para calcular preview/estado.

Con 1 puente son ~5-6 lecturas de archivo + 1 encode completo por request; con
N sesiones se suman N lecturas de mensajes. El polling pasivo es cada 4 s
(`POLL_BASE_MS`, `app.js:129`) y el rapido cada 2.2 s (`POLL_FAST_MS`).

### 2.3 SSE: el costo mas alto del hosting

`?action=stream` (`api.php:1260`) mantiene un worker PHP **ocupado ~25 s**
(`$maxRuntime = 25`) y el cliente `EventSource` reconecta al cortar
(`app.js:4622`). Es decir: **una pestana abierta ocupa un worker de forma casi
continua** (25 s + reconexion).

Dentro del bucle, cada **500 ms** (`api.php:1365`):

- lee `bridges.json` completo (`api.php:1298`);
- recorre `glob(data/catalog*.json)` y **lee cada archivo completo** para sacar
  su md5 (`api.php:1318-1331`);
- lee `sessions.json` completo (`api.php:1332`);
- cada 1 s hace `glob(data/messages-*.json)` y `filemtime` de todos
  (`api.php:1349`).

= ~50 vueltas por conexion. Con 1 catalogo y 1 sesion son ~150-200 lecturas de
archivo por conexion, y hay una conexion nueva cada 25 s. El costo escala con el
**tamano** de los datos (lee catalogos enteros) y con el **numero de pestanas**.
En cPanel el limite de *entry processes* es acotado (tipico 20-30): ~20 pestanas
ociosas pueden agotar el pool y dejar la web sin workers.

El `.htaccess` excluye `text/event-stream` de gzip y el server manda
`X-Accel-Buffering: no`; si el hosting bufferea, `app.js` cae a polling
(`app.js:4581`), que es mas barato por request pero mucho mas frecuente.

### 2.4 Long-poll del puente: escrituras cada ~5 s

`?action=poll` (`api.php:573`) espera hasta 5 s (`waitMax` que manda el puente,
`bridge.js:2421`) y, en **cada** request:

- `bridge_registry_upsert()` (`api.php:581`) -> `bridges_modify` **escribe**
  `bridges.json` (mkdir + rename).
- `sessions_read()` y luego `sessions_save($sdata, $sfp)` **sin condicion**
  (`api.php:684`): reescribe `sessions.json` entero aunque no cambie nada.
- `claim_commands($file)` (`api.php:702`) -> `catalog_modify` **escribe** el
  catalogo del puente aunque no haya comandos.
- `poll_peek_work()` (`lib.php:1741`) lee `sessions.json` y **todos** los
  `messages-*.json` en cada vuelta de 500 ms durante la espera.

Con un puente son ~12 polls/min: ~24 reescrituras grandes/min (sesiones +
catalogo) mas `bridges.json`. El heartbeat cada 15 s agrega otra escritura
(`bridge.js:2588`). Es I/O constante incluso sin actividad.

### 2.5 Bloat del catalogo y de los mensajes

- `fs_result` acepta hasta **700 000** caracteres (`api.php:766`) y
  `prune_commands` conserva **60** comandos terminados (`lib.php:1720`):
  hasta ~42 MB de `catalog-<id>.json`. `proc_result` agrega hasta 100 000 por
  comando.
- `models_full` admite hasta 80 proveedores x 800 modelos (`api.php:379-382`),
  con ids de 160 chars: puede superar varios MB. `catalog_version` hace
  `json_encode` de todo eso en cada request.
- Imagenes: se guardan inline como dataURL de hasta **4 MB** en el mensaje
  (`api.php:300-308`), y `respond_partial` reescribe el archivo entero en cada
  parcial (`api.php:845`).
- `search_index` (`lib.php:1831`) lee todos los `messages-*.json` en cada
  busqueda, sin cache.

### 2.6 Crecimiento en disco (estimacion)

- Cada imagen adjunta suma hasta ~5.3 MB al JSON de su sesion (4 MB en base64 +
  overhead).
- Cada comando `fs_read` grande deja hasta 700 KB en el catalogo (x60).
- `messages-*.json` nunca se compacta ni rota.

### 2.7 Trafico y CPU diarios (orden de magnitud)

| Escenario | Requests/dia | Comentario |
|---|---|---|
| 1 pestana abierta con SSE | ~3 460 conexiones | Cada una ocupa un worker ~25 s: ~24 h de worker/dia |
| 1 pestana en polling (4 s) | ~21 600 | Cada request lee catalogo+puentes (+sesiones en home) |
| 1 puente (poll 5 s + heartbeat) | ~17 000 + ~5 800 | Con 2-3 reescrituras de JSON por poll |
| Login con `sodium` | ms por intento | OK (ver 3.2) |

---

## 3. Hallazgos de seguridad

### Alto

1. **Sin aislamiento de inquilinos en `respond` / `respond_partial`**
   (`api.php:849` y `api.php:794`). Validan el token del puente pero no que la
   sesion pertenezca a ese puente (`session_bridge($sess) === $bridge`). Un
   token de PC emparejada puede inyectar/editar respuestas assistant en sesiones
   de otro usuario adivinando `session_id` (ids incrementales). `cancel_status`
   solo lee.
2. **Remember-me no invalida por `pv`** (`hub.php:243-256`).
   `ob_remember_auto_login` no compara `pv`, asi que cambiar la contrasena
   (que sube `pv` y anula `ob_session`) **no** invalida la cookie `ob_remember`:
   una cookie robada sobrevive al cambio de clave.
3. **Push global y sin dueno** (`lib.php:1458` + `api.php:966`).
   `push_store` no guarda `owner` y `push_send` notifica a **todas** las
   suscripciones: un usuario recibe avisos de chats de otro (fuga de
   privacidad) y el POST sincrono (timeout 10 s por sub) alarga `respond`.
   `push_unsubscribe` tampoco valida dueno.
4. **Secretos y datos protegidos solo por `.htaccess`**
   (`php/app/htaccess-deny`, `php/app/.htaccess`). Con `AllowOverride None` en
   el hosting, los `.htaccess` se ignoran y `app.json` (con `csrfSecret` y
   `bridgeToken`) y `data/` quedan accesibles por web. El `csrfSecret` permite
   **falsificar la cookie de sesion** (entrar como admin).

### Medio

5. **Doze de CPU en login si falta `sodium`** (`hub.php:129-134`). Con la
   extension activa el scrypt nativo corre en ms; sin ella, el fallback puro
   tarda ~15 s por intento y el lock es por `ip|usuario` (`hub.php:264-294`),
   no global: rotando IPs se puede saturar el CPU. (En este hosting `sodium`
   esta activo, segun lo confirmado.)
6. **`session_import` / `session_tokens` buscan por `opencode_session` global**
   (`api.php:426`, `api.php:458`), sin filtrar por dueno: un puente puede
   reasignar carpeta/tokens de una sesion ajena si conoce el id.
7. **CSP permisiva** (`hub.php:555`): `script-src 'unsafe-inline'` y
   `frame-src http: https:`. Amplia la superficie ante XSS/clickjacking.
8. **Archivos de rate limit sin poda ni mutex**
   (`hub.php:272` `.login-lock.json`, `hub.php:533` `.pair-rate.json`): crecen
   con cada IP y el read-modify-write puede perder entradas por carreras.
9. **`browse` / `read_file` operan sobre el filesystem del hosting**
   (`api.php:973`, `api.php:987`) usando el `workspace` del catalogo (que es una
   ruta de la PC). No es explotable, pero no hace lo esperado en el hub remoto.

### Bajo / informativo

10. Cookies `SameSite=Lax` (no `Strict`) y sin rotacion de sesion adicional.
11. `ob_secure()` depende de `HTTPS` / `X-Forwarded-Proto` (correcto detras del
    proxy de cPanel, pero sin forzar HTTPS desde PHP).
12. Permisos de `data/` dependen del hosting; conviene 0600/0644 explicito.

---

## 4. Como medir el consumo (propuesta)

No hay instrumentacion hoy. Para tener numeros reales antes/despues:

1. **Endpoint admin `?action=diag`** (futuro, `api.php`): solo `admin`, que
   devuelva `memory_get_usage`/`peak`, `microtime`, `phpversion()`, si hay
   `sodium`, y un resumen de `data/` (tamano total y por archivo, cantidad de
   sesiones/mensajes/puentes/suscripciones y bytes de la cola de comandos).
2. **Log de requests lentos** a `data/.diag.log` con umbral (duracion/memoria) y
   rotacion, activable por `app.json.diag`.
3. **Script local `scripts/hub-budget.mjs`**: calcula el peso de `php/dist` y de
   un `data/` dado para estimar el presupuesto de subida y el crecimiento.
4. **Metricas del hosting**: en cPanel -> *Metrics* / *Resource Usage* mirar
   **Entry Processes**, **CPU**, **I/O** y **Physical Memory**. Comparar antes y
   despues de cerrar pestanas para confirmar el peso del SSE (2.3).
5. **Contadores rapidos por SSH/FTP**: `du -sh data`, `wc -c data/*.json`,
   `ls data/messages-*.json | wc -l`.

---

## 5. Priorizacion sugerida (para la etapa de correcciones)

| # | Tema | Impacto | Esfuerzo |
|---|---|---|---|
| 1 | Ownership en `respond`/`respond_partial` (seg. 1) | Alto | Bajo |
| 2 | `pv` en remember-me (seg. 2) | Alto | Bajo |
| 3 | Push por dueno + no bloqueante (seg. 3) | Alto | Medio |
| 4 | SSE: cache por mtime, intervalo mayor, limite por usuario (rec. 2.3) | Alto | Medio |
| 5 | Poll: no reescribir sin cambios; peek sin leer todo (rec. 2.4) | Alto | Medio |
| 6 | Topes por bytes en comandos y `models_full` (rec. 2.5) | Medio | Medio |
| 7 | Defensa en profundidad para `app.json`/`data` (seg. 4) | Alto | Medio |
| 8 | `?action=diag` + log de lentos (medicion) | Medio | Bajo |
| 9 | Rate limit global por IP + poda/mutex (seg. 5,8) | Medio | Bajo |
| 10 | CSP y permisos (seg. 7,12) | Bajo | Bajo |

## 6. Estado de las correcciones (aplicadas)

- **Seguridad**: ownership en `respond`/`respond_partial`/`cancel_status` y
  filtrado por dueno en `session_import`/`session_tokens` (seg. 1, 6);
  remember-me firma `pv` (seg. 2); push por dueno y postergado al cierre del
  request (seg. 3); rate limit con mutex, poda y limite global por IP (seg. 5,
  8). Queda pendiente la defensa en profundidad del docroot (seg. 4, requiere
  cambio de hosting) y la CSP (seg. 7, los templates usan `<script>` inline).
- **Performance**: SSE con firmas `mtime+size`, 1 s por vuelta y muestreo de
  mensajes cada 2 s (rec. 2.3); long-poll despertado por `data/.wake` en vez de
  releer todos los `messages-*.json` (rec. 2.4); `poll` sin reescribir
  `sessions.json`/catalogo/`bridges.json` si no cambio nada (rec. 2.4); version
  de catalogo cacheada en `catalog*.json.ver` (rec. 2.5); cola de comandos
  acotada por bytes (rec. 2.5); cache por request de catalogo/registro de puentes
  (evita el O(P^2) de `bridges_summary` y las relecturas de `catalog_read`) y
  cache persistente del resumen de sesiones en `data/.preview.json`, que evita
  releer todos los `messages-*.json` en cada `sessions`/`bootstrap` (rec. 2.2).
- **Medicion**: `?action=diag` + log de requests lentos + `scripts/hub-budget.mjs`
  (seccion 4, puntos 1-3).

## 7. Conclusion

Lo mas caro del hosting no es el peso de lo subido (~561 KB) sino el
comportamiento en ejecucion: **el SSE ocupa un worker casi continuo** y **el
long-poll del puente reescribe JSON cada ~5 s**, ambos con lecturas que crecen
con el tamano de `data/`. En seguridad, lo mas urgente es el **aislamiento entre
inquilinos en `respond`**, la **invalidacion del remember-me** y **no depender
solo de `.htaccess`** para los secretos.
