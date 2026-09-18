<?php
require __DIR__ . '/config.php';
require_once __DIR__ . '/lib.php';

ob_security_headers();

$action = $_GET['action'] ?? '';

// Diagnostico: registra en data/.diag.log los requests lentos (duracion +
// memoria pico) para poder medir el consumo real del hosting. Se activa con
// app.json.diag=true o OPENBRIDGE_DIAG=1.
if (OB_DIAG) {
    $__ob_t0 = microtime(true);
    register_shutdown_function(function () use ($__ob_t0) {
        $ms = (int)round((microtime(true) - $__ob_t0) * 1000);
        if ($ms < DIAG_SLOW_MS) return;
        $line = gmdate('c') . ' action=' . preg_replace('/[^a-z_]/', '', strtolower((string)($_GET['action'] ?? '')))
            . ' ms=' . $ms
            . ' peak=' . memory_get_peak_usage(true)
            . ' ip=' . ($_SERVER['REMOTE_ADDR'] ?? '')
            . "\n";
        @file_put_contents(DIAG_LOG, $line, FILE_APPEND | LOCK_EX);
        clearstatcache(true, DIAG_LOG);
        if (@filesize(DIAG_LOG) > 262144) {
            $all = @file(DIAG_LOG, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
            if (is_array($all) && count($all) > 200) {
                @file_put_contents(DIAG_LOG, implode("\n", array_slice($all, -200)) . "\n", LOCK_EX);
            }
        }
    });
}

// Comprobación de salud (puede usarla el puente).
if ($action === 'ping') {
    json_response(['ok' => true, 'now' => gmdate('c')]);
}

// Diagnostico de consumo (solo admin): memoria del request, extensiones y
// resumen de `data/`. Sirve para saber cuanto ocupa/consume el hub.
if ($action === 'diag') {
    require_role(['admin']);
    $stats = ob_data_stats();
    json_response([
        'ok' => true,
        'php' => PHP_VERSION,
        'sodium' => function_exists('sodium_crypto_pwhash_scryptsalsa208sha256_ll'),
        'memory_bytes' => memory_get_usage(true),
        'memory_peak_bytes' => memory_get_peak_usage(true),
        'diag_log_bytes' => (int)@filesize(DIAG_LOG),
        'data' => $stats,
    ]);
}

// ---------------------------------------------------------------------------
// Catálogo / sesiones (web, requiere login).
// El catálogo es POR PUENTE: la web elige la PC (?bridge=<id>) y recibe sus
// carpetas/modelos/workspace. Con ?v=<versión> responde liviano si no cambió.
// ---------------------------------------------------------------------------
// Ultimo latido de un puente dentro del resumen ya leido (evita otra lectura
// de bridges.json en el camino "no cambio").
function bridges_summary_online_ts($live, $bridge) {
    foreach ((array)$live as $b) {
        if ((string)($b['id'] ?? '') === (string)$bridge) {
            return (string)($b['last_online_ts'] ?? '');
        }
    }
    return '';
}

if ($action === 'catalog') {
    require_login_readonly();
    $bridge = resolve_web_bridge();
    $file = bridge_catalog_file($bridge);
    $v = isset($_GET['v']) ? (string)$_GET['v'] : '';
    $live = bridges_summary();
    // Camino liviano: si la version coincide, responde sin leer ni re-encodear
    // el catalogo (clave para el polling cada pocos segundos).
    if ($v !== '') {
        $ver = catalog_version_cached($file);
        if (hash_equals($ver, $v)) {
            json_response(['ok' => true, 'changed' => false, 'cat_ver' => $ver, 'bridge' => $bridge, 'bridges' => $live, 'online_ts' => bridges_summary_online_ts($live, $bridge)]);
        }
    }
    $cat = catalog_read($file);
    $ver = catalog_version($cat);
    $outCat = bridge_live_overlay($cat, $bridge);
    json_response(['ok' => true, 'changed' => true, 'catalog' => $outCat, 'cat_ver' => $ver, 'bridge' => $bridge, 'bridges' => $live, 'online_ts' => $outCat['last_online_ts'] ?? '']);
}

// Todo lo que la app necesita al arrancar, en una sola llamada:
// catálogo del puente activo (si cambió respecto a ?v=) + sesiones + puentes.
if ($action === 'bootstrap') {
    require_login_readonly();
    $bridge = resolve_web_bridge();
    $file = bridge_catalog_file($bridge);
    $v = isset($_GET['v']) ? (string)$_GET['v'] : '';
    $live = bridges_summary();
    $ver = catalog_version_cached($file);
    $changed = !($v !== '' && hash_equals($ver, $v));
    $out = [
        'ok' => true,
        'changed' => $changed,
        'cat_ver' => $ver,
        'bridge' => $bridge,
        'bridges' => $live,
        'sessions' => sessions_list_full(),
        'features' => ['pairing' => true],
    ];
    if ($changed) {
        // Solo aca se lee el catalogo completo.
        $cat = catalog_read($file);
        $out['catalog'] = bridge_live_overlay($cat, $bridge);
        $out['online_ts'] = $out['catalog']['last_online_ts'] ?? '';
    } else {
        $out['online_ts'] = bridges_summary_online_ts($live, $bridge);
    }
    json_response($out);
}

if ($action === 'sessions') {
    require_login_readonly();
    json_response(['ok' => true, 'sessions' => sessions_list_full()]);
}

if ($action === 'session_create') {
    require_login();
    require_csrf();
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body)) {
        $body = $_POST;
    }
    $name = trim((string)($body['name'] ?? ''));
    $folder = (string)($body['folder'] ?? '');
    $model = (string)($body['model'] ?? '');
    $agent = (string)($body['agent'] ?? 'build');
    // El puente dueño: el que eligió la web (header/query). Sin él, cae en el
    // único registrado o en '' (legacy de un solo puente).
    $bridge = isset($body['bridge']) && is_string($body['bridge']) && bridge_valid_id($body['bridge'])
        ? $body['bridge'] : resolve_web_bridge();
    $file = bridge_catalog_file($bridge);

    if ($folder === '' || folder_path_in_catalog($folder, $file) === null) {
        json_response(['ok' => false, 'error' => 'Carpeta no disponible'], 400);
    }
    if ($model === '' || !model_in_catalog($model, $file)) {
        json_response(['ok' => false, 'error' => 'Modelo no disponible'], 400);
    }
    if (!agent_in_catalog($agent, $file)) {
        json_response(['ok' => false, 'error' => 'Agente no disponible'], 400);
    }
    if (mb_strlen($name) > 60) {
        json_response(['ok' => false, 'error' => 'Nombre demasiado largo'], 400);
    }

    $id = add_session($name, $folder, $model, $agent, null, $bridge);
    if ($id === null) {
        json_response(['ok' => false, 'error' => 'No se pudo crear'], 500);
    }
    json_response(['ok' => true, 'session' => get_session($id)]);
}

if ($action === 'session_delete') {
    $u = require_csrf();
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body)) {
        $body = $_POST;
    }
    $id = (int)($body['id'] ?? 0);
    if ($id <= 0) {
        json_response(['ok' => false, 'error' => 'id inválido'], 400);
    }
    $sess = get_session($id);
    if ($sess === null) {
        json_response(['ok' => false, 'error' => 'Sesión no encontrada'], 404);
    }
    // Borrar chats es solo para admin (igual que el hub Node).
    if (($u['role'] ?? '') !== 'admin') {
        json_response(['ok' => false, 'error' => 'Permiso insuficiente'], 403);
    }
    delete_session($id);
    json_response(['ok' => true]);
}

