<?php
/**
 * WHMCS MCP Event Hook — pushes allowlisted events to the MCP event receiver.
 *
 * Drop this file into <WHMCS_ROOT>/includes/hooks/ and configure the two
 * required settings below (or via WHMCS Configuration → General → Other).
 *
 * Environment / define constants (set in configuration.php or a wrapper that
 * loads before hooks, or as env vars on the container):
 *   MCP_EVENT_RECEIVER_URL    — full URL (required)
 *   MCP_EVENT_HMAC_SECRET     — shared HMAC-SHA256 secret (never commit)
 *   MCP_EVENT_AUTHORIZATION   — full Authorization header value,
 *                                e.g. "Bearer <token>" (never commit)
 *
 * At least one of MCP_EVENT_HMAC_SECRET or MCP_EVENT_AUTHORIZATION must be set
 * alongside MCP_EVENT_RECEIVER_URL for the hook to fire.
 *
 * @see docs/runbooks/whmcs-event-hook.md
 */

if (!defined('MCP_EVENT_RECEIVER_URL') && getenv('MCP_EVENT_RECEIVER_URL')) {
    define('MCP_EVENT_RECEIVER_URL', getenv('MCP_EVENT_RECEIVER_URL'));
}
if (!defined('MCP_EVENT_HMAC_SECRET') && getenv('MCP_EVENT_HMAC_SECRET')) {
    define('MCP_EVENT_HMAC_SECRET', getenv('MCP_EVENT_HMAC_SECRET'));
}
if (!defined('MCP_EVENT_AUTHORIZATION') && getenv('MCP_EVENT_AUTHORIZATION')) {
    define('MCP_EVENT_AUTHORIZATION', getenv('MCP_EVENT_AUTHORIZATION'));
}

/**
 * POST a signed JSON payload to the MCP event receiver.
 * Best-effort: failures are logged but never bubble up to the WHMCS UI.
 */
function mcpEventPost(string $eventType, array $payload): void
{
    if (!defined('MCP_EVENT_RECEIVER_URL') || empty(MCP_EVENT_RECEIVER_URL)) {
        return;
    }

    $url   = MCP_EVENT_RECEIVER_URL;
    $secret = defined('MCP_EVENT_HMAC_SECRET') ? MCP_EVENT_HMAC_SECRET : '';
    $auth   = defined('MCP_EVENT_AUTHORIZATION') ? MCP_EVENT_AUTHORIZATION : '';

    if (empty($secret) && empty($auth)) {
        return;
    }

    $event = [
        'event'     => $eventType,
        'timestamp' => gmdate('Y-m-d\TH:i:s\Z'),
        'event_id'  => bin2hex(random_bytes(16)),
        'payload'   => $payload,
    ];

    $body    = json_encode($event, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    $headers = [
        'Content-Type: application/json',
        'X-MCP-Event: ' . $eventType,
    ];

    if (!empty($secret)) {
        $signature = hash_hmac('sha256', $body, $secret);
        $headers[] = 'X-MCP-Signature: sha256=' . $signature;
    }

    if (!empty($auth)) {
        $headers[] = 'Authorization: ' . $auth;
    }

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => $body,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 5,
        CURLOPT_CONNECTTIMEOUT => 3,
        CURLOPT_HTTPHEADER     => $headers,
    ]);

    $result   = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err      = curl_error($ch);
    curl_close($ch);

    if ($result === false || $httpCode >= 400) {
        logActivity(sprintf(
            'MCP Event Hook: failed to POST %s (HTTP %d): %s',
            $eventType,
            $httpCode,
            $err ?: substr((string)$result, 0, 200)
        ));
    }
}

// ── Hook registrations (allowlisted events only) ──────────────────────────

add_hook('InvoicePaid', 1, function (array $vars) {
    mcpEventPost('invoice.paid', [
        'invoiceid' => $vars['invoiceid'] ?? null,
    ]);
});

add_hook('TicketOpen', 1, function (array $vars) {
    mcpEventPost('ticket.opened', [
        'ticketid'     => $vars['ticketid'] ?? null,
        'ticketmask'   => $vars['ticketmask'] ?? null,
        'deptid'       => $vars['deptid'] ?? null,
        'deptname'     => $vars['deptname'] ?? null,
        'clientid'     => $vars['userid'] ?? null,
        'subject'      => $vars['subject'] ?? null,
        'priority'     => $vars['priority'] ?? null,
    ]);
});

add_hook('AfterModuleSuspend', 1, function (array $vars) {
    if (($vars['completed'] ?? false) === true) {
        mcpEventPost('service.suspended', [
            'serviceid' => $vars['params']['serviceid'] ?? null,
            'clientid'  => $vars['params']['clientsdetails']['userid'] ?? null,
            'reason'    => $vars['params']['suspendreason'] ?? '',
        ]);
    }
});

add_hook('AfterModuleCreate', 1, function (array $vars) {
    if (($vars['completed'] ?? false) !== true) {
        mcpEventPost('module.create_failed', [
            'serviceid'    => $vars['params']['serviceid'] ?? null,
            'clientid'     => $vars['params']['clientsdetails']['userid'] ?? null,
            'module'       => $vars['params']['moduletype'] ?? '',
            'error'        => $vars['failurereason'] ?? '',
        ]);
    }
});

add_hook('DailyCronJob', 1, function (array $vars) {
    // Domain grace/expiry detection from the daily cron.
    // Query domains in grace or expired status that changed today.
    if (!function_exists('localAPI')) {
        return;
    }

    $today = date('Y-m-d');

    $result = localAPI('GetClientsDomains', [
        'status'   => 'Expired',
        'limitnum' => 50,
    ]);

    if (($result['result'] ?? '') === 'success' && !empty($result['domains']['domain'])) {
        foreach ($result['domains']['domain'] as $domain) {
            $expiryDate = $domain['expirydate'] ?? '';
            if (substr($expiryDate, 0, 10) === $today || $domain['status'] === 'Grace') {
                mcpEventPost('domain.grace_or_expired', [
                    'domainid'   => $domain['id'] ?? null,
                    'domain'     => $domain['domainname'] ?? '',
                    'status'     => $domain['status'] ?? '',
                    'expirydate' => $expiryDate,
                    'clientid'   => $domain['userid'] ?? null,
                ]);
            }
        }
    }
});
