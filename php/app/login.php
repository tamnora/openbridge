<?php
/**
 * Login del hub PHP de OpenBridge. Renderiza la plantilla compartida
 * templates/login.html y valida contra los usuarios de .openbridge/app.json.
 */
require __DIR__ . '/config.php';
require_once __DIR__ . '/lib.php';

ob_security_headers();

function ob_login_error($msg, $prefill) {
    $known = themes_known();
    $html = ob_render('login.html', [
        'THEME' => ob_pick_theme($known),
        'THEMES_JSON' => json_encode(themes_index(), JSON_UNESCAPED_UNICODE),
        'ERROR_BLOCK' => '<div class="error">&#9888; ' . ob_esc($msg) . '</div>',
        'CSRF' => ob_login_csrf(),
        'USER_PREFILL' => ob_esc($prefill),
    ]);
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-cache');
    echo $html;
    exit;
}

// Ya logueado (o auto-login por remember): directo al chat.
if (ob_read_session() || ob_remember_auto_login()) {
    header('Location: chat.php');
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
    $form = $_POST;
    $csrfCookie = ob_cookie(OB_CSRF_COOKIE);
    $csrfOk = !empty($form['csrf']) && $csrfCookie !== '' && hash_equals($csrfCookie, (string)$form['csrf']);
    if (!$csrfOk) {
        ob_login_error('Sesion expirada, recarga la pagina.', '');
    }
    // Limite global por IP (todos los usuarios): frena el barrido de usuarios
    // sin depender solo del lock por ip|usuario.
    if (!ob_login_ip_rate_ok(30, 900)) {
        ob_login_error('Demasiados intentos. Proba de nuevo en unos minutos.', '');
    }
    $username = trim((string)($form['username'] ?? ''));
    $locked = ob_login_lock_remaining($username);
    if ($locked > 0) {
        $mins = max(1, (int)ceil($locked / 60));
        ob_login_error('Demasiados intentos fallidos. Proba de nuevo en ' . $mins . ' min.', $username);
    }
    $password = (string)($form['password'] ?? '');
    $user = ob_find_user($username);
    $passOk = ob_verify_user_password($user, $password);
    if ($user && empty($user['disabled']) && $passOk) {
        ob_login_clear($username);
        ob_start_session($user, !empty($form['keep']));
        header('Location: chat.php');
        exit;
    }
    ob_login_record_failure($username);
    ob_login_error('Usuario o contrasena incorrectos.', $username !== '' ? $username : ob_last_user());
}

$known = themes_known();
$html = ob_render('login.html', [
    'THEME' => ob_pick_theme($known),
    'THEMES_JSON' => json_encode(themes_index(), JSON_UNESCAPED_UNICODE),
    'ERROR_BLOCK' => '',
    'CSRF' => ob_login_csrf(),
    'USER_PREFILL' => ob_esc(ob_last_user()),
]);
header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-cache');
echo $html;
