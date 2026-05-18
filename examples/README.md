# Examples — governed WHMCS MCP consumption (dev/test, READ-ONLY)

Runnable Node ESM demos showing how an **app** consumes this MCP integration
gateway's read-only tools through the **governance** layer.

> **READ-ONLY · SYNTHETIC ONLY.** These are demonstrations, not test infra and
> not production code. They perform only read calls, never writes. The bearer
> tokens are synthetic (`EXAMPLE-<id>-SYNTHETIC-DO-NOT-USE-IN-PROD`, sha256'd
> into a tiny inline single-consumer registry — the same pattern as
> `scripts/mcp-governed-smoke.mjs`). No real credentials or PII are used.

## Run

```bash
npm run build            # produces dist/index.js
node examples/account360-dashboard.mjs
node examples/billing-dashboard.mjs
node examples/support-console.mjs
node examples/renewal-worker.mjs
node examples/reconciliation.mjs
node examples/ops-account360-cli.mjs [clientid]   # synthetic clientid, default 1
```

Each script spawns `node dist/index.js` over stdio with:
`MCP_ENV=local`, `MCP_MODE=read_only`, `MCP_GOVERNANCE_ENABLED=true`,
`MCP_ALLOW_ANON_LLM=false`, `MCP_RATE_LIMIT=1000`, and an inline
`MCP_CONSUMER_REGISTRY` holding exactly one synthetic consumer. It needs the
local dev WHMCS stack reachable at `MCP_ENV=local`; on a tool error the script
exits non-zero.

## How apps read results: `structuredContent` vs `content[0].text`

A tool result exposes two views:

- **Governed (governance ON) → `result.structuredContent`.** An object
  `{ entity, consumer, contract, data }` — contract-projected and
  machine-readable. This is what an app should render. A denied consumer or
  env-forbidden contract yields a structured failure
  `{ isError, error, status }` instead of data. Apps must branch on that.
- **Legacy (governance OFF) → `JSON.parse(result.content[0].text)`.** The raw
  aggregate object. In governed mode the same JSON is mirrored into
  `content[0].text` for backward compatibility, so legacy clients keep working.

The shared helper `examples/_lib.mjs` prefers `structuredContent`, falls back
to the text mirror, and throws on a governed/tool error (non-zero exit).

Key things the examples demonstrate per consumer/contract:

| Example                     | Consumer            | Contract                | Shows |
|-----------------------------|---------------------|-------------------------|-------|
| `account360-dashboard.mjs`  | `ops_operator`      | `ops_operator`          | dashboard stat tiles + recent linked IDs |
| `billing-dashboard.mjs`     | `billing_dashboard` | `billing_reconciliation`| financial refs preserved + upgraded reconciliation (matching/whmcs9_notice/ledger_adjustments) |
| `support-console.mjs`       | `support_console`   | `support_triage`        | ticket free-text preserved for authorized contract |
| `renewal-worker.mjs`        | `renewal_worker`    | `renewal_automation`    | email/domain/expiry fields for renewal jobs |
| `reconciliation.mjs`        | `ops_operator`      | `ops_operator`          | upgraded reconciliation: matched/unmatched/duplicate-risk/unpaid-with-recent-payment + source IDs; composed vs degraded; `capability_unavailable` |
| `ops-account360-cli.mjs`    | `ops_operator`      | `ops_operator`          | CLI: account360 dashboard + the 4 promoted reads + `list_users` degrade |

## Phase H — promoted read tools, structuredContent, capability_unavailable

### The 4 newly-promoted governed read tools

Four capability shells are now **PROMOTED** to real governed read tools: they
call WHMCS and return governed `structuredContent` (no longer a static
capability stub). The library/concept name is shown with the **registered tool
name** in parentheses:

| Concept                | Registered tool             | Governed envelope shape |
|------------------------|-----------------------------|-------------------------|
| list_client_transactions | `list_client_transactions` | list: `{ consumer, contract, items:[…], count, limit, offset }` |
| get_system_stats       | `get_stats`                 | single: `{ entity, consumer, contract, data:{ metrics } }` |
| list_todo_items        | `get_todo_items`            | list: `{ consumer, contract, items:[…], count, limit, offset }` |
| list_automation_log    | `get_automation_log`        | list: `{ consumer, contract, items:[…], count, limit, offset }` |

