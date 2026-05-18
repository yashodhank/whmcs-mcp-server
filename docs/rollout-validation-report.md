# WHMCS MCP — Read-Only Rollout Validation Report

**Branch:** `feature/whmcs-mcp-readonly-rollout-validation` (from `main` `9a8b4ae` = `origin/main`)
**Scope:** read-only validation only. No Phase F. No prod writes. No mutation tools. Nothing pushed/merged.
**Dev stack used:** `docker-compose.whmcs-test.yml` — `mcpw8` (WHMCS 8) `:8813`, `mcpw9` (WHMCS 9) `:8890`, both healthy; 158 **synthetic** test clients.

## 1. Commands run

| # | Command | Purpose |
|---|---|---|
| 1 | `git checkout -b feature/whmcs-mcp-readonly-rollout-validation` | branch from merged main |
| 2 | `npm run typecheck / lint / build / test` | local baseline gate |
| 3 | secret/PII tree scan | safety |
| 4 | `MCP_ENV=local npx tsx test-connection.ts` | Dev WHMCS9 read-only connectivity (`GetClients limitnum:1`) |
| 5 | `node scripts/mcp-e2e.mjs` (MCP_ENV=local) | live read-only e2e, **legacy** (governance OFF) |
| 6 | `node scripts/mcp-governed-smoke.mjs` (MCP_ENV=local, GOVERNANCE=on) | live read-only **governed** smoke, 5 example consumers |
| 7 | `MCP_MODE=read_only npx tsx test-connection.ts` (prod `.env`) | **PROD read-only connectivity — explicitly user-authorized, single run; SUCCESS (see §3a)** |

## 2. Test / build / typecheck / lint

| Gate | Result |
|---|---|
| Full test suite | **243 passed / 14 skipped** (37 files) |
| Build (tsup) | **success** |
| Typecheck | **26** (pre-existing baseline; 0 introduced) |
| Lint | **530** (pre-existing baseline; 0 introduced) |
| Secret/PII tree scan | **CLEAN** — no tracked `.env`/key/credential; no non-synthetic emails; no raw prod responses/real ticket content |

## 3. Smoke test results (LIVE, Dev WHMCS9, read-only)

**Legacy e2e (`mcp-e2e.mjs`, governance OFF): 10/10 PASS** — 46 tools registered; `list_products`, `get_ticket_departments`, `get_client_details`, `check_domain_availability` work on real dev data; SEC-002 (no token in resource URIs); PII scrubbed; **`read_only` blocks `mark_invoice_paid` live** (`{"isError":true,"error":"Tool not available in read_only mode"}`).

**Governed smoke (`mcp-governed-smoke.mjs`, governance ON): 23/23 PASS** — incl. small-limit reads + all aggregators (`search_clients` l1, `list_client_services|orders` l3, `get_activity_log` l3, `get_account_360` r3, `get_billing/support/renewal_snapshot`, `get_activity_timeline`, `get_reconciliation/provisioning/risk_snapshot`) all `isError=false`; write blocked even governed.

> Note: `search_clients limit 1`, `list_client_invoices/domains limit 3` were exercised governed; tools requiring a specific known client used dev client id 1 ("Demo Account", synthetic).

## 3a. Production read-only connectivity (user-authorized, single run)

Explicitly authorized, scoped to a read-only connectivity probe only
(`MCP_MODE=read_only npx tsx test-connection.ts`, prod `.env`,
`GetClients limitnum:1`). Result:

- `Mode: read_only` (unchanged) · Access Mode: admin
- **API connection: SUCCESS** · `Response result: success`
- A client count was returned (read path works end-to-end); exact value
  withheld from this report by scope — **no customer PII, emails, domains,
  invoice/ticket data, credentials, or raw response emitted**
- No 403 / IP-allowlist / auth / network error. Single run, no retry, no
  config change, no write command.

Production read-only connectivity + credential + IP-allowlist path is
**confirmed working**.

## 4. Governance behavior matrix (LIVE-verified on Dev)

| Scenario | Expected | Result |
|---|---|---|
| Unknown token, prod-style (anon disabled) | denied, no data | ✅ `consumer denied: unknown_token`, `status=consumer_denied`, no `data` |
| `llm_chat` | `llm_safe_summary`, secrets gone | ✅ contract=`llm_safe_summary`, no `secret.credential` field |
| `ops_operator` | `ops_operator` | ✅ contract=`ops_operator` |
| `billing_dashboard` | `billing_reconciliation` | ✅ contract=`billing_reconciliation` (invoices, 3 items) |
| `renewal_worker` | `renewal_automation` | ✅ contract=`renewal_automation` |
| `support_console` | `support_triage` (ticket text preserved for authorized) | ✅ contract=`support_triage` |
| `llm_chat` requests `admin_full_trusted` | NOT honored | ✅ stays `llm_safe_summary` (no escalation) |
| `none_local_only` outside local | impossible | ✅ unit-proven (`ProjectionEnvError`); local run cannot exercise prod-reject — covered by `tests/governance/projection.test.ts` |
| Write under governance ON | blocked | ✅ `read_only mode` |

