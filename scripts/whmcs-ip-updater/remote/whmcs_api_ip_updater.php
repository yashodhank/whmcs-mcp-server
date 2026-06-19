<?php
declare(strict_types=1);

error_reporting(E_ALL);
ini_set('display_errors', '0');

const TARGET_ROW = 'APIAllowedIPs';
const NOTE_IPV4 = 'MacIPv4';
const NOTE_IPV6 = 'MacIPv6';

function respond(bool $ok, string $code, string $message, array $data = []): never
{
    $payload = [
        'ok' => $ok,
        'code' => $code,
        'message' => $message,
        'data' => $data,
    ];
    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit($ok ? 0 : 1);
}

set_exception_handler(static function (Throwable $e): void {
    error_log('[whmcs-api-ip-updater] ' . $e->getMessage());
    respond(false, 'INTERNAL_ERROR', 'Internal worker failure');
});

set_error_handler(static function (int $severity, string $message, string $file, int $line): bool {
    throw new ErrorException($message, 0, $severity, $file, $line);
});

/**
 * Canonicalize and constrain the WHMCS root. Rejects relative paths, parent
 * traversal, and any resolved path outside the allowed prefix. Returns the
 * normalized absolute path (no trailing slash) or calls respond() and exits.
 */
function sanitize_whmcs_root(string $whmcsRoot): string
{
    $allowedPrefix = '/var/www/';

    if ($whmcsRoot === '' || $whmcsRoot[0] !== '/') {
        respond(false, 'INVALID_WHMCS_ROOT', 'whmcs_root must be an absolute path');
    }
    foreach (explode('/', $whmcsRoot) as $segment) {
        if ($segment === '..') {
            respond(false, 'INVALID_WHMCS_ROOT', 'whmcs_root must not contain parent-directory segments');
        }
    }
    $normalized = rtrim($whmcsRoot, '/');
    // If it exists, resolve symlinks and re-check the prefix; if it does not
    // exist yet, the absolute + no-".." checks above still apply.
    $resolved = realpath($normalized);
    $candidate = $resolved !== false ? $resolved : $normalized;
    if (strpos($candidate . '/', $allowedPrefix) !== 0) {
        respond(false, 'INVALID_WHMCS_ROOT', 'whmcs_root is outside the allowed base directory');
    }
    return $candidate;
}

function b64url_decode_str(string $input): string
{
    $remainder = strlen($input) % 4;
    if ($remainder > 0) {
        $input .= str_repeat('=', 4 - $remainder);
    }
    $decoded = base64_decode(strtr($input, '-_', '+/'), true);
    if ($decoded === false) {
        respond(false, 'INVALID_PAYLOAD', 'Unable to decode payload argument');
    }
    return $decoded;
}

function decode_payload(?string $encoded): array
{
    if ($encoded === null || $encoded === '') {
        return [];
    }
    if (!preg_match('/^[A-Za-z0-9_-]+$/', $encoded)) {
        respond(false, 'INVALID_PAYLOAD', 'Payload contains unsupported characters');
    }
    $decoded = b64url_decode_str($encoded);
    $parsed = json_decode($decoded, true);
    if (!is_array($parsed)) {
        respond(false, 'INVALID_PAYLOAD', 'Decoded payload is not JSON object');
    }
    return $parsed;
}

function checksum(string $value): string
{
    return hash('sha256', $value);
}

function validate_public_ip(string $ip, int $version): bool
{
    $flags = FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE;
    $flags |= ($version === 4) ? FILTER_FLAG_IPV4 : FILTER_FLAG_IPV6;
    return filter_var($ip, FILTER_VALIDATE_IP, ['flags' => $flags]) !== false;
}

