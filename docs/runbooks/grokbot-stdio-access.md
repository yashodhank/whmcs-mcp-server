# Grok Bot / Business WhatsApp — WHMCS MCP stdio access

Operational guide for running the WHMCS MCP server as a stdio backend for
Grok Bot (Business WhatsApp) and similar trusted local consumers.

## Architecture

```
Grok Bot (local process)
  └→ WHMCS MCP Server (stdio)
       ├─ Governance: consumer-aware projection
       │   └→ operator-reconcile profile (via MCP_DEFAULT_CONSUMER_AUTH_TOKEN)
       ├─ WHMCS API (https://my.securiace.com)
       └─ IP allowlist auto-heal (dokploy mode)
```

The MCP server runs as a local stdio child process. Grok Bot does not need to
pass `auth_token` on every tool call — the **trusted stdio default consumer**
auto-injects the configured token when the caller omits it.

## Required environment variables

```bash
# WHMCS API connection
WHMCS_API_URL=https://my.securiace.com
WHMCS_IDENTIFIER=<api-credential-identifier>
WHMCS_SECRET=<api-credential-secret>

# Governance (opt-in for consumer-aware projection)
MCP_GOVERNANCE_ENABLED=true
MCP_CONSUMER_REGISTRY_FILE=~/.config/whmcs-mcp/consumer-registry.production.json

# Trusted stdio default consumer (local Cursor escape hatch ONLY — not production Grok identity)
MCP_DEFAULT_CONSUMER_AUTH_TOKEN=<raw-bearer-token>
# Staff ops_ask allow-list (consumer ids and/or OIDC subs). Empty ⇒ no staff jobs.
MCP_STAFF_CONSUMER_IDS=operator-reconcile
# MCP_STAFF_OIDC_SUBS=
# OR: MCP_DEFAULT_CONSUMER_AUTH_TOKEN_FILE=~/.config/whmcs-mcp/default-consumer-token

# IP allowlist auto-heal (Dokploy mode)
WHMCS_AUTO_IP_HEAL=true
WHMCS_HEAL_MODE=dokploy
# Extra IPs to always include in the allowlist (e.g. Grok Bot egress)
WHMCS_HEAL_EXTRA_IPS=104.30.180.111
```

## Trusted stdio default consumer

When `MCP_DEFAULT_CONSUMER_AUTH_TOKEN` (or `_FILE`) is set and the transport is
`stdio`, the governance pipeline auto-injects this token for any tool call that
omits `auth_token`. This means Grok Bot can call governed tools without manually
passing the token.

Safety:
- **Never applied for HTTP transports** — remote clients must always provide
  their own token.
- The raw token is **never logged** (only its presence/absence is logged at boot).
- The token must match an entry in the consumer registry by sha256 hash.

## Consumer registry setup

The registry should include an `operator-reconcile` consumer with read access to
the actions Grok Bot needs. See `docs/reference/consumer-registry.example.md`
for the full example. Key fields for the operator-reconcile entry:

```json
{
  "id": "operator-reconcile",
  "token_sha256": "<sha256-of-the-raw-token>",
  "defaultContract": "grok_channel_safe",
  "allowedContracts": ["grok_channel_safe", "ops_operator"],
  "allowedActions": [
    "search_clients", "get_client_details", "list_client_invoices",
    "list_invoices", "get_invoice", "list_services",
    "list_client_services", "get_currencies", "get_whmcs_details",
    "get_capability_matrix", "list_client_tickets",
    "get_ticket_thread", "list_support_departments",
    "get_billing_snapshot", "get_account_360",
    "ops_ask", "mcp_doctor"
  ],
  "writeCapability": "false"
}
```

## IP allowlist auto-heal (Dokploy)

The Dokploy healer (`scripts/whmcs-ip-updater/dokploy/dokploy_ip_heal.sh`)
auto-detects the Mac's public IP and ensures it's in WHMCS `APIAllowedIPs`.

Extra IPs (e.g. Grok Bot's egress IP `104.30.180.111`) are added via
`WHMCS_HEAL_EXTRA_IPS`.

SSH key resolution order:
1. `WHMCS_HEAL_SSH_KEY` (explicit)
2. `WHMCS_SSH_KEY` (MCP env)
3. `~/.ssh/id_rsa_securiace`
4. `~/.ssh/id_ed25519`
5. `~/.ssh/id_rsa`

## WhmcsDetails fallback

The `get_whmcs_details` tool gracefully handles the common case where the API
credential role does not allow `WhmcsDetails`:

1. Try `WhmcsDetails` → extract version info
2. On permission denial → try `GetAdminDetails` → `.whmcs.version`
3. If that fails → try `GetConfigurationValue(Version)`
4. All fail → `{ version: null, release: null }`

No need to add `WhmcsDetails` to the API credential's allowed-actions list.

## 403 classification

The MCP now classifies WHMCS 403 responses:

| Kind | Body pattern | Healable? |
|------|-------------|-----------|
| `invalid_ip` | `"Invalid IP x.x.x.x"` | Yes (auto-heal) |
| `invalid_permissions` | `"Invalid Permissions: ..."` | No (API credential role) |
| `waf_or_empty` | No WHMCS body | No (edge/WAF) |
| `unknown` | Other 403 body | No |

Only `invalid_ip` triggers the auto-heal. `invalid_permissions` produces a clear
error message directing the operator to the API Credentials settings.

## Production Grok is not this path

This stdio default token is a **local Cursor escape hatch** (ADR-0002.4).
Production Grok **MUST** use HTTP + MCP-audience tokens from a federation AS.
WhatsApp bind and refresh storage live **outside** this repository — see
[whatsapp-bind-outside-mcp.md](whatsapp-bind-outside-mcp.md). Do not present a
WHMCS access or ID token as the MCP Bearer.
