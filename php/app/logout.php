<?php
require __DIR__ . '/config.php';
require_once __DIR__ . '/lib.php';
ob_security_headers();
ob_end_session();
header('Location: login.php');
