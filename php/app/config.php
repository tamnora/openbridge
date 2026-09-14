<?php
/**
 * Configuracion del hub PHP de OpenBridge.
 *
 * A diferencia de OpenConex (constantes sueltas), el hub lee el MISMO
 * `.openbridge/app.json` que usa el hub Node, para que la casa sea portable
 * entre ambos. La base se toma de OPENBRIDGE_HOME (o el directorio de la app):
 *
 *   <base>/.openbridge/app.json   usuarios, bridgeToken, VAPID, csrfSecret
 *   <base>/.openbridge/data/      sesiones, mensajes, catalogos, bridges, push
 *
 * El puente NO usa cookie de sesion (autentica con X-Bridge-Token), asi que no
 * abrimos sesion PHP en ningun request: la sesion web es una cookie firmada
 * (ver hub.php).
 */

$base = getenv('OPENBRIDGE_HOME');
if ($base === false || $base === '') {
    $base = __DIR__;
}
$base = rtrim(str_replace('\\', '/', $base), '/');
if (basename($base) === '.openbridge') {
    $home = $base;
} else {
    $home = $base . '/.openbridge';
}

define('OB_HOME', $home);
define('OB_APP_JSON', OB_HOME . '/app.json');
define('DATA_DIR', OB_HOME . '/data');
define('SESSIONS_FILE', DATA_DIR . '/sessions.json');
define('CATALOG_FILE', DATA_DIR . '/catalog.json');
define('PUSH_FILE', DATA_DIR . '/push.json');
define('BRIDGES_FILE', DATA_DIR . '/bridges.json');
define('PAIRINGS_FILE', DATA_DIR . '/pairings.json');
define('MESSAGES_FILE', DATA_DIR . '/messages.json'); // legacy v1

define('STALE_PROCESSING_SECONDS', 600);

// ---------------------------------------------------------------------------
// app.json
// ---------------------------------------------------------------------------
function ob_default_app() {
    return [
        'port' => 8799,
        'host' => '127.0.0.1',
        'baseUrl' => '',
        'users' => [],
        'csrfSecret' => '',
        'bridgeToken' => '',
        'vapid' => ['publicKey' => '', 'privateKey' => ''],
        'tunnel' => ['provider' => 'none', 'domain' => ''],
    ];
}

function ob_read_app() {
    $data = @json_decode((string)@file_get_contents(OB_APP_JSON), true);
    if (!is_array($data)) {
        $data = [];
    }
    $app = array_merge(ob_default_app(), $data);
    if (!is_array($app['vapid'])) {
        $app['vapid'] = ['publicKey' => '', 'privateKey' => ''];
    }
    if (!is_array($app['users'])) {
        $app['users'] = [];
    }
    // Modelo viejo (username/password) -> users[0].
    if (empty($app['users']) && isset($app['password']['hash'])) {
        $app['users'] = [[
            'id' => 'u1',
            'name' => (isset($app['username']) && $app['username'] !== '') ? $app['username'] : 'admin',
            'role' => 'admin',
            'password' => $app['password'],
            'pv' => 1,
            'created' => '',
            'disabled' => false,
        ]];
    }
    return $app;
}

$OB_APP = ob_read_app();

// ---------------------------------------------------------------------------
// Constantes que espera el store/push portado de OpenConex.
// ---------------------------------------------------------------------------
define('APP_BASE_URL', rtrim((string)($OB_APP['baseUrl'] ?? ''), '/'));
define('BRIDGE_TOKEN', (string)($OB_APP['bridgeToken'] ?? ''));
define('OB_CSRF_SECRET', (string)($OB_APP['csrfSecret'] ?? ''));
define('VAPID_SUBJECT', '');

// VAPID: app.json guarda la privada en base64url cruda (32 bytes, formato
// web-push). La lib PHP de OpenConex espera PKCS#8 DER en base64. La envolvemos
// con el prefijo fijo de P-256 (RFC 5915 + RFC 5958).
function ob_pkcs8_from_raw_private($raw32) {
    $prefix = hex2bin('3041020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420');
    return $prefix . $raw32;
}
function ob_b64url_decode($s) {
    $s = strtr((string)$s, '-_', '+/');
    $pad = strlen($s) % 4;
    if ($pad > 0) {
        $s .= str_repeat('=', 4 - $pad);
    }
    return base64_decode($s, true);
}
$ob_vapid_raw = ob_b64url_decode($OB_APP['vapid']['privateKey'] ?? '');
define('VAPID_PRIVATE_KEY', (is_string($ob_vapid_raw) && strlen($ob_vapid_raw) === 32)
    ? base64_encode(ob_pkcs8_from_raw_private($ob_vapid_raw))
    : '');

date_default_timezone_set('UTC');

// ---------------------------------------------------------------------------
// Datos iniciales
// ---------------------------------------------------------------------------
if (!is_dir(DATA_DIR)) {
    @mkdir(DATA_DIR, 0775, true);
}
foreach ([
    'sessions' => ['sessions' => [], 'nextId' => 1],
    'catalog' => ['folders' => [], 'models' => [], 'models_full' => [], 'models_ctx' => [], 'vision' => [], 'workspace' => '', 'allow_create_folders' => false, 'agents' => ['build', 'plan'], 'synced_ts' => null, 'requests' => [], 'nextRequestId' => 1, 'commands' => [], 'nextCommandId' => 1],
    'bridges' => ['version' => 2, 'bridges' => []],
    'pairings' => ['version' => 1, 'pending' => []],
    'push' => ['subscriptions' => []],
] as $name => $initial) {
    $path = DATA_DIR . '/' . $name . '.json';
    if (!file_exists($path)) {
        @file_put_contents($path, json_encode($initial, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
    }
}

require_once __DIR__ . '/lib.php';   // store, catalogo, mensajes, push (port de OpenConex)
require_once __DIR__ . '/hub.php';   // auth multiusuario, pairing, dueno de PCs