// Cambia modelo y/o agente de un chat existente. El puente usa estos valores
// en cada mensaje (opencode run --model ... --agent ...), así que el cambio
// aplica desde el próximo mensaje sin tocar la sesión de opencode. La lista de
// modelos válidos es la del puente dueño de la sesión.
if ($action === 'session_update') {
    require_login();
    require_csrf();
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body)) {
        $body = $_POST;
    }
    $id = (int)($body['id'] ?? 0);
    $sess = $id > 0 ? get_session($id) : null;
    if ($sess === null) {
        json_response(['ok' => false, 'error' => 'Sesión no encontrada'], 404);
    }
    if (!ob_session_accessible($sess, ob_current_user())) {
        json_response(['ok' => false, 'error' => 'Permiso insuficiente'], 403);
    }
    $file = bridge_catalog_file(session_bridge($sess));
    $model = trim((string)($body['model'] ?? ''));
    $agent = trim((string)($body['agent'] ?? ''));
    if ($model === '' && $agent === '') {
        json_response(['ok' => false, 'error' => 'Nada que cambiar'], 400);
    }
    if ($model !== '' && !model_in_catalog($model, $file)) {
        json_response(['ok' => false, 'error' => 'Modelo no disponible'], 400);
    }
    if ($agent !== '' && !agent_in_catalog($agent, $file)) {
        json_response(['ok' => false, 'error' => 'Agente no disponible'], 400);
    }
    $sdata = sessions_read($fp);
    $idx = -1;
    foreach ($sdata['sessions'] as $i => $s) {
        if ((int)$s['id'] === $id) {
            $idx = $i;
            break;
        }
    }
    if ($idx < 0) {
        json_done($fp);
        json_response(['ok' => false, 'error' => 'Sesión no encontrada'], 404);
    }
    if ($model !== '') {
        $sdata['sessions'][$idx]['model'] = $model;
    }
    if ($agent !== '') {
        $sdata['sessions'][$idx]['agent'] = $agent;
    }
    $sdata['sessions'][$idx]['last_ts'] = gmdate('c');
    sessions_save($sdata, $fp);
    json_response(['ok' => true, 'session' => $sdata['sessions'][$idx]]);
}

// ---------------------------------------------------------------------------
// Mensajes (web, requiere login + CSRF para enviar).
// ---------------------------------------------------------------------------
if ($action === 'history') {
    require_login_readonly();
    $sid = (int)($_GET['session'] ?? 0);
    $sess = $sid > 0 ? get_session($sid) : null;
    if ($sess === null) {
        json_response(['ok' => false, 'error' => 'Sesión no encontrada'], 404);
    }
    if (!ob_session_accessible($sess, ob_current_user())) {
        json_response(['ok' => false, 'error' => 'Permiso insuficiente'], 403);
    }
    $data = messages_read($sid, $fp);
    // Borradores huérfanos (el puente murió a mitad de la respuesta): se
    // cierran para que este chat deje de mostrar "generando…" para siempre.
    if (messages_heal_stale_streaming($data, time() - STALE_PROCESSING_SECONDS)) {
        messages_save($data, $fp);
    } else {
        json_done($fp);
    }
    // Refresco incremental: ?since=<último id conocido>&ts=<ts del último visto>.
    // Devuelve los nuevos + los que cambiaron de estado relevantes para la UI
    // (borrador en streaming, respuesta recién finalizada).
    $since = isset($_GET['since']) ? (int)$_GET['since'] : 0;
    $sinceTs = isset($_GET['ts']) ? (string)$_GET['ts'] : '';
    $msgs = $data['messages'];
    if ($since > 0) {
        $tsCut = $sinceTs !== '' ? @strtotime($sinceTs) : 0;
        $out = [];
        foreach ($msgs as $m) {
            if ((int)$m['id'] > $since
                || ($m['status'] ?? '') === 'streaming'
                || (isset($m['answered_ts']) && $tsCut > 0 && @strtotime((string)$m['answered_ts']) > $tsCut)) {
                $out[] = $m;
            }
        }
        $msgs = $out;
    }
    json_response(['ok' => true, 'session' => $sess, 'messages' => $msgs]);
}

// ---------------------------------------------------------------------------
// Cancelar una acción en curso (web). Marca el/los mensajes pendientes como
// 'canceled' y al que ya está procesando le pone cancel_requested para que el
// puente lo corte en su próximo chequeo (~2 s).
// ---------------------------------------------------------------------------
if ($action === 'cancel') {
    $u = require_csrf();
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body)) {
        $body = $_POST;
    }
    $sid = (int)($body['session'] ?? 0);
    $sess = $sid > 0 ? get_session($sid) : null;
    if ($sess === null) {
        json_response(['ok' => false, 'error' => 'Sesión no encontrada'], 404);
    }
    if (!ob_session_accessible($sess, $u)) {
        json_response(['ok' => false, 'error' => 'Permiso insuficiente'], 403);
    }
    $data = messages_read($sid, $mfp);
    $marked = 0;
    foreach ($data['messages'] as &$msg) {
        if ($msg['role'] !== 'user') continue;
        if ($msg['status'] === 'pending') {
            $msg['status'] = 'canceled';
            $msg['canceled_ts'] = gmdate('c');
            $marked++;
        } elseif ($msg['status'] === 'processing' && empty($msg['cancel_requested'])) {
            $msg['cancel_requested'] = true;
            $marked++;
        }
    }
    unset($msg);
    if (!$marked) {
        json_done($mfp);
        json_response(['ok' => false, 'error' => 'No hay nada en curso para cancelar'], 400);
    }
    messages_save($data, $mfp);
    json_response(['ok' => true, 'marked' => $marked]);
}

// El puente consulta esto cada ~2 s mientras opencode está corriendo.
if ($action === 'cancel_status') {
    if (!check_bridge_token($_SERVER)) {
        json_response(['ok' => false, 'error' => 'Token inválido'], 401);
    }
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body)) $body = $_POST;
    $sid = (int)($body['session_id'] ?? 0);
    if ($sid <= 0) {
        json_response(['ok' => false, 'error' => 'session_id requerido'], 400);
    }
    $sess = get_session($sid);
    if ($sess === null) {
        json_response(['ok' => false, 'error' => 'Sesion no encontrada'], 404);
    }
    if (!bridge_can_claim_session(resolve_request_bridge(), $sess)) {
        json_response(['ok' => false, 'error' => 'Permiso insuficiente'], 403);
    }
    $data = messages_read($sid, $mfp);
    json_done($mfp);
    foreach ($data['messages'] as $msg) {
        if ($msg['role'] === 'user' && !empty($msg['cancel_requested'])) {
            json_response(['ok' => true, 'cancel' => true, 'user_id' => (int)$msg['id']]);
        }
    }
    json_response(['ok' => true, 'cancel' => false]);
}

if ($action === 'send') {
    $u = require_csrf();
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body)) {
        $body = $_POST;
    }
    $sid = (int)($body['session'] ?? 0);
    $sess = $sid > 0 ? get_session($sid) : null;
    if ($sess === null) {
        json_response(['ok' => false, 'error' => 'Sesión no encontrada'], 404);
    }
    if (!ob_session_accessible($sess, $u)) {
        json_response(['ok' => false, 'error' => 'Permiso insuficiente'], 403);
    }
    $text = trim((string)($body['text'] ?? ''));
    // Imagen adjunta (dataURL) para modelos con visión.
    $img = trim((string)($body['image'] ?? ''));
    if ($img !== '') {
        if (!preg_match('#^data:image/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$#', $img)) {
            json_response(['ok' => false, 'error' => 'Imagen inválida'], 400);
        }
        if (strlen($img) * 3 / 4 > 4 * 1024 * 1024) {
            json_response(['ok' => false, 'error' => 'Imagen demasiado grande (máx 4 MB)'], 400);
        }
    }
    if ($text === '' && $img === '') {
        json_response(['ok' => false, 'error' => 'Mensaje vacío'], 400);
    }
    if (mb_strlen($text) > 10000) {
        json_response(['ok' => false, 'error' => 'Mensaje demasiado largo'], 400);
    }
    $extra = ['agent' => (string)($sess['agent'] ?? 'build'), 'author' => (string)$u['name']];
    if ($img !== '') {
        $extra['img'] = $img;
    }
    $id = add_message($sid, 'user', $text, 'pending', $extra);
    // Auto-título (estilo opencode): si el chat sigue con el nombre por defecto,
    // lo renombramos usando el primer prompt que escribió el usuario.
    if (session_has_default_name($sess)) {
        $t = session_title_from_prompt($text);
        if ($t !== '') {
            session_rename($sid, $t);
        }
    }
    json_response(['ok' => true, 'id' => $id]);
}

