<?php
/**
 * Funciones compartidas: sesiones, mensajes por sesión, catálogo (carpetas/modelos),
 * sesión web, token del puente, CSRF y avisos push (Web Push).
 *
 * Datos (en data/, sin base de datos):
 *   sessions.json          → lista de conversaciones (metadata)
 *   catalog.json           → carpetas y modelos sincronizados por el puente
 *   messages-<id>.json     → historial de cada conversación
 */

function json_response($data, $code = 200) {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

// ---------------------------------------------------------------------------
// Lectura/escritura con bloqueo de archivos JSON.
// ---------------------------------------------------------------------------
function json_read($path, &$fp = null) {
    $fp = @fopen($path, 'c+');
    if (!$fp) {
        return null;
    }
    flock($fp, LOCK_EX);
    $content = stream_get_contents($fp);
    $data = json_decode($content, true);
    if (!is_array($data)) {
        $data = [];
    }
    return $data;
}

function json_save($data, $fp) {
    ftruncate($fp, 0);
    rewind($fp);
    fwrite($fp, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
    fflush($fp);
    flock($fp, LOCK_UN);
    fclose($fp);
}

function json_done($fp) {
    flock($fp, LOCK_UN);
    fclose($fp);
}

// Marca "hay trabajo nuevo" (send / comandos / carpetas). El long-poll del
// puente mira el mtime de este archivo para no releer todos los mensajes en
// cada vuelta: solo hace el escaneo completo cuando el aviso cambio.
function ob_wake() {
    @touch(WAKE_FILE);
}

// ¿Hubo un aviso nuevo desde $since? (barato: un stat).
function poll_wake_changed($since) {
    $mt = @filemtime(WAKE_FILE);
    return $mt !== false && $mt >= (int)$since;
}

// ---------------------------------------------------------------------------
// Puentes (computadoras): identidad y registro de estado en vivo.
//
// El hosting puede atender N puentes a la vez (una PC cada uno, mismo data/).
// Cada puente se identifica con un id (header X-Bridge-Id) y tiene:
//   - un archivo de catálogo propio (carpetas/modelos/workspace/colas):
//     catalog.json para el puente '' (legacy) o catalog-<id>.json.
//   - una entrada en el registro BRIDGES_FILE con su estado en vivo
//     (online / busy), que usa la web para el selector y los indicadores.
// Una sesión web guarda a qué puente pertenece (`bridge`); el poll solo
// reclama mensajes de las sesiones del puente que los pide.
// ---------------------------------------------------------------------------
if (!defined('BRIDGES_FILE')) {
    define('BRIDGES_FILE', DATA_DIR . '/bridges.json');
}

function bridge_valid_id($id) {
    return is_string($id) && $id !== ''
        && preg_match('/^[A-Za-z0-9][A-Za-z0-9._\-]{0,39}$/', $id) === 1;
}

// Id del puente que origina este request: header X-Bridge-Id (puente real)
// o, para la web, el query ?bridge=<id> (la PC seleccionada en el sidebar).
function resolve_request_bridge() {
    // Con token por PC, el id sale de la identidad (no se puede falsificar el
    // header X-Bridge-Id para hacerse pasar por otra PC).
    $ident = $GLOBALS['OB_BRIDGE_IDENTITY'] ?? null;
    if (is_array($ident) && !empty($ident['id']) && bridge_valid_id($ident['id'])) {
        return $ident['id'];
    }
    $h = '';
    foreach ($_SERVER as $name => $value) {
        if (strtoupper($name) === 'HTTP_X_BRIDGE_ID' && is_string($value)) {
            $h = trim($value);
            break;
        }
    }
    if (!bridge_valid_id($h) && isset($_GET['bridge'])) {
        $h = trim((string)$_GET['bridge']);
    }
    return bridge_valid_id($h) ? $h : '';
}

// Nombre legible del puente (header X-Bridge-Name), saneado.
function request_bridge_name() {
    foreach ($_SERVER as $name => $value) {
        if (strtoupper($name) === 'HTTP_X_BRIDGE_NAME' && is_string($value)) {
            $v = trim($value);
            return mb_substr(preg_replace('/[^\p{L}\p{N} ._\-]/u', '', $v), 0, 40);
        }
    }
    return '';
}

// Archivo de catálogo de un puente: '' usa el catalog.json legacy.
function bridge_catalog_file($id) {
    if (!bridge_valid_id($id)) return CATALOG_FILE;
    return DATA_DIR . '/catalog-' . preg_replace('/[^A-Za-z0-9._\-]/', '', $id) . '.json';
}

// Registro de puentes: estado en vivo (no el catálogo).
function bridges_default() {
    return ['version' => 1, 'bridges' => []];
}

// Lectura-modificación-escritura atómica genérica con mutex por archivo.
function file_lock_modify($path, $defFn, $fn) {
    $lock = $path . '.lock';
    $acquired = false;
    for ($i = 0; $i < 400; $i++) { // ~10 s esperando el mutex
        if (@mkdir($lock)) { $acquired = true; break; }
        clearstatcache(true, $lock);
        $age = is_dir($lock) ? (time() - (int)@filemtime($lock)) : 0;
        if ($age > 10) { @rmdir($lock); continue; }
        usleep(25000);
    }
    if (!$acquired) return false;
    try {
        $data = json_decode((string)@file_get_contents($path), true);
        if (!is_array($data)) $data = [];
        $def = $defFn();
        foreach ($def as $k => $v) {
            if (!isset($data[$k])) $data[$k] = $v;
        }
        if ($fn($data) === false) return false;
        $tmp = $path . '.' . getmypid() . '.' . mt_rand() . '.tmp';
        $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);
        if ($json === false || @file_put_contents($tmp, $json) === false) {
            @unlink($tmp);
            return false;
        }
        if (!@rename($tmp, $path)) {
            @unlink($tmp);
            return false;
        }
        return $data;
    } finally {
        @rmdir($lock);
    }
}

function bridges_modify($fn) {
    $r = file_lock_modify(BRIDGES_FILE, 'bridges_default', $fn);
    if ($r !== false) bridges_cache_forget();
    return $r;
}

// Cache por request del registro de puentes: bridges_summary() y los helpers de
// estado lo leen muchas veces por request (O(P^2) antes). Se invalida al
// escribir (bridges_modify y los writers de hub.php).
function bridges_cache_forget() {
    $GLOBALS['OB_BRIDGES_CACHE'] = null;
}

// Mapa id => entrada del registro (sin locks persistentes).
function bridges_map() {
    $mt = @filemtime(BRIDGES_FILE);
    $sz = @filesize(BRIDGES_FILE);
    if ($mt !== false && is_array($GLOBALS['OB_BRIDGES_CACHE'] ?? null)
        && $GLOBALS['OB_BRIDGES_CACHE']['mt'] === $mt
        && $GLOBALS['OB_BRIDGES_CACHE']['sz'] === $sz) {
        return $GLOBALS['OB_BRIDGES_CACHE']['data'];
    }
    $data = json_read(BRIDGES_FILE, $fp);
    if ($fp) json_done($fp);
    $map = (is_array($data) && isset($data['bridges']) && is_array($data['bridges'])) ? $data['bridges'] : [];
    if ($mt !== false) {
        $GLOBALS['OB_BRIDGES_CACHE'] = ['mt' => $mt, 'sz' => $sz, 'data' => $map];
    }
    return $map;
}

// Upsert de un puente en el registro: heartbeat, sync_catalog, poll.
// El id '' es el puente legacy (bridge viejo, sin X-Bridge-Id). Una vez que
// existe un puente real, el legacy ya no late: sus heartbeats se ignoran (se
// retiró su entrada para que no reaparezca en el selector).
function bridge_registry_upsert($id, $name, $busy = null, $busySession = 0) {
    if (!is_string($id) || ($id !== '' && !bridge_valid_id($id))) return false;
    if ($id === '') {
        $hasReal = false;
        foreach (bridges_map() as $k => $v) {
            if ((string)$k !== '') { $hasReal = true; break; }
        }
        if ($hasReal) return false;
        if ($name === '') $name = 'Puente';
    }
    bridges_modify(function (&$reg) use ($id, $name, $busy, $busySession) {
        if (!isset($reg['bridges'][$id]) || !is_array($reg['bridges'][$id])) {
            $reg['bridges'][$id] = ['id' => $id];
        }
        $e = &$reg['bridges'][$id];
        if ($name !== '') $e['name'] = $name;
        $e['last_online_ts'] = gmdate('c');
        if ($busy !== null) {
            $busySession = (int)$busySession;
            if ($busy && $busySession > 0) {
                $e['busy_session'] = $busySession;
                $e['busy_since'] = gmdate('c');
            } else {
                $e['busy_session'] = null;
                $e['busy_since'] = null;
            }
        }
    });
    return true;
}

// Entrada de un puente en el registro (con defaults).
function bridge_registry_get($id) {
    $map = bridges_map();
    if (!isset($map[$id]) || !is_array($map[$id])) return null;
    return $map[$id];
}

// ¿El puente $id late? (heartbeat hace < 120 s).
function bridge_online_live($id) {
    $e = bridge_registry_get($id);
    if ($e === null) return false;
    $ts = isset($e['last_online_ts']) ? (string)$e['last_online_ts'] : '';
    if ($ts === '') return false;
    return (time() - (int)@strtotime($ts)) <= 120;
}

// Sesión que el puente $id está ejecutando AHORA, o null.
function bridge_busy_session($id) {
    $e = bridge_registry_get($id);
    if ($e === null) return null;
    $sid = isset($e['busy_session']) ? (int)$e['busy_session'] : 0;
    $ts = isset($e['busy_since']) ? (string)$e['busy_since'] : '';
    if ($sid <= 0 || $ts === '') return null;
    if ((time() - (int)@strtotime($ts)) > 120) return null;
    return $sid;
}

// Resumen para la web: lista de puentes con su estado en vivo. Filtrado por
// dueño: un usuario comun ve solo sus PCs; el admin ve todas.
function bridges_summary() {
    $map = bridges_map();
    $user = ob_current_user();
    $out = [];
    foreach ($map as $id => $e) {
        $id = (string)$id;
        if ($user && !ob_bridge_visible($id, $user)) continue;
        $label = (isset($e['name']) && $e['name'] !== '') ? $e['name'] : ($id === '' ? 'Puente' : $id);
        $out[] = [
            'id' => $id,
            'name' => $label,
            'owner' => $e['owner'] ?? null,
            'online' => bridge_online_live($id),
            'busy_session' => bridge_busy_session($id),
            'last_online_ts' => isset($e['last_online_ts']) ? (string)$e['last_online_ts'] : '',
        ];
    }
    usort($out, function ($a, $b) {
        return strcmp($a['id'], $b['id']);
    });
    return $out;
}

// Único puente registrado (para caer en él cuando la web no pide bridge).
function sole_bridge_id() {
    $map = bridges_map();
    $user = ob_current_user();
    $ids = [];
    foreach ($map as $id => $e) {
        $id = (string)$id;
        if ($user && !ob_bridge_visible($id, $user)) continue;
        $ids[] = $id;
    }
    return count($ids) === 1 ? $ids[0] : '';
}

// Copia del catálogo con el estado en vivo del puente $id superpuesto (para
// que la respuesta al browser tenga la forma de siempre: last_online_ts, etc).
// El cat_ver se calcula SIEMPRE sobre el archivo, sin estos campos vivos.
function bridge_live_overlay($cat, $id) {
    $e = bridge_registry_get($id);
    if ($e === null) return $cat;
    $cat['last_online_ts'] = isset($e['last_online_ts']) ? (string)$e['last_online_ts'] : '';
    $cat['busy_session'] = isset($e['busy_session']) && $e['busy_session'] ? (int)$e['busy_session'] : null;
    $cat['busy_since'] = isset($e['busy_since']) ? (string)$e['busy_since'] : null;
    return $cat;
}

// Id efectivo de un request web: ?bridge= o, si no hay nada registrado todavía,
// el puente legacy (''). Con un solo puente registrado, se usa ese.
function resolve_web_bridge() {
    $b = resolve_request_bridge();
    $user = ob_current_user();
    if ($b !== '') {
        // Un usuario no puede pedir la PC de otro.
        if ($user && !ob_bridge_visible($b, $user)) {
            json_response(['ok' => false, 'error' => 'Permiso insuficiente'], 403);
        }
        return $b;
    }
    return sole_bridge_id();
}

// Asigna el dueño $id a todas las sesiones que todavía no lo tienen. Es la
// migración del mundo "un solo puente" (los chats de antes no guardaban owner).
function adopt_sessions_to_bridge($id) {
    if (!bridge_valid_id($id)) return;
    $data = sessions_read($fp);
    $changed = false;
    foreach ($data['sessions'] as &$s) {
        if (session_bridge($s) === '') {
            $s['bridge'] = $id;
            $changed = true;
        }
    }
    unset($s);
    if ($changed) sessions_save($data, $fp);
    else json_done($fp);
}

// Primer puente real que se registra en el hosting: era el único PC histórico,
// así que hereda el catálogo legacy (data/catalog.json) y los chats sin dueño.
// También retira la entrada legacy '' del registro (puente viejo sin id).
function bridge_register_first($id, $name) {
    if (!bridge_valid_id($id)) return false;
    $map = bridges_map();
    if (isset($map[$id])) return false;
    $onlyLegacy = (count($map) === 1 && array_key_exists('', $map));
    if (count($map) > 0 && !$onlyLegacy) return false; // no es el primero
    $file = bridge_catalog_file($id);
    if (!file_exists($file) && file_exists(CATALOG_FILE)) {
        @copy(CATALOG_FILE, $file);
    }
    adopt_sessions_to_bridge($id);
    bridges_modify(function (&$reg) use ($id, $name) {
        if (array_key_exists('', $reg['bridges'])) {
            unset($reg['bridges']['']);
        }
        if (!isset($reg['bridges'][$id]) || !is_array($reg['bridges'][$id])) {
            $reg['bridges'][$id] = ['id' => $id];
        }
        $reg['bridges'][$id]['name'] = $name;
        $reg['bridges'][$id]['last_online_ts'] = gmdate('c');
    });
    return true;
}

// ¿El puente $id puede ejecutar mensajes de la sesión $sess? Las sesiones sin
// dueño (legacy) se asignan al puente cuya carpeta las contiene; así nunca se
// le entregan a una PC que no tiene ese proyecto.
function bridge_can_claim_session($id, $sess) {
    $owner = session_bridge($sess);
    if ($owner !== '') return $owner === $id;
    if (!bridge_valid_id($id)) return true; // puente legacy: reclama lo suyo
    $folder = isset($sess['folder']) ? (string)$sess['folder'] : '';
    if ($folder === '') return true;        // sin carpeta: nadie puede correrla
    $cat = catalog_read(bridge_catalog_file($id));
    foreach ($cat['folders'] as $f) {
        if (is_array($f) && ($f['path'] ?? '') === $folder) return true;
        if (is_string($f) && $f === $folder) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Indice de sesiones (proxy) y fetch efimero (historial): el hub no guarda
// conversaciones; el puente manda metadatos y sirve el historial on demand.
// ---------------------------------------------------------------------------
function session_index_file($bridge = '') {
    $id = bridge_valid_id($bridge) ? preg_replace('/[^A-Za-z0-9._-]/', '', $bridge) : '';
    return $id === '' ? DATA_DIR . '/index.json' : DATA_DIR . '/index-' . $id . '.json';
}
function history_fetch_file($id) {
    return DATA_DIR . '/fetch-' . (int)$id . '.json';
}
function session_index_sync($bridge, $sessions, $totals = []) {
    $list = [];
    $indexSet = [];
    foreach ((array)$sessions as $s) {
        if (!is_array($s)) continue;
        $id = trim((string)($s['id'] ?? ''));
        if (!preg_match('/^ses_[A-Za-z0-9]{4,64}$/', $id)) continue;
        $list[] = [
            'id' => $id,
            'title' => mb_substr((string)($s['title'] ?? ''), 0, 120),
            'folder' => mb_substr((string)($s['folder'] ?? ''), 0, 500),
            'updated' => (string)($s['updated'] ?? ''),
        ];
        $indexSet[$id] = true;
        if (count($list) >= 5000) break;
    }
    // Total de sesiones por carpeta conectada: la web lo usa para saber si hay
    // mas sesiones para pedir ("Ver mas sesiones").
    $tot = [];
    if (is_array($totals)) {
        foreach ($totals as $k => $v) {
            $k = trim((string)$k);
            if ($k === '') continue;
            $tot[mb_substr($k, 0, 500)] = max(0, (int)$v);
        }
    }
    $fp = null;
    json_read(session_index_file($bridge), $fp);
    json_save(['sessions' => $list, 'totals' => $tot, 'ts' => gmdate('c')], $fp);
    // Alta/actualizacion de las sesiones de opencode en el registro del hub
    // (metadatos, sin historial) para que aparezcan en el sidebar.
    $sdata = sessions_read($sfp);
    foreach ($list as $it) {
        $uts = ($it['updated'] !== '' && @strtotime($it['updated'])) ? gmdate('c', @strtotime($it['updated'])) : '';
        $foundIdx = -1;
        foreach ($sdata['sessions'] as $i => $s) {
            if (!empty($s['opencode_session']) && (string)$s['opencode_session'] === $it['id']) { $foundIdx = $i; break; }
        }
        if ($foundIdx >= 0) {
            $s = &$sdata['sessions'][$foundIdx];
            if ($it['title'] !== '' && !session_name_placeholder($it['title'])) $s['name'] = $it['title'];
            if ($it['folder'] !== '' && (string)($s['folder'] ?? '') !== $it['folder']) $s['folder'] = $it['folder'];
            $s['importada'] = true;
            if ($uts !== '' && (string)($s['last_ts'] ?? '') < $uts) $s['last_ts'] = $uts;
            if (bridge_valid_id($bridge) && session_bridge($s) === '') $s['bridge'] = $bridge;
            unset($s);
        } else {
            $id = (int)$sdata['nextId'];
            $sdata['nextId'] = $id + 1;
            $ts = $uts !== '' ? $uts : gmdate('c');
            $sess = [
                'id' => $id,
                'name' => $it['title'] !== '' ? $it['title'] : ('Opencode ' . substr($it['id'], 0, 8)),
                'folder' => $it['folder'],
                'model' => '',
                'agent' => 'build',
                'created_ts' => $ts,
                'last_ts' => $ts,
                'opencode_session' => $it['id'],
                'importada' => true,
            ];
            if (bridge_valid_id($bridge)) $sess['bridge'] = $bridge;
            $sdata['sessions'][] = $sess;
        }
    }
    // Poda: el indice es autoritativo (el puente manda solo las sesiones de los
    // proyectos conectados, cortadas a las mas recientes). Las importadas de
    // este puente que ya no vienen se borran para que el sidebar refleje la PC
    // y no acumule sesiones fantasma.
    $sole = sole_bridge_id();
    $keep = [];
    $del = [];
    foreach ($sdata['sessions'] as $s) {
        $oc = isset($s['opencode_session']) ? (string)$s['opencode_session'] : '';
        $owner = session_bridge($s);
        $mine = ($owner === $bridge) || ($owner === '' && $sole === $bridge);
        if ($mine && !empty($s['importada']) && $oc !== '' && !isset($indexSet[$oc])) {
            $del[] = (int)$s['id'];
            continue;
        }
        $keep[] = $s;
    }
    if ($del) {
        $sdata['sessions'] = $keep;
        foreach ($del as $id) { @unlink(session_messages_file($id)); }
    }
    sessions_save($sdata, $sfp);
    return count($list);
}
function session_index_list($bridge) {
    $fp = null;
    $data = json_read(session_index_file($bridge), $fp);
    if ($fp) json_done($fp);
    return (is_array($data) && isset($data['sessions']) && is_array($data['sessions'])) ? $data['sessions'] : [];
}
function session_index_totals($bridge) {
    $fp = null;
    $data = json_read(session_index_file($bridge), $fp);
    if ($fp) json_done($fp);
    return (is_array($data) && isset($data['totals']) && is_array($data['totals'])) ? $data['totals'] : [];
}

// Marcador de reset: lo escribe el deploy (`clean`/`reset --wipe-data`) para que
// el puente desconecte los proyectos y el sidebar quede en blanco. El puente lo
// ve en el poll, limpia sus carpetas activas y confirma con `reset_ack`.
function bridge_reset_marker() {
    return DATA_DIR . '/.reset';
}
function bridge_reset_pending() {
    return @file_exists(bridge_reset_marker());
}
function bridge_reset_request() {
    $ok = @file_put_contents(bridge_reset_marker(), gmdate('c'));
    if ($ok !== false) @chmod(bridge_reset_marker(), 0664);
    return $ok !== false;
}
function bridge_reset_clear() {
    @unlink(bridge_reset_marker());
}
function history_ready($id, $payload) {
    $fp = null;
    json_read(history_fetch_file($id), $fp);
    json_save(is_array($payload) ? $payload : [], $fp);
    // Limpia fetches viejos que el cliente no llego a tomar (evita basura).
    foreach ((array)@glob(DATA_DIR . '/fetch-*.json') as $f) {
        if (@filemtime($f) < time() - 600) @unlink($f);
    }
}
function history_take($id) {
    $file = history_fetch_file($id);
    $fp = null;
    $data = json_read($file, $fp);
    if ($fp) json_done($fp);
    @unlink($file);
    return is_array($data) && $data ? $data : null;
}

// ---------------------------------------------------------------------------
// Cola de salida (transitoria) e inflight (turno en curso). El hub no guarda
// historial: la conversacion vive en opencode y se sirve por proxy.
// ---------------------------------------------------------------------------
function queue_file($bridge = '') {
    $id = bridge_valid_id($bridge) ? preg_replace('/[^A-Za-z0-9._-]/', '', $bridge) : '';
    return $id === '' ? DATA_DIR . '/queue.json' : DATA_DIR . '/queue-' . $id . '.json';
}
function inflight_file($bridge = '') {
    $id = bridge_valid_id($bridge) ? preg_replace('/[^A-Za-z0-9._-]/', '', $bridge) : '';
    return $id === '' ? DATA_DIR . '/inflight.json' : DATA_DIR . '/inflight-' . $id . '.json';
}
function queue_read($bridge) {
    $fp = null;
    $data = json_read(queue_file($bridge), $fp);
    if ($fp) json_done($fp);
    if (!is_array($data)) $data = [];
    if (!isset($data['items']) || !is_array($data['items'])) $data['items'] = [];
    if (!isset($data['nextId'])) $data['nextId'] = 1;
    return $data;
}
function queue_save($bridge, $data) {
    $fp = null;
    json_read(queue_file($bridge), $fp);
    json_save($data, $fp);
}
function queue_add($bridge, $item) {
    $data = queue_read($bridge);
    $id = (int)$data['nextId'];
    $data['nextId'] = $id + 1;
    $data['items'][] = array_merge(['id' => $id, 'status' => 'pending', 'ts' => gmdate('c')], is_array($item) ? $item : []);
    if (count($data['items']) > 500) $data['items'] = array_slice($data['items'], -500);
    queue_save($bridge, $data);
    ob_wake();
    return $id;
}
function queue_claim($bridge, $cutoffSeconds) {
    $data = queue_read($bridge);
    $out = [];
    $keep = [];
    $now = time();
    foreach ($data['items'] as $it) {
        $status = $it['status'] ?? '';
        if (!empty($it['cancel_requested']) && $status === 'pending') continue;
        $stale = $status === 'processing' && isset($it['ts']) && (strtotime($it['ts']) < ($now - (int)$cutoffSeconds));
        if ($status === 'pending' || $stale) {
            $it['status'] = 'processing';
            $it['ts'] = gmdate('c');
            $out[] = $it;
        }
        $keep[] = $it;
    }
    $data['items'] = $keep;
    queue_save($bridge, $data);
    return $out;
}
function queue_remove($bridge, $id) {
    $data = queue_read($bridge);
    $data['items'] = array_values(array_filter($data['items'], function ($it) use ($id) {
        return (int)($it['id'] ?? 0) !== (int)$id;
    }));
    queue_save($bridge, $data);
}
function queue_cancel($bridge, $id) {
    $data = queue_read($bridge);
    foreach ($data['items'] as &$it) {
        if ((int)($it['id'] ?? 0) === (int)$id) $it['cancel_requested'] = true;
    }
    unset($it);
    queue_save($bridge, $data);
}
function queue_for_session($bridge, $sessionId) {
    $data = queue_read($bridge);
    $sid = (int)$sessionId;
    $out = [];
    foreach ($data['items'] as $it) {
        if ((int)($it['session'] ?? 0) === $sid) $out[] = $it;
    }
    return $out;
}
function inflight_set($bridge, $payload) {
    $fp = null;
    json_read(inflight_file($bridge), $fp);
    json_save(is_array($payload) ? $payload : [], $fp);
}
function inflight_get($bridge) {
    $fp = null;
    $data = json_read(inflight_file($bridge), $fp);
    if ($fp) json_done($fp);
    return is_array($data) && $data ? $data : null;
}
function inflight_clear($bridge) {
    @unlink(inflight_file($bridge));
}

// ---------------------------------------------------------------------------
// Sesiones (conversaciones).
// ---------------------------------------------------------------------------
function sessions_read(&$fp = null) {
    $data = json_read(SESSIONS_FILE, $fp);
    if (!is_array($data) || !isset($data['sessions'])) {
        $data = ['sessions' => [], 'nextId' => 1];
    }
    return $data;
}

function sessions_save($data, $fp) {
    json_save($data, $fp);
}

function session_messages_file($sid) {
    return DATA_DIR . '/messages-' . (int)$sid . '.json';
}

function find_session_ref(&$data, $id) {
    foreach ($data['sessions'] as &$sess) {
        if ((int)$sess['id'] === (int)$id) {
            return $sess;
        }
    }
    return null;
}

function get_session($id) {
    $data = sessions_read($fp);
    $sess = find_session_ref($data, $id);
    json_done($fp);
    return $sess;
}

function add_session($name, $folder, $model, $agent = 'build', $opencodeSession = null, $bridge = '') {
    $data = sessions_read($fp);
    $id = $data['nextId'];
    $data['nextId'] = $id + 1;
    $sess = [
        'id' => $id,
        'name' => $name !== '' ? $name : 'Chat ' . $id,
        'folder' => (string)$folder,
        'model' => (string)$model,
        'agent' => (string)$agent,
        'created_ts' => gmdate('c'),
        'last_ts' => gmdate('c'),
        'opencode_session' => $opencodeSession,
    ];
    if (bridge_valid_id($bridge)) $sess['bridge'] = $bridge;
    $data['sessions'][] = $sess;
    sessions_save($data, $fp);
    @touch(session_messages_file($id));
    return $id;
}

// Dueño de una sesión ('' si es legacy, sin puente asignado).
function session_bridge($sess) {
    $b = isset($sess['bridge']) ? (string)$sess['bridge'] : '';
    return bridge_valid_id($b) ? $b : '';
}

function update_session($id, $folder, $model, $opencodeSession = null) {
    $data = sessions_read($fp);
    $idx = -1;
    foreach ($data['sessions'] as $i => $s) {
        if ((int)$s['id'] === (int)$id) {
            $idx = $i;
            break;
        }
    }
    if ($idx < 0) {
        json_done($fp);
        return false;
    }
    if (is_string($folder)) {
        $data['sessions'][$idx]['folder'] = $folder;
    }
    if (is_string($model)) {
        $data['sessions'][$idx]['model'] = $model;
    }
    if (is_string($opencodeSession)) {
        $data['sessions'][$idx]['opencode_session'] = $opencodeSession;
    }
    $data['sessions'][$idx]['last_ts'] = gmdate('c');
    sessions_save($data, $fp);
    return true;
}

function touch_session($id) {
    $data = sessions_read($fp);
    $idx = -1;
    foreach ($data['sessions'] as $i => $s) {
        if ((int)$s['id'] === (int)$id) {
            $idx = $i;
            break;
        }
    }
    if ($idx < 0) {
        json_done($fp);
        return;
    }
    $data['sessions'][$idx]['last_ts'] = gmdate('c');
    sessions_save($data, $fp);
}

function session_rename($id, $name) {
    $name = trim((string)$name);
    if ($name === '') return false;
    $data = sessions_read($fp);
    $idx = -1;
    foreach ($data['sessions'] as $i => $s) {
        if ((int)$s['id'] === (int)$id) {
            $idx = $i;
            break;
        }
    }
    if ($idx < 0) {
        json_done($fp);
        return false;
    }
    $data['sessions'][$idx]['name'] = mb_substr($name, 0, 60);
    $data['sessions'][$idx]['last_ts'] = gmdate('c');
    sessions_save($data, $fp);
    return true;
}

// Detecta el nombre por defecto que genera add_session ("Chat N"): esos chats
// aún no fueron nombrados por el usuario, así que pueden auto-titularse.
function session_has_default_name($sess) {
    $name = isset($sess['name']) ? (string)$sess['name'] : '';
    return ($name === '' || preg_match('/^Chat \d+$/', $name) === 1);
}

// Título placeholder que opencode genera solo: no sirve para pisar un nombre
// útil del hub en un sync forzado.
function session_name_placeholder($name) {
    $n = trim((string)$name);
    return ($n === '' || preg_match('/^Chat \d+$/', $n) === 1 || strpos($n, 'New session - ') === 0);
}

// ---------------------------------------------------------------------------
// Historial único: importa (merge idempotente) una sesión de opencode del TUI
// local. Si ya existe (por opencode_session) solo agrega los mensajes que
// falten; la clave de dedupe es rol|fecha|resumen de texto.
// $bridge es el puente que importa (dueño de la sesión).
// ---------------------------------------------------------------------------
// Texto canonico para deduplicar mensajes importados de opencode. opencode
// guarda el mensaje del usuario entre comillas dobles y, si hubo un adjunto, le
// antepone el detalle del archivo ("Called the Read tool ..."). El hub guarda
// solo el texto que tipeo el usuario, asi que normalizamos para que la
// "adopcion" por texto lo reconozca y no lo duplique.
function session_dedupe_text($role, $text) {
    $s = trim((string)$text);
    if ($role === 'user') {
        $wrap = 'Called the Read tool with the following input:';
        if (strpos($s, $wrap) === 0) {
            $marker = 'read successfully';
            $mi = strripos($s, $marker);
            if ($mi !== false) $s = trim(substr($s, $mi + strlen($marker)));
        }
        if (strlen($s) >= 2 && $s[0] === '"' && substr($s, -1) === '"') {
            $s = trim(substr($s, 1, -1));
        }
    }
    return $s;
}

function session_import($ocSession, $name, $folder, $model, $agent, $updatedTs, $messages, $tokens = 0, $cost = 0.0, $bridge = '', $rename = false) {
    $ocSession = trim((string)$ocSession);
    if ($ocSession === '') {
        return ['ok' => false, 'error' => 'opencode_session requerido'];
    }
    $file = bridge_catalog_file($bridge);
    $folder = (string)$folder;
    if ($folder !== '' && folder_path_in_catalog($folder, $file) === null) {
        // El puente solo escanea su workspace: damos de alta la carpeta nueva.
        $base = basename(str_replace('\\', '/', rtrim($folder, '/\\')));
        catalog_modify(function (&$cat) use ($base, $folder) {
            if (!isset($cat['folders']) || !is_array($cat['folders'])) $cat['folders'] = [];
            foreach ($cat['folders'] as $f) {
                if (is_array($f) && $f['path'] === $folder) return;
            }
                $cat['folders'][] = ['name' => mb_substr((string)$base, 0, 60), 'path' => mb_substr($folder, 0, 500), 'active' => true];
        }, $file);
    }
    $sdata = sessions_read($fp);
    $idx = -1;
    $ownedByOther = false;
    foreach ($sdata['sessions'] as $i => $s) {
        if (empty($s['opencode_session']) || (string)$s['opencode_session'] !== $ocSession) continue;
        $owner = session_bridge($s);
        if ($owner === '' || $owner === $bridge) { $idx = $i; break; }
        $ownedByOther = true; // mismo id de opencode pero de otro puente
    }
    if ($ownedByOther) {
        json_done($fp);
        return ['ok' => false, 'error' => 'Permiso insuficiente'];
    }
    $created = false;
    if ($idx < 0) {
        $id = $sdata['nextId'];
        $sdata['nextId'] = $id + 1;
        $ts = ($updatedTs !== '' && @strtotime($updatedTs)) ? $updatedTs : gmdate('c');
        $sess = [
            'id' => $id,
            'name' => $name !== '' ? $name : 'Opencode ' . substr($ocSession, 0, 8),
            'folder' => $folder,
            'model' => ($model !== '' && model_in_catalog($model, $file)) ? $model : '',
            'agent' => ($agent !== '' && agent_in_catalog($agent, $file)) ? $agent : 'build',
            'created_ts' => $ts,
            'last_ts' => $ts,
            'opencode_session' => $ocSession,
            'importada' => true,
        ];
        if (bridge_valid_id($bridge)) $sess['bridge'] = $bridge;
        $sdata['sessions'][] = $sess;
        $idx = count($sdata['sessions']) - 1;
        $created = true;
        @touch(session_messages_file($id));
    }
    $sid = (int)$sdata['sessions'][$idx]['id'];
    if (!$created && $rename) {
        if ($name !== '' && !session_name_placeholder($name)) {
            $sdata['sessions'][$idx]['name'] = mb_substr($name, 0, 60);
        }
    } elseif (!$created && session_has_default_name($sdata['sessions'][$idx]) && $name !== '') {
        $sdata['sessions'][$idx]['name'] = mb_substr($name, 0, 60);
    }
    // El barrido manda la carpeta real del proyecto (info.directory del export);
    // si una pasada anterior la clasificó mal, se corrige acá. De paso queda
    // marcada como espejo importado: el poll deja de contarla en known_oc y el
    // barrido vuelve a manejarla (carpeta/tokens) en las siguientes pasadas.
    if (!$created) {
        if ($folder !== '' && (string)$sdata['sessions'][$idx]['folder'] !== $folder) {
            $sdata['sessions'][$idx]['folder'] = $folder;
        }
        $sdata['sessions'][$idx]['importada'] = true;
        // El dueño se mantiene estable; solo se asigna si aún no tiene uno.
        if (bridge_valid_id($bridge) && session_bridge($sdata['sessions'][$idx]) === '') {
            $sdata['sessions'][$idx]['bridge'] = $bridge;
        }
    }
    // Tokens/costo acumulados que reporta opencode (se actualizan en cada barrido).
    if ($tokens > 0) {
        $sdata['sessions'][$idx]['tokens'] = $tokens;
    }
    if ($cost > 0) {
        $sdata['sessions'][$idx]['cost'] = round($cost, 4);
    }
    $data = messages_read($sid, $mfp);
    $known = [];
    $knownOc = [];
    $byText = [];
    foreach ($data['messages'] as $i => $m) {
        $mRole = (string)($m['role'] ?? '');
        $mText = session_dedupe_text($mRole, (string)($m['text'] ?? ''));
        $known[$mRole . '|' . (string)($m['ts'] ?? '') . '|' . md5(mb_substr($mText, 0, 400))] = true;
        $oc = trim((string)($m['oc_msg'] ?? ''));
        if ($oc !== '') {
            $knownOc[$oc] = true;
        } else {
            // Candidato a "adopción": mensaje optimista de la web (sin id de opencode).
            $byText[$mRole . '|' . md5(mb_substr($mText, 0, 400))] = $i;
        }
    }
    $added = 0;
    foreach ((array)$messages as $m) {
        if (!is_array($m)) continue;
        $role = (string)($m['role'] ?? '');
        if ($role !== 'user' && $role !== 'assistant') continue;
        $text = trim((string)($m['text'] ?? ''));
        if ($text === '') continue;
        if (mb_strlen($text) > 50000) $text = mb_substr($text, 0, 50000);
        $ts = (string)($m['ts'] ?? '');
        if ($ts === '' || !@strtotime($ts)) $ts = gmdate('c');
        $ocMsg = trim((string)($m['oc_msg'] ?? ''));
        $dtext = session_dedupe_text($role, $text);
        // Identidad de opencode: si ya está, es el mismo mensaje.
        if ($ocMsg !== '' && isset($knownOc[$ocMsg])) continue;
        $key = $role . '|' . $ts . '|' . md5(mb_substr($dtext, 0, 400));
        if (isset($known[$key])) continue;
        // Adopción: llegó de opencode (con oc_msg) y existe uno de la web con
        // el mismo rol+texto y sin id. Se le asigna el id en vez de duplicar.
        if ($ocMsg !== '') {
            $tk = $role . '|' . md5(mb_substr($dtext, 0, 400));
            if (isset($byText[$tk])) {
                $data['messages'][$byText[$tk]]['oc_msg'] = $ocMsg;
                $knownOc[$ocMsg] = true;
                $known[$key] = true;
                unset($byText[$tk]);
                continue;
            }
        }
        // Respuesta del agente partida en varios mensajes de opencode (uno por
        // paso/tool): el hub guarda la respuesta combinada. Si esta parte ya
        // está contenida en un mensaje del agente, no duplicar.
        if ($role === 'assistant' && mb_strlen($dtext) >= 40) {
            $contained = false;
            foreach ($data['messages'] as $em) {
                if ((string)($em['role'] ?? '') !== 'assistant') continue;
                $et = session_dedupe_text('assistant', (string)($em['text'] ?? ''));
                if ($et !== '' && mb_strlen($et) > mb_strlen($dtext) && mb_strpos($et, $dtext) !== false) {
                    $contained = true;
                    break;
                }
            }
            if ($contained) {
                $known[$key] = true;
                if ($ocMsg !== '') $knownOc[$ocMsg] = true;
                continue;
            }
        }
        $known[$key] = true;
        if ($ocMsg !== '') $knownOc[$ocMsg] = true;
        $id = $data['nextId'];
        $data['nextId'] = $id + 1;
        $msg = [
            'id' => $id,
            'role' => $role,
            'text' => $text,
            'ts' => $ts,
            'status' => 'done',
        ];
        if ($ocMsg !== '') {
            $msg['oc_msg'] = $ocMsg;
        }
        $reasoning = trim((string)($m['reasoning'] ?? ''));
        if ($reasoning !== '') {
            $msg['reasoning'] = mb_strlen($reasoning) > 50000 ? mb_substr($reasoning, 0, 50000) : $reasoning;
        }
        if (!empty($m['agent'])) {
            $msg['agent'] = mb_substr((string)$m['agent'], 0, 40);
        }
        $data['messages'][] = $msg;
        $added++;
    }
    $last = end($data['messages']);
    $newTs = $last ? (string)($last['ts'] ?? '') : '';
    if ($newTs !== '' && @strtotime($newTs) > @strtotime((string)($sdata['sessions'][$idx]['last_ts'] ?? ''))) {
        $sdata['sessions'][$idx]['last_ts'] = $newTs;
    }
    messages_save($data, $mfp);
    sessions_save($sdata, $fp);
    return ['ok' => true, 'session_id' => $sid, 'created' => $created, 'added' => $added];
}

// Título a partir del primer prompt del usuario (estilo opencode): una línea,
// recortada en ~48 caracteres con corte por palabra.
function session_title_from_prompt($text) {
    $t = trim(preg_replace('/\s+/u', ' ', (string)$text));
    if ($t === '') return '';
    $max = 48;
    if (mb_strlen($t) > $max) {
        $cut = mb_substr($t, 0, $max);
        $sp = mb_strrpos($cut, ' ');
        if ($sp !== false && $sp > 20) {
            $cut = mb_substr($cut, 0, $sp);
        }
        $t = rtrim($cut, " \t.,:;-") . '…';
    }
    return $t;
}

function delete_session($id) {
    $data = sessions_read($fp);
    $out = [];
    foreach ($data['sessions'] as $sess) {
        if ((int)$sess['id'] !== (int)$id) {
            $out[] = $sess;
        }
    }
    $data['sessions'] = $out;
    sessions_save($data, $fp);
    @unlink(session_messages_file($id));
}

// Cache del resumen de cada sesion (preview/estado) para no releer todos los
// `messages-*.json` en cada `sessions`/`bootstrap`: el polling de la web cae
// aca cada pocos segundos. Se guarda en `data/.preview.json` y se invalida por
// mtime+size del archivo de mensajes (cualquier escritura lo renueva).
function preview_cache_file() {
    return DATA_DIR . '/.preview.json';
}
function preview_cache_read(&$cache) {
    if (is_array($GLOBALS['OB_PREVIEW_CACHE'] ?? null)) {
        $cache = $GLOBALS['OB_PREVIEW_CACHE'];
        return;
    }
    $d = @json_decode((string)@file_get_contents(preview_cache_file()), true);
    $cache = is_array($d) ? $d : [];
    $GLOBALS['OB_PREVIEW_CACHE'] = $cache;
}
function preview_cache_save($cache) {
    $GLOBALS['OB_PREVIEW_CACHE'] = $cache;
    $tmp = preview_cache_file() . '.' . getmypid() . '.tmp';
    if (@file_put_contents($tmp, json_encode($cache, JSON_UNESCAPED_UNICODE)) !== false) {
        @rename($tmp, preview_cache_file());
    }
}

function sessions_list_full() {
    $data = sessions_read($fp);
    $user = ob_current_user();
    $visible = $user ? ob_visible_bridge_ids($user) : null; // null = todas (admin)
    // Sesión que opencode está ejecutando AHORA (la informa el puente de esa
    // sesión). Cada puente corre sus propias sesiones, así que el estado se
    // deriva del dueño de cada una; sin aviso (puente viejo/caído) se infiere
    // de los mensajes, pero solo si su puente late.
    $cutoff = time() - STALE_PROCESSING_SECONDS;
    preview_cache_read($pcache);
    $pcacheDirty = false;
    $seenIds = [];
    $out = [];
    foreach ($data['sessions'] as $sess) {
        $owner = session_bridge($sess);
        if ($visible !== null && !in_array($owner, $visible, true)) continue;
        $sid = (int)$sess['id'];
        $seenIds[] = $sid;
        $busyId = bridge_busy_session($owner);
        $bridgeLive = bridge_online_live($owner);
        $mfile = session_messages_file($sid);
        $mt = @filemtime($mfile);
        $sz = @filesize($mfile);
        $ce = isset($pcache[$sid]) && is_array($pcache[$sid]) ? $pcache[$sid] : null;
        $useCache = $ce !== null && $mt !== false
            && (int)($ce['mt'] ?? -1) === (int)$mt && (int)($ce['sz'] ?? -1) === (int)$sz;
        // Un borrador 'streaming' viejo hay que curarlo escribiendo el archivo,
        // asi que en ese caso no sirve la cache.
        $ceStreamTs = $ce ? (int)($ce['streaming_ts'] ?? 0) : 0;
        if ($useCache && $ceStreamTs > 0 && $ceStreamTs < $cutoff) $useCache = false;
        if ($useCache) {
            $prev = (string)($ce['preview'] ?? '');
            $prevRole = (string)($ce['preview_role'] ?? '');
            $prevTs = (string)($ce['last_ts'] ?? ($sess['last_ts'] ?? $sess['created_ts']));
            $hasPending = !empty($ce['has_pending']);
            $procTs = (int)($ce['processing_ts'] ?? 0);
            $hasProcessing = $procTs > 0 && $procTs >= $cutoff;
            $hasStreaming = $ceStreamTs > 0 && $ceStreamTs >= $cutoff;
        } else {
            $prev = '';
            $prevRole = '';
            $prevTs = $sess['last_ts'] ?? $sess['created_ts'];
            $hasPending = false;
            $hasProcessing = false;
            $hasStreaming = false;
            $processingTs = 0;
            $streamingTs = 0;
            $mchanged = false;
            $mdata = json_read($mfile, $mfp);
            if (is_array($mdata) && !empty($mdata['messages'])) {
                foreach ($mdata['messages'] as &$msg) {
                    $role = (string)($msg['role'] ?? '');
                    $status = (string)($msg['status'] ?? '');
                    $mts = (int)@strtotime((string)($msg['ts'] ?? ''));
                    if ($role === 'assistant') {
                        if ($status === 'streaming') {
                            // Borrador sin parciales hace demasiado: el puente murió
                            // a mitad de la respuesta. Se cierra acá mismo para que
                            // el indicador no quede trabado en "trabajando".
                            if ($mts < $cutoff) {
                                $msg['status'] = 'done';
                                $msg['canceled'] = true;
                                $mchanged = true;
                            } else {
                                $hasStreaming = true;
                                if ($mts > $streamingTs) $streamingTs = $mts;
                            }
                        }
                    } elseif ($role === 'user') {
                        if ($status === 'processing') {
                            // Solo cuenta si es reciente; uno viejo lo reclama o lo
                            // cancela el poll en cuanto el puente vuelve.
                            if ($mts >= $cutoff) {
                                $hasProcessing = true;
                                if ($mts > $processingTs) $processingTs = $mts;
                            }
                        } elseif ($status === 'pending') {
                            $hasPending = true;
                        }
                    }
                    $prev = (string)($msg['text'] ?? '');
                    $prevRole = $role;
                    $prevTs = (string)($msg['ts'] ?? $prevTs);
                }
                unset($msg);
            }
            if ($mfp) {
                if ($mchanged) messages_save($mdata, $mfp);
                else json_done($mfp);
            }
            clearstatcache(true, $mfile);
            $nmt = @filemtime($mfile);
            $nsz = @filesize($mfile);
            $newCe = [
                'mt' => $nmt === false ? -1 : (int)$nmt,
                'sz' => $nsz === false ? -1 : (int)$nsz,
                'preview' => $prev,
                'preview_role' => $prevRole,
                'last_ts' => (string)$prevTs,
                'has_pending' => $hasPending,
                'processing_ts' => $processingTs,
                'streaming_ts' => $streamingTs,
            ];
            if ($ce !== $newCe) {
                $pcache[$sid] = $newCe;
                $pcacheDirty = true;
            }
        }
        if ($busyId !== null) {
            $state = $sid === $busyId ? 'working' : (($hasPending || $hasProcessing) ? 'waiting' : '');
        } else {
            // Sin aviso del puente (versión vieja): se infiere de los mensajes,
            // pero solo si el puente late; caído, nada puede estar corriendo.
            $state = ($bridgeLive && ($hasStreaming || $hasProcessing)) ? 'working' : ($hasPending ? 'waiting' : '');
        }
        $sess['state'] = $state;
        $sess['preview'] = mb_substr($prev, 0, 120);
        $sess['preview_role'] = $prevRole;
        $sess['last_ts'] = $prevTs;
        $out[] = $sess;
    }
    json_done($fp);
    // Poda de sesiones borradas (solo el admin ve todas; un usuario no debe
    // tirar entradas de sesiones que no ve).
    if ($visible === null && $pcache) {
        $flip = array_flip($seenIds);
        foreach (array_keys($pcache) as $k) {
            if (!isset($flip[$k])) { unset($pcache[$k]); $pcacheDirty = true; }
        }
    }
    if ($pcacheDirty) preview_cache_save($pcache);
    // Más reciente primero.
    usort($out, function ($a, $b) {
        return strcmp((string)($b['last_ts'] ?? ''), (string)($a['last_ts'] ?? ''));
    });
    return $out;
}

// ---------------------------------------------------------------------------
// Mensajes de una sesión.
// ---------------------------------------------------------------------------
function messages_read($sid, &$fp = null) {
    $data = json_read(session_messages_file($sid), $fp);
    if (!is_array($data) || !isset($data['messages'])) {
        $data = ['messages' => [], 'nextId' => 1];
    }
    return $data;
}

function messages_save($data, $fp) {
    json_save($data, $fp);
}

// Cierra borradores 'streaming' huérfanos: si el puente murió a mitad de la
// respuesta (crash, PC apagada, corte de red), el borrador queda en streaming
// para siempre y la web sigue mostrando "trabajando". Si hace más de
// STALE_PROCESSING_SECONDS no llega ningún parcial, se da la respuesta por
// cortada: queda 'done' + canceled (el texto parcial se conserva).
// No escribe: quien llama decide guardar con el $fp que ya tiene abierto.
function messages_heal_stale_streaming(&$data, $cutoff) {
    $changed = false;
    if (!is_array($data) || empty($data['messages'])) return false;
    foreach ($data['messages'] as &$msg) {
        if (($msg['role'] ?? '') !== 'assistant') continue;
        if (($msg['status'] ?? '') !== 'streaming') continue;
        if (@strtotime((string)($msg['ts'] ?? '')) >= $cutoff) continue;
        $msg['status'] = 'done';
        $msg['canceled'] = true;
        $changed = true;
    }
    unset($msg);
    return $changed;
}

function add_message($sid, $role, $text, $status = 'pending', $extra = []) {
    $data = messages_read($sid, $fp);
    $id = $data['nextId'];
    $data['nextId'] = $id + 1;
    $msg = [
        'id' => $id,
        'role' => $role,
        'text' => $text,
        'ts' => gmdate('c'),
        'status' => $status,
    ];
    // Campos extra (p. ej. 'agent' para el badge plan/build por mensaje).
    foreach ((array)$extra as $k => $v) {
        if (in_array($k, ['id', 'role', 'text', 'ts', 'status', 'draft_for'], true)) continue;
        $msg[$k] = $v;
    }
    $data['messages'][] = $msg;
    messages_save($data, $fp);
    touch_session($sid);
    ob_wake();
    return $id;
}

// Actualiza tokens/costo de la sesión vinculada (chats web: el barrido del
// puente lee el export de opencode pero no debe tocar los mensajes). $folder
// (opcional) corrige la carpeta con la real del proyecto. $bridge es quien
// barre (el dueño de la sesión).
function session_tokens($ocSession, $tokens, $cost, $folder = '', $bridge = '') {
    $ocSession = trim((string)$ocSession);
    if ($ocSession === '') return;
    $file = bridge_catalog_file($bridge);
    $folder = (string)$folder;
    if ($folder !== '' && folder_path_in_catalog($folder, $file) === null) {
        // Carpeta nueva vista por el barrido: se da de alta (igual que import).
        $base = basename(str_replace('\\', '/', rtrim($folder, '/\\')));
        catalog_modify(function (&$cat) use ($base, $folder) {
            if (!isset($cat['folders']) || !is_array($cat['folders'])) $cat['folders'] = [];
            foreach ($cat['folders'] as $f) {
                if (is_array($f) && $f['path'] === $folder) return;
            }
                $cat['folders'][] = ['name' => mb_substr((string)$base, 0, 60), 'path' => mb_substr($folder, 0, 500), 'active' => true];
        }, $file);
    }
    $sdata = sessions_read($fp);
    foreach ($sdata['sessions'] as $i => $s) {
        if (empty($s['opencode_session']) || (string)$s['opencode_session'] !== $ocSession) continue;
        $owner = session_bridge($s);
        if ($owner !== '' && $owner !== $bridge) continue; // es de otro puente: no tocar
        if ($tokens > 0) $sdata['sessions'][$i]['tokens'] = $tokens;
        if ($cost > 0) $sdata['sessions'][$i]['cost'] = round($cost, 4);
        if ($folder !== '' && (string)($s['folder'] ?? '') !== $folder) {
            $sdata['sessions'][$i]['folder'] = $folder;
        }
        if (bridge_valid_id($bridge) && session_bridge($sdata['sessions'][$i]) === '') {
            $sdata['sessions'][$i]['bridge'] = $bridge;
        }
        sessions_save($sdata, $fp);
        return;
    }
    json_done($fp);
}

// Normaliza una carpeta para comparar (mismo criterio que el store de Node).
function reconcile_norm_folder($f) {
    return rtrim(strtolower(str_replace('/', '\\', (string)$f)), '\\');
}

// Reconciliación de bajas: el puente informa qué sesiones de opencode ve
// ($known) y en qué carpetas escaneó ($folders). Se borran en el hub solo las
// sesiones importadas de ESE puente, cuya carpeta fue escaneada y cuyo
// opencode_session ya no existe en la PC. Las de carpetas no escaneadas
// (fuera del workspace) se conservan.
function session_reconcile($known, $folders, $bridge) {
    if (!bridge_valid_id($bridge)) return ['ok' => true, 'deleted' => 0];
    $knownSet = [];
    foreach ((array)$known as $x) { $knownSet[(string)$x] = true; }
    $folderSet = [];
    foreach ((array)$folders as $f) { $folderSet[reconcile_norm_folder($f)] = true; }
    if (!$folderSet) return ['ok' => true, 'deleted' => 0];
    $sdata = sessions_read($fp);
    $keep = [];
    $del = [];
    foreach ($sdata['sessions'] as $s) {
        $oc = isset($s['opencode_session']) ? (string)$s['opencode_session'] : '';
        $orphan = session_bridge($s) === $bridge
            && !empty($s['importada'])
            && $oc !== ''
            && !isset($knownSet[$oc])
            && isset($folderSet[reconcile_norm_folder($s['folder'] ?? '')]);
        if ($orphan) { $del[] = (int)$s['id']; continue; }
        $keep[] = $s;
    }
    if ($del) {
        $sdata['sessions'] = $keep;
        sessions_save($sdata, $fp);
        foreach ($del as $id) { @unlink(session_messages_file($id)); }
    } else {
        json_done($fp);
    }
    return ['ok' => true, 'deleted' => count($del)];
}

// Al desconectar un proyecto, saca del hub las sesiones importadas de esa
// carpeta para que el sidebar se actualice al instante (el puente igual
// confirma y republica el indice). Devuelve cuantas borro.
function session_prune_folder($folder, $bridge) {
    if (!bridge_valid_id($bridge) || trim((string)$folder) === '') return 0;
    $norm = reconcile_norm_folder($folder);
    $sdata = sessions_read($fp);
    $keep = [];
    $del = [];
    $sole = sole_bridge_id();
    foreach ($sdata['sessions'] as $s) {
        $oc = isset($s['opencode_session']) ? (string)$s['opencode_session'] : '';
        $owner = session_bridge($s);
        $mine = ($owner === $bridge) || ($owner === '' && $sole === $bridge);
        $sameF = reconcile_norm_folder($s['folder'] ?? '') === $norm;
        if ($mine && !empty($s['importada']) && $oc !== '' && $sameF) { $del[] = (int)$s['id']; continue; }
        $keep[] = $s;
    }
    if ($del) {
        $sdata['sessions'] = $keep;
        sessions_save($sdata, $fp);
        foreach ($del as $id) { @unlink(session_messages_file($id)); }
    } else {
        json_done($fp);
    }
    return count($del);
}

// Agente con el que se envió el mensaje $userId (para estamparlo en la
// respuesta). Si el mensaje no tiene, cae en $fallback.
function message_agent_of($data, $userId, $fallback = '') {
    foreach ((array)($data['messages'] ?? []) as $msg) {
        if ((int)($msg['id'] ?? 0) === (int)$userId) {
            $a = isset($msg['agent']) ? (string)$msg['agent'] : '';
            return $a !== '' ? $a : $fallback;
        }
    }
    return $fallback;
}

// ---------------------------------------------------------------------------
// Temas (themes/index.json es la única fuente).
// ---------------------------------------------------------------------------
function themes_index() {
    $fallback = [
        ['slug' => 'terminal', 'label' => 'Terminal', 'sw' => ['#0a0d12', '#3fb950']],
        ['slug' => 'default', 'label' => 'Oscuro', 'sw' => ['#0f172a', '#0ea5e9']],
        ['slug' => 'dark-red', 'label' => 'Carmesí', 'sw' => ['#14080a', '#ef4444']],
        ['slug' => 'solarized', 'label' => 'Solarized', 'sw' => ['#fdf6e3', '#268bd2']],
        ['slug' => 'light', 'label' => 'Claro', 'sw' => ['#f1f5f9', '#4f46e5']],
        ['slug' => 'high-contrast', 'label' => 'Alto contraste', 'sw' => ['#000000', '#ffffff']],
    ];
    $fp = null;
    $data = json_read(__DIR__ . '/themes/index.json', $fp);
    if ($fp) {
        json_done($fp);
    }
    if (!is_array($data) || !isset($data['themes']) || !is_array($data['themes'])) {
        return $fallback;
    }
    $list = [];
    foreach ($data['themes'] as $t) {
        if (!is_array($t) || !isset($t['slug']) || !is_string($t['slug']) || !preg_match('/^[a-z\-]{1,40}$/', $t['slug'])) {
            continue;
        }
        $entry = ['slug' => $t['slug'], 'label' => is_string($t['label'] ?? null) ? $t['label'] : $t['slug']];
        if (isset($t['sw']) && is_array($t['sw']) && count($t['sw']) === 2
            && preg_match('/^#[0-9a-fA-F]{3,8}$/', (string)$t['sw'][0])
            && preg_match('/^#[0-9a-fA-F]{3,8}$/', (string)$t['sw'][1])) {
            $entry['sw'] = [$t['sw'][0], $t['sw'][1]];
        }
        $list[] = $entry;
    }
    return $list ? $list : $fallback;
}

function themes_known() {
    $slugs = [];
    foreach (themes_index() as $t) {
        $slugs[] = $t['slug'];
    }
    return $slugs;
}

// ---------------------------------------------------------------------------
// Catálogo (sincronizado por el puente) + solicitudes de creación de carpetas.
// ---------------------------------------------------------------------------
function catalog_default() {
    return [
        'folders' => [],
        'models' => [],
        'favorites' => [],
        'default_model' => '',
        'models_full' => [],
        'models_ctx' => [],
        'models_names' => [],
        'vision' => [],
        'workspace' => '',
        'allow_create_folders' => false,
        'agents' => ['build', 'plan'],
        'synced_ts' => null,
        'last_online_ts' => null,
        'busy_session' => null,   // sesión que opencode está ejecutando ahora
        'busy_since' => null,
        'requests' => [],
        'nextRequestId' => 1,
    ];
}

// Versión estable del catálogo: ignora lo que cambia solo por latido del
// puente o por colas internas (requests/commands). La app web la usa para no
// re-descargar el catálogo completo cuando no cambió.
function catalog_version($cat = null) {
    if ($cat === null) {
        $cat = catalog_read();
    }
    $sig = $cat;
    foreach (['last_online_ts', 'busy_session', 'busy_since', 'requests', 'commands', 'nextRequestId', 'nextCommandId'] as $k) {
        unset($sig[$k]);
    }
    return md5(json_encode($sig, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
}

// Version del catalogo con cache en disco (mtime+size): permite responder
// changed:false sin leer ni re-encodear el catalogo entero en cada poll. El
// archivo lateral `.ver` se reescribe solo cuando cambia mtime o tamano.
function catalog_version_cached($file = CATALOG_FILE) {
    $mt = @filemtime($file);
    $sz = @filesize($file);
    if ($mt === false || $sz === false) {
        return catalog_version(catalog_read($file));
    }
    $cf = $file . '.ver';
    // Solo se confia en la cache si el archivo lleva >2 s sin tocarse: evita el
    // caso raro de dos escrituras en el mismo segundo con igual tamano.
    if ((time() - (int)$mt) > 2) {
        $raw = @file_get_contents($cf);
        if ($raw !== false) {
            $c = json_decode($raw, true);
            if (is_array($c) && (int)($c['mt'] ?? -1) === (int)$mt
                && (int)($c['sz'] ?? -1) === (int)$sz && isset($c['v'])) {
                return (string)$c['v'];
            }
        }
    }
    $ver = catalog_version(catalog_read($file));
    @file_put_contents($cf, json_encode(['mt' => (int)$mt, 'sz' => (int)$sz, 'v' => $ver]));
    return $ver;
}

// Heartbeat del puente: marca que el servicio local está vivo (lo llama el
// puente cada ~15 s). Hoy el estado en vivo vive en el registro de puentes
// (bridges.json); estas dos funciones legacy operan sobre el catálogo '' para
// no romper versiones viejas del puente.
function catalog_set_online() {
    return catalog_modify(function (&$cat) {
        $cat['last_online_ts'] = gmdate('c');
    }) !== false;
}

// Sesión que el puente está ejecutando AHORA (para el indicador "working").
// Lo reporta el puente al arrancar/cambiar de mensaje y lo refresca con cada
// heartbeat; si pasa el umbral sin refresco (puente caído) se ignora.
function catalog_busy_session() {
    $cat = catalog_read();
    $sid = isset($cat['busy_session']) ? (int)$cat['busy_session'] : 0;
    $ts = isset($cat['busy_since']) ? (string)$cat['busy_since'] : '';
    if ($sid <= 0 || $ts === '') return null;
    $ago = time() - (int)@strtotime($ts);
    if ($ago > 120) return null;
    return $sid;
}

// ¿El puente late? (heartbeat con menos de 120 s). Si no late, en la PC no
// puede haber nada corriendo: los indicadores de trabajo no deben creerle a
// mensajes viejos en processing/streaming.
function catalog_online_live() {
    $cat = catalog_read();
    $ts = isset($cat['last_online_ts']) ? (string)$cat['last_online_ts'] : '';
    if ($ts === '') return false;
    return (time() - (int)@strtotime($ts)) <= 120;
}

// Actualiza (o limpia, si $sid <= 0) la sesión que opencode está ejecutando.
function catalog_set_busy($sid) {
    $sid = (int)$sid;
    catalog_modify(function (&$cat) use ($sid) {
        if ($sid > 0) {
            $cat['busy_session'] = $sid;
            $cat['busy_since'] = gmdate('c');
        } else {
            $cat['busy_session'] = null;
            $cat['busy_since'] = null;
        }
    });
}

// Cache por request: el catalogo se lee muchas veces en un mismo request
// (bridge_can_claim_session por sesion sin dueno, catalog_version, overlays).
// Se invalida en cada escritura (catalog_write/catalog_modify) y tambien por
// mtime+size, asi dos procesos no se pisan.
function catalog_cache_forget($file = null) {
    if (!isset($GLOBALS['OB_CAT_CACHE']) || !is_array($GLOBALS['OB_CAT_CACHE'])) {
        $GLOBALS['OB_CAT_CACHE'] = [];
    }
    if ($file === null) { $GLOBALS['OB_CAT_CACHE'] = []; return; }
    unset($GLOBALS['OB_CAT_CACHE'][$file]);
}

function catalog_read($file = CATALOG_FILE) {
    $mt = @filemtime($file);
    $sz = @filesize($file);
    if ($mt !== false && isset($GLOBALS['OB_CAT_CACHE'][$file])
        && $GLOBALS['OB_CAT_CACHE'][$file]['mt'] === $mt
        && $GLOBALS['OB_CAT_CACHE'][$file]['sz'] === $sz) {
        return $GLOBALS['OB_CAT_CACHE'][$file]['data'];
    }
    $data = json_read($file, $fp);
    json_done($fp);
    if (!is_array($data)) {
        $data = [];
    }
    $def = catalog_default();
    foreach ($def as $k => $v) {
        if (!isset($data[$k])) {
            $data[$k] = $v;
        }
    }
    if ($mt !== false) {
        $GLOBALS['OB_CAT_CACHE'][$file] = ['mt' => $mt, 'sz' => $sz, 'data' => $data];
    }
    return $data;
}

function catalog_write($catalog, $file = CATALOG_FILE) {
    $fp = @fopen($file, 'c+');
    if (!$fp) {
        return false;
    }
    flock($fp, LOCK_EX);
    ftruncate($fp, 0);
    rewind($fp);
    fwrite($fp, json_encode($catalog, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
    fflush($fp);
    flock($fp, LOCK_UN);
    fclose($fp);
    catalog_cache_forget($file);
    return true;
}

// Lectura-modificación-escritura atómica del catálogo de un puente: mantiene
// un mutex entre la lectura y el guardado para que dos escritores concurrentes
// no se pisen (el heartbeat, la cola de comandos y las sincronizaciones corren
// en paralelo; con el patrón leer→soltar→escribir se perdían cambios, p. ej.
// comandos recién encolados).
// El mutex es un directorio con mkdir(): es atómico en cualquier plataforma y
// no depende de flock(), que en el server local de Windows no serializa entre
// hilos del mismo proceso. La escritura va a un .tmp y rename() para que los
// lectores nunca vean un archivo cortado. $fn(&$cat) modifica el array;
// devolver false aborta sin escribir.
function catalog_modify($fn, $file = CATALOG_FILE) {
    $r = file_lock_modify($file, 'catalog_default', $fn);
    if ($r !== false) catalog_cache_forget($file);
    return $r;
}

// $modelsFull: catálogo completo agrupado por proveedor
// (objeto proveedor => [ids "proveedor/modelo"]) que sincroniza el puente.
// $models sigue siendo la lista corta de favoritos de config.json.
// $modelsCtx: mapa {id: contexto_en_tokens} (lo lee la web de OpenBridge).
// $vision: lista de modelos que aceptan imagenes.
// $file es el catálogo del puente que sincroniza (ver bridge_catalog_file()).
function sync_catalog($folders, $models, $workspace, $allowCreateFolder, $agents = ['build', 'plan'], $modelsFull = null, $vision = null, $modelsCtx = null, $modelsNames = null, $file = CATALOG_FILE) {
    $fresh = catalog_default();
    $fresh['folders'] = array_values($folders);
    $fresh['workspace'] = (string)$workspace;
    $fresh['allow_create_folders'] = (bool)$allowCreateFolder;
    $fresh['agents'] = array_values(array_filter((array)$agents, 'is_string'));
    $fresh['synced_ts'] = gmdate('c');
    // Campos de modelos opcionales: null = el puente no los mando (p. ej. fallo
    // al ejecutar el CLI), por lo que se conserva lo ultimo guardado en vez de
    // vaciar el catalogo del hub.
    if ($models !== null) {
        $fresh['models'] = array_values($models);
    } else {
        unset($fresh['models']);
    }
    if ($modelsFull !== null) {
        $fresh['models_full'] = is_array($modelsFull) ? $modelsFull : [];
    } else {
        unset($fresh['models_full']);
    }
    if ($vision !== null) {
        $fresh['vision'] = is_array($vision) ? array_values($vision) : [];
    } else {
        unset($fresh['vision']);
    }
    if ($modelsCtx !== null) {
        $fresh['models_ctx'] = is_array($modelsCtx) ? $modelsCtx : [];
    } else {
        unset($fresh['models_ctx']);
    }
    if ($modelsNames !== null) {
        $fresh['models_names'] = is_array($modelsNames) ? $modelsNames : [];
    } else {
        unset($fresh['models_names']);
    }
    // La sincronización reemplaza carpetas/modelos, NUNCA la cola del puente:
    // preserva comandos y solicitudes en curso (y sus contadores), los favoritos
    // y los campos de modelos no enviados.
    $ok = catalog_modify(function (&$cat) use ($fresh) {
        $keep = [];
        foreach ($cat as $k => $v) {
            if (in_array($k, ['commands', 'requests', 'nextCommandId', 'nextRequestId', 'favorites', 'default_model'], true)
                || !array_key_exists($k, $fresh)) {
                $keep[$k] = $v;
            }
        }
        $cat = array_merge($fresh, $keep);
    }, $file);
    return $ok !== false;
}

// Valida el nombre de una carpeta nueva (evita rutas y caracteres extraños).
function valid_folder_name($name) {
    return is_string($name) && preg_match('/^[A-Za-z0-9][A-Za-z0-9 _\-.()]{1,49}$/', $name) === 1;
}

// Favoritos + modelo predeterminado (los gestiona la web desde el hub).
function catalog_set_models($favorites, $defaultModel, $file = CATALOG_FILE) {
    $favs = [];
    foreach ((array)$favorites as $m) {
        if (!is_string($m)) continue;
        $m = trim($m);
        if ($m === '') continue;
        $favs[] = mb_substr($m, 0, 160);
        if (count($favs) >= 400) break;
    }
    catalog_modify(function (&$cat) use ($favs, $defaultModel) {
        $cat['favorites'] = $favs;
        $def = trim((string)$defaultModel);
        $cat['default_model'] = ($def !== '' && in_array($def, $favs, true)) ? $def : (count($favs) ? $favs[0] : '');
    }, $file);
    return true;
}

function catalog_add_request($name, $file = CATALOG_FILE) {
    $id = 0;
    catalog_modify(function (&$cat) use ($name, &$id) {
        $id = $cat['nextRequestId'];
        $cat['nextRequestId'] = $id + 1;
        if (!isset($cat['requests']) || !is_array($cat['requests'])) $cat['requests'] = [];
        $cat['requests'][] = [
            'id' => $id,
            'name' => mb_substr(trim($name), 0, 50),
            'status' => 'pending',
            'error' => '',
            'ts' => gmdate('c'),
        ];
    }, $file);
    if ($id > 0) ob_wake();
    return $id;
}

// Marca las solicitudes pending como processing y las devuelve para que el
// puente las procese (solo si la creación remota está habilitada).
function catalog_claim_requests($file = CATALOG_FILE) {
    $out = [];
    catalog_modify(function (&$cat) use (&$out) {
        if (empty($cat['allow_create_folders']) || !isset($cat['requests']) || !is_array($cat['requests'])) return;
        foreach ($cat['requests'] as &$r) {
            if ($r['status'] === 'pending') {
                $r['status'] = 'processing';
                $out[] = ['id' => (int)$r['id'], 'name' => $r['name']];
            }
        }
        unset($r);
    }, $file);
    return $out;
}

// Resultado de una solicitud: marca 'done'/'error' y, si tuvo éxito, agrega la
// carpeta al catálogo para que la app la pueda usar al instante.
function catalog_finish_request($id, $ok, $folder = null, $error = '', $file = CATALOG_FILE) {
    catalog_modify(function (&$cat) use ($id, $ok, $folder, $error) {
        if (!isset($cat['requests']) || !is_array($cat['requests'])) return;
        foreach ($cat['requests'] as &$r) {
            if ((int)$r['id'] === (int)$id) {
                $r['status'] = $ok ? 'done' : 'error';
                $r['error'] = (string)$error;
                $r['ts'] = gmdate('c');
                if ($ok && is_array($folder) && !empty($folder['name']) && !empty($folder['path'])) {
                    $exists = false;
                    if (!isset($cat['folders']) || !is_array($cat['folders'])) $cat['folders'] = [];
                    foreach ($cat['folders'] as $f) {
                        if (is_array($f) && $f['path'] === $folder['path']) {
                            $exists = true;
                            break;
                        }
                    }
                    if (!$exists) {
                        $cat['folders'][] = ['name' => $folder['name'], 'path' => $folder['path'], 'active' => true];
                    }
                }
            }
        }
        unset($r);
    }, $file);
}

function folder_path_in_catalog($folder, $file = CATALOG_FILE) {
    $cat = catalog_read($file);
    foreach ($cat['folders'] as $f) {
        if (is_array($f) && isset($f['name']) && isset($f['path']) && $f['path'] === $folder) {
            return $f['path'];
        }
        if (is_string($f) && $f === $folder) {
            return $f;
        }
    }
    return null;
}

// Valida contra favoritos + lista completa sincronizada por el puente.
function model_in_catalog($model, $file = CATALOG_FILE) {
    $cat = catalog_read($file);
    if (in_array($model, (array)($cat['models'] ?? []), true)) {
        return true;
    }
    foreach ((array)($cat['models_full'] ?? []) as $prov => $list) {
        foreach ((array)$list as $m) {
            if (is_string($m) && $m !== '' && $m === $model) {
                return true;
            }
        }
    }
    return false;
}

function agent_in_catalog($agent, $file = CATALOG_FILE) {
    $cat = catalog_read($file);
    return in_array($agent, $cat['agents'], true);
}

// ---------------------------------------------------------------------------
// Auth web y token del puente: viven en hub.php (multiusuario + token por PC).
// Se mantienen los nombres require_login/require_login_readonly/require_csrf/
// current_csrf/check_bridge_token que usa api.php.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Avisos push (Web Push nativo de la PWA, RFC 8030/8291/8188).
// Sin dependencias externas: usa openssl (ECDH P-256, AES-128-GCM, VAPID) y
// curl (o file_get_contents si no hay curl) para publicar en el push service.
// ---------------------------------------------------------------------------

// Permite cifrar de extremo a extremo un mensaje push para una suscripcion.
function push_enabled() {
    return VAPID_PRIVATE_KEY !== '' && function_exists('openssl_pkey_new');
}

function b64url_encode($data) {
    return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
}

function b64url_decode($data) {
    $s = strtr($data, '-_', '+/');
    $pad = strlen($s) % 4;
    if ($pad > 0) {
        $s .= str_repeat('=', 4 - $pad);
    }
    return base64_decode($s, true);
}

// Longitud de una longitud DER (long form solo si hace falta).
function der_length($n) {
    if ($n < 128) {
        return chr($n);
    }
    $out = '';
    while ($n > 0) {
        $out = chr($n & 0xff) . $out;
        $n >>= 8;
    }
    return chr(0x80 | strlen($out)) . $out;
}

// Elemento TLV DER genérico.
function der_tlv($tag, $content) {
    return chr($tag) . der_length(strlen($content)) . $content;
}

function der_oid_curve() {
    return der_tlv(0x06, hex2bin('2A8648CE3D030107')); // prime256v1
}

// PEM "EC PRIVATE KEY" (SEC1) a partir de la llave privada cruda (d, 32 octetos)
// y, opcionalmente, el punto publico (65 octetos).
function ec_sec1_pem_from_raw($d, $point = null) {
    $body = der_tlv(0x02, "\x01")                               // version = 1
        . der_tlv(0x04, $d)                                    // privateKey (d)
        . der_tlv(0xa0, der_oid_curve());                      // [0] prime256v1
    if ($point !== null) {
        $body .= der_tlv(0xa1, der_tlv(0x03, "\x00" . $point)); // [1] publicKey
    }
    $der = der_tlv(0x30, $body);
    return "-----BEGIN EC PRIVATE KEY-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END EC PRIVATE KEY-----\n";
}

// PEM "PUBLIC KEY" (SPKI) a partir del punto publico crudo (65 octetos).
function ec_spki_pem_from_point($point) {
    $alg = der_tlv(0x30, der_tlv(0x06, hex2bin('2A8648CE3D0201')) . der_oid_curve());
    $der = der_tlv(0x30, $alg . der_tlv(0x03, "\x00" . $point));
    return "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END PUBLIC KEY-----\n";
}

// Punto publico P-256 (X9.62, 65 octetos) a partir de una llave openssl EC.
function ec_point_from_key($key) {
    $det = openssl_pkey_get_details($key);
    if (!$det || empty($det['ec'])) {
        return null;
    }
    $x = str_pad($det['ec']['x'], 32, "\x00", STR_PAD_LEFT);
    $y = str_pad($det['ec']['y'], 32, "\x00", STR_PAD_LEFT);
    return "\x04" . $x . $y;
}

function ec_load_private($derB64) {
    $der = base64_decode($derB64, true);
    if ($der === false || $der === '') {
        return null;
    }
    $pem = "-----BEGIN PRIVATE KEY-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END PRIVATE KEY-----\n";
    $key = openssl_pkey_get_private($pem);
    return $key ? $key : null;
}

// Convierte la firma ECDSA DER de openssl a la forma cruda r||s (64 octetos) que
// exige JWS ES256.
function ecdsa_der_to_raw($der) {
    if ($der === '' || $der[0] !== "\x30") {
        return null;
    }
    $i = 2;
    $tag = ord($der[$i++] ?? "\x00");
    if ($tag !== 0x02) return null;
    $len = ord($der[$i++] ?? "\x00");
    $r = ltrim(substr($der, $i, $len), "\x00");
    if ($r === '') return null;
    $i += $len;
    $tag = ord($der[$i++] ?? "\x00");
    if ($tag !== 0x02) return null;
    $len = ord($der[$i++] ?? "\x00");
    $s = ltrim(substr($der, $i, $len), "\x00");
    if ($s === '') return null;
    return str_pad($r, 32, "\x00", STR_PAD_LEFT) . str_pad($s, 32, "\x00", STR_PAD_LEFT);
}

// Llave publica VAPID (punto crudo 65 octetos) derivada de la llave de config.
function push_public_raw() {
    static $point = null;
    if ($point === null) {
        if (!push_enabled()) {
            return '';
        }
        $key = ec_load_private(VAPID_PRIVATE_KEY);
        $point = $key ? (ec_point_from_key($key) ?: '') : '';
    }
    return $point;
}

function push_public_key_base64url() {
    $point = push_public_raw();
    return $point === '' ? '' : b64url_encode($point);
}

// Cabecera "Authorization: vapid ..." para un endpoint dado.
function vapid_authorization($endpoint) {
    $key = ec_load_private(VAPID_PRIVATE_KEY);
    if (!$key) {
        return '';
    }
    $point = ec_point_from_key($key);
    if ($point === null) {
        return '';
    }
    $aud = parse_url($endpoint, PHP_URL_SCHEME) . '://' . parse_url($endpoint, PHP_URL_HOST);
    $port = parse_url($endpoint, PHP_URL_PORT);
    if ($port) {
        $aud .= ':' . $port;
    }
    $sub = VAPID_SUBJECT !== '' ? VAPID_SUBJECT : APP_BASE_URL;
    $header = b64url_encode(json_encode(['typ' => 'JWT', 'alg' => 'ES256']));
    $claims = b64url_encode(json_encode(['aud' => $aud, 'exp' => time() + 43200, 'sub' => $sub]));
    $signingInput = $header . '.' . $claims;
    $sig = '';
    $ok = openssl_sign($signingInput, $sig, $key, OPENSSL_ALGO_SHA256);
    $raw = $ok ? ecdsa_der_to_raw($sig) : null;
    if ($raw === null) {
        return '';
    }
    return 'vapid t=' . $signingInput . '.' . b64url_encode($raw) . ', k=' . b64url_encode($point);
}

// Cifra el payload (RFC 8291 + RFC 8188, un solo record). Devuelve el body
// listo para POSTear (header aes128gcm + ciphertext), o null si falla.
function webpush_encrypt($payloadJson, $asD, $asPoint, $uaPoint, $auth, $salt = null) {
    $key = openssl_pkey_get_private(ec_sec1_pem_from_raw($asD, $asPoint));
    $peer = openssl_pkey_get_public(ec_spki_pem_from_point($uaPoint));
    if (!$key || !$peer) {
        return null;
    }
    $ecdh = openssl_pkey_derive($peer, $key);
    if (!is_string($ecdh) || $ecdh === '') {
        return null;
    }
    if ($salt === null) {
        $salt = random_bytes(16);
    }
    // Combina el secreto ECDH con el auth_secret de la suscripcion (RFC 8291 3.4).
    $prkKey = hash_hmac('sha256', $ecdh, $auth, true);
    $keyInfo = 'WebPush: info' . "\x00" . $uaPoint . $asPoint;
    $ikm = hash_hmac('sha256', $keyInfo . "\x01", $prkKey, true);
    // Deriva CEK y nonce con el salt aleatorio (RFC 8188 2.2 / 2.3).
    $prk = hash_hmac('sha256', $ikm, $salt, true);
    $cek = substr(hash_hmac('sha256', "Content-Encoding: aes128gcm\x00\x01", $prk, true), 0, 16);
    $nonce = substr(hash_hmac('sha256', "Content-Encoding: nonce\x00\x01", $prk, true), 0, 12);
    // Record unico (ultimo): delimiter de padding 0x02, sin padding extra.
    $plain = $payloadJson . "\x02";
    $cipher = openssl_encrypt($plain, 'aes-128-gcm', $cek, OPENSSL_RAW_DATA, $nonce, $tag, '', 16);
    if ($cipher === false) {
        return null;
    }
    $header = $salt . pack('N', 4096) . chr(strlen($asPoint)) . $asPoint;
    return $header . $cipher . $tag;
}

// Permite solo push services conocidos (evita SSRF por endpoints forzados).
function push_host_allowed($host) {
    $fixed = [
        'fcm.googleapis.com',
        'android.googleapis.com',
        'push.services.mozilla.com',
        'updates.push.services.mozilla.com',
        'web.push.apple.com',
    ];
    if (in_array($host, $fixed, true)) {
        return true;
    }
    $host = strtolower($host);
    $suffix = ['.notify.windows.com', '.googleapis.com', '.mozilla.com'];
    foreach ($suffix as $sfx) {
        if (substr($host, -strlen($sfx)) === $sfx) {
            return true;
        }
    }
    return false;
}

function push_http_post($url, $headers, $body) {
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_TIMEOUT => 10,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_RETURNTRANSFER => true,
        ]);
        $resp = @curl_exec($ch);
        $code = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        return $code;
    }
    $ctx = stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' => implode("\r\n", $headers),
            'content' => $body,
            'timeout' => 10,
            'ignore_errors' => true,
        ],
    ]);
    @file_get_contents($url, false, $ctx);
    $code = 0;
    foreach ($http_response_header ?? [] as $h) {
        if (preg_match('#^HTTP/\S+\s+(\d+)#i', $h, $m)) {
            $code = (int)$m[1];
        }
    }
    return $code;
}

function push_read(&$fp = null) {
    $data = json_read(PUSH_FILE, $fp);
    if (!is_array($data) || !isset($data['subscriptions']) || !is_array($data['subscriptions'])) {
        $data = ['subscriptions' => []];
    }
    return $data;
}

// $owner: id del usuario dueno de la suscripcion (para no avisar a otros).
function push_store($endpoint, $p256dh, $auth, $ua = '', $owner = '') {
    $data = push_read($fp);
    $found = false;
    foreach ($data['subscriptions'] as &$sub) {
        if ($sub['endpoint'] === $endpoint) {
            $sub['p256dh'] = $p256dh;
            $sub['auth'] = $auth;
            $sub['ua'] = $ua;
            if ($owner !== '') $sub['owner'] = $owner;
            $sub['ts'] = gmdate('c');
            $found = true;
            break;
        }
    }
    unset($sub);
    if (!$found) {
        $data['subscriptions'][] = [
            'endpoint' => $endpoint,
            'p256dh' => $p256dh,
            'auth' => $auth,
            'ua' => $ua,
            'owner' => $owner,
            'ts' => gmdate('c'),
        ];
    }
    json_save($data, $fp);
}

// Con $owner no nulo solo borra la suscripcion de ese usuario (o una legacy
// sin dueno); un usuario no puede desuscribir el dispositivo de otro.
function push_remove($endpoint, $owner = null) {
    $data = push_read($fp);
    $kept = [];
    foreach ($data['subscriptions'] as $sub) {
        if ($sub['endpoint'] === $endpoint) {
            if ($owner !== null && ($sub['owner'] ?? '') !== '' && ($sub['owner'] ?? '') !== $owner) {
                $kept[] = $sub; // no es suya: se conserva
                continue;
            }
            continue; // se borra
        }
        $kept[] = $sub;
    }
    $data['subscriptions'] = $kept;
    json_save($data, $fp);
}

// Envia el aviso a las suscripciones guardadas. Con $bridge solo avisa a los
// duenos que pueden ver ese puente (evita fugas entre usuarios). Devuelve
// cuantas se pudieron notificar. Elimina las suscripciones caidas (404/410).
function push_send($title, $body, $clickPath = 'chat.php', $bridge = null) {
    if (!push_enabled()) {
        return 0;
    }
    $key = ec_load_private(VAPID_PRIVATE_KEY);
    $asPoint = $key ? ec_point_from_key($key) : null;
    if ($key === null || $asPoint === null) {
        return 0;
    }
    $det = openssl_pkey_get_details($key);
    $asD = $det['ec']['d'] ?? '';
    if ($asD === '') {
        return 0;
    }
    $url = APP_BASE_URL . '/' . $clickPath;
    $payload = json_encode([
        'title' => $title,
        'body' => $body,
        'url' => $url,
        'ts' => gmdate('c'),
    ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    if (strlen($payload) > 3500) {
        return 0; // texto demasiado largo para un push (no deberia pasar)
    }

    $data = push_read($fp);
    $sent = 0;
    $dead = [];
    $processed = 0;
    $maxSubs = 20; // tope: no bloquear la respuesta por cientos de dispositivos
    $userCache = [];
    foreach ($data['subscriptions'] as $sub) {
        if ($processed >= $maxSubs) break;
        // Filtro por dueno: solo los usuarios que pueden ver el puente de la
        // sesion reciben el aviso (admin incluido).
        if ($bridge !== null) {
            $owner = isset($sub['owner']) ? (string)$sub['owner'] : '';
            if ($owner === '' || !function_exists('ob_user_by_id') || !function_exists('ob_bridge_visible')) {
                continue;
            }
            if (!isset($userCache[$owner])) $userCache[$owner] = ob_user_by_id($owner);
            $u = $userCache[$owner];
            if (!$u || !ob_bridge_visible($bridge, $u)) continue;
        }
        $endpoint = isset($sub['endpoint']) ? (string)$sub['endpoint'] : '';
        $uaPoint = b64url_decode((string)($sub['p256dh'] ?? ''));
        $auth = b64url_decode((string)($sub['auth'] ?? ''));
        $host = parse_url($endpoint, PHP_URL_HOST) ?: '';
        $scheme = parse_url($endpoint, PHP_URL_SCHEME) ?: '';
        if ($endpoint === '' || $scheme !== 'https' || !push_host_allowed($host)
            || strlen($uaPoint) !== 65 || strlen($auth) !== 16) {
            continue;
        }
        $body64 = webpush_encrypt($payload, $asD, $asPoint, $uaPoint, $auth);
        if ($body64 === null) {
            continue;
        }
        $authz = vapid_authorization($endpoint);
        if ($authz === '') {
            continue;
        }
        $processed++;
        $code = push_http_post($endpoint, [
            'Content-Type: application/octet-stream',
            'Content-Encoding: aes128gcm',
            'Authorization: ' . $authz,
            'TTL: 86400',
        ], $body64);
        if ($code === 404 || $code === 410) {
            $dead[] = $endpoint;
        } elseif ($code >= 200 && $code < 300) {
            $sent++;
        }
    }
    if ($dead) {
        foreach ($dead as $endpoint) {
            foreach ($data['subscriptions'] as $i => $sub) {
                if ($sub['endpoint'] === $endpoint) {
                    unset($data['subscriptions'][$i]);
                }
            }
        }
        $data['subscriptions'] = array_values($data['subscriptions']);
        json_save($data, $fp);
    } else {
        json_done($fp);
    }
    return $sent;
}

// Envia el push despues de responder: con PHP-FPM se libera la conexion al
// cliente con fastcgi_finish_request() y recien ahi se hace la red; sin FPM
// (php -S) queda sincrono, pero el cliente ya no espera la respuesta.
function push_send_later($title, $body, $clickPath = 'chat.php', $bridge = null) {
    if (!push_enabled()) return;
    register_shutdown_function(function () use ($title, $body, $clickPath, $bridge) {
        if (function_exists('fastcgi_finish_request')) {
            @fastcgi_finish_request();
        }
        @ignore_user_abort(true);
        @set_time_limit(20);
        try {
            push_send($title, $body, $clickPath, $bridge);
        } catch (Throwable $e) {
            // el push nunca debe romper el cierre del request
        }
    });
}

// ---------------------------------------------------------------------------
// Explorador de archivos (solo dentro del workspace del puente activo).
// ---------------------------------------------------------------------------
function catalog_workspace_root($file = CATALOG_FILE) {
    $cat = catalog_read($file);
    return isset($cat['workspace']) ? (string)$cat['workspace'] : '';
}

// Devuelve la ruta absoluta validada dentro de workspace, o null si se escapa.
// Se pasa la ruta tal como la manda el cliente (puede tener / o \ mezclados).
function safe_join_workspace($rel, $maxDepth = 4, $file = CATALOG_FILE) {
    $root = catalog_workspace_root($file);
    if ($root === '') return null;
    $rootReal = @realpath($root);
    if (!$rootReal || !is_dir($rootReal)) return null;
    $rel = str_replace('\\', '/', (string)$rel);
    $rel = ltrim($rel, '/');
    if ($rel === '' || $rel === '.') return $rootReal;
    // separa por / y descarta segmentos sospechosos (.., vacío)
    $parts = array_values(array_filter(explode('/', $rel), function ($p) {
        return $p !== '' && $p !== '.' && $p !== '..';
    }));
    if (count($parts) > $maxDepth) return null;
    $candidate = $rootReal;
    foreach ($parts as $p) {
        $candidate .= DIRECTORY_SEPARATOR . $p;
    }
    $real = @realpath($candidate);
    if (!$real) return null;
    // tiene que quedar dentro de rootReal
    $rootNorm = rtrim($rootReal, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR;
    $realNorm = rtrim($real, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR;
    if (strncmp($realNorm, $rootNorm, strlen($rootNorm)) !== 0) return null;
    return $real;
}

function file_too_big($path, $max = 524288) {
    if (!is_file($path)) return true;
    $s = @filesize($path);
    if ($s === false) return true;
    return $s > $max;
}

function read_text_file($path, $max = 524288) {
    if (!is_file($path) || !is_readable($path)) return null;
    if (file_too_big($path, $max)) return null;
    $data = @file_get_contents($path);
    if ($data === false) return null;
    // detecta binario: cualquier byte NUL o > 30% no imprimibles
    $len = strlen($data);
    if ($len === 0) return '';
    $sample = substr($data, 0, min(4096, $len));
    $nonPrintable = 0;
    for ($i = 0; $i < strlen($sample); $i++) {
        $o = ord($sample[$i]);
        if ($o === 0 || ($o < 32 && $o !== 9 && $o !== 10 && $o !== 13)) {
            $nonPrintable++;
        }
    }
    if ($nonPrintable / max(1, strlen($sample)) > 0.3) return null;
    return $data;
}

function fmt_size($n) {
    if ($n < 1024) return $n . ' B';
    if ($n < 1024 * 1024) return round($n / 1024, 1) . ' KB';
    if ($n < 1024 * 1024 * 1024) return round($n / (1024 * 1024), 1) . ' MB';
    return round($n / (1024 * 1024 * 1024), 1) . ' GB';
}

// Lista el workspace. Con $recursive=true expande subcarpetas (depth-limited).
// Excluye node_modules, .git, dist, build y carpetas ocultas para no colgarse
// recorriendo miles de archivos.
function workspace_skip_name($name) {
    if ($name === '' || $name[0] === '.') return true;
    static $skip = ['node_modules', 'dist', 'build', '.next', '.cache', '.venv', '__pycache__', 'vendor', 'target', 'Pods', '.gradle', '.idea', '.vscode'];
    return in_array($name, $skip, true);
}

function workspace_list($rel, $file = CATALOG_FILE) {
    $root = catalog_workspace_root($file);
    $absRoot = @realpath($root);
    $base = ($rel === '' || $rel === '.') ? $absRoot : safe_join_workspace($rel, 8, $file);
    if (!$base || !is_dir($base)) return null;

    $entries = workspace_list_entries($base, $absRoot);

    return [
        'path' => $base === $absRoot ? '' : trim(str_replace('\\', '/', substr($base, strlen($absRoot))), '/'),
        'entries' => $entries,
    ];
}

// Lista subcarpetas y archivos inmediatos (un nivel), carpetas primero.
// Excluye node_modules, .git, etc. para no recorrer miles de archivos.
function workspace_list_entries($base, $absRoot) {
    $rootNorm = rtrim($absRoot, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR;
    $items = @scandir($base);
    if (!is_array($items)) return [];
    $dirs = [];
    $files = [];
    foreach ($items as $name) {
        if ($name === '.' || $name === '..') continue;
        if (workspace_skip_name($name)) continue;
        $full = $base . DIRECTORY_SEPARATOR . $name;
        $st = @stat($full);
        if (!$st) continue;
        $isDir = ($st['mode'] & 040000) === 040000;
        if (!$isDir) {
            if (($st['mode'] & 0120000) === 0120000) {
                $real = @realpath($full);
                if (!$real) continue;
                $realNorm = rtrim($real, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR;
                if (strncmp($realNorm, $rootNorm, strlen($rootNorm)) !== 0) continue;
                if (!@is_dir($real)) continue;
            } else {
                // archivo regular: se lista con tamaño y fecha
                $files[] = [
                    'name' => $name,
                    'type' => 'file',
                    'size' => @filesize($full),
                    'mtime' => @filemtime($full),
                ];
                continue;
            }
        }
        $dirs[] = [
            'name' => $name,
            'type' => 'dir',
            'size' => null,
            'mtime' => null,
        ];
    }
    $cmp = function ($a, $b) {
        return strcmp(strtolower($a['name']), strtolower($b['name']));
    };
    usort($dirs, $cmp);
    usort($files, $cmp);
    return array_merge($dirs, $files);
}

// ---------------------------------------------------------------------------
// Cola de comandos para el puente (read-only).
// ---------------------------------------------------------------------------
function enqueue_command($name, $args = [], $file = CATALOG_FILE) {
    $id = 0;
    catalog_modify(function (&$cat) use ($name, $args, &$id) {
        $id = isset($cat['nextCommandId']) ? (int)$cat['nextCommandId'] : 1;
        $cat['nextCommandId'] = $id + 1;
        if (!isset($cat['commands']) || !is_array($cat['commands'])) $cat['commands'] = [];
        $cat['commands'][] = [
            'id' => $id,
            'name' => (string)$name,
            'args' => array_values(array_map('strval', $args)),
            'status' => 'pending',
            'result' => null,
            'error' => '',
            'ts' => gmdate('c'),
        ];
        $cat = prune_commands($cat);
    }, $file);
    if ($id > 0) ob_wake();
    return $id;
}

function claim_commands($file = CATALOG_FILE) {
    $out = [];
    catalog_modify(function (&$cat) use (&$out) {
        if (!isset($cat['commands']) || !is_array($cat['commands'])) return;
        foreach ($cat['commands'] as $i => $c) {
            if ($c['status'] === 'pending') {
                $cat['commands'][$i]['status'] = 'processing';
                $out[] = [
                    'id' => (int)$c['id'],
                    'name' => $c['name'],
                    'args' => isset($c['args']) ? $c['args'] : [],
                ];
            }
        }
        $cat = prune_commands($cat);
    }, $file);
    return $out;
}

// Acota el historial de la cola de comandos: deja como mucho `$keep` entradas
// terminadas (done/error), conservando las MÁS NUEVAS (el array está en orden
// de inserción, así que se recortan del principio). Nunca toca pending ni
// processing (un cliente puede estar consultando su resultado). Además corta
// por BYTES: un `fs_read`/`proc_log` grande puede pesar cientos de KB y 60 de
// ellos inflaban catalog.json a decenas de MB (y el SSE lo releía entero).
function prune_commands($cat, $keep = 60, $maxBytes = 2097152) {
    if (!isset($cat['commands']) || !is_array($cat['commands'])) return $cat;
    $finishedIdx = [];
    $bytes = 0;
    foreach ($cat['commands'] as $i => $c) {
        $st = isset($c['status']) ? $c['status'] : '';
        if ($st === 'done' || $st === 'error') {
            $finishedIdx[] = $i;
            $bytes += strlen((string)($c['result'] ?? '')) + strlen((string)($c['error'] ?? ''));
        }
    }
    $drop = [];
    // 1) Por cantidad: deja los `$keep` terminados mas nuevos.
    $excess = count($finishedIdx) - $keep;
    if ($excess > 0) $drop = array_slice($finishedIdx, 0, $excess);
    // 2) Por bytes: sigue descartando los mas viejos hasta entrar en el tope
    // (sin bajar del minimo de 5, por conveniencia de la UI).
    if ($bytes > $maxBytes) {
        $minKeep = 5;
        $remaining = count($finishedIdx) - count($drop);
        foreach ($finishedIdx as $i) {
            if ($bytes <= $maxBytes || $remaining <= $minKeep) break;
            if (in_array($i, $drop, true)) continue;
            $c = $cat['commands'][$i];
            $bytes -= strlen((string)($c['result'] ?? '')) + strlen((string)($c['error'] ?? ''));
            $drop[] = $i;
            $remaining--;
        }
    }
    if (!$drop) return $cat;
    foreach ($drop as $i) unset($cat['commands'][$i]);
    $cat['commands'] = array_values($cat['commands']);
    return $cat;
}

// Chequeo sin efectos para el long-poll del poll: ¿hay algo que el puente
// pueda reclamar ahora? No reclama nada; las escrituras pasan recién en la
// fase de reclamo, cuando ya se va a responder (así un cliente que corta la
// conexión a mitad de la espera no deja mensajes marcados como processing).
// Solo mira mensajes de sesiones que puede ejecutar ESTE puente ($bridge),
// más su propia cola de carpetas/comandos.
function poll_peek_work($cutoff, $bridge = '') {
    if (bridge_reset_pending()) return true;
    $work = false;
    $q = queue_read($bridge);
    foreach ($q['items'] as $it) {
        if (($it['status'] ?? '') === 'pending'
            || (($it['status'] ?? '') === 'processing' && strtotime($it['ts'] ?? '') < $cutoff)) {
            return true;
        }
    }
    $cat = catalog_read(bridge_catalog_file($bridge));
    if (!empty($cat['allow_create_folders'])) {
        foreach ((array)($cat['requests'] ?? []) as $r) {
            if (($r['status'] ?? '') === 'pending') return true;
        }
    }
    foreach ((array)($cat['commands'] ?? []) as $c) {
        if (($c['status'] ?? '') === 'pending') return true;
    }
    return false;
}

function finish_command($id, $ok, $text, $error = '', $file = CATALOG_FILE) {
    $found = false;
    catalog_modify(function (&$cat) use ($id, $ok, $text, $error, &$found) {
        if (!isset($cat['commands']) || !is_array($cat['commands'])) return;
        foreach ($cat['commands'] as $i => $c) {
            if ((int)$c['id'] === (int)$id) {
                $cat['commands'][$i]['status'] = $ok ? 'done' : 'error';
                $cat['commands'][$i]['result'] = (string)$text;
                $cat['commands'][$i]['error'] = (string)$error;
                $cat['commands'][$i]['finished_ts'] = gmdate('c');
                $found = true;
                break;
            }
        }
        if ($found) $cat = prune_commands($cat);
    }, $file);
    return $found;
}

// ---------------------------------------------------------------------------
// Diagnostico: resumen de uso de `data/` (tamanos, contadores y bytes de la
// cola de comandos). Lo usa `?action=diag` (solo admin).
// ---------------------------------------------------------------------------
function ob_data_stats() {
    $out = [
        'total_bytes' => 0,
        'files' => [],
        'messages' => ['count' => 0, 'bytes' => 0],
        'sessions' => 0,
        'bridges' => 0,
        'subscriptions' => 0,
        'command_bytes' => 0,
    ];
    $entries = @scandir(DATA_DIR);
    if (!is_array($entries)) return $out;
    foreach ($entries as $f) {
        if ($f === '.' || $f === '..') continue;
        $path = DATA_DIR . '/' . $f;
        if (!is_file($path)) continue;
        $sz = (int)@filesize($path);
        $out['total_bytes'] += $sz;
        if (preg_match('/^messages-(\d+)\.json$/', $f)) {
            $out['messages']['count']++;
            $out['messages']['bytes'] += $sz;
            continue;
        }
        if (preg_match('/^catalog.*\.json$/', $f)) {
            $out['files'][$f] = $sz;
            $cat = @json_decode((string)@file_get_contents($path), true);
            if (is_array($cat) && isset($cat['commands']) && is_array($cat['commands'])) {
                foreach ($cat['commands'] as $c) {
                    $out['command_bytes'] += strlen((string)($c['result'] ?? '')) + strlen((string)($c['error'] ?? ''));
                }
            }
            continue;
        }
        if ($f === 'sessions.json') {
            $sd = @json_decode((string)@file_get_contents($path), true);
            if (is_array($sd) && isset($sd['sessions']) && is_array($sd['sessions'])) {
                $out['sessions'] = count($sd['sessions']);
            }
        } elseif ($f === 'bridges.json') {
            $bd = @json_decode((string)@file_get_contents($path), true);
            if (is_array($bd) && isset($bd['bridges']) && is_array($bd['bridges'])) {
                $out['bridges'] = count($bd['bridges']);
            }
        } elseif ($f === 'push.json') {
            $pd = @json_decode((string)@file_get_contents($path), true);
            if (is_array($pd) && isset($pd['subscriptions']) && is_array($pd['subscriptions'])) {
                $out['subscriptions'] = count($pd['subscriptions']);
            }
        }
        $out['files'][$f] = $sz;
    }
    arsort($out['files']);
    return $out;
}

// Lista de sesiones de opencode parseada del output crudo del puente.
function oc_sessions_list() {
    $entries = @scandir(DATA_DIR);
    $found = [];
    if (!is_array($entries)) return $found;
    foreach ($entries as $f) {
        if (preg_match('/^messages-(\d+)\.json$/', $f, $m)) {
            $sid = (int)$m[1];
            $data = json_read(DATA_DIR . '/' . $f, $fp);
            $sess = null;
            $sessFile = SESSIONS_FILE;
            $sd = json_read($sessFile, $sfp);
            if (is_array($sd) && !empty($sd['sessions'])) {
                foreach ($sd['sessions'] as $s) {
                    if ((int)$s['id'] === $sid) { $sess = $s; break; }
                }
            }
            if ($sfp) json_done($sfp);
            if ($fp) json_done($fp);
            $opencode = $sess && !empty($sess['opencode_session']) ? $sess['opencode_session'] : null;
            $found[] = [
                'session_id' => $sid,
                'name' => $sess ? $sess['name'] : ('Chat ' . $sid),
                'folder' => $sess ? ($sess['folder'] ?? '') : '',
                'model' => $sess ? ($sess['model'] ?? '') : '',
                'agent' => $sess ? ($sess['agent'] ?? 'build') : 'build',
                'opencode_session' => $opencode,
                'has_opencode' => !empty($opencode),
            ];
        }
    }
    return $found;
}

// ---------------------------------------------------------------------------
// Búsqueda full-text simple sobre todos los messages-*.json.
// ---------------------------------------------------------------------------
function search_index_build($query, $maxSnippets = 3) {
    $q = trim((string)$query);
    if ($q === '' || mb_strlen($q) < 2) return [];
    $needle = mb_strtolower($q);
    $out = [];
    $entries = @scandir(DATA_DIR);
    if (!is_array($entries)) return $out;
    $sessions = [];
    $sd = json_read(SESSIONS_FILE, $sfp);
    if (is_array($sd) && !empty($sd['sessions'])) {
        foreach ($sd['sessions'] as $s) {
            $sessions[(int)$s['id']] = $s;
        }
    }
    if ($sfp) json_done($sfp);
    foreach ($entries as $f) {
        if (!preg_match('/^messages-(\d+)\.json$/', $f, $m)) continue;
        $sid = (int)$m[1];
        $data = json_read(DATA_DIR . '/' . $f, $fp);
        if (!is_array($data) || empty($data['messages'])) { if ($fp) json_done($fp); continue; }
        $matches = [];
        foreach ($data['messages'] as $msg) {
            $text = (string)($msg['text'] ?? '');
            if ($text === '') continue;
            $hay = mb_strtolower($text);
            $pos = 0;
            $count = 0;
            while (($p = mb_strpos($hay, $needle, $pos)) !== false) {
                $count++;
                if (count($matches) < $maxSnippets) {
                    $start = max(0, $p - 40);
                    $snippet = mb_substr($text, $start, 140);
                    if ($start > 0) $snippet = '…' . $snippet;
                    $matches[] = [
                        'mid' => (int)($msg['id'] ?? 0),
                        'role' => (string)($msg['role'] ?? ''),
                        'snippet' => $snippet,
                    ];
                }
                $pos = $p + mb_strlen($needle);
            }
        }
        if ($fp) json_done($fp);
        if ($count > 0) {
            $out[] = [
                'session_id' => $sid,
                'name' => isset($sessions[$sid]) ? $sessions[$sid]['name'] : ('Chat ' . $sid),
                'count' => $count,
                'matches' => $matches,
            ];
        }
    }
    return $out;
}