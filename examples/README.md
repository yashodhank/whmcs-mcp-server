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
| `billing-dashboard.mjs`     | `billing_dashboard` | `billing_reconciliation`| financial reference/amount fields preserved |
| `support-console.mjs`       | `support_console`   | `support_triage`        | ticket free-text preserved for authorized contract |
| `renewal-worker.mjs`        | `renewal_worker`    | `renewal_automation`    | email/domain/expiry fields for renewal jobs |
| `reconciliation.mjs`        | `ops_operator`      | `ops_operator`          | invoice refs + structured `capability_unavailable` (apps must handle) |