// ---------------------------------------------------------------------------
// Puente (token del puente).
// ---------------------------------------------------------------------------
if ($action === 'sync_catalog') {
    if (!check_bridge_token($_SERVER)) {
        json_response(['ok' => false, 'error' => 'Token inválido'], 401);
    }
    $bridge = resolve_request_bridge();
    $bridgeName = request_bridge_name();
    // Primer puente registrado: hereda el catálogo legacy y los chats sin
    // dueño (eran de un mundo de una sola PC). Después, asegura su entrada.
    bridge_register_first($bridge, $bridgeName);
    bridge_registry_upsert($bridge, $bridgeName);
    $file = bridge_catalog_file($bridge);
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body)) {
        json_response(['ok' => false, 'error' => 'Body inválido'], 400);
    }
    $folders = [];
    foreach ((array)($body['folders'] ?? []) as $f) {
        if (is_array($f) && isset($f['name']) && isset($f['path'])) {
            $folders[] = [
                'name' => mb_substr((string)$f['name'], 0, 60),
                'path' => mb_substr((string)$f['path'], 0, 500),
            ];
        } elseif (is_string($f)) {
            $folders[] = ['name' => mb_substr($f, 0, 60), 'path' => mb_substr($f, 0, 500)];
        }
    }
    $models = [];
    foreach ((array)($body['models'] ?? []) as $m) {
        if (is_string($m) && trim($m) !== '') {
            $models[] = mb_substr(trim($m), 0, 120);
        }
    }
    // Catálogo completo agrupado por proveedor: {proveedor: [id, ...]}.
    $modelsFull = [];
    foreach ((array)($body['models_full'] ?? []) as $prov => $list) {
        if (!is_string($prov) || $prov === '' || !is_array($list)) {
            continue;
        }
        $clean = [];
        foreach ($list as $m) {
            if (is_string($m) && trim($m) !== '') {
                $clean[] = mb_substr(trim($m), 0, 160);
            }
        }
        if ($clean) {
            $modelsFull[mb_substr($prov, 0, 60)] = array_slice(array_values($clean), 0, 800);
        }
    }
    $modelsFull = array_slice($modelsFull, 0, 80, true);
    $folders = array_slice($folders, 0, 200);
    $models = array_slice($models, 0, 400);
    $workspace = trim((string)($body['workspace'] ?? ''));
    $allowCreate = !empty($body['allowCreateFolders']);
    $agents = [];
    foreach ((array)($body['agents'] ?? []) as $a) {
        if (is_string($a) && trim($a) !== '') {
            $agents[] = mb_substr(trim($a), 0, 40);
        }
    }
    $agents = array_slice($agents, 0, 20);
    // Modelos con entrada de imagen (visión) según el catálogo de opencode.
    $vision = [];
    foreach ((array)($body['vision'] ?? []) as $m) {
        if (is_string($m) && trim($m) !== '') {
            $vision[] = mb_substr(trim($m), 0, 160);
        }
    }
    $vision = array_slice(array_values(array_unique($vision)), 0, 800);
    // Contexto por modelo en tokens: {id: ctx} (formato del puente de OpenBridge).
    $modelsCtx = [];
    foreach ((array)($body['models_ctx'] ?? []) as $id => $v) {
        if (!is_string($id) || trim($id) === '') {
            continue;
        }
        $ctx = (int)$v;
        if ($ctx <= 0) {
            continue;
        }
        $modelsCtx[mb_substr(trim($id), 0, 160)] = $ctx;
        if (count($modelsCtx) >= 2000) break;
    }
    if (!sync_catalog($folders, $models, $workspace, $allowCreate, $agents, $modelsFull, $vision, $modelsCtx, $file)) {
        json_response(['ok' => false, 'error' => 'No se pudo guardar'], 500);
    }
    json_response(['ok' => true, 'folders' => count($folders), 'models' => count($models), 'models_full' => count($modelsFull), 'agents' => count($agents)]);
}

// ---------------------------------------------------------------------------
// Importa (merge idempotente) una sesión de opencode creada en el TUI local.
// La llama el puente tras `opencode export <id>`. Si la sesión ya existe
// (por opencode_session) solo agrega los mensajes que falten.
// ---------------------------------------------------------------------------
if ($action === 'session_import') {
    if (!check_bridge_token($_SERVER)) {
        json_response(['ok' => false, 'error' => 'Token inválido'], 401);
    }
    $bridge = resolve_request_bridge();
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body)) {
        json_response(['ok' => false, 'error' => 'Body inválido'], 400);
    }
    $oc = trim((string)($body['opencode_session'] ?? ''));
    if (!preg_match('/^ses_[A-Za-z0-9]{4,64}$/', $oc)) {
        json_response(['ok' => false, 'error' => 'opencode_session inválido'], 400);
    }
    $name = mb_substr(trim((string)($body['name'] ?? '')), 0, 60);
    $folder = mb_substr(trim((string)($body['folder'] ?? '')), 0, 500);
    $model = trim((string)($body['model'] ?? ''));
    $agent = trim((string)($body['agent'] ?? 'build'));
    $updated = trim((string)($body['updated'] ?? ''));
    $msgs = isset($body['messages']) && is_array($body['messages']) ? $body['messages'] : [];
    if (count($msgs) > 400) {
        $msgs = array_slice($msgs, -400);
    }
    $tokens = max(0, (int)($body['tokens'] ?? 0));
    $cost = max(0.0, (float)($body['cost'] ?? 0));
    $res = session_import($oc, $name, $folder, $model, $agent, $updated, $msgs, $tokens, $cost, $bridge);
    if (empty($res['ok'])) {
        json_response($res, 400);
    }
    json_response($res);
}

// Refresco liviano de tokens/costo de un chat web ya vinculado (sin mensajes).
if ($action === 'session_tokens') {
    if (!check_bridge_token($_SERVER)) {
        json_response(['ok' => false, 'error' => 'Token inválido'], 401);
    }
    $bridge = resolve_request_bridge();
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body)) {
        json_response(['ok' => false, 'error' => 'Body inválido'], 400);
    }
    $oc = trim((string)($body['opencode_session'] ?? ''));
    if (!preg_match('/^ses_[A-Za-z0-9]{4,64}$/', $oc)) {
        json_response(['ok' => false, 'error' => 'opencode_session inválido'], 400);
    }
    $tokens = max(0, (int)($body['tokens'] ?? 0));
    $cost = max(0.0, (float)($body['cost'] ?? 0));
    $folder = trim((string)($body['folder'] ?? ''));
    if ($folder !== '' && mb_strlen($folder) > 500) $folder = '';
    session_tokens($oc, $tokens, $cost, $folder, $bridge);
    json_response(['ok' => true]);
}

// ---------------------------------------------------------------------------
// Crear carpeta remotamente (web). La solicitud la resuelve el puente en la PC.
// ---------------------------------------------------------------------------
if ($action === 'request_folder') {
    require_login();
    require_csrf();
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body)) {
        $body = $_POST;
    }
    $bridge = isset($body['bridge']) && is_string($body['bridge']) && bridge_valid_id($body['bridge'])
        ? $body['bridge'] : resolve_web_bridge();
    $file = bridge_catalog_file($bridge);
    $cat = catalog_read($file);
    if (empty($cat['allow_create_folders'])) {
        json_response(['ok' => false, 'error' => 'La creación de carpetas está desactivada'], 403);
    }
    if ($cat['workspace'] === '') {
        json_response(['ok' => false, 'error' => 'El puente no definió un espacio de trabajo'], 400);
    }
    $name = trim((string)($body['name'] ?? ''));
    if (!valid_folder_name($name)) {
        json_response(['ok' => false, 'error' => 'Nombre inválido (solo letras, números, espacios, - _ . () y 3-50 caracteres)'], 400);
    }
    $id = catalog_add_request($name, $file);
    json_response(['ok' => true, 'request' => ['id' => $id, 'name' => $name]]);
}

