<?php
require __DIR__ . '/config.php';
require_once __DIR__ . '/lib.php';
ob_security_headers();
if (!ob_read_session()) {
    ob_remember_auto_login();
}
$u = ob_read_session();
header('Location: ' . ($u ? 'chat.php' : 'login.php'));
