# Agent & contributor guide — WHMCS MCP Server

Concise orientation for AI agents and humans working in this repo. The full historical build specification lives in [AGENT.md](AGENT.md); operational runbooks live under [docs/](docs/).

## What this server is

- **Transport:** MCP over **stdio** (Cursor, Claude Desktop, Kilo, etc.). Logs go to **stderr** only; never write to stdout except JSON-RPC.
- **Backend:** WHMCS External API via `WhmcsClient` (`src/whmcs/`).
- **Surface:** ~50 tools (legacy WHMCS actions, list/reporting, aggregators, capability probes, controlled write-flow) and **7 read-only resources**.

## Architecture (current)

```
MCP host → src/index.ts
  ├─ config / security / rateLimiter
  ├─ tools/*  (zod schemas, outputSchema + structuredContent)
  ├─ governance/*  (opt-in: consumer → canonical → project)
  ├─ write/*  (intent store, validation, execution gate, audit)
  ├─ resources/* + playbook + compat-9x
  └─ whmcs/WhmcsClient
```

**Governance (Phase B, opt-in):** Set `MCP_GOVERNANCE_ENABLED=true` and configure `MCP_CONSUMER_REGISTRY` (SHA-256 of bearer tokens only — never commit raw tokens). When off (default), legacy tool output paths remain for backward compatibility. See [docs/PHASE_B_GOVERNANCE.md](docs/PHASE_B_GOVERNANCE.md).

**Controlled writes (Phase F–G+):** Mutations that bypass simple `MCP_MODE=full` use the write-flow tools (`draft_write_intent` → `validate_write_intent` → `approve_write_intent` → `execute_write_intent`). Production execution is **deny-by-default** unless explicitly allowlisted (`MCP_PROD_WRITE_AUTHORIZED`, caps, audit path). See [docs/phase-f-controlled-write-automation.md](docs/phase-f-controlled-write-automation.md) (implemented; sealed by default) and [docs/superpowers/specs/2026-05-19-whmcs-prod-write-RUNBOOK.md](docs/superpowers/specs/2026-05-19-whmcs-prod-write-RUNBOOK.md).

## Tool families (where to edit)

| Family | Module | Examples |
|--------|--------|----------|
| Legacy CRUD | `clients.ts`, `billing.ts`, `orders.ts`, `services.ts`, `domains.ts`, `support.ts` | `search_clients`, `get_invoice`, `suspend_service` |
| Governed lists | `listTools.ts`, `reportingListTools.ts` | `list_client_invoices`, `list_invoices`, `list_services` |
| Aggregators | `aggregators.ts` | `get_account_360`, `get_billing_snapshot` |
| Capability / probes | `capabilityShellTools.ts` | `get_capability_matrix`, `get_stats`, `list_users` (unverified) |
| Ticket read | `ticketThreadTool.ts` | `get_ticket_thread` |
| Write flow | `writeFlow.ts` | `draft_write_intent`, `execute_write_intent` |

Register new tools in the matching module, then wire registration from `src/index.ts`. Prefer **zod** input/output schemas and return **`structuredContent`** when `outputSchema` is declared (see `tests/tools/outputSchemaCompliance.test.ts`).

## Resources (read-only URIs)

| URI | Purpose |
|-----|---------|
| `whmcs://clients/{clientid}/summary` | Client identity + counts |
| `whmcs://clients/{clientid}/log` | Recent client activity |
| `whmcs://invoices/{invoiceid}/history` | Invoice + transactions |
| `whmcs://tickets/{ticketid}/thread` | Ticket thread |
| `whmcs://system/activity` | Global activity (admin) |
| `whmcs://docs/ops-playbook` | Agent behavioral playbook |
| `whmcs://docs/compat-9x` | WHMCS 8.13 / 9.x compatibility notes |

Resources do **not** use `auth_token` query params; scope is process + `MCP_ACCESS_MODE` / client allowlist.

## Configuration essentials

Copy [.env.example](.env.example). Required: `WHMCS_API_URL`, `WHMCS_IDENTIFIER`, `WHMCS_SECRET`.

| Variable | Notes |
|----------|--------|
| `MCP_ENV` | Layers `.env.<profile>`; `WHMCS_API_URL` must be HTTPS unless `WHMCS_ALLOW_HTTP=true` (local stack only). |
| `MCP_MODE` | `read_only` (default), `simulate`, `full` — legacy direct mutators. |
| `MCP_ACCESS_MODE` | `admin` or scoped `client` + `MCP_ALLOWED_CLIENT_IDS`. |
| `MCP_GOVERNANCE_ENABLED` | Opt-in projection boundary. |
| `MCP_CONSUMER_REGISTRY` | JSON array with `token_sha256` — see [docs/consumer-registry.example.md](docs/consumer-registry.example.md). |
| `MCP_CLIENT_CUSTOM_FIELD_LABELS` | `id:label` pairs for stable custom-field names in client output. |
| `MCP_PROD_WRITE_*` / `MCP_WRITE_*` | Production write authorizer, caps, audit/idempotency paths. |

## Scripts & verification

| Script | Purpose |
|--------|---------|
| `npm run build` | Produce `dist/index.js` (required before MCP hosts connect). |
| `npm test` | Vitest unit/integration suite. |
| `npm run mcp:test:production-program` | L0–L6 production test program. |
| `scripts/mcp-governed-smoke.mjs` | Governed read smoke. |
| `scripts/mcp-capability-probe.mjs` | Capability probe report. |
| `scripts/mcp-exposure-audit.mjs` | Exposure audit harness. |
| `scripts/whmcs-ip-updater/` | Optional API IP allowlist updater (ops). |

Local dual-WHMCS stack: [docs/local-whmcs-testing.md](docs/local-whmcs-testing.md). Operator troubleshooting: [docs/ai-agent-local-runbook.md](docs/ai-agent-local-runbook.md).

## Safety rules for agents editing this repo

1. **No secrets in git** — credentials, registry tokens, `.env.local`, prod seeds.
2. **Preserve stdio contract** — no `console.log` on stdout; use `Logger` → stderr.
3. **Minimal diffs** — match existing patterns in the tool module you touch.
4. **Tests** — add/adjust Vitest for behavior changes; run `npm run typecheck && npm test` before PR.
5. **WHMCS 9** — invoice immutability and credit/debit notes: read [docs/whmcs9-credit-debit-notes.md](docs/whmcs9-credit-debit-notes.md) before billing/write changes.
6. **Do not commit** `.cursor/hooks/state/` or other IDE-local paths.

## Documentation map

| Doc | When to read |
|-----|----------------|
| [README.md](README.md) | Install, MCP config, tool catalog summary |
| [docs/PHASE_B_GOVERNANCE.md](docs/PHASE_B_GOVERNANCE.md) | Consumer contracts & projection |
| [docs/capability-probe-runbook.md](docs/capability-probe-runbook.md) | Promoting verified capabilities |
| [docs/phase-i-controlled-writes-recommendation.md](docs/phase-i-controlled-writes-recommendation.md) | Production write GO/NO-GO |
| [docs/whmcs-mcp-production-test-program.md](docs/whmcs-mcp-production-test-program.md) | Reliability / RCA test program |
| [docs/cursor-skills.md](docs/cursor-skills.md) | Recommended Cursor skills |
| [examples/README.md](examples/README.md) | `structuredContent` integration patterns |

## Cursor / rules

- Repo-wide coding standards: [.cursorrules](.cursorrules)
- WHMCS-specific Cursor rule: [.cursor/rules/whmcs-mcp-server.mdc](.cursor/rules/whmcs-mcp-server.mdc)
