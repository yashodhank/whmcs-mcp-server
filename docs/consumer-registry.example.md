# Consumer Registry — Example & Operator Guide

> **SYNTHETIC EXAMPLE ONLY. Do not use these tokens/hashes in production.**
> Real bearer tokens are never committed. Only the lowercase **sha256** of a
> raw token is stored, and only via the deployment environment
> (`MCP_CONSUMER_REGISTRY`), sourced from your secret manager.

## How the registry works

- Each consumer authenticates with a **raw bearer token** (passed as the
  `auth_token` tool argument).
- The server hashes the presented token (`sha256`, hex) and matches it to a
  registry entry's `token_sha256`.
- The matched profile decides the **data contract** (projection), allowed
  scopes/actions, environment restrictions, and write capability
  (write is inert this engagement — production stays read-only).
- Unknown / no token in `production` ⇒ **denied** (unless an explicit
  `anonymous` entry pinned to `llm_safe_summary` exists **and**
  `MCP_ALLOW_ANON_LLM=true`).

## Generate a real token hash

```sh
# pick a strong random token, store the RAW token only in your secret manager
RAW="$(openssl rand -hex 32)"
printf '%s' "$RAW" | shasum -a 256 | cut -d' ' -f1   # -> token_sha256
```

Put the **raw** token in the consuming app's secret store; put only the
**hash** into `MCP_CONSUMER_REGISTRY` (single-line JSON) in the MCP
deployment environment. Rotate by replacing the hash; revoke by removing the
entry. Audit logs record `consumer_id`, never the token.

## Example registry (synthetic — testing only)

Raw example tokens (DO NOT USE IN PROD): `EXAMPLE-<id>-SYNTHETIC-DO-NOT-USE-IN-PROD`

```json
[
  {
    "id": "llm_chat",
    "token_sha256": "074518040b2437ab401d9a99bd0ff91ad8870e8287c0a84a44e39e437ba2c390",
    "allowedScopes": ["read"],
    "defaultContract": "llm_safe_summary",
    "allowedContracts": ["llm_safe_summary"],
    "allowedActions": ["get_client_details", "list_invoices", "list_tickets", "get_ticket", "list_activity_log"],
    "writeCapability": "false",
    "envRestrictions": [],
    "anonymous": false
  },
  {
    "id": "ops_operator",
    "token_sha256": "876a2ed933252d7e2fae66926b7ba0da1bfcea694874b8c48b678f2a90376593",
    "allowedScopes": ["read"],
    "defaultContract": "ops_operator",
    "allowedContracts": ["ops_operator"],
    "allowedActions": ["list_clients", "get_client_details", "list_client_products", "list_client_domains", "list_invoices", "get_invoice", "list_orders", "list_tickets", "get_ticket", "list_activity_log"],
    "writeCapability": "false",
    "envRestrictions": [],
    "anonymous": false
  },
  {
    "id": "billing_dashboard",
    "token_sha256": "da3956a70db9b2d15f55f810f39c40eadf0db2fe6fd367983fada03cf1743b7e",
    "allowedScopes": ["read"],
    "defaultContract": "billing_reconciliation",
    "allowedContracts": ["billing_reconciliation"],
    "allowedActions": ["get_client_details", "list_invoices", "get_invoice", "list_orders"],
    "writeCapability": "false",
    "envRestrictions": [],
    "anonymous": false
  },
  {
    "id": "renewal_worker",
    "token_sha256": "75802a3e9352417a7a2efdaedce3ac19d23bbcc91a7fcb864fc5996757dcb289",
    "allowedScopes": ["read"],
    "defaultContract": "renewal_automation",
    "allowedContracts": ["renewal_automation"],
    "allowedActions": ["list_client_products", "list_client_domains", "get_client_details"],
    "writeCapability": "false",
    "envRestrictions": [],
    "anonymous": false
  },
  {
    "id": "support_console",
    "token_sha256": "66c3468bc72e5824ff1575a55149dce9961328671b4b66fad911d7a676356ea2",
    "allowedScopes": ["read"],
    "defaultContract": "support_triage",
    "allowedContracts": ["support_triage"],
    "allowedActions": ["list_tickets", "get_ticket", "list_support_departments", "get_client_details", "list_client_products"],
    "writeCapability": "false",
    "envRestrictions": [],
    "anonymous": false
  }
]
```

## Supplying it in production (read-only)

```sh
# real env — single line, hashes only, raw tokens never here
export MCP_ENV=production
export MCP_MODE=read_only
export MCP_GOVERNANCE_ENABLED=true        # Stage 1; start at false for Stage 0
export MCP_ALLOW_ANON_LLM=false
export MCP_CONSUMER_REGISTRY='[{"id":"ops_operator","token_sha256":"<real sha256>","defaultContract":"ops_operator","allowedContracts":["ops_operator"],"writeCapability":"false"}]'
```

`writeCapability` is modeled but **inert** — no production write path exists.
