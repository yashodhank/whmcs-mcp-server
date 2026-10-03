# Runbook — WHMCS Event Hook & MCP Event Receiver

Real-time push path for important WHMCS events. The PHP hook posts signed
payloads to the MCP HTTP server, which verifies, deduplicates, and optionally
forwards them to an external webhook (e.g. Grok Bot).

## Architecture

```
WHMCS (PHP hook)
  ─ POST /events/whmcs ─▶  MCP HTTP server (eventReceiver.ts)
                              ├─ HMAC verify
                              ├─ allowlist filter
                              ├─ dedup (in-memory, 5 min window)
                              ├─ log (accepted)
                              └─ async forward ──▶  Notifier URL (best-effort)
```

## Allowlisted events

| Event type                | WHMCS hook              | Fires when                          |
| ------------------------- | ----------------------- | ----------------------------------- |
| `invoice.paid`            | `InvoicePaid`           | An invoice is fully paid            |
| `ticket.opened`           | `TicketOpen`            | A new ticket is created             |
| `service.suspended`       | `AfterModuleSuspend`    | A service is successfully suspended |
| `module.create_failed`    | `AfterModuleCreate`     | Module provisioning fails           |
| `domain.grace_or_expired` | `DailyCronJob`          | Domain enters grace period / expiry |

All other WHMCS hook points are ignored.

## Environment variables

### MCP server side

| Variable                  | Required | Default  | Description                                            |
| ------------------------- | -------- | -------- | ------------------------------------------------------ |
| `MCP_EVENT_HMAC_SECRET`   | Yes      | (empty)  | Shared HMAC-SHA256 secret. Must match the WHMCS side.  |
| `MCP_EVENT_NOTIFIER_URL`  | No       | (empty)  | URL to forward accepted events to. Empty = no forward. |
| `MCP_EVENT_DEDUP_WINDOW_MS` | No     | `300000` | Dedup window in ms (0 = disabled).                     |
| `MCP_TRANSPORT`           | —        | `stdio`  | Must be `http` for the receiver to be active.          |

### WHMCS side

Set these as PHP `define()` constants (e.g. in `configuration.php` or a loader)
or as environment variables read by `getenv()`:

| Variable / define          | Required | Description                                   |
| -------------------------- | -------- | --------------------------------------------- |
| `MCP_EVENT_RECEIVER_URL`   | Yes      | Full URL, e.g. `https://mcp.example.com/events/whmcs` |
| `MCP_EVENT_HMAC_SECRET`    | Yes      | Same shared secret as the MCP server side.    |

## Installing the WHMCS hook

1. Copy `deploy/whmcs-event-hook/mcp_event_hook.php` to
   `<WHMCS_ROOT>/includes/hooks/mcp_event_hook.php`.

2. Configure the two required constants. Recommended: add to `configuration.php`
   (below the existing WHMCS settings) or a separate include:

   ```php
   define('MCP_EVENT_RECEIVER_URL', 'https://mcp.example.com/events/whmcs');
   define('MCP_EVENT_HMAC_SECRET',  'your-secret-here');
   ```

   Or set as environment variables in the PHP-FPM / Apache / systemd unit.

3. Verify the hook is loaded: WHMCS Admin → Setup → Addon Modules → Hooks
   (or simply trigger a test invoice payment).

## Pointing the notifier at a webhook

Set `MCP_EVENT_NOTIFIER_URL` to your downstream webhook. The notifier receives
a POST with `Content-Type: application/json` and the same event payload:

```json
{
  "event": "invoice.paid",
  "timestamp": "2026-10-03T12:00:00Z",
  "event_id": "aabbccdd00112233...",
  "payload": { "invoiceid": 42 }
}
```

### Grok Bot example

```
MCP_EVENT_NOTIFIER_URL=https://grokbot.example.com/api/webhooks/whmcs
```

The forward is best-effort with a 10-second timeout. A notifier failure is
logged but never fails the hook response — the WHMCS side always gets a fast
response (202 Accepted or a rejection status).

## Payload signing

Every POST from the hook carries an `X-MCP-Signature` header:

```
X-MCP-Signature: sha256=<hex HMAC-SHA256 of the raw JSON body>
```

The receiver uses timing-safe comparison (`crypto.timingSafeEqual`).

## Duplicate handling

Each event carries a unique `event_id` (32-character hex). The receiver keeps
an in-memory set for `MCP_EVENT_DEDUP_WINDOW_MS` (default 5 minutes). A
duplicate within the window returns `200 { "status": "duplicate" }` instead of
`202`. This covers WHMCS retry or accidental double-fire.

## Troubleshooting

| Symptom                            | Check                                                       |
| ---------------------------------- | ----------------------------------------------------------- |
| Hook POST returns 503              | `MCP_EVENT_HMAC_SECRET` is empty on the MCP side.           |
| Hook POST returns 401              | Secrets don't match, or the body was modified in transit.    |
| Hook POST returns 422              | Event type not in the allowlist. Check `X-MCP-Event` header.|
| Hook POST returns 404              | `MCP_TRANSPORT` is not `http`, or server not running.       |
| Notifier not receiving events      | Check `MCP_EVENT_NOTIFIER_URL` is set and reachable.        |
| WHMCS admin log shows failures     | Check WHMCS → Utilities → Activity Log for "MCP Event Hook".|

## Security notes

- The HMAC secret must **never** be committed to git.
- The receiver endpoint does **not** use MCP consumer auth — it has its own
  HMAC verification, independent of the MCP bearer token flow.
- The hook only sends a minimal payload (IDs and metadata, not full PII).
- The notifier forward carries no additional authentication. If the downstream
  requires auth, extend `forwardToNotifier` in `eventReceiver.ts`.