// ---------------------------------------------------------------------------
// Suscripciones Web Push de la PWA (web). El servidor guarda el endpoint con
// sus llaves y lo usa al responder para avisarle al dispositivo.
// ---------------------------------------------------------------------------
if ($action === 'push_subscribe') {
    $u = require_csrf();
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body)) {
        $body = $_POST;
    }
    $endpoint = trim((string)($body['endpoint'] ?? ''));
    $p256dh = trim((string)($body['p256dh'] ?? ''));
    $auth = trim((string)($body['auth'] ?? ''));
    $ua = mb_substr(trim((string)($body['ua'] ?? '')), 0, 120);
    if ($endpoint === '' || $p256dh === '' || $auth === '') {
        json_response(['ok' => false, 'error' => 'Faltan datos de la suscripción'], 400);
    }
    if (!push_enabled()) {
        json_response(['ok' => false, 'error' => 'Los avisos push están desactivados en el servidor'], 400);
    }
    $host = parse_url($endpoint, PHP_URL_HOST) ?: '';
    $scheme = parse_url($endpoint, PHP_URL_SCHEME) ?: '';
    if ($scheme !== 'https' || !push_host_allowed($host)) {
        json_response(['ok' => false, 'error' => 'Suscripción no válida'], 400);
    }
    if (strlen((string)b64url_decode($p256dh)) !== 65 || strlen((string)b64url_decode($auth)) !== 16) {
        json_response(['ok' => false, 'error' => 'Llaves de la suscripción no válidas'], 400);
    }
    push_store($endpoint, $p256dh, $auth, $ua, (string)$u['id']);
    json_response(['ok' => true]);
}

if ($action === 'push_unsubscribe') {
    $u = require_csrf();
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body)) {
        $body = $_POST;
    }
    $endpoint = trim((string)($body['endpoint'] ?? ''));
    if ($endpoint !== '') {
        push_remove($endpoint, (string)$u['id']);
    }
    json_response(['ok' => true]);
}

if ($action === 'heartbeat') {
    if (!check_bridge_token($_SERVER)) {
        json_response(['ok' => false, 'error' => 'Token inválido'], 401);
    }
    $bridge = resolve_request_bridge();
    $bridgeName = request_bridge_name();
    // El puente puede reportar qué sesión está ejecutando (indicador working).
    $body = json_decode(file_get_contents('php://input'), true);
    $busy = null;
    $busySession = 0;
    if (is_array($body) && array_key_exists('busy', $body)) {
        $busy = !empty($body['busy']);
        $busySession = empty($body['busy']) ? 0 : (int)($body['busy_session'] ?? 0);
    }
    bridge_register_first($bridge, $bridgeName);
    bridge_registry_upsert($bridge, $bridgeName, $busy, $busySession);
    json_response(['ok' => true]);
}

if ($action === 'poll') {
    if (!check_bridge_token($_SERVER)) {
        json_response(['ok' => false, 'error' => 'Token inválido'], 401);
    }
    // Este puente solo reclama mensajes de sus propias sesiones (dueño = su
    // id) y de las legacy sin dueño cuya carpeta tiene en su catálogo.
    $bridge = resolve_request_bridge();
    $file = bridge_catalog_file($bridge);
    // El estado "online" lo mantiene el heartbeat cada 15 s; no hace falta
    // reescribir bridges.json en cada poll (era 1 write cada ~5 s).
    // Vista previa del catalogo: solo se reescribe si hay comandos/carpetas
    // pendientes (antes se hacia un write por poll aunque no hubiera nada).
    $catPeek = catalog_read($file);
    $hasPendingCmd = false;
    foreach ((array)($catPeek['commands'] ?? []) as $c) {
        if (($c['status'] ?? '') === 'pending') { $hasPendingCmd = true; break; }
    }
    $hasPendingReq = false;
    if (!empty($catPeek['allow_create_folders'])) {
        foreach ((array)($catPeek['requests'] ?? []) as $r) {
            if (($r['status'] ?? '') === 'pending') { $hasPendingReq = true; break; }
        }
    }
    $cutoff = time() - STALE_PROCESSING_SECONDS;
    // Modo liviano (lo pide el puente mientras tiene un mensaje procesándose):
    // solo reclama comandos; mensajes y carpetas quedan para el poll normal,
    // para no adelantar trabajo que no se va a poder atender recién terminado
    // el mensaje.
    $body = json_decode(file_get_contents('php://input'), true);
    $lite = (is_array($body) && !empty($body['lite'])) || isset($_GET['lite']);
    // Long-poll: si el puente pide espera y no hay nada, retenemos la respuesta
    // hasta 20 s revisando cada 500 ms (igual que el stream). El espacio que
    // imprimimos en cada vuelta mantiene la conexión vigilada y evita que un
    // proxy del hosting la corte; el parser JSON del puente lo tolera.
    // En el server de desarrollo local (php -S, un solo worker) la espera se
    // acorta a 1 s: retener el único hilo bloquearía la web en la misma PC.
    $waitMax = 20;
    // El puente puede pedir una espera menor (waitMax) para que los comandos
    // recién encolados no queden presos detrás de un long-poll de 20 s.
    // Avisar trabajo sigue siendo instantáneo (el peek revisa cada 500 ms);
    // waitMax solo acorta cuánto se retiene la respuesta cuando NO hay nada.
    $reqWaitMax = 0;
    if (is_array($body) && isset($body['waitMax'])) $reqWaitMax = (int)$body['waitMax'];
    elseif (isset($_GET['waitMax'])) $reqWaitMax = (int)$_GET['waitMax'];
    if ($reqWaitMax > 0) $waitMax = max(1, min(20, $reqWaitMax));
    $sw = isset($_SERVER['SERVER_SOFTWARE']) ? (string)$_SERVER['SERVER_SOFTWARE'] : '';
    $host = isset($_SERVER['HTTP_HOST']) ? (string)$_SERVER['HTTP_HOST'] : '';
    if (stripos($sw, 'Development Server') !== false
        || stripos($host, '127.0.0.1') === 0
        || stripos($host, 'localhost') === 0) {
        $waitMax = 1;
    }
    if (!$lite && ((is_array($body) && !empty($body['wait'])) || isset($_GET['wait']))) {
        @set_time_limit(30);
        $started = time();
        // Un escaneo completo al entrar (puede haber trabajo encolado antes de
        // la espera). Despues, durante la espera, solo se vuelve a escanear si
        // ob_wake() aviso algo nuevo: evita releer todos los messages-*.json
        // cada 500 ms.
        $hasWork = poll_peek_work($cutoff, $bridge);
        while (!$hasWork) {
            echo ' ';
            @flush();
            if (connection_aborted()) exit;
            if ((time() - $started) >= $waitMax) break;
            usleep(500000);
            if (poll_wake_changed($started)) {
                $hasWork = poll_peek_work($cutoff, $bridge);
            }
        }
        if (connection_aborted()) exit;
    }
    $sdata = sessions_read($sfp);
    $claimed = [];
    $knownOc = [];
    $sessChanged = false;
    if (!$lite) {
        foreach ($sdata['sessions'] as &$sess) {
            $sid = (int)$sess['id'];
            if (!bridge_can_claim_session($bridge, $sess)) {
                continue;
            }
            $data = messages_read($sid, $mfp);
            if ($data === null) {
                continue;
            }
            $changed = false;
            foreach ($data['messages'] as &$msg) {
                if ($msg['role'] !== 'user') {
                    continue;
                }
                $pending = $msg['status'] === 'pending';
                $processing = $msg['status'] === 'processing' && (strtotime($msg['ts']) < $cutoff);
                if ($pending || $processing) {
                    if (!empty($msg['cancel_requested'])) {
                        // Cancelado mientras esperaba: no se ejecuta nunca.
                        $msg['status'] = 'canceled';
                        $msg['canceled_ts'] = gmdate('c');
                        unset($msg['cancel_requested']);
                        $changed = true;
                        continue;
                    }
                    $msg['status'] = 'processing';
                    $msg['ts'] = gmdate('c');
                    $changed = true;
                    // Sesión legacy sin dueño que este puente puede correr
                    // (tiene la carpeta): queda asignada a él.
                    if ($bridge !== '' && session_bridge($sess) === '') {
                        $sess['bridge'] = $bridge;
                        $sessChanged = true;
                    }
                    $claimed[] = [
                        'session_id' => $sid,
                        'id' => (int)$msg['id'],
                        'text' => $msg['text'],
                        'img' => isset($msg['img']) ? (string)$msg['img'] : null,
                        'opencode_session' => $sess['opencode_session'] ?? null,
                        'session' => [
                            'id' => $sid,
                            'name' => $sess['name'],
                            'folder' => $sess['folder'] ?? '',
                            'model' => $sess['model'] ?? '',
                            'agent' => $sess['agent'] ?? 'build',
                        ],
                    ];
                }
            }
            unset($msg);
            if ($changed) {
                messages_save($data, $mfp);
            } else {
                json_done($mfp);
            }
        }
        unset($sess);
        if ($sessChanged) sessions_save($sdata, $sfp);
        else json_done($sfp);
        // Chats web creados acá y ya vinculados a opencode: el puente los salta
        // al barrer (no duplicar). Solo cuenta los de este puente (dueño = su
        // id) y los legacy sin dueño; los espejos importados de OTRO puente no.
        // Los espejos importados NO cuentan: el barrido sí los re-importa, y
        // así corrige carpeta/tokens si una pasada vieja los clasificó mal.
        foreach ($sdata['sessions'] as $s) {
            if (empty($s['opencode_session']) || !empty($s['importada'])) continue;
            $owner = session_bridge($s);
            if ($owner === '' || $owner === $bridge) {
                $knownOc[] = (string)$s['opencode_session'];
            }
        }
        $foldersToCreate = $hasPendingReq ? catalog_claim_requests($file) : [];
    } else {
        json_done($sfp);
        $foldersToCreate = [];
    }
    $commands = $hasPendingCmd ? claim_commands($file) : [];
    json_response(['ok' => true, 'messages' => $claimed, 'folders' => $foldersToCreate, 'commands' => $commands, 'known_oc' => $knownOc]);
}

