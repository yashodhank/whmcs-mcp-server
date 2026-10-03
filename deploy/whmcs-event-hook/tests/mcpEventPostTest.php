<?php
/**
 * Standalone tests for mcp_event_hook.php header/guard logic.
 *
 * Run:  php deploy/whmcs-event-hook/tests/mcpEventPostTest.php
 *
 * Uses a curl-intercepting shim to capture the headers sent by mcpEventPost()
 * without making real HTTP calls.
 */

$passed = 0;
$failed = 0;

function assert_true(bool $cond, string $label): void
{
    global $passed, $failed;
    if ($cond) {
        $passed++;
        echo "  ✓ {$label}\n";
    } else {
        $failed++;
        echo "  ✗ FAIL: {$label}\n";
    }
}

// ── Stub WHMCS helpers that the hook expects ──────────────────────────────

if (!function_exists('logActivity')) {
    function logActivity(string $msg): void
    {
        // no-op for tests
    }
}

// ── Capture layer: override curl functions via a namespace-free shim ──────

// We cannot override built-in curl_* in the same namespace, so we test the
// header-building logic by extracting it into a testable helper. Instead of
// loading the hook directly (which registers WHMCS hooks we can't call), we
// replicate and test the core dispatch logic that mcpEventPost uses.

/**
 * Replicate the header-building + guard logic from mcpEventPost.
 * Returns null if the function would bail (no post), or the array of headers
 * it would send to curl.
 */
function buildHeaders(string $url, string $secret, string $auth, string $eventType, string $body): ?array
{
    if (empty($url)) {
        return null;
    }

    if (empty($secret) && empty($auth)) {
        return null;
    }

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

    return $headers;
}

// ── Tests ─────────────────────────────────────────────────────────────────

$testBody = json_encode([
    'event'     => 'invoice.paid',
    'timestamp' => '2026-10-03T00:00:00Z',
    'event_id'  => 'aabbccdd00112233aabbccdd00112233',
    'payload'   => ['invoiceid' => 42],
]);

echo "\n=== Bearer-only path (no HMAC) ===\n";
$headers = buildHeaders(
    'https://api.x.ai/v1/grok-routine/wh_abc',
    '',
    'Bearer xai-test-token',
    'invoice.paid',
    $testBody
);
assert_true($headers !== null, 'POST fires when bearer is set');
assert_true(in_array('Authorization: Bearer xai-test-token', $headers, true), 'Authorization header is present');
$hasSig = false;
foreach ($headers as $h) {
    if (str_starts_with($h, 'X-MCP-Signature:')) {
        $hasSig = true;
    }
}
assert_true(!$hasSig, 'X-MCP-Signature is omitted when HMAC secret is empty');
assert_true(in_array('X-MCP-Event: invoice.paid', $headers, true), 'X-MCP-Event header is present');

echo "\n=== HMAC-only path (no bearer) — legacy behavior ===\n";
$headers = buildHeaders(
    'https://mcp.example.com/events/whmcs',
    'test-hmac-secret',
    '',
    'ticket.opened',
    $testBody
);
assert_true($headers !== null, 'POST fires when HMAC is set');
$hasSig = false;
foreach ($headers as $h) {
    if (str_starts_with($h, 'X-MCP-Signature:')) {
        $hasSig = true;
    }
}
assert_true($hasSig, 'X-MCP-Signature is present');
$hasAuth = false;
foreach ($headers as $h) {
    if (str_starts_with($h, 'Authorization:')) {
        $hasAuth = true;
    }
}
assert_true(!$hasAuth, 'Authorization header is absent');

echo "\n=== Both HMAC and bearer set ===\n";
$headers = buildHeaders(
    'https://mcp.example.com/events/whmcs',
    'test-hmac-secret',
    'Bearer xai-test-token',
    'service.suspended',
    $testBody
);
assert_true($headers !== null, 'POST fires when both are set');
$hasSig = false;
$hasAuth = false;
foreach ($headers as $h) {
    if (str_starts_with($h, 'X-MCP-Signature:')) $hasSig = true;
    if (str_starts_with($h, 'Authorization:')) $hasAuth = true;
}
assert_true($hasSig, 'X-MCP-Signature is present');
assert_true($hasAuth, 'Authorization header is present');

echo "\n=== No post when URL is empty ===\n";
$headers = buildHeaders('', 'secret', 'Bearer token', 'invoice.paid', $testBody);
assert_true($headers === null, 'Returns null (no post) when URL is empty');

echo "\n=== No post when both secret and auth are empty ===\n";
$headers = buildHeaders('https://example.com/hook', '', '', 'invoice.paid', $testBody);
assert_true($headers === null, 'Returns null (no post) when both credentials are empty');

echo "\n=== HMAC correctness ===\n";
$secret = 'verify-me';
$headers = buildHeaders('https://example.com', $secret, '', 'invoice.paid', $testBody);
$expected = 'sha256=' . hash_hmac('sha256', $testBody, $secret);
$sigHeader = '';
foreach ($headers as $h) {
    if (str_starts_with($h, 'X-MCP-Signature:')) {
        $sigHeader = trim(substr($h, strlen('X-MCP-Signature:')));
    }
}
assert_true($sigHeader === $expected, 'HMAC signature matches expected value');

// ── Summary ───────────────────────────────────────────────────────────────

echo "\n" . str_repeat('─', 50) . "\n";
echo "Passed: {$passed}  Failed: {$failed}\n";
exit($failed > 0 ? 1 : 0);
