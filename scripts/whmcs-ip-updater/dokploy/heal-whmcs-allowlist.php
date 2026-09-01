#!/usr/bin/env php
<?php
declare(strict_types=1);

/**
 * Dokploy container-side WHMCS APIAllowedIPs healer.
 *
 * Env:
 *   WHMCS_ROOT          — install root (default /var/www/html)
 *   HEAL_KNOWN_IPS      — comma-separated IPv4/IPv6 to allow
 *   HEALER_ENABLED=1    — perform write; absent ⇒ dry-run verify only
 *   SNAPSHOT_DIR        — optional backup directory
 */

error_reporting(E_ALL);
ini_set('display_errors', '0');

const TARGET_ROW = 'APIAllowedIPs';
const NOTE_IPV4 = 'MacIPv4';
const NOTE_IPV6 = 'MacIPv6';

function respond(bool $ok, string $code, string $message, array $data = []): never
{
    echo json_encode(['ok' => $ok, 'code' => $code, 'message' => $message, 'data' => $data], JSON_UNESCAPED_SLASHES);
    exit($ok ? 0 : 1);
}

function connect_db(string $whmcsRoot): mysqli
{
    $configPath = rtrim($whmcsRoot, '/') . '/configuration.php';
    if (!is_file($configPath)) {
        respond(false, 'CONFIG_FILE_MISSING', 'configuration.php not found');
    }
    require $configPath;
    $db = @new mysqli($db_host, $db_username, $db_password, $db_name);
    if ($db->connect_errno) {
        respond(false, 'DB_CONNECT_FAILED', 'Unable to connect to database');
    }
    $db->set_charset('utf8mb4');
    return $db;
}

function fetch_raw(mysqli $db): string
{
    $stmt = $db->prepare('SELECT value FROM tblconfiguration WHERE setting = ? LIMIT 1');
    $setting = TARGET_ROW;
    $stmt->bind_param('s', $setting);
    $stmt->execute();
    $row = $stmt->get_result()?->fetch_assoc();
    $stmt->close();
    if (!$row || !array_key_exists('value', $row)) {
        respond(false, 'CONFIG_ROW_MISSING', 'APIAllowedIPs row missing');
    }
    return (string) $row['value'];
}

function decode_allowlist(string $raw): array
{
    $value = @unserialize($raw, ['allowed_classes' => false]);
    if (!is_array($value)) {
        respond(false, 'UNSERIALIZE_FAILED', 'APIAllowedIPs is not an array');
    }
    return $value;
}

function find_note_index(array $allowlist, string $note): ?int
{
    foreach ($allowlist as $idx => $entry) {
        if (is_array($entry) && (($entry['note'] ?? '') === $note)) {
            return (int) $idx;
        }
    }
    return null;
}

function is_ipv4(string $ip): bool
{
    return filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) !== false;
}

function is_ipv6(string $ip): bool
{
    return filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) !== false;
}

$root = getenv('WHMCS_ROOT') ?: '/var/www/html';
$known = array_values(array_filter(array_map('trim', explode(',', getenv('HEAL_KNOWN_IPS') ?: ''))));
$enabled = getenv('HEALER_ENABLED') === '1';

$ipv4 = null;
$ipv6 = null;
foreach ($known as $ip) {
    if (is_ipv4($ip)) {
        $ipv4 = $ip;
    } elseif (is_ipv6($ip)) {
        $ipv6 = $ip;
    }
}
if ($ipv4 === null && $ipv6 === null) {
    respond(false, 'INVALID_NEW_IP', 'No valid IPv4/IPv6 in HEAL_KNOWN_IPS');
}

$db = connect_db($root);
$raw = fetch_raw($db);
$allowlist = decode_allowlist($raw);
$changed = false;

if ($ipv4 !== null) {
    $idx = find_note_index($allowlist, NOTE_IPV4);
    if ($idx === null) {
        $allowlist[] = ['ip' => $ipv4, 'note' => NOTE_IPV4];
        $changed = true;
    } elseif (($allowlist[$idx]['ip'] ?? '') !== $ipv4) {
        $allowlist[$idx]['ip'] = $ipv4;
        $changed = true;
    }
}
if ($ipv6 !== null) {
    $idx = find_note_index($allowlist, NOTE_IPV6);
    if ($idx === null) {
        $allowlist[] = ['ip' => $ipv6, 'note' => NOTE_IPV6];
        $changed = true;
    } elseif (($allowlist[$idx]['ip'] ?? '') !== $ipv6) {
        $allowlist[$idx]['ip'] = $ipv6;
        $changed = true;
    }
}

if (!$changed) {
    respond(true, 'OK', 'No change required', ['action' => 'no_change']);
}

if (!$enabled) {
    respond(true, 'OK', 'Dry run — change detected but HEALER_ENABLED not set', ['action' => 'dry_run']);
}

$newRaw = serialize($allowlist);
$stmt = $db->prepare('UPDATE tblconfiguration SET value = ? WHERE setting = ? AND value = ?');
$setting = TARGET_ROW;
$stmt->bind_param('sss', $newRaw, $setting, $raw);
if (!$stmt->execute() || $stmt->affected_rows < 1) {
    respond(false, 'DB_UPDATE_FAILED', 'Compare-and-swap update failed');
}
$stmt->close();

respond(true, 'OK', 'Allowlist updated', ['action' => 'updated', 'ipv4' => $ipv4, 'ipv6' => $ipv6]);
