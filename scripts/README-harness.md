# mcp-workflow-harness

Read-only operational **workflow simulation** runner for the WHMCS MCP
server. It spawns the built server (`dist/index.js`) as an MCP client with
governance ON and a **synthetic** `ops_operator` consumer, then:

1. Exercises the operational read aggregators with **small limits**:
   `get_account_360`, `get_billing_snapshot`, `get_reconciliation_snapshot`,
   `get_support_snapshot`, `get_renewal_snapshot`,
   `get_provisioning_snapshot`, `get_activity_timeline`, `get_risk_snapshot`.
   Each must return a non-error structured result carrying the governed
   envelope (`consumer`/`contract`/`data`) or the legacy aggregator shape
   (`items`/`partial_errors`/…). One compact `PASS`/`FAIL` line per workflow.
2. Runs a controlled **write flow** — `draft_write_intent` (`ticket:reply`)
   → `validate` → `approve` → `execute_write_intent` — and **asserts the
   execute is DENIED** (`executed:false`, a `blocked_reason` present) with no
   thrown error. The execute-denied path only; **no live mutation is ever
   attempted or expected.**

## Safety

- Read-only only. No write is ever executed.
- Synthetic consumer token only (`sha256` of an `EXAMPLE-*` value).
- No PII printed — only the workflow name, PASS/FAIL, and a short list of
  top-level result keys (never raw data).
- Production is **strictly opt-in**, read-only, and small-limit. It never
  runs by default.

## Prerequisites

```bash
npm run build
```

For `devw9` / `devw8`, the dev docker stack must be up
(`npm run whmcs:test:up`).

## Run

```bash
# default: dev WHMCS 9 (MCP_ENV=local profile → localhost:8890)
node scripts/mcp-workflow-harness.mjs

# dev WHMCS 8 (same API creds, WHMCS_API_URL → http://localhost:8813)
TARGET=devw8 node scripts/mcp-workflow-harness.mjs

# production — READ-ONLY, small limits, OPT-IN ONLY.
# Without the flag it prints a notice and skips (exit 0).
TARGET=prodread node scripts/mcp-workflow-harness.mjs                 # skipped
WORKFLOW_ALLOW_PROD=1 TARGET=prodread node scripts/mcp-workflow-harness.mjs
```

`TARGET` values: `devw9` (default) | `devw8` | `prodread`.
Prod opt-in flag: `WORKFLOW_ALLOW_PROD=1` (operator-run only).

The run ends with `RESULT: N passed, M failed` and exits non-zero on any
failure.