function connect_db(string $whmcsRoot): mysqli
{
    $configPath = rtrim($whmcsRoot, '/') . '/configuration.php';
    if (!is_file($configPath)) {
        respond(false, 'CONFIG_FILE_MISSING', 'configuration.php not found', ['path' => $configPath]);
    }

    /** @noinspection PhpIncludeInspection */
    require $configPath;

    $required = ['db_host', 'db_username', 'db_password', 'db_name'];
    foreach ($required as $var) {
        if (!isset($$var) || !is_string($$var) || $$var === '') {
            respond(false, 'CONFIG_INVALID', 'Missing WHMCS DB configuration value', ['key' => $var]);
        }
    }

    $db = @new mysqli($db_host, $db_username, $db_password, $db_name);
    if ($db->connect_errno) {
        respond(false, 'DB_CONNECT_FAILED', 'Unable to connect to database', ['errno' => $db->connect_errno]);
    }
    $db->set_charset('utf8mb4');
    return $db;
}

function fetch_api_allowed_ips_raw(mysqli $db): string
{
    $stmt = $db->prepare('SELECT value FROM tblconfiguration WHERE setting = ? LIMIT 1');
    if (!$stmt) {
        respond(false, 'DB_QUERY_PREPARE_FAILED', 'Failed to prepare configuration query');
    }
    $setting = TARGET_ROW;
    $stmt->bind_param('s', $setting);
    $stmt->execute();
    $result = $stmt->get_result();
    $row = $result ? $result->fetch_assoc() : null;
    $stmt->close();

    if (!$row || !array_key_exists('value', $row)) {
        respond(false, 'CONFIG_ROW_MISSING', 'APIAllowedIPs configuration row is missing');
    }
    return (string) $row['value'];
}

function decode_allowlist(string $raw): array
{
    $value = @unserialize($raw, ['allowed_classes' => false]);
    if ($value === false && $raw !== serialize(false)) {
        respond(false, 'UNSERIALIZE_FAILED', 'Failed to unserialize APIAllowedIPs payload');
    }
    if (!is_array($value)) {
        respond(false, 'PAYLOAD_NOT_ARRAY', 'APIAllowedIPs unserialized value is not array');
    }
    return $value;
}

function find_target_indexes(array $allowlist): array
{
    $found = [
        NOTE_IPV4 => [],
        NOTE_IPV6 => [],
    ];

    foreach ($allowlist as $idx => $entry) {
        if (!is_array($entry) || !array_key_exists('note', $entry)) {
            continue;
        }
        $note = (string) $entry['note'];
        if ($note === NOTE_IPV4 || $note === NOTE_IPV6) {
            $found[$note][] = $idx;
        }
    }

    foreach ([NOTE_IPV4, NOTE_IPV6] as $note) {
        if (count($found[$note]) > 1) {
            respond(false, 'DUPLICATE_TARGET_NOTE', 'Duplicate target notes found', ['note' => $note, 'indexes' => $found[$note]]);
        }
    }

    return $found;
}

function ensure_backup_table(mysqli $db): void
{
    // Required column set. Keep this in lock-step with the CREATE TABLE DDL
    // emitted by remote/install-remote-bootstrap.sh (search for
    // "CREATE TABLE IF NOT EXISTS mod_api_ip_allowlist_backups"). If you add a
    // new column to the installer DDL, append it here so existing installs
    // detect the missing column and prompt the operator to re-run bootstrap.
    $requiredColumns = [
        'id',
        'created_at',
        'reason',
        'old_value',
        'new_value',
        'checksum_before',
        'checksum_after',
        'applied',
        'applied_at',
    ];

    $result = $db->query('SHOW COLUMNS FROM mod_api_ip_allowlist_backups');
    if (!$result) {
        respond(false, 'SCHEMA_MIGRATION_REQUIRED', 'Backup schema missing; run install-remote-bootstrap.sh before updater actions');
    }

    $columns = [];
    while ($row = $result->fetch_assoc()) {
        $columns[(string) $row['Field']] = true;
    }
    $result->free();

    foreach ($requiredColumns as $column) {
        if (!isset($columns[$column])) {
            respond(false, 'SCHEMA_MIGRATION_REQUIRED', 'Backup schema incomplete; run install-remote-bootstrap.sh before updater actions', [
                'missing_column' => $column,
            ]);
        }
    }
}