if ($action === 'folder_done') {
    if (!check_bridge_token($_SERVER)) {
        json_response(['ok' => false, 'error' => 'Token inválido'], 401);
    }
    $file = bridge_catalog_file(resolve_request_bridge());
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body)) {
        $body = $_POST;
    }
    $id = (int)($body['id'] ?? 0);
    if ($id <= 0) {
        json_response(['ok' => false, 'error' => 'id inválido'], 400);
    }
    $ok = !empty($body['ok']);
    $folder = isset($body['folder']) && is_array($body['folder'])
        ? ['name' => mb_substr((string)($body['folder']['name'] ?? ''), 0, 60), 'path' => mb_substr((string)($body['folder']['path'] ?? ''), 0, 500)]
        : null;
    $error = trim((string)($body['error'] ?? ''));
    catalog_finish_request($id, $ok, $folder, $error, $file);
    json_response(['ok' => true]);
}

// ---------------------------------------------------------------------------
// Resultado de un comando opencode ejecutado por el puente.
// ---------------------------------------------------------------------------
if ($action === 'command_done') {
    if (!check_bridge_token($_SERVER)) {
        json_response(['ok' => false, 'error' => 'Token inválido'], 401);
    }
    $file = bridge_catalog_file(resolve_request_bridge());
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body)) $body = $_POST;
    $id = (int)($body['id'] ?? 0);
    $ok = !empty($body['ok']);
    $text = (string)($body['text'] ?? '');
    $error = (string)($body['error'] ?? '');
    if ($id <= 0) {
        json_response(['ok' => false, 'error' => 'id inválido'], 400);
    }
    if (mb_strlen($text) > 8000) $text = mb_substr($text, 0, 8000) . '…';
    finish_command($id, $ok, $text, $error, $file);
    json_response(['ok' => true]);
}

// Resultado de un comando fs_* del puente (listados y contenido de archivos
// pueden ser grandes, así que tienen su propio tope).
if ($action === 'fs_result') {
    if (!check_bridge_token($_SERVER)) {
        json_response(['ok' => false, 'error' => 'Token inválido'], 401);
    }
    $file = bridge_catalog_file(resolve_request_bridge());
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body)) $body = $_POST;
    $id = (int)($body['id'] ?? 0);
    $ok = !empty($body['ok']);
    $text = (string)($body['text'] ?? '');
    $error = (string)($body['error'] ?? '');
    if ($id <= 0) {
        json_response(['ok' => false, 'error' => 'id inválido'], 400);
    }
    if (mb_strlen($text) > 700000) $text = mb_substr($text, 0, 700000);
    finish_command($id, $ok, $text, $error, $file);
    json_response(['ok' => true]);
}

// Resultado de un comando proc_* del puente (trozos de log de un proceso de
// desarrollo; también pueden ser grandes, tope propio).
if ($action === 'proc_result') {
    if (!check_bridge_token($_SERVER)) {
        json_response(['ok' => false, 'error' => 'Token inválido'], 401);
    }
    $file = bridge_catalog_file(resolve_request_bridge());
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body)) $body = $_POST;
    $id = (int)($body['id'] ?? 0);
    $ok = !empty($body['ok']);
    $text = (string)($body['text'] ?? '');
    $error = (string)($body['error'] ?? '');
    if ($id <= 0) {
        json_response(['ok' => false, 'error' => 'id inválido'], 400);
    }
    if (mb_strlen($text) > 100000) $text = mb_substr($text, 0, 100000);
    finish_command($id, $ok, $text, $error, $file);
    json_response(['ok' => true]);
}

// Respuesta en streaming: crea/actualiza el mensaje assistant "borrador" del
// puente mientras opencode está trabajando (status 'streaming').
if ($action === 'respond_partial') {
    if (!check_bridge_token($_SERVER)) {
        json_response(['ok' => false, 'error' => 'Token inválido'], 401);
    }
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body)) {
        $body = $_POST;
    }
    $sid = (int)($body['session_id'] ?? 0);
    $userId = (int)($body['user_id'] ?? 0);
    $text = trim((string)($body['text'] ?? ''));
    $reasoning = trim((string)($body['reasoning'] ?? ''));
    $ocMsg = trim((string)($body['oc_msg'] ?? ''));
    if ($sid <= 0 || $userId <= 0) {
        json_response(['ok' => false, 'error' => 'session_id y user_id son obligatorios'], 400);
    }
    // Aislamiento entre inquilinos: el puente solo puede publicar parciales de
    // sesiones que le pertenecen (o legacy sin dueno de su catalogo).
    $sess = get_session($sid);
    if ($sess === null) {
        json_response(['ok' => false, 'error' => 'Sesion no encontrada'], 404);
    }
    if (!bridge_can_claim_session(resolve_request_bridge(), $sess)) {
        json_response(['ok' => false, 'error' => 'Permiso insuficiente'], 403);
    }
    if (mb_strlen($text) > 50000 || mb_strlen($reasoning) > 50000) {
        json_response(['ok' => false, 'error' => 'Respuesta demasiado larga'], 400);
    }
    if ($text === '' && $reasoning === '') {
        json_response(['ok' => false, 'error' => 'Nada para publicar'], 400);
    }
    $data = messages_read($sid, $mfp);
    $draftIdx = -1;
    foreach ($data['messages'] as $i => $msg) {
        if ($msg['role'] === 'assistant' && isset($msg['draft_for']) && (int)$msg['draft_for'] === $userId) {
            $draftIdx = $i;
            break;
        }
    }
    if ($draftIdx >= 0) {
        $data['messages'][$draftIdx]['text'] = $text;
        if ($reasoning !== '') $data['messages'][$draftIdx]['reasoning'] = $reasoning;
        if ($ocMsg !== '') $data['messages'][$draftIdx]['oc_msg'] = $ocMsg;
        $data['messages'][$draftIdx]['ts'] = gmdate('c');
    } else {
        $aid = $data['nextId'];
        $data['nextId'] = $aid + 1;
        $draft = [
            'id' => $aid,
            'role' => 'assistant',
            'text' => $text,
            'ts' => gmdate('c'),
            'status' => 'streaming',
            'draft_for' => $userId,
            'agent' => message_agent_of($data, $userId),
        ];
        if ($reasoning !== '') $draft['reasoning'] = $reasoning;
        if ($ocMsg !== '') $draft['oc_msg'] = $ocMsg;
        $data['messages'][] = $draft;
    }
    messages_save($data, $mfp);
    json_response(['ok' => true]);
}