`GetUsers` / `list_users` is **NOT** promoted (no canonical mapper). It returns
a structured `{ capability_unavailable:true, action:'GetUsers',
status:'unverified', retriable:true, guidance, note }` payload (the MCP SDK
marks it `isError:true`). Apps must branch on `capability_unavailable===true`
and degrade — never treat it as data, never crash.

`get_reconciliation_snapshot` was upgraded: when `GetTransactions` is supported
it composes transactions, matches them to invoices, and emits
`transactions` (summary), `source_transaction_ids`, and a `system.audit`
`reconciliation_ledger.matching` with `matched` / `unmatched_transaction_ids` /
`duplicate_risk` / `unpaid_with_recent_payment`. It always emits the
`whmcs9_notice` (WHMCS 9 non-draft invoices are immutable — reconcile via
credit/debit notes) and a `ledger_adjustments` structured
capability_unavailable marker (credit/debit notes have no verified read on this
build; an empty `canonical_notes` is UNVERIFIED, not "no notes"). If
`GetTransactions` is not supported it degrades to the structured
`transactions: { capability_unavailable:true, … }` block and reconciles
invoices alone.

### How examples consume `structuredContent`

Every example reads the parsed governed JSON, **not** the human text. Helpers
in `_lib.mjs`:

- `structured(result, label)` — returns the governed envelope
  (`{ entity, consumer, contract, data }` or list `{ items, count, … }`);
  **throws** on any governed/tool error so a hard failure exits non-zero.
- `readCapability(result)` — never throws; returns
  `{ kind:'data', env }` | `{ kind:'unavailable', cap }` |
  `{ kind:'error', status, error }`. Use this for tools that may honestly
  return `capability_unavailable` (e.g. `list_users`) so the example can
  demonstrate graceful degrade end-to-end instead of crashing.
- `printUnavailable(label, cap)` — prints the `action / status / retriable /
  guidance / note` an app should log before degrading.

### How `capability_unavailable` is handled

Every updated/new example explicitly demonstrates the degrade: it calls
`list_users`, branches on `capability_unavailable===true`, prints the
structured marker, and continues (skips that panel) without throwing.
`billing-dashboard.mjs` and `reconciliation.mjs` additionally show the
`ledger_adjustments` capability_unavailable block and the composed-vs-degraded
`transactions` branch.

### Verifying contract behavior with the exposure audit

`scripts/mcp-exposure-audit.mjs` drives the **built** server as a synthetic
consumer, captures the exact governed result that consumer would receive, and
reports whether every emitted field is safe under that contract. A clean report
(every `allowed:true` for its classification) proves the example's
consumer×tool pairing exposes nothing the contract forbids. The script imports
`src/audit/exposureAudit.ts`, so run it under the repo's TS runner (`tsx`):

```bash
npm run build
# One consumer × one tool (the pairing a given example uses):
MCP_ENV=local npx tsx scripts/mcp-exposure-audit.mjs \
  ops_operator get_reconciliation_snapshot
MCP_ENV=local npx tsx scripts/mcp-exposure-audit.mjs \
  billing_dashboard list_client_invoices '{"clientid":1,"limit":3}'
MCP_ENV=local npx tsx scripts/mcp-exposure-audit.mjs ops_operator get_stats

# Companion batch runner — sweep every (consumer × known tool) pair,
# redacted aggregate to stdout. Optional filters: consumer, then tool.
MCP_ENV=local npx tsx scripts/mcp-exposure-audit-all.mjs                       # all
MCP_ENV=local npx tsx scripts/mcp-exposure-audit-all.mjs ops_operator          # one consumer
MCP_ENV=local npx tsx scripts/mcp-exposure-audit-all.mjs '' get_stats          # one tool
```

stdout is ALWAYS the redacted report (no raw values). It is a reporting tool,
not a gate (exit code is always 0) — read the report to confirm the contract
behaves as the example claims.
