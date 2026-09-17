<?php
/**
 * Hub PHP de OpenBridge: auth multiusuario (scrypt), cookie de sesion firmada,
 * roles, rate limit, identidad de puente con token por PC, emparejamiento por
 * codigo y dueño de cada PC.
 *
 * Es el equivalente PHP de src/auth.js + src/config.js (parte usuarios) y del
 * modelo multi-tenant que el hub Node todavia no tiene.
 */

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
function ob_b64url($data) {
    return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
}
function ob_b64url_dec($s) {
    $s = strtr((string)$s, '-_', '+/');
    $pad = strlen($s) % 4;
    if ($pad > 0) {
        $s .= str_repeat('=', 4 - $pad);
    }
    return base64_decode($s, true);
}
function ob_random_token($bytes = 32) {
    return ob_b64url(random_bytes($bytes));
}
function ob_now() {
    return gmdate('c');
}
function ob_secure() {
    if (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') return true;
    if (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https') return true;
    return false;
}
function ob_header($name) {
    $key = 'HTTP_' . strtoupper(str_replace('-', '_', $name));
    return isset($_SERVER[$key]) && is_string($_SERVER[$key]) ? trim($_SERVER[$key]) : '';
}
function ob_cookie($name) {
    return isset($_COOKIE[$name]) && is_string($_COOKIE[$name]) ? $_COOKIE[$name] : '';
}

// ---------------------------------------------------------------------------
// Password: scrypt compatible con Node (crypto.scryptSync defaults N=16384,
// r=8, p=1). El salt que usa Node es el HEX como TEXTO (32 chars), no bytes.
// Con ext-sodium usamos la primitiva; si no, scrypt puro en PHP.
// ---------------------------------------------------------------------------
function ob_rotl($v, $n) {
    $v &= 0xffffffff;
    return (($v << $n) | ($v >> (32 - $n))) & 0xffffffff;
}
function ob_salsa20_8($block) {
    $x = array_values(unpack('V16', $block));
    $in = $x;
    for ($i = 0; $i < 8; $i += 2) {
        $x[4]  ^= ob_rotl(($x[0]  + $x[12]) & 0xffffffff, 7);
        $x[8]  ^= ob_rotl(($x[4]  + $x[0])  & 0xffffffff, 9);
        $x[12] ^= ob_rotl(($x[8]  + $x[4])  & 0xffffffff, 13);
        $x[0]  ^= ob_rotl(($x[12] + $x[8])  & 0xffffffff, 18);
        $x[9]  ^= ob_rotl(($x[5]  + $x[1])  & 0xffffffff, 7);
        $x[13] ^= ob_rotl(($x[9]  + $x[5])  & 0xffffffff, 9);
        $x[1]  ^= ob_rotl(($x[13] + $x[9])  & 0xffffffff, 13);
        $x[5]  ^= ob_rotl(($x[1]  + $x[13]) & 0xffffffff, 18);
        $x[14] ^= ob_rotl(($x[10] + $x[6])  & 0xffffffff, 7);
        $x[2]  ^= ob_rotl(($x[14] + $x[10]) & 0xffffffff, 9);
        $x[6]  ^= ob_rotl(($x[2]  + $x[14]) & 0xffffffff, 13);
        $x[10] ^= ob_rotl(($x[6]  + $x[2])  & 0xffffffff, 18);
        $x[3]  ^= ob_rotl(($x[15] + $x[11]) & 0xffffffff, 7);
        $x[7]  ^= ob_rotl(($x[3]  + $x[15]) & 0xffffffff, 9);
        $x[11] ^= ob_rotl(($x[7]  + $x[3])  & 0xffffffff, 13);
        $x[15] ^= ob_rotl(($x[11] + $x[7])  & 0xffffffff, 18);
        $x[1]  ^= ob_rotl(($x[0]  + $x[3])  & 0xffffffff, 7);
        $x[2]  ^= ob_rotl(($x[1]  + $x[0])  & 0xffffffff, 9);
        $x[3]  ^= ob_rotl(($x[2]  + $x[1])  & 0xffffffff, 13);
        $x[0]  ^= ob_rotl(($x[3]  + $x[2])  & 0xffffffff, 18);
        $x[6]  ^= ob_rotl(($x[5]  + $x[4])  & 0xffffffff, 7);
        $x[7]  ^= ob_rotl(($x[6]  + $x[5])  & 0xffffffff, 9);
        $x[4]  ^= ob_rotl(($x[7]  + $x[6])  & 0xffffffff, 13);
        $x[5]  ^= ob_rotl(($x[4]  + $x[7])  & 0xffffffff, 18);
        $x[11] ^= ob_rotl(($x[10] + $x[9])  & 0xffffffff, 7);
        $x[8]  ^= ob_rotl(($x[11] + $x[10]) & 0xffffffff, 9);
        $x[9]  ^= ob_rotl(($x[8]  + $x[11]) & 0xffffffff, 13);
        $x[10] ^= ob_rotl(($x[9]  + $x[8])  & 0xffffffff, 18);
        $x[12] ^= ob_rotl(($x[15] + $x[14]) & 0xffffffff, 7);
        $x[13] ^= ob_rotl(($x[12] + $x[15]) & 0xffffffff, 9);
        $x[14] ^= ob_rotl(($x[13] + $x[12]) & 0xffffffff, 13);
        $x[15] ^= ob_rotl(($x[14] + $x[13]) & 0xffffffff, 18);
    }
    $out = '';
    for ($i = 0; $i < 16; $i++) {
        $out .= pack('V', ($x[$i] + $in[$i]) & 0xffffffff);
    }
    return $out;
}
function ob_blockmix($b, $r) {
    $x = substr($b, (2 * $r - 1) * 64, 64);
    $y = [];
    for ($i = 0; $i < 2 * $r; $i++) {
        $x = ob_salsa20_8($x ^ substr($b, $i * 64, 64));
        $y[$i] = $x;
    }
    $out = '';
    for ($i = 0; $i < $r; $i++) $out .= $y[2 * $i];
    for ($i = 0; $i < $r; $i++) $out .= $y[2 * $i + 1];
    return $out;
}
function ob_romix($b, $n, $r) {
    $x = $b;
    $v = [];
    for ($i = 0; $i < $n; $i++) {
        $v[$i] = $x;
        $x = ob_blockmix($x, $r);
    }
    for ($i = 0; $i < $n; $i++) {
        $j = unpack('V', substr($x, (2 * $r - 1) * 64, 4))[1] % $n;
        $x = ob_blockmix($x ^ $v[$j], $r);
    }
    return $x;
}
function ob_scrypt_raw($password, $salt, $n, $r, $p, $dkLen) {
    $b = hash_pbkdf2('sha256', $password, $salt, 1, $p * 128 * $r, true);
    $out = '';
    for ($i = 0; $i < $p; $i++) {
        $out .= ob_romix(substr($b, $i * 128 * $r, 128 * $r), $n, $r);
    }
    return hash_pbkdf2('sha256', $password, $out, 1, $dkLen, true);
}
function ob_scrypt($password, $salt, $keylen) {
    if (function_exists('sodium_crypto_pwhash_scryptsalsa208sha256_ll')) {
        return sodium_crypto_pwhash_scryptsalsa208sha256_ll($password, $salt, 16384, 8, 1, $keylen);
    }
    return ob_scrypt_raw($password, $salt, 16384, 8, 1, $keylen);
}
function ob_hash_password($password) {
    $salt = bin2hex(random_bytes(16)); // 32 chars: Node usa este texto como salt
    $keylen = 64;
    return ['algo' => 'scrypt', 'salt' => $salt, 'hash' => bin2hex(ob_scrypt((string)$password, $salt, $keylen)), 'keylen' => $keylen];
}
function ob_verify_password($password, $stored) {
    if (!is_array($stored) || ($stored['algo'] ?? '') !== 'scrypt' || empty($stored['salt']) || empty($stored['hash'])) {
        return false;
    }
    $keylen = (int)($stored['keylen'] ?? 64) ?: 64;
    $calc = bin2hex(ob_scrypt((string)$password, (string)$stored['salt'], $keylen));
    return hash_equals((string)$stored['hash'], $calc);
}

// ---------------------------------------------------------------------------
// Usuarios
// ---------------------------------------------------------------------------
function ob_user_list() {
    global $OB_APP;
    return isset($OB_APP['users']) && is_array($OB_APP['users']) ? $OB_APP['users'] : [];
}
function ob_find_user($name) {
    $n = strtolower(trim((string)$name));
    if ($n === '') return null;
    foreach (ob_user_list() as $u) {
        if (strtolower((string)($u['name'] ?? '')) === $n) return $u;
    }
    return null;
}
function ob_user_by_id($id) {
    foreach (ob_user_list() as $u) {
        if (($u['id'] ?? '') === $id) return $u;
    }
    return null;
}
function ob_verify_user_password($user, $password) {
    return is_array($user) && ob_verify_password($password, $user['password'] ?? null);
}
function ob_admin_count() {
    $n = 0;
    foreach (ob_user_list() as $u) {
        if (($u['role'] ?? '') === 'admin' && empty($u['disabled'])) $n++;
    }
    return $n;
}

// ---------------------------------------------------------------------------
// Sesion web: cookie firmada (stateless), igual que src/auth.js.
// Payload base64url(JSON{u,pv,c,e}) + '.' + HMAC-SHA256(csrfSecret).
// ---------------------------------------------------------------------------
define('OB_SESSION_COOKIE', 'ob_session');
define('OB_REMEMBER_COOKIE', 'ob_remember');
define('OB_LASTUSER_COOKIE', 'ob_lastuser');
define('OB_CSRF_COOKIE', 'ob_csrf');
define('OB_SESSION_TTL', 30 * 86400);

function ob_session_sign($payloadB64) {
    return hash_hmac('sha256', $payloadB64, OB_CSRF_SECRET);
}
function ob_make_session($user, $csrf = null) {
    $payload = [
        'u' => (string)($user['id'] ?? ''),
        'pv' => (int)($user['pv'] ?? 1),
        'c' => $csrf ?: bin2hex(random_bytes(16)),
        'e' => time() + OB_SESSION_TTL,
    ];
    $b64 = ob_b64url(json_encode($payload));
    return $b64 . '.' . ob_session_sign($b64);
}
function ob_read_session() {
    $raw = ob_cookie(OB_SESSION_COOKIE);
    if ($raw === '' || strpos($raw, '.') === false) return null;
    list($b64, $sig) = explode('.', $raw, 2);
    if (!hash_equals(ob_session_sign($b64), $sig)) return null;
    $data = json_decode((string)ob_b64url_dec($b64), true);
    if (!is_array($data) || empty($data['u']) || empty($data['e']) || (int)$data['e'] < time()) return null;
    $user = ob_user_by_id($data['u']);
    if (!$user || !empty($user['disabled'])) return null;
    if ((int)($user['pv'] ?? 1) !== (int)($data['pv'] ?? 1)) return null; // pv subio: sesion invalidada
    return ['id' => $data['u'], 'name' => $user['name'], 'role' => $user['role'] ?? 'user', 'csrf' => $data['c'] ?? ''];
}
function ob_set_cookie($name, $value, $maxAge = 0) {
    $opts = [
        'expires' => $maxAge > 0 ? time() + $maxAge : 0,
        'path' => '/',
        'secure' => ob_secure(),
        'httponly' => true,
        'samesite' => 'Lax',
    ];
    if (PHP_VERSION_ID >= 70300) {
        setcookie($name, $value, $opts);
    } else {
        setcookie($name, $value, $opts['expires'], '/; samesite=Lax', '', $opts['secure'], $opts['httponly']);
    }
}
function ob_start_session($user, $remember = false) {
    ob_set_cookie(OB_SESSION_COOKIE, ob_make_session($user), OB_SESSION_TTL);
    ob_set_cookie(OB_LASTUSER_COOKIE, (string)$user['name'], 365 * 86400);
    if ($remember) {
        $exp = time() + OB_SESSION_TTL;
        $sig = hash_hmac('sha256', $user['id'] . '|' . $exp, OB_CSRF_SECRET);
        ob_set_cookie(OB_REMEMBER_COOKIE, ob_b64url($user['id'] . '|' . $exp . '|' . $sig), OB_SESSION_TTL);
    }
}
function ob_end_session() {
    ob_set_cookie(OB_SESSION_COOKIE, '', -3600);
    ob_set_cookie(OB_REMEMBER_COOKIE, '', -3600);
}
function ob_remember_auto_login() {
    if (ob_read_session()) return true;
    $raw = ob_b64url_dec(ob_cookie(OB_REMEMBER_COOKIE));
    if (!is_string($raw) || $raw === '') return false;
    $parts = explode('|', $raw);
    if (count($parts) !== 3) return false;
    list($uid, $exp, $sig) = $parts;
    if (!ctype_digit((string)$exp) || (int)$exp < time()) return false;
    if (!hash_equals(hash_hmac('sha256', $uid . '|' . $exp, OB_CSRF_SECRET), $sig)) return false;
    $user = ob_user_by_id($uid);
    if (!$user || !empty($user['disabled'])) return false;
    ob_start_session($user, false);
    return true;
}

// ---------------------------------------------------------------------------
// Login rate limit (por ip|usuario): 5 fallos / 15 min, lock 15 min.
// ---------------------------------------------------------------------------
function ob_login_lock_file() {
    return DATA_DIR . '/.login-lock.json';
}
function ob_login_lock_remaining($username) {
    $all = @json_decode((string)@file_get_contents(ob_login_lock_file()), true);
    if (!is_array($all)) return 0;
    $ip = $_SERVER['REMOTE_ADDR'] ?? 'x';
    $e = $all[strtolower($ip . '|' . $username)] ?? null;
    if (!is_array($e) || empty($e['until'])) return 0;
    return max(0, (int)$e['until'] - time());
}
function ob_login_record_failure($username) {
    $path = ob_login_lock_file();
    $all = @json_decode((string)@file_get_contents($path), true);
    if (!is_array($all)) $all = [];
    $ip = $_SERVER['REMOTE_ADDR'] ?? 'x';
    $key = strtolower($ip . '|' . $username);
    $e = $all[$key] ?? ['fails' => 0, 'until' => 0];
    $e['fails'] = (int)$e['fails'] + 1;
    if ($e['fails'] >= 5) {
        $e['until'] = time() + 900;
        $e['fails'] = 0;
    }
    $all[$key] = $e;
    @file_put_contents($path, json_encode($all), LOCK_EX);
}
function ob_login_clear($username) {
    $path = ob_login_lock_file();
    $all = @json_decode((string)@file_get_contents($path), true);
    if (!is_array($all)) return;
    $ip = $_SERVER['REMOTE_ADDR'] ?? 'x';
    unset($all[strtolower($ip . '|' . $username)]);
    @file_put_contents($path, json_encode($all), LOCK_EX);
}

// ---------------------------------------------------------------------------
// Gates de la API web (equivalen a requireLogin/requireRole/requireCsrf).
// ---------------------------------------------------------------------------
function ob_current_user() {
    return ob_read_session();
}
function require_login() {
    $u = ob_current_user();
    if (!$u) {
        json_response(['ok' => false, 'error' => 'No autorizado'], 401);
    }
    return $u;
}
// En PHP no hay lock de sesion que liberar; se mantiene por compatibilidad.
function require_login_readonly() {
    return require_login();
}
function require_role($roles) {
    $u = require_login();
    if (!in_array($u['role'], (array)$roles, true)) {
        json_response(['ok' => false, 'error' => 'Permiso insuficiente'], 403);
    }
    return $u;
}
function current_csrf() {
    $u = ob_current_user();
    return $u ? $u['csrf'] : '';
}
function require_csrf() {
    $u = require_login();
    $given = ob_header('X-CSRF');
    if ($given !== '' && $u['csrf'] !== '' && hash_equals($u['csrf'], $given)) {
        return $u;
    }
    json_response(['ok' => false, 'error' => 'Sesion expirada, recarga la pagina.'], 403);
}

// ---------------------------------------------------------------------------
// Identidad del puente: token global (legacy) o token por PC.
// ---------------------------------------------------------------------------
function ob_bridges_map() {
    $data = @json_decode((string)@file_get_contents(BRIDGES_FILE), true);
    return (is_array($data) && isset($data['bridges']) && is_array($data['bridges'])) ? $data['bridges'] : [];
}
function ob_token_hash($token) {
    return hash('sha256', (string)$token);
}
// Devuelve ['id'=>, 'owner'=>, 'legacy'=>bool] o null.
function ob_bridge_identity() {
    $given = ob_header('X-Bridge-Token');
    if ($given === '' && isset($_GET['token'])) $given = trim((string)$_GET['token']);
    if ($given === '') return null;
    if (BRIDGE_TOKEN !== '' && hash_equals(BRIDGE_TOKEN, $given)) {
        $id = '';
        $h = ob_header('X-Bridge-Id');
        if (bridge_valid_id($h)) $id = $h;
        return ['id' => $id, 'owner' => null, 'legacy' => true];
    }
    $h = ob_token_hash($given);
    foreach (ob_bridges_map() as $id => $e) {
        if (!empty($e['token_hash']) && hash_equals((string)$e['token_hash'], $h)) {
            return ['id' => $id, 'owner' => $e['owner'] ?? null, 'legacy' => false];
        }
    }
    return null;
}
// Compatibilidad con api.php (port de OpenConex): bool + fija el id del puente.
function check_bridge_token($server = null) {
    $ident = ob_bridge_identity();
    $GLOBALS['OB_BRIDGE_IDENTITY'] = $ident;
    return $ident !== null;
}

// ---------------------------------------------------------------------------
// Dueno de PCs / visibilidad
// ---------------------------------------------------------------------------
function ob_is_admin($user) {
    return is_array($user) && ($user['role'] ?? '') === 'admin';
}
function ob_visible_bridge_ids($user) {
    if (ob_is_admin($user)) return null; // null = todas
    $uid = is_array($user) ? ($user['id'] ?? '') : '';
    $out = [];
    foreach (ob_bridges_map() as $id => $e) {
        if (($e['owner'] ?? null) === $uid) $out[] = $id;
    }
    return $out;
}
function ob_bridge_visible($bridge, $user) {
    if (ob_is_admin($user)) return true;
    if ($bridge === '') return false;
    $ids = ob_visible_bridge_ids($user);
    return is_array($ids) && in_array($bridge, $ids, true);
}
function ob_can_use_bridge($bridge, $user) {
    return ob_bridge_visible($bridge, $user);
}
// ¿El usuario puede ver/operar esta sesión? (su PC es suya; el admin ve todo).
function ob_session_accessible($sess, $user) {
    if (ob_is_admin($user)) return true;
    $owner = function_exists('session_bridge') ? session_bridge($sess) : (string)($sess['bridge'] ?? '');
    return ob_bridge_visible($owner, $user);
}
function ob_require_session($sess) {
    $u = require_login();
    if (!ob_session_accessible($sess, $u)) {
        json_response(['ok' => false, 'error' => 'Permiso insuficiente'], 403);
    }
    return $u;
}

// ---------------------------------------------------------------------------
// Emparejamiento por codigo (device code).
// ---------------------------------------------------------------------------
function ob_pairings_read() {
    $d = @json_decode((string)@file_get_contents(PAIRINGS_FILE), true);
    if (!is_array($d) || !isset($d['pending']) || !is_array($d['pending'])) {
        $d = ['version' => 1, 'pending' => []];
    }
    return $d;
}
function ob_pairings_write($d) {
    $tmp = PAIRINGS_FILE . '.' . getmypid() . '.tmp';
    @file_put_contents($tmp, json_encode($d, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX);
    @rename($tmp, PAIRINGS_FILE);
}
// Codigo legible: 8 chars base32 Crockford, en formato XXXX-XXXX.
function ob_user_code() {
    $alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    $s = '';
    for ($i = 0; $i < 8; $i++) $s .= $alphabet[random_int(0, 31)];
    return substr($s, 0, 4) . '-' . substr($s, 4);
}
function ob_user_code_norm($code) {
    return preg_replace('/[^0-9A-Z]/', '', strtoupper((string)$code));
}
function ob_pair_start($bridgeId, $bridgeName) {
    $d = ob_pairings_read();
    $now = time();
    // limpia expirados
    foreach ($d['pending'] as $k => $e) {
        if (($e['expires_ts'] ?? 0) < $now) unset($d['pending'][$k]);
    }
    $device = ob_random_token(32);
    $code = ob_user_code();
    $norm = ob_user_code_norm($code);
    $d['pending'][$norm] = [
        'device_hash' => ob_token_hash($device),
        'bridge_id' => bridge_valid_id($bridgeId) ? $bridgeId : '',
        'bridge_name' => mb_substr((string)$bridgeName, 0, 40),
        'created_ts' => $now,
        'expires_ts' => $now + 600,
        'status' => 'pending',
        'owner' => null,
        'token_hash' => null,
    ];
    ob_pairings_write($d);
    return ['code' => $code, 'device_code' => $device, 'expires_in' => 600];
}
function ob_pair_poll($deviceCode) {
    $d = ob_pairings_read();
    $h = ob_token_hash($deviceCode);
    foreach ($d['pending'] as $norm => $e) {
        if (($e['device_hash'] ?? '') !== $h) continue;
        if (($e['expires_ts'] ?? 0) < time()) return ['status' => 'expired'];
        if (($e['status'] ?? '') === 'approved') {
            // Un solo uso: consume y devuelve credenciales.
            $bridgeId = $e['bridge_id'] !== '' ? $e['bridge_id'] : ('pc' . substr(ob_token_hash($deviceCode), 0, 6));
            $token = ob_random_token(32);
            ob_bridge_upsert($bridgeId, $e['bridge_name'], $e['owner'], ob_token_hash($token));
            unset($d['pending'][$norm]);
            ob_pairings_write($d);
            return ['status' => 'approved', 'bridge_id' => $bridgeId, 'bridge_name' => $e['bridge_name'], 'bridge_token' => $token];
        }
        return ['status' => 'pending'];
    }
    return ['status' => 'unknown'];
}
function ob_pair_approve($userCode, $user) {
    $norm = ob_user_code_norm($userCode);
    $d = ob_pairings_read();
    $e = $d['pending'][$norm] ?? null;
    if (!is_array($e)) return ['ok' => false, 'error' => 'Codigo invalido'];
    if (($e['expires_ts'] ?? 0) < time()) return ['ok' => false, 'error' => 'Codigo expirado'];
    if (($e['status'] ?? '') === 'approved') return ['ok' => false, 'error' => 'Codigo ya usado'];
    $d['pending'][$norm]['status'] = 'approved';
    $d['pending'][$norm]['owner'] = $user['id'];
    ob_pairings_write($d);
    return ['ok' => true, 'bridge' => ['id' => $e['bridge_id'], 'name' => $e['bridge_name']]];
}
function ob_bridge_upsert($id, $name, $owner, $tokenHash) {
    if (!bridge_valid_id($id)) return;
    $data = @json_decode((string)@file_get_contents(BRIDGES_FILE), true);
    if (!is_array($data) || !isset($data['bridges']) || !is_array($data['bridges'])) {
        $data = ['version' => 2, 'bridges' => []];
    }
    if (!isset($data['bridges'][$id]) || !is_array($data['bridges'][$id])) {
        $data['bridges'][$id] = ['id' => $id];
    }
    $data['bridges'][$id]['name'] = $name !== '' ? $name : $id;
    $data['bridges'][$id]['owner'] = $owner;
    $data['bridges'][$id]['token_hash'] = $tokenHash;
    $data['bridges'][$id]['paired_ts'] = ob_now();
    $tmp = BRIDGES_FILE . '.' . getmypid() . '.tmp';
    @file_put_contents($tmp, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX);
    @rename($tmp, BRIDGES_FILE);
}
function ob_bridge_revoke($id, $user) {
    $data = @json_decode((string)@file_get_contents(BRIDGES_FILE), true);
    if (!is_array($data) || !isset($data['bridges'][$id])) return false;
    if (!ob_is_admin($user) && ($data['bridges'][$id]['owner'] ?? null) !== $user['id']) return false;
    unset($data['bridges'][$id]);
    $tmp = BRIDGES_FILE . '.' . getmypid() . '.tmp';
    @file_put_contents($tmp, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX);
    @rename($tmp, BRIDGES_FILE);
    return true;
}
function ob_bridges_list($user) {
    $out = [];
    foreach (ob_bridges_map() as $id => $e) {
        if (!ob_bridge_visible($id, $user)) continue;
        $ts = $e['last_online_ts'] ?? '';
        $out[] = [
            'id' => $id,
            'name' => ($e['name'] ?? '') !== '' ? $e['name'] : $id,
            'owner' => $e['owner'] ?? null,
            'paired_ts' => $e['paired_ts'] ?? '',
            'online' => $ts !== '' && (time() - strtotime($ts)) <= 120,
        ];
    }
    usort($out, function ($a, $b) { return strcmp($a['id'], $b['id']); });
    return $out;
}

// ---------------------------------------------------------------------------
// Rate limit generico (emparejamiento): $max por $window segundos.
// ---------------------------------------------------------------------------
function ob_pair_rate_ok($key, $max = 10, $window = 900) {
    $path = DATA_DIR . '/.pair-rate.json';
    $all = @json_decode((string)@file_get_contents($path), true);
    if (!is_array($all)) $all = [];
    $now = time();
    $e = isset($all[$key]) && is_array($all[$key]) ? $all[$key] : ['n' => 0, 't' => $now];
    if ($now - (int)($e['t'] ?? 0) > $window) {
        $e = ['n' => 0, 't' => $now];
    }
    $e['n'] = (int)($e['n'] ?? 0) + 1;
    $all[$key] = $e;
    @file_put_contents($path, json_encode($all), LOCK_EX);
    return $e['n'] <= $max;
}

// ---------------------------------------------------------------------------
// Cabeceras de seguridad (equivalen a src/web/server.js).
// ---------------------------------------------------------------------------
function ob_security_headers() {
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: no-referrer');
    header('X-Frame-Options: DENY');
    header("Content-Security-Policy: default-src 'self'; img-src 'self' data:; "
        . "style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; "
        . "connect-src 'self'; worker-src 'self'; manifest-src 'self'; "
        . "frame-src 'self' http: https:; "
        . "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}

// Render minimo de plantillas {{VAR}} (mismo formato que routes.js).
function ob_render($name, $vars) {
    $tpl = @file_get_contents(__DIR__ . '/templates/' . $name);
    if ($tpl === false) return '';
    return preg_replace_callback('/\{\{([A-Z_]+)\}\}/', function ($m) use ($vars) {
        return array_key_exists($m[1], $vars) ? (string)$vars[$m[1]] : $m[0];
    }, $tpl);
}

// Token CSRF de la pantalla de login (cookie ob_csrf, como el hub Node).
function ob_login_csrf() {
    $c = ob_cookie(OB_CSRF_COOKIE);
    if ($c === '' || !preg_match('/^[a-f0-9]{16,64}$/', $c)) {
        $c = bin2hex(random_bytes(16));
        ob_set_cookie(OB_CSRF_COOKIE, $c, 3600);
    }
    return $c;
}
function ob_last_user() {
    return preg_replace('/[^A-Za-z0-9._-]/', '', ob_cookie(OB_LASTUSER_COOKIE));
}
// Tema elegido: ?theme= o cookie ob_theme / ocx_theme (legado), si es conocido.
function ob_pick_theme($known) {
    $fromUrl = preg_replace('/[^a-z-]/', '', strtolower((string)($_GET['theme'] ?? '')));
    $fromCookie = preg_replace('/[^a-z-]/', '', strtolower(ob_cookie('ob_theme') !== '' ? ob_cookie('ob_theme') : ob_cookie('ocx_theme')));
    if ($fromUrl !== '' && in_array($fromUrl, $known, true)) return $fromUrl;
    if ($fromCookie !== '' && in_array($fromCookie, $known, true)) return $fromCookie;
    return 'terminal';
}
function ob_esc($s) {
    return htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8');
}