if ($action === 'respond') {
    if (!check_bridge_token($_SERVER)) {
        json_response(['ok' => false, 'error' => 'Token inválido'], 401);
    }
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body)) {
        $body = $_POST;
    }
    $sid = (int)($body['session_id'] ?? 0);
    $userId = (int)($body['user_id'] ?? 0);
    $text = trim((string)($body['text'] ?? ''));
    if ($sid <= 0 || $userId <= 0 || $text === '') {
        json_response(['ok' => false, 'error' => 'session_id, user_id y text son obligatorios'], 400);
    }
    if (mb_strlen($text) > 50000) {
        json_response(['ok' => false, 'error' => 'Respuesta demasiado larga'], 400);
    }
    $sdata = sessions_read($sfp);
    $sidIdx = -1;
    foreach ($sdata['sessions'] as $i => $s) {
        if ((int)$s['id'] === (int)$sid) {
            $sidIdx = $i;
            break;
        }
    }
    if ($sidIdx < 0) {
        json_done($sfp);
        json_response(['ok' => false, 'error' => 'Sesión no encontrada'], 404);
    }
    // Aislamiento entre inquilinos: el token del puente solo puede responder
    // mensajes de sus propias sesiones (o legacy sin dueno de su catalogo).
    $reqBridge = resolve_request_bridge();
    if (!bridge_can_claim_session($reqBridge, $sdata['sessions'][$sidIdx])) {
        json_done($sfp);
        json_response(['ok' => false, 'error' => 'Permiso insuficiente'], 403);
    }
    $oc = isset($body['opencode_session']) ? trim((string)$body['opencode_session']) : '';
    $reasoning = trim((string)($body['reasoning'] ?? ''));
    $ocMsg = trim((string)($body['oc_msg'] ?? ''));
    $clearSession = !empty($body['clear_session']);
    if ($clearSession) {
        $sdata['sessions'][$sidIdx]['opencode_session'] = null;
    } elseif ($oc !== '' && ($sdata['sessions'][$sidIdx]['opencode_session'] ?? null) !== $oc) {
        // No vincular si otra sesión ya usa ese opencode_session (puede pasar
        // si el barrido del puente la importó mientras se procesaba el mensaje).
        $taken = false;
        foreach ($sdata['sessions'] as $i2 => $s2) {
            if ($i2 !== $sidIdx && !empty($s2['opencode_session']) && (string)$s2['opencode_session'] === $oc) {
                $taken = true;
                break;
            }
        }
        if (!$taken) {
            $sdata['sessions'][$sidIdx]['opencode_session'] = $oc;
        }
    }
    $sdata['sessions'][$sidIdx]['last_ts'] = gmdate('c');
    sessions_save($sdata, $sfp);

    $data = messages_read($sid, $mfp);
    $found = false;
    foreach ($data['messages'] as &$msg) {
        if ((int)$msg['id'] === $userId) {
            $msg['status'] = 'done';
            $msg['answered_ts'] = gmdate('c');
            unset($msg['cancel_requested']);
            $found = true;
            break;
        }
    }
    unset($msg);
    if (!$found) {
        json_done($mfp);
        json_response(['ok' => false, 'error' => 'Mensaje no encontrado'], 404);
    }
    // Si el puente publicó parciales, finalizamos ese borrador en vez de duplicar.
    $draftIdx = -1;
    foreach ($data['messages'] as $i => $msg) {
        if ($msg['role'] === 'assistant' && isset($msg['draft_for']) && (int)$msg['draft_for'] === $userId) {
            $draftIdx = $i;
            break;
        }
    }
    $canceled = !empty($body['canceled']);
    if ($draftIdx >= 0) {
        $aid = (int)$data['messages'][$draftIdx]['id'];
        $data['messages'][$draftIdx]['text'] = $text;
        $data['messages'][$draftIdx]['status'] = 'done';
        $data['messages'][$draftIdx]['answered_ts'] = gmdate('c');
        $data['messages'][$draftIdx]['ts'] = gmdate('c');
        if ($reasoning !== '') {
            $data['messages'][$draftIdx]['reasoning'] = $reasoning;
        } else {
            unset($data['messages'][$draftIdx]['reasoning']);
        }
        if ($ocMsg !== '') $data['messages'][$draftIdx]['oc_msg'] = $ocMsg;
        if ($canceled) {
            $data['messages'][$draftIdx]['canceled'] = true;
        } else {
            unset($data['messages'][$draftIdx]['canceled']);
        }
        if (empty($data['messages'][$draftIdx]['agent'])) {
            $data['messages'][$draftIdx]['agent'] = message_agent_of($data, $userId, (string)($sdata['sessions'][$sidIdx]['agent'] ?? ''));
        }
        unset($data['messages'][$draftIdx]['draft_for']);
    } else {
        $aid = $data['nextId'];
        $data['nextId'] = $aid + 1;
        $newMsg = [
            'id' => $aid,
            'role' => 'assistant',
            'text' => $text,
            'ts' => gmdate('c'),
            'status' => 'done',
            'agent' => message_agent_of($data, $userId, (string)($sdata['sessions'][$sidIdx]['agent'] ?? '')),
        ];
        if ($reasoning !== '') $newMsg['reasoning'] = $reasoning;
        if ($ocMsg !== '') $newMsg['oc_msg'] = $ocMsg;
        if ($canceled) {
            $newMsg['canceled'] = true;
        }
        $data['messages'][] = $newMsg;
    }
    messages_save($data, $mfp);
    push_send_later(($canceled ? '⏹ ' : '') . 'IA respondió · ' . ($sdata['sessions'][$sidIdx]['name'] ?? 'chat'), mb_substr($text, 0, 200) . (mb_strlen($text) > 200 ? '.' : ''), 'chat.php?session=' . $sid, session_bridge($sdata['sessions'][$sidIdx]));
    json_response(['ok' => true, 'id' => $aid]);
}

// ---------------------------------------------------------------------------
// Explorador de archivos del workspace (web, autenticado).
// ---------------------------------------------------------------------------
if ($action === 'browse') {
    require_login_readonly();
    $file = bridge_catalog_file(resolve_web_bridge());
    $ws = catalog_workspace_root($file);
    if ($ws === '') {
        json_response(['ok' => false, 'error' => 'El puente no ha definido un workspace'], 400);
    }
    $rel = isset($_GET['path']) ? (string)$_GET['path'] : '';
    $res = workspace_list($rel, $file);    if ($res === null) {
        json_response(['ok' => false, 'error' => 'Ruta inválida o fuera del workspace'], 400);
    }
    json_response(['ok' => true, 'workspace' => $ws, 'path' => $res['path'], 'entries' => $res['entries']]);
}

if ($action === 'read_file') {
    require_login_readonly();
    $file = bridge_catalog_file(resolve_web_bridge());
    $rel = isset($_GET['path']) ? (string)$_GET['path'] : '';
    $abs = safe_join_workspace($rel, 4, $file);
    if (!$abs || !is_file($abs)) {
        json_response(['ok' => false, 'error' => 'Archivo no encontrado'], 404);
    }
    $size = (int)@filesize($abs);
    $ext = strtolower((string)pathinfo($abs, PATHINFO_EXTENSION));
    $mimes = [
        'png' => 'image/png',
        'jpg' => 'image/jpeg',
        'jpeg' => 'image/jpeg',
        'gif' => 'image/gif',
        'webp' => 'image/webp',
        'avif' => 'image/avif',
    ];
    if (isset($mimes[$ext])) {
        // Imagen: se devuelve como data URL para previsualizarla en el lector.
        if ($size <= 0 || $size > 6 * 1024 * 1024) {
            json_response(['ok' => false, 'error' => 'Imagen demasiado grande (>6 MB) para previsualizar'], 400);
        }
        $bin = (string)@file_get_contents($abs);
        if ($bin === '') {
            json_response(['ok' => false, 'error' => 'No se pudo leer la imagen'], 400);
        }
        json_response([
            'ok' => true,
            'path' => $rel,
            'size' => $size,
            'mtime' => (int)@filemtime($abs),
            'kind' => 'image',
            'mime' => $mimes[$ext],
            'url' => 'data:' . $mimes[$ext] . ';base64,' . base64_encode($bin),
        ]);
    }
    $content = read_text_file($abs);
    if ($content === null) {
        json_response(['ok' => false, 'error' => 'Binario o demasiado grande (>512 KB)'], 400);
    }
    json_response([
        'ok' => true,
        'path' => $rel,
        'size' => $size,
        'mtime' => filemtime($abs),
        'kind' => 'text',
        'content' => $content,
    ]);
}

