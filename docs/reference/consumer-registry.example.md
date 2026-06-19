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
  scopes/actions, environment restrictions, write capability, and (optionally)
  `allowedWriteScopes` (write is inert this engagement — production stays
  read-only; see "Write scopes" below).
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
  },
  {
    "id": "support_writer",
    "token_sha256": "1c8f5b2e7a934d06bb2f1d4e8c0a37915d6b2e4f9a7c3081bd5e2f4a6c8e0b13",
    "allowedScopes": ["read"],
    "defaultContract": "support_triage",
    "allowedContracts": ["support_triage"],
    "allowedActions": ["list_tickets", "get_ticket", "list_support_departments", "get_client_details", "list_client_products"],
    "writeCapability": "approval_required",
    "allowedWriteScopes": ["ticket:reply", "ticket:status"],
    "envRestrictions": [],
    "anonymous": false
  },
  {
    "id": "billing_writer",
    "token_sha256": "9b3d7e1f5a2c4806de1b8f3a0c7d2941e6f5b8a2c9d4e7038ab1f6c2e5d80a47",
    "allowedScopes": ["read"],
    "defaultContract": "billing_reconciliation",
    "allowedContracts": ["billing_reconciliation"],
    "allowedActions": ["get_client_details", "list_invoices", "get_invoice", "list_orders"],
    "writeCapability": "approval_required",
    "allowedWriteScopes": ["billing:invoice:create", "billing:credit:add"],
    "envRestrictions": [],
    "anonymous": false
  }
]
```

## Write scopes (Phase F — framework only, no live execution)

> **No production write path exists.** The Phase F seam is types + a
> deny-by-default execution gate (`src/write/types.ts`,
> `src/governance/types.ts`). Even a consumer marked `execution_allowed` is
> **INERT**: a live write also requires separate per-action **runtime**
> authorization (`runtimeAuthorizedActions`) that is intentionally absent in
> the default posture, plus a non-`read_only` MCP mode. Default posture
> always denies.

`writeCapability` (per `WRITE_CAPABILITIES`) semantics:

| value | meaning |
|---|---|
| `false` | consumer cannot draft or execute writes (default) |
| `draft_only` | may produce a `WriteIntent`; never advances to execute |
| `approval_required` | drafts may proceed only after explicit approval |
| `disabled` | writes explicitly turned off for this consumer |
| `execution_allowed` | cleared for the gated path — still inert without runtime auth |

`allowedWriteScopes` (optional `string[]`) is validated against the frozen
`WRITE_SCOPES` list (`src/write/types.ts`):

`client_note:write`, `ticket:create`, `ticket:reply`, `ticket:status`,
`billing:invoice:create`, `billing:payment:add`, `billing:credit:add`,
`billing:refund:record`

Rules:

- **Default-deny.** Omit the field ⇒ no write scopes. It is **never inferred**
  from `allowedScopes`, `allowedActions`, or contract.
- A write is permitted only if the action's scope ∈ `allowedWriteScopes`
  **and** `writeCapability` allows it **and** per-action runtime
  authorization is present — none of which is wired in this engagement.
- Synthetic examples above: `support_writer`
  (`approval_required` + `["ticket:reply","ticket:status"]`) and
  `billing_writer` (`approval_required` + `["billing:invoice:create","billing:credit:add"]`).
  Both are inert: they model intent, they cannot mutate WHMCS.
- Real bearer tokens are supplied via the deployment environment only and are
  **never committed**; only the lowercase `sha256` hash is stored.

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