## 5. Consumer contract behavior matrix

| Consumer | Default contract | secret.credential | untrusted.free_text | PII | financial | Live |
|---|---|---|---|---|---|---|
| llm_chat | llm_safe_summary | drop | summarize | mask | allow | ✅ |
| ops_operator | ops_operator | drop | wrap_untrusted | allow | allow | ✅ |
| billing_dashboard | billing_reconciliation | drop | drop | mask (name/email allow) | allow | ✅ |
| renewal_worker | renewal_automation | drop | drop | allow(email)/mask | allow | ✅ |
| support_console | support_triage | drop | allow (verbatim) | allow | allow | ✅ |

(Contract policy per `src/governance/contracts.ts`; behavior tags unit-tested in `tests/governance/projection.test.ts` and live-confirmed via contract tagging on real dev data.)

## 6. Capability matrix (live `get_capability_matrix`)

- **supported (15, allowlisted):** GetClients, GetClientsDetails, GetClientsProducts, GetClientsDomains, GetInvoice, GetInvoices, GetTickets, GetTicket, GetSupportDepartments, GetOrders, GetProducts, **GetActivityLog**, GetAdminDetails, GetAdminLog, DomainWhois
- **unverified (5, capability-shell):** GetTransactions, GetStats, GetToDoItems, GetAutomationLog, GetUsers → live `list_client_transactions` returned `{capability_unavailable:true, action:"GetTransactions", status:"unverified"}`, **no WHMCS call**
- **WHMCS version:** `unverified` (honest; no allowlisted version source probed)

## 7. Integration friendliness

- Canonical data complete internally; projection only at output boundary (architecture + `tests/governance/*` + live contract tagging).
- `structuredContent` present on governed tool results (apps) + human-readable `content` text (LLM/operator) — confirmed live.
- `capability_unavailable` is structured and predictable (`{capability_unavailable, action, status, note}`, `isError:true`).
- Minor consistency note (non-blocking): `get_capability_matrix` nests under `data` when governed vs top-level legacy — harness handles both; documented for app authors.

## 8. Safety

- Production write path blocked — verified **live** in both legacy and governed modes (`mark_invoice_paid` → `read_only`).
- No mutating WHMCS action invoked anywhere in validation.
- Logs are stderr-only; no secrets observed in output.
- llm_safe_summary projection contained **no** `secret.credential` field on real dev data.
- Ticket/client free-text: preserved verbatim only under `support_triage` (authorized); summarized/wrapped for `llm_safe_summary`.

## 9. Gaps & recommended fixes

| Gap | Severity | Recommendation |
|---|---|---|
| Prod read-only connectivity | Resolved | User-authorized single probe passed (§3a); full Stage 0/1 smoke still recommended at rollout |
| `get_capability_matrix` payload shape differs governed vs legacy (`data.` nesting) | Low | Document for app authors (done here) or normalize in a follow-up |
| 5 capability-shell actions remain `unverified` | By design | Promote only via deliberate per-tool allowlist + prod read-only probe |
| WHMCS 8 (`:8813`) not API-smoked (creds differ from w9) | Low | Optional: operator runs e2e against w8 env; governed reads are version-agnostic by design |

No functional defects found. No regressions.

## 10. Production deployment checklist (read-only)

**Stage 0 — legacy (governance OFF):** `MCP_ENV=production`, `MCP_MODE=read_only`, `MCP_GOVERNANCE_ENABLED=false`, https URL, API-role + IP-allowlisted credential. Run `npx tsx test-connection.ts` (read-only). Smoke ≤5 limits; confirm legacy output unchanged; confirm a write tool returns `read_only`.

**Stage 1 — governed (one consumer):** add one entry to `MCP_CONSUMER_REGISTRY` (sha256 hash only; see `docs/consumer-registry.example.md`), `MCP_GOVERNANCE_ENABLED=true`, `MCP_ALLOW_ANON_LLM=false`. Confirm unknown token denied; consumer gets contract-projected output; `none_local_only`/`debug_local` rejected; re-run small-limit smoke; `get_capability_matrix` shows 5 `unverified`.

**Guardrails:** no prod-write mode; no mutation tools; smoke only (never bulk); rollback = `MCP_GOVERNANCE_ENABLED=false`.

## 11. Readiness verdict

**READY for wider internal app integration in read-only mode.** Live Dev WHMCS9 validation (legacy 10/10 + governed 23/23), green baseline, clean scan, **and a confirmed user-authorized production read-only connectivity check (§3a)** establish: backward-compatible legacy path, correct per-consumer contract projection, honest capability gating, intact production read-only write block, and working prod credential/IP path. Recommended pre-broad-rollout step remains the operator §10 Stage 0/1 small-limit prod smoke.
