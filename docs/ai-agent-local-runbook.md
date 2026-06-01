# AI Agent Local Runbook

Operator-focused runbook for agents using the WHMCS MCP server from local hosts (Kilo, Cursor, Claude Desktop).

## 1) Preflight

1. Build server: `npm run build`
2. Confirm MCP points to `dist/index.js`
3. Verify environment has the same WHMCS endpoint/identifier/secret/access key across hosts
4. Validate read probe first: `search_clients` and `list_products`

If these fail, do not start billing or reporting workflows.

## 2) Local File Location Map

Common files to inspect when host behavior differs:

- Kilo global config: `~/.config/kilo/kilo.jsonc`
- Project MCP env files: `.env`, `.env.local`, `.env.<profile>`
- Cursor sample config in this repo: `cursor-mcp-config.json`
- Server docs/runbooks: `README.md`, `docs/testing-readonly.md`, `docs/capability-probe-runbook.md`

Use this map to compare effective configuration between hosts before debugging code.

## 3) 403 Diagnosis by Layer

Treat 403 as a layered issue, not a generic failure.

### A. Transport / Host Layer

- Symptom: no tools or malformed responses
- Check: server boot logs, tool list visibility
- Action: fix MCP host config, rebuild, restart host process

### B. MCP Governance Layer

- Symptom: `consumer denied`, `capability_unavailable`, scoped denials
- Check: `MCP_ACCESS_MODE`, consumer/token policy, capability matrix endpoint
- Action: update policy, allowlist, or client scope

### C. WHMCS API Authorization Layer

- Symptom: some actions succeed (for example client search) while others return 403
- Check: WHMCS API role permissions per action (`GetInvoices`, `GetInvoice`, `GetClientsDetails`, etc.)
- Action: grant missing actions to the API credential role

### D. Network/IP Layer

- Symptom: works from one host, fails from another with same creds
- Check: egress IPv4 and IPv6 from each host
- Action: whitelist both addresses in WHMCS/API perimeter controls

## 4) Standard Verification Sequence

Run in order after config changes:

1. `search_clients` (connectivity + baseline auth)
2. `get_client_details` (action-level permission)
3. `list_client_invoices` + `get_invoice` (billing reads)
4. `get_account_360` (composite read health)

Do not proceed to reporting workflows until all 4 checks pass.

## 5) Ops Guardrails

- Keep `MCP_MODE=read_only` for production reporting and analytics requests.
- Use `simulate` or `full` only in approved windows or local disposable stacks.
- Prefer client-scoped mode for customer-facing assistants.
- Keep write-intent flows audited; avoid direct mutating calls for high-risk operations.

## 6) Dev Workflow Recommendations

- Use the local dual-WHMCS stack for reproducible mutation tests.
- Keep integration tests read-only in production-bound runs.
- Record failing action names with timestamps in run artifacts for precise ACL fixes.
- When adding a new tool, update schema, tests, and runbooks together.

## 7) Known Operational Pitfall

"MCP connected" does not imply "all WHMCS actions authorized". Always verify at least one action per domain (clients, invoices, services, tickets, domains) before assuming readiness.
