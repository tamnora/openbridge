<?php
/**
 * Chat del hub PHP de OpenBridge. Renderiza la plantilla compartida
 * templates/chat.html con las variables que espera app.js.
 */
require __DIR__ . '/config.php';
require_once __DIR__ . '/lib.php';

ob_security_headers();

if (!ob_read_session()) {
    ob_remember_auto_login();
}
$u = ob_read_session();
if (!$u) {
    header('Location: login.php');
    exit;
}

$known = themes_known();
$initial = isset($_GET['session']) ? (int)$_GET['session'] : 0;
$ver = 0;
$appjs = __DIR__ . '/app.js';
if (file_exists($appjs)) {
    $ver = (int)filemtime($appjs);
}

$html = ob_render('chat.html', [
    'THEME' => ob_pick_theme($known),
    'CSRF' => $u['csrf'],
    'USER_NAME' => ob_esc($u['name']),
    'USER_ROLE' => ob_esc($u['role']),
    'INITIAL_SESSION' => $initial > 0 ? (string)$initial : 'null',
    'THEMES_JSON' => json_encode(themes_index(), JSON_UNESCAPED_UNICODE),
    'SSE_DISABLED' => 'false',
    'PUSH_ENABLED' => push_enabled() ? 'true' : 'false',
    'PUSH_KEY' => push_public_key_base64url(),
    'APPJS_VER' => rawurlencode((string)$ver),
]);
header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-cache');
echo $html;