// ---------------------------------------------------------------------------
// Sub-comandos opencode (read-only). Se encolan y los procesa el puente.
// Cada entrada lista los tipos de argumentos que admite, por posición:
//   'arg'  → alfanumérico básico   'path' → ruta relativa segura
//   'cmd'  → línea de comando (permite espacios, sin caracteres de control)
// El puente revalida siempre (carpetas contra el workspace, binarios contra
// su whitelist), así que esto es una primera barrera, no la única.
// ---------------------------------------------------------------------------
$OC_ALLOWED = [
    'models' => [],
    'session_list' => [],
    'session_info' => ['arg'],
    'opencode_version' => [],
    'mcp_list' => [],
    'fs_list' => ['path'],
    'fs_read' => ['path'],
    // Git (solo lectura salvo checkout, que revierte cambios rastreados)
    'git_status' => ['path'],
    'git_diff' => ['path'],
    'git_checkout' => ['path', 'path'],
    // Túneles (los ejecuta el puente en la PC; arg = puerto, solo dígitos)
    'tunnel_start' => ['arg'],
    'tunnel_stop' => ['arg'],
    'tunnel_list' => [],
    // Procesos de desarrollo (dev servers) en la carpeta de una sesión
    'proc_start' => ['path', 'cmd'],
    'proc_stop' => ['arg'],
    'proc_list' => [],
    'proc_log' => ['arg', 'arg'],
    // Detección de cómo correr el proyecto en dev (read-only)
    'proc_detect' => ['path'],
    // Libera un puerto TCP (pid que escucha) cuando un dev server falla con EADDRINUSE
    'port_free' => ['arg'],
];

// Comandos que mutan algo (procesos, túneles, revertir): solo admin.
$OC_MUTATING = ['proc_start', 'proc_stop', 'tunnel_start', 'tunnel_stop', 'git_checkout'];

function oc_arg_valido($tipo, $valor) {
    $a = (string)$valor;
    if ($tipo === 'path') {
        // Ruta relativa: sin controles, sin '..' (el puente resuelve contra el workspace).
        return mb_strlen($a) <= 300 && strpos($a, '..') === false && !preg_match('/[[:cntrl:]]/', $a);
    }
    if ($tipo === 'cmd') {
        // Línea de comando: solo letras/números/espacios y puntuación neutra.
        // Sin comillas, sin $, |, &, ;, <, >, `, %, \, controles → no hay shell
        // en el puente, pero mantenemos la superficie chica.
        return mb_strlen($a) <= 200 && preg_match('/^[\p{L}\p{N} _\-.:@\/+=]{1,200}$/u', $a);
    }
    return preg_match('/^[A-Za-z0-9_\-\.\/]{1,80}$/', $a);
}

if ($action === 'run_oc') {
    $u = require_csrf();
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body)) $body = $_POST;
    $bridge = isset($body['bridge']) && is_string($body['bridge']) && bridge_valid_id($body['bridge'])
        ? $body['bridge'] : resolve_web_bridge();
    if (!ob_bridge_visible($bridge, $u)) {
        json_response(['ok' => false, 'error' => 'Permiso insuficiente'], 403);
    }
    $file = bridge_catalog_file($bridge);
    $cmd = preg_replace('/[^a-z_]/', '', strtolower((string)($body['cmd'] ?? '')));
    $args = isset($body['args']) && is_array($body['args']) ? $body['args'] : [];
    if (!isset($OC_ALLOWED[$cmd])) {
        json_response(['ok' => false, 'error' => 'Comando no permitido'], 400);
    }
    if (in_array($cmd, $OC_MUTATING, true) && ($u['role'] ?? '') !== 'admin') {
        json_response(['ok' => false, 'error' => 'Permiso insuficiente'], 403);
    }
    $spec = $OC_ALLOWED[$cmd];
    $cleanArgs = [];
    foreach ($args as $i => $a) {
        $tipo = isset($spec[$i]) ? $spec[$i] : 'arg';
        if (oc_arg_valido($tipo, $a)) $cleanArgs[] = (string)$a;
    }
    if ($spec && count($cleanArgs) !== count(array_slice($args, 0, count($spec)))) {
        // Si el comando define argumentos y alguno no pasó la validación, no encolar.
        json_response(['ok' => false, 'error' => 'Argumento inválido'], 400);
    }
    $id = enqueue_command($cmd, $cleanArgs, $file);
    json_response(['ok' => true, 'id' => $id]);
}

if ($action === 'oc_command_status') {
    require_login_readonly();
    $id = isset($_GET['id']) ? (int)$_GET['id'] : 0;
    $file = bridge_catalog_file(resolve_web_bridge());
    $cat = catalog_read($file);
    if (!isset($cat['commands']) || !is_array($cat['commands'])) {
        json_response(['ok' => false, 'error' => 'no existe'], 404);
    }
    foreach ($cat['commands'] as $c) {
        if ((int)$c['id'] === $id) {
            json_response([
                'ok' => true,
                'status' => $c['status'],
                'result' => isset($c['result']) ? $c['result'] : null,
                'error' => isset($c['error']) ? $c['error'] : '',
            ]);
        }
    }
    json_response(['ok' => false, 'error' => 'no existe'], 404);
}

// listar sesiones (las que están en opencode, vinculadas por opencode_session)
if ($action === 'oc_sessions') {
    require_login_readonly();
    json_response(['ok' => true, 'sessions' => oc_sessions_list()]);
}

if ($action === 'oc_session_attach') {
    require_login();
    require_csrf();
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body)) $body = $_POST;
    $opencodeSession = trim((string)($body['opencode_session'] ?? ''));
    $name = trim((string)($body['name'] ?? ''));
    $folder = (string)($body['folder'] ?? '');
    $model = (string)($body['model'] ?? '');
    $agent = (string)($body['agent'] ?? 'build');
    $bridge = isset($body['bridge']) && is_string($body['bridge']) && bridge_valid_id($body['bridge'])
        ? $body['bridge'] : resolve_web_bridge();
    $file = bridge_catalog_file($bridge);
    if ($opencodeSession === '') {
        json_response(['ok' => false, 'error' => 'opencode_session requerido'], 400);
    }
    if ($folder !== '' && folder_path_in_catalog($folder, $file) === null) {
        json_response(['ok' => false, 'error' => 'Carpeta no disponible'], 400);
    }
    if ($model !== '' && !model_in_catalog($model, $file)) {
        json_response(['ok' => false, 'error' => 'Modelo no disponible'], 400);
    }
    if ($agent !== '' && !agent_in_catalog($agent, $file)) {
        json_response(['ok' => false, 'error' => 'Agente no disponible'], 400);
    }
    $id = add_session($name !== '' ? $name : 'Opencode ' . substr($opencodeSession, 0, 8), $folder, $model, $agent, $opencodeSession, $bridge);
    json_response(['ok' => true, 'session' => get_session($id)]);
}

// ---------------------------------------------------------------------------
// Búsqueda global en el historial.
// ---------------------------------------------------------------------------
if ($action === 'search_index') {
    require_login_readonly();
    $q = isset($_GET['q']) ? (string)$_GET['q'] : '';
    json_response(['ok' => true, 'results' => search_index_build($q)]);
}