function insert_backup(mysqli $db, string $reason, string $oldValue, string $newValue, string $checksumBefore, string $checksumAfter): int
{
    $stmt = $db->prepare('INSERT INTO mod_api_ip_allowlist_backups (reason, old_value, new_value, checksum_before, checksum_after, applied, applied_at) VALUES (?, ?, ?, ?, ?, 0, NULL)');
    if (!$stmt) {
        respond(false, 'DB_UPDATE_FAILED', 'Failed to prepare backup insert');
    }
    $stmt->bind_param('sssss', $reason, $oldValue, $newValue, $checksumBefore, $checksumAfter);
    if (!$stmt->execute()) {
        $stmt->close();
        respond(false, 'DB_UPDATE_FAILED', 'Failed to insert backup row');
    }
    $id = (int) $stmt->insert_id;
    $stmt->close();
    return $id;
}

function mark_backup_applied(mysqli $db, int $backupId): void
{
    $stmt = $db->prepare('UPDATE mod_api_ip_allowlist_backups SET applied = 1, applied_at = NOW() WHERE id = ?');
    if (!$stmt) {
        respond(false, 'DB_UPDATE_FAILED', 'Failed to prepare backup mark-applied query');
    }
    $stmt->bind_param('i', $backupId);
    if (!$stmt->execute()) {
        $stmt->close();
        respond(false, 'DB_UPDATE_FAILED', 'Failed to mark backup as applied');
    }
    $stmt->close();
}

function assert_non_target_semantics(array $before, array $after, array $targetIndexes): void
{
    foreach ($before as $idx => $entry) {
        if (in_array($idx, $targetIndexes, true)) {
            continue;
        }
        $left = json_encode($entry, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $right = json_encode($after[$idx] ?? null, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($left !== $right) {
            respond(false, 'CHECKSUM_VERIFY_FAILED', 'Non-target semantic preservation check failed', ['index' => $idx]);
        }
    }
}

function apply_targets(array $allowlist, array $targetIndexes, ?string $ipv4, ?string $ipv6): array
{
    $updated = $allowlist;
    $changed = false;
    $selectedIndexes = [];

    if ($ipv4 !== null) {
        $idx = $targetIndexes[NOTE_IPV4][0] ?? null;
        if ($idx === null) {
            respond(false, 'TARGET_NOTE_MISSING', 'MacIPv4 note was not found');
        }
        $selectedIndexes[] = $idx;
        if (!is_array($updated[$idx])) {
            respond(false, 'PAYLOAD_NOT_ARRAY', 'Target IPv4 entry is not array');
        }
        $current = (string) ($updated[$idx]['ip'] ?? '');
        if ($current !== $ipv4) {
            $updated[$idx]['ip'] = $ipv4;
            $changed = true;
        }
    }

    if ($ipv6 !== null) {
        $idx = $targetIndexes[NOTE_IPV6][0] ?? null;
        if ($idx === null) {
            respond(false, 'TARGET_NOTE_MISSING', 'MacIPv6 note was not found');
        }
        $selectedIndexes[] = $idx;
        if (!is_array($updated[$idx])) {
            respond(false, 'PAYLOAD_NOT_ARRAY', 'Target IPv6 entry is not array');
        }
        $current = (string) ($updated[$idx]['ip'] ?? '');
        if ($current !== $ipv6) {
            $updated[$idx]['ip'] = $ipv6;
            $changed = true;
        }
    }

    assert_non_target_semantics($allowlist, $updated, $selectedIndexes);

    return [$updated, $changed];
}

function compare_and_swap_update(mysqli $db, string $expectedOldRaw, string $newRaw): bool
{
    $stmt = $db->prepare('UPDATE tblconfiguration SET value = ? WHERE setting = ? AND value = ?');
    if (!$stmt) {
        respond(false, 'DB_UPDATE_FAILED', 'Failed to prepare compare-and-swap query');
    }
    $setting = TARGET_ROW;
    $stmt->bind_param('sss', $newRaw, $setting, $expectedOldRaw);
    if (!$stmt->execute()) {
        $stmt->close();
        respond(false, 'DB_UPDATE_FAILED', 'Database update failed');
    }
    $affected = $stmt->affected_rows;
    $stmt->close();
    return $affected > 0;
}

function action_verify(mysqli $db): never
{
    $raw = fetch_api_allowed_ips_raw($db);
    $allowlist = decode_allowlist($raw);
    $targets = find_target_indexes($allowlist);

    if (count($targets[NOTE_IPV4]) !== 1) {
        respond(false, 'TARGET_NOTE_MISSING', 'MacIPv4 note missing during verification');
    }
    if (count($targets[NOTE_IPV6]) !== 1) {
        respond(false, 'TARGET_NOTE_MISSING', 'MacIPv6 note missing during verification');
    }

    respond(true, 'OK', 'Remote worker verification successful', [
        'row_setting' => TARGET_ROW,
        'entries_count' => count($allowlist),
        'mac_ipv4_indexes' => $targets[NOTE_IPV4],
        'mac_ipv6_indexes' => $targets[NOTE_IPV6],
        'checksum' => checksum($raw),
    ]);
}

function action_read(mysqli $db): never
{
    $raw = fetch_api_allowed_ips_raw($db);
    $allowlist = decode_allowlist($raw);
    $targets = find_target_indexes($allowlist);

    if (count($targets[NOTE_IPV4]) !== 1) {
        respond(false, 'TARGET_NOTE_MISSING', 'MacIPv4 note missing');
    }
    if (count($targets[NOTE_IPV6]) !== 1) {
        respond(false, 'TARGET_NOTE_MISSING', 'MacIPv6 note missing');
    }

    $idx4 = $targets[NOTE_IPV4][0];
    $idx6 = $targets[NOTE_IPV6][0];

    $entry4 = $allowlist[$idx4];
    $entry6 = $allowlist[$idx6];
    if (!is_array($entry4) || !is_array($entry6)) {
        respond(false, 'PAYLOAD_NOT_ARRAY', 'Target entries are not arrays');
    }

    respond(true, 'OK', 'Read successful', [
        'mac_ipv4' => (string) ($entry4['ip'] ?? ''),
        'mac_ipv6' => (string) ($entry6['ip'] ?? ''),
        'checksum' => checksum($raw),
        'entries_count' => count($allowlist),
    ]);
}

function action_update(mysqli $db, array $payload): never
{
    $reason = isset($payload['reason']) && is_string($payload['reason']) && $payload['reason'] !== ''
        ? substr($payload['reason'], 0, 255)
        : 'Automated Mac IP refresh';

    $ipv4 = null;
    if (isset($payload['ipv4'])) {
        if (!is_string($payload['ipv4']) || !validate_public_ip($payload['ipv4'], 4)) {
            respond(false, 'INVALID_NEW_IP', 'Invalid public IPv4 target');
        }
        $ipv4 = $payload['ipv4'];
    }

    $ipv6 = null;
    if (isset($payload['ipv6'])) {
        if (!is_string($payload['ipv6']) || !validate_public_ip($payload['ipv6'], 6)) {
            respond(false, 'INVALID_NEW_IP', 'Invalid public IPv6 target');
        }
        $ipv6 = $payload['ipv6'];
    }

    if ($ipv4 === null && $ipv6 === null) {
        respond(false, 'INVALID_NEW_IP', 'At least one of ipv4/ipv6 must be provided');
    }

    ensure_backup_table($db);

    $attempts = 0;
    $currentRaw = fetch_api_allowed_ips_raw($db);

    while ($attempts < 2) {
        $attempts++;
        $allowlist = decode_allowlist($currentRaw);
        $targets = find_target_indexes($allowlist);
        [$updatedAllowlist, $changed] = apply_targets($allowlist, $targets, $ipv4, $ipv6);

        if (!$changed) {
            respond(true, 'OK', 'No change required', [
                'action' => 'no_change',
                'checksum_before' => checksum($currentRaw),
                'checksum_after' => checksum($currentRaw),
                'attempts' => $attempts,
            ]);
        }

        $newRaw = serialize($updatedAllowlist);
        $checksumBefore = checksum($currentRaw);
        $checksumAfter = checksum($newRaw);

        $db->begin_transaction();
        $backupId = insert_backup($db, $reason, $currentRaw, $newRaw, $checksumBefore, $checksumAfter);

        if (compare_and_swap_update($db, $currentRaw, $newRaw)) {
            $readback = fetch_api_allowed_ips_raw($db);
            if (checksum($readback) !== $checksumAfter) {
                $db->rollback();
                respond(false, 'CHECKSUM_VERIFY_FAILED', 'Post-write checksum verification failed', ['backup_id' => $backupId]);
            }
            mark_backup_applied($db, $backupId);
            $db->commit();
            respond(true, 'OK', 'Update applied', [
                'action' => 'updated',
                'backup_id' => $backupId,
                'checksum_before' => $checksumBefore,
                'checksum_after' => $checksumAfter,
                'attempts' => $attempts,
            ]);
        }

        if ($attempts < 2) {
            $db->rollback();
            $currentRaw = fetch_api_allowed_ips_raw($db);
            continue;
        }

        $db->rollback();
        respond(false, 'CONCURRENT_MODIFICATION_DETECTED', 'Concurrent modification detected; update aborted');
    }

    respond(false, 'DB_UPDATE_FAILED', 'Update loop exhausted unexpectedly');
}

function action_rollback(mysqli $db): never
{
    ensure_backup_table($db);

    $stmt = $db->prepare('SELECT id, old_value, new_value, checksum_before, checksum_after FROM mod_api_ip_allowlist_backups WHERE applied = 1 ORDER BY id DESC LIMIT 1');
    if (!$stmt) {
        respond(false, 'DB_UPDATE_FAILED', 'Failed to prepare rollback lookup');
    }
    $stmt->execute();
    $result = $stmt->get_result();
    $backup = $result ? $result->fetch_assoc() : null;
    $stmt->close();

    if (!$backup) {
        respond(false, 'DB_UPDATE_FAILED', 'No applied backup rows available for rollback');
    }

    $backupId = (int) $backup['id'];
    $oldValue = (string) $backup['old_value'];
    $checksumBefore = (string) $backup['checksum_before'];
    $checksumAfter = (string) $backup['checksum_after'];

    $currentRaw = fetch_api_allowed_ips_raw($db);
    $currentChecksum = checksum($currentRaw);
    if ($currentChecksum !== $checksumAfter) {
        respond(false, 'CHECKSUM_VERIFY_FAILED', 'Rollback refused: current checksum does not match latest backup', [
            'backup_id' => $backupId,
            'expected' => $checksumAfter,
            'current' => $currentChecksum,
        ]);
    }

    if (!compare_and_swap_update($db, $currentRaw, $oldValue)) {
        respond(false, 'CONCURRENT_MODIFICATION_DETECTED', 'Rollback CAS failed due to concurrent change', ['backup_id' => $backupId]);
    }

    $readback = fetch_api_allowed_ips_raw($db);
    if (checksum($readback) !== $checksumBefore) {
        respond(false, 'CHECKSUM_VERIFY_FAILED', 'Rollback checksum verification failed', ['backup_id' => $backupId]);
    }

    respond(true, 'OK', 'Rollback applied', [
        'backup_id' => $backupId,
        'checksum_after' => $checksumBefore,
    ]);
}

function action_test_api_local(string $whmcsRoot): never
{
    $configPath = rtrim($whmcsRoot, '/') . '/configuration.php';
    $initPath = rtrim($whmcsRoot, '/') . '/init.php';
    if (!is_file($configPath)) {
        respond(false, 'LOCAL_API_BOOTSTRAP_FAILED', 'configuration.php not found', ['path' => $configPath]);
    }
    if (!is_file($initPath)) {
        respond(false, 'LOCAL_API_BOOTSTRAP_FAILED', 'init.php not found', ['path' => $initPath]);
    }

    /** @noinspection PhpIncludeInspection */
    require_once $configPath;

    $tempCompileDir = '/tmp/whmcs-ip-updater-templates_c';
    if (!is_dir($tempCompileDir) && !mkdir($tempCompileDir, 0700, true) && !is_dir($tempCompileDir)) {
        respond(false, 'LOCAL_API_BOOTSTRAP_FAILED', 'Unable to create temporary templates compile directory', [
            'path' => $tempCompileDir,
        ]);
    }

    $templates_compiledir = $tempCompileDir;
    $GLOBALS['templates_compiledir'] = $tempCompileDir;

    /** @noinspection PhpIncludeInspection */
    ob_start();
    require_once $initPath;
    $bootstrapOutput = trim((string) ob_get_clean());
    if ($bootstrapOutput !== '') {
        respond(false, 'LOCAL_API_BOOTSTRAP_FAILED', 'init.php emitted unexpected output', [
            'output_preview' => substr($bootstrapOutput, 0, 500),
        ]);
    }

    if (!function_exists('localAPI')) {
        respond(false, 'LOCAL_API_BOOTSTRAP_FAILED', 'localAPI function unavailable after init bootstrap');
    }

    ob_start();
    $result = localAPI('WhmcsDetails', [], '');
    $localApiOutput = trim((string) ob_get_clean());
    if ($localApiOutput !== '') {
        respond(false, 'LOCAL_API_FAILED', 'localAPI emitted unexpected output', [
            'output_preview' => substr($localApiOutput, 0, 500),
        ]);
    }
    if (!is_array($result)) {
        respond(false, 'LOCAL_API_FAILED', 'localAPI returned non-array response');
    }
    if (($result['result'] ?? 'error') !== 'success') {
        respond(false, 'LOCAL_API_FAILED', 'localAPI returned failure', [
            'message' => (string) ($result['message'] ?? 'unknown localAPI error'),
        ]);
    }

    respond(true, 'OK', 'Local API validation successful', [
        'result' => 'success',
        'server_name' => (string) ($result['whmcs']['name'] ?? ''),
        'version' => (string) ($result['whmcs']['version'] ?? ''),
    ]);
}

$action = $argv[1] ?? '';
$payload = decode_payload($argv[2] ?? null);
$whmcsRootRaw = isset($payload['whmcs_root']) && is_string($payload['whmcs_root']) && $payload['whmcs_root'] !== ''
    ? $payload['whmcs_root']
    : '/var/www/my_securiace_usr/data/www/my.securiace.com';
$whmcsRoot = sanitize_whmcs_root($whmcsRootRaw);

$db = connect_db($whmcsRoot);

// Dispatcher. The action set below MUST stay in lock-step with the allow-list
// in the forced-command wrapper (/usr/local/sbin/whmcs-api-ip-updater).
// The wrapper rejects any action not in its case statement before invoking
// PHP, so adding a new action here without also extending the wrapper means
// it is unreachable in production.
switch ($action) {
    case 'verify':
        action_verify($db);
    case 'read':
        action_read($db);
    case 'update':
        action_update($db, $payload);
    case 'rollback':
        action_rollback($db);
    case 'test_api_local':
        action_test_api_local($whmcsRoot);
    default:
        respond(false, 'INVALID_ACTION', 'Unsupported action', ['action' => $action]);
}
