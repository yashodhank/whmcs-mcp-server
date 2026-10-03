# Runbook — WHMCS Event Hook

Real-time push path for important WHMCS events. The PHP hook can post
directly to an external webhook (e.g. Grok Bot routine) or to the MCP
HTTP server for local processing.

## Architecture

Two deployment modes:

### Direct-to-webhook (recommended for Grok Bot)

```
WHMCS (PHP hook)
  ─ POST ──▶  Grok Bot routine webhook (one run per POST)
                 ├─ Authorization: Bearer <key>
                 ├─ X-MCP-Event header
                 └─ JSON body (event + payload)
```

No cloudflared, no Mac staying awake, no MCP HTTP server required.

### Local MCP receiver (legacy / development)

```
WHMCS (PHP hook)
  ─ POST /events/whmcs ──▶  MCP HTTP server (eventReceiver.ts)
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
or as environment variables on the WHMCS container / PHP-FPM unit. **Never
commit secrets to git.**

| Variable / define          | Required | Description                                                        |
| -------------------------- | -------- | ------------------------------------------------------------------ |
| `MCP_EVENT_RECEIVER_URL`   | Yes      | Full URL of the receiver or webhook endpoint.                      |
| `MCP_EVENT_HMAC_SECRET`    | No\*     | Shared HMAC-SHA256 secret (for the local MCP receiver path).       |
| `MCP_EVENT_AUTHORIZATION`  | No\*     | Full `Authorization` header value, e.g. `Bearer <token>`.          |

\* At least one of `MCP_EVENT_HMAC_SECRET` or `MCP_EVENT_AUTHORIZATION` must be
set. When only `MCP_EVENT_AUTHORIZATION` is set, `X-MCP-Signature` is omitted.
When only `MCP_EVENT_HMAC_SECRET` is set, no `Authorization` header is sent
(legacy behavior). Both can coexist.

## Installing the WHMCS hook

1. Copy `deploy/whmcs-event-hook/mcp_event_hook.php` to
   `<WHMCS_ROOT>/includes/hooks/mcp_event_hook.php`.

2. Configure environment. Pick **one** of the two deployment modes below.

3. Verify the hook is loaded: WHMCS Admin → Setup → Addon Modules → Hooks
   (or simply trigger a test invoice payment).

## Direct-to-Grok deployment (recommended)

Posts events straight to a Grok Bot routine webhook. No cloudflared tunnel, no
local MCP HTTP server, no Mac that needs to stay awake.

Set the following on the WHMCS container (env vars or `define()` in
`configuration.php`). **Never commit these values.**

```sh
MCP_EVENT_RECEIVER_URL=https://api.x.ai/v1/grok-routine/wh_<your-id>
MCP_EVENT_AUTHORIZATION=Bearer <your-grok-routine-webhook-key>
```

Every allowlisted event produces **one POST → one Grok run**. The
`DailyCronJob` hook queries both Expired and Grace domains (50 each), so it
can emit up to **100 `domain.grace_or_expired` posts** in a single cron
invocation — that is up to 100 separate Grok runs. Plan routine capacity
accordingly.

The POST carries the same JSON body as the local path:

```json
{
  "event": "invoice.paid",
  "timestamp": "2026-10-03T12:00:00Z",
  "event_id": "aabbccdd00112233...",
  "payload": { "invoiceid": 42 }
}
```

Headers sent: `Content-Type: application/json`, `Authorization: Bearer <key>`,
`X-MCP-Event: <type>`. No `X-MCP-Signature` (HMAC is not configured in this
mode).

A **200** from Grok means a run started. A **non-200** is logged to the WHMCS
activity log (`Utilities → Activity Log`, search "MCP Event Hook") but never
surfaces to the WHMCS UI or blocks the hook caller.

## Local MCP receiver deployment (legacy)

Posts signed events to the MCP HTTP server (requires `MCP_TRANSPORT=http` on
the MCP side and a network path from WHMCS to the MCP host).

```sh
MCP_EVENT_RECEIVER_URL=https://mcp.example.com/events/whmcs
MCP_EVENT_HMAC_SECRET=your-shared-secret
```

### Pointing the MCP notifier at a downstream webhook

Set `MCP_EVENT_NOTIFIER_URL` on the **MCP server side** to forward accepted
events further (e.g. to Grok Bot). The forward is best-effort with a
10-second timeout. A notifier failure is logged but never fails the hook
response — the WHMCS side always gets a fast response (202 Accepted or a
rejection status).

## Payload signing (HMAC path only)

When `MCP_EVENT_HMAC_SECRET` is set, every POST carries an `X-MCP-Signature`
header:

```
X-MCP-Signature: sha256=<hex HMAC-SHA256 of the raw JSON body>
```

The MCP receiver uses timing-safe comparison (`crypto.timingSafeEqual`).
When only `MCP_EVENT_AUTHORIZATION` is set (direct-to-Grok), no signature
header is sent.

## Duplicate handling (MCP receiver path only)

Each event carries a unique `event_id` (32-character hex). The MCP receiver
keeps an in-memory set for `MCP_EVENT_DEDUP_WINDOW_MS` (default 5 minutes). A
duplicate within the window returns `200 { "status": "duplicate" }` instead of
`202`. This covers WHMCS retry or accidental double-fire. The direct-to-Grok
path does not deduplicate — each POST starts a new Grok run.

## Troubleshooting

| Symptom                            | Check                                                       |
| ---------------------------------- | ----------------------------------------------------------- |
| Hook never fires                   | Both `MCP_EVENT_HMAC_SECRET` and `MCP_EVENT_AUTHORIZATION` are empty, or `MCP_EVENT_RECEIVER_URL` is empty. At least one credential must be set alongside the URL. |
| Hook POST returns 401 (Grok)       | Bearer key is wrong or expired. Check `MCP_EVENT_AUTHORIZATION`. |
| Hook POST returns 401 (MCP)        | HMAC secrets don't match, or the body was modified in transit. |
| Hook POST returns 503 (MCP)        | `MCP_EVENT_HMAC_SECRET` is empty on the MCP server side.    |
| Hook POST returns 422 (MCP)        | Event type not in the allowlist. Check `X-MCP-Event` header.|
| Hook POST returns 404 (MCP)        | `MCP_TRANSPORT` is not `http`, or server not running.       |
| Notifier not receiving events      | Check `MCP_EVENT_NOTIFIER_URL` is set and reachable.        |
| WHMCS admin log shows failures     | Check WHMCS → Utilities → Activity Log for "MCP Event Hook".|
| Non-200 from Grok webhook          | Logged to WHMCS Activity Log. Does not block WHMCS.         |

## Security notes

- `MCP_EVENT_HMAC_SECRET` and `MCP_EVENT_AUTHORIZATION` must **never** be
  committed to git. Set them as environment variables on the container.
- The receiver endpoint does **not** use MCP consumer auth — it has its own
  HMAC verification, independent of the MCP bearer token flow.
- The hook only sends a minimal payload (IDs and metadata, not full PII).
- In the direct-to-Grok path the bearer token authenticates the POST. The
  Grok routine webhook is HTTPS; the key travels only in the `Authorization`
  header over TLS.