// ---------------------------------------------------------------------------
// Emparejamiento de PCs (device code). La PC pide un codigo, el usuario lo
// tipea en la web y la PC recibe su token propio. Solo el hub PHP lo tiene.
// ---------------------------------------------------------------------------
if ($action === 'bridge_pair_start') {
    $ip = $_SERVER['REMOTE_ADDR'] ?? 'x';
    if (!ob_pair_rate_ok('start|' . $ip, 20, 600)) {
        json_response(['ok' => false, 'error' => 'Demasiados intentos, espera un rato'], 429);
    }
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body)) $body = $_POST;
    $res = ob_pair_start((string)($body['bridge_id'] ?? ''), (string)($body['bridge_name'] ?? ''));
    $verify = APP_BASE_URL !== '' ? APP_BASE_URL . '/chat.php' : '';
    json_response(['ok' => true, 'user_code' => $res['code'], 'device_code' => $res['device_code'], 'expires_in' => $res['expires_in'], 'verify_url' => $verify]);
}

if ($action === 'bridge_pair_poll') {
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body)) $body = $_POST;
    $device = trim((string)($body['device_code'] ?? ''));
    if ($device === '') {
        json_response(['ok' => false, 'error' => 'device_code requerido'], 400);
    }
    $res = ob_pair_poll($device);
    if ($res['status'] === 'approved') {
        json_response(['ok' => true, 'status' => 'approved', 'bridge_id' => $res['bridge_id'], 'bridge_name' => $res['bridge_name'], 'bridge_token' => $res['bridge_token']]);
    }
    json_response(['ok' => true, 'status' => $res['status']]);
}

if ($action === 'bridge_pair_approve') {
    $u = require_csrf();
    if (!ob_pair_rate_ok('approve|' . $u['id'], 10, 900)) {
        json_response(['ok' => false, 'error' => 'Demasiados intentos, espera un rato'], 429);
    }
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body)) $body = $_POST;
    $res = ob_pair_approve((string)($body['user_code'] ?? ''), $u);
    if (empty($res['ok'])) {
        json_response(['ok' => false, 'error' => $res['error'] ?? 'Codigo invalido'], 400);
    }
    json_response(['ok' => true, 'bridge' => $res['bridge']]);
}

// Lista de PCs del usuario (admin ve todas).
if ($action === 'bridges') {
    $u = require_login_readonly();
    json_response(['ok' => true, 'bridges' => ob_bridges_list($u)]);
}

if ($action === 'bridge_revoke') {
    $u = require_csrf();
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body)) $body = $_POST;
    $id = trim((string)($body['id'] ?? ''));
    if (!bridge_valid_id($id)) {
        json_response(['ok' => false, 'error' => 'id invalido'], 400);
    }
    if (!ob_bridge_revoke($id, $u)) {
        json_response(['ok' => false, 'error' => 'No se pudo desvincular'], 403);
    }
    json_response(['ok' => true]);
}

// ---------------------------------------------------------------------------
// Server-Sent Events: stream de eventos para la UI.
// Emite 'catalog' cuando cambian los datos relevantes (ignora last_online_ts
// que cambia con cada heartbeat) y 'sessions_changed' cuando cambia el JSON.
// La conexión dura como máximo 25 s; el cliente (EventSource) re-conecta
// automáticamente. Esto evita que un worker quede ocupado indefinidamente
// (importante en `php -S` single-threaded).
// ---------------------------------------------------------------------------
if ($action === 'stream') {
    require_login_readonly();
    @ini_set('display_errors', '0');
    header('Content-Type: text/event-stream');
    header('Cache-Control: no-cache');
    header('Connection: keep-alive');
    header('X-Accel-Buffering: no');
    @ini_set('output_buffering', '0');
    while (ob_get_level() > 0) @ob_end_flush();
    @ob_implicit_flush(true);
    @set_time_limit(30);
    $started = time();
    $maxRuntime = 25; // cortamos la conexión antes del timeout de PHP
    $loopMs = 1000;   // 1 s por vuelta (antes 500 ms): la mitad de lecturas
    $lastRegSig = '';
    $lastBusySig = '';
    $lastCatSigs = [];
    $lastSessionsSig = '';
    $lastMsgScanSec = 0;
    $lastMsgMaxTs = 0;
    $lastSessNotifyAt = 0;
    $loopN = 0;
    $send = function ($event, $data) {
        echo 'event: ' . $event . "\n";
        echo 'data: ' . json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n\n";
        @flush();
    };
    // Firma barata (mtime+size): evita leer el archivo entero en cada vuelta.
    $sigOf = function ($path) {
        $mt = @filemtime($path);
        if ($mt === false) return '';
        $sz = @filesize($path);
        return $mt . ':' . ($sz === false ? 0 : $sz);
    };
    $send('hello', ['now' => gmdate('c')]);
    while (true) {
        if (connection_aborted()) break;
        if ((time() - $started) >= $maxRuntime) {
            // Cortamos la conexión: EventSource re-conecta solo.
            $send('bye', ['ts' => gmdate('c')]);
            break;
        }
        // Estado en vivo por puente (bridges.json): heartbeat/cambios de sesión
        // en ejecución. Evento liviano 'online' con el resumen de puentes para
        // que la web pinte el selector; si cambia quién está "trabajando", se
        // avisa además con sessions_changed (las listas recalculan estados).
        // Solo se parsea/lee si la firma (mtime+size) cambio.
        $regSig = $sigOf(BRIDGES_FILE);
        if ($regSig !== $lastRegSig) {
            $lastRegSig = $regSig;
            if ($regSig !== '') {
                $sum = bridges_summary();
                $busyParts = [];
                foreach ($sum as $b) {
                    $busyParts[] = $b['id'] . '=' . ($b['busy_session'] ?? '');
                }
                $busySig = md5(implode('|', $busyParts));
                $send('online', ['ts' => gmdate('c'), 'bridges' => $sum]);
                if ($busySig !== $lastBusySig) {
                    $lastBusySig = $busySig;
                    $send('sessions_changed', ['ts' => gmdate('c'), 'busy' => true]);
                }
            }
        }
        // Catálogo de algún puente cambió (carpetas/modelos/etc): aviso con el
        // id para que la web recargue solo si el puente activo es ese.
        foreach ((glob(DATA_DIR . '/catalog*.json') ?: []) as $f) {
            $sigF = $sigOf($f);
            if (!isset($lastCatSigs[$f])) {
                $lastCatSigs[$f] = $sigF;
                continue;
            }
            if ($lastCatSigs[$f] !== $sigF) {
                $lastCatSigs[$f] = $sigF;
                $base = basename($f);
                $id = $base === 'catalog.json' ? '' : preg_replace('/^catalog-|\.json$/', '', $base);
                $send('catalog', ['bridge' => (string)$id]);
            }
        }
        $sessSig = $sigOf(SESSIONS_FILE);
        if ($sessSig !== $lastSessionsSig) {
            $lastSessionsSig = $sessSig;
            if ($sessSig !== '') $send('sessions_changed', ['ts' => gmdate('c')]);
        }
        // Un mensaje en curso (pending→processing→streaming→done) cambia su
        // messages-<id>.json sin tocar sessions.json. Para que las listas
        // muestren en vivo qué sesiones están trabajando, avisamos con el
        // mismo evento cuando cambia el archivo de mensajes más reciente
        // (muestreo cada 2 s, aviso mínimo cada 2 s para no inundar).
        $nowSec = time();
        if (($nowSec - $lastMsgScanSec) >= 2) {
            $lastMsgScanSec = $nowSec;
            $maxTs = 0;
            foreach ((glob(DATA_DIR . '/messages-*.json') ?: []) as $f) {
                $mt = (int)@filemtime($f);
                if ($mt > $maxTs) $maxTs = $mt;
            }
            if ($maxTs !== $lastMsgMaxTs) {
                $lastMsgMaxTs = $maxTs;
                if (($nowSec - $lastSessNotifyAt) >= 2) {
                    $lastSessNotifyAt = $nowSec;
                    $send('sessions_changed', ['ts' => gmdate('c'), 'msgs' => true]);
                }
            }
        }
        // Keep-alive cada ~5 s para que proxies del hosting no corten la conexión.
        if ((++$loopN % 5) === 0) {
            $send('ping', ['ts' => gmdate('c')]);
        }
        usleep($loopMs * 1000); // 1 s
    }
    exit;
}

json_response(['ok' => false, 'error' => 'Acción no válida'], 400);