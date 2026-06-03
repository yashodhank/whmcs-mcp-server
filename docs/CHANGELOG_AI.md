# CHANGELOG (AI) — concise implementation notes

Newest first.

## 2026-06-03 (annotation hints — clients/domains/orders)
- Migrated `server.tool()` → `server.registerTool(...)` in clients/domains/orders
  and set all 4 annotation hints per tool (readOnly/destructive/idempotent/
  openWorld). transfer_domain → destructiveHint:true. No new outputSchema (avoids
  the compliance-test structuredContent requirement). Behavior unchanged.
- Note: `entityOwnership.ts` evaluated for adoption — DECLINED as redundant;
  `get_invoice`/`get_ticket_thread`/invoice+ticket resources already enforce
  client-mode ownership via the wired `ensureClientOwnership`.

## 2026-06-03 (progress notifications + Track C money scopes — parallel)
- **MCP progress notifications** on heavy aggregators (get_account_360,
  get_reconciliation_snapshot/export, get_provisioning_snapshot): per-section
  `notifications/progress` via `extra.sendNotification` + `_meta.progressToken`.
  No-op without a token (results byte-identical); never throws; counts/section
  names only. register() extended to pass `(params, extra)` backward-compatibly.
- **Track C money scopes** (completes the governed billing surface):
  `billing:payment:capture`→CapturePayment, `billing:credit:apply`→ApplyCredit,
  both **high-risk** (full gate). Strict mappers (no CVV ever). Legacy
  `capture_payment`/`apply_credit` retired by default (legacyWriteToolsEnabled).
- 2 parallel agents (disjoint files). Full suite **1007 pass**. tsc/eslint/build clean.

## 2026-06-03 (MCP resource templates + completions + logging — parallel)
- **Resource templates** (`ResourceTemplate`): `whmcs://client/{clientid}/{summary,
  services,domains}`, `whmcs://invoice/{invoiceid}/history`,
  `whmcs://ticket/{ticketid}/thread`. Existing plural-URI resources refactored to
  shared handlers + dual-registered — backward compatible. SEC-003 + client-scope
  preserved.
- **Completions**: `{clientid}` (bounded GetClients search, ≤10, ids only, no PII;
  client-mode returns prefix-matched allowlist, never queries WHMCS) and
  `{status}` (closed enum sets). Empty input → []; errors → [].
- **MCP logging utility**: `logging` capability + `src/mcpLogging.ts` bridge —
  `mcpLog(level,msg,data)` → `sendLoggingMessage` (RFC-5424 levels; setLevel
  auto-handled by SDK; client-capability feature-detect; secret/PII/PAN-safe;
  never throws). Default behavior unchanged without a logging-capable client.
- Authored by 2 parallel agents (disjoint files). Full suite **994 pass**.
  tsc/eslint/build clean.

## 2026-06-03 (PCI PAN guard + MCP Elicitation + adoption report)
- **PCI-DSS PAN input guard ADOPTED + WIRED.** Committed `src/security/panScanner.ts`
  (was dormant/untracked) and call `assertNoPAN(params)` in the write-flow
  `register()` wrapper — any tool input containing a Luhn-valid 13–19 digit card
  number is rejected with a structured error BEFORE drafting/executing; the PAN
  value is never echoed. (entityOwnership.ts left untracked — separate concern.)
- **MCP Elicitation** (spec 2025-11-25) inline confirm for MEDIUM one-call
  writes: when the client advertises `elicitation`, the `write` tool requests an
  explicit confirm before executing (best-UX approval in one round-trip); decline/
  cancel/error → fail-closed (rejected, no mutation); clients WITHOUT elicitation
  are unchanged (medium still auto-executes). `confirmViaElicitation` helper +
  `server.server.elicitInput` / `getClientCapabilities` feature-detect.
- **docs/MCP_ADOPTION.md** — full report on github.com/modelcontextprotocol and
  how it improves this project (verified spec 2025-11-25, SDK 1.29).
- Full suite **963 pass**. tsc/eslint/build clean.

## 2026-06-03 (legacy-tool retirement + composites + pagination — parallel)
- **Legacy duplicate write tools RETIRED by default.** `create_ticket`,
  `reply_ticket`, `create_invoice`, `mark_invoice_paid`, `add_credit`,
  `record_refund` (duplicate governed scopes, bypass tiered governance) gated
  behind `legacyWriteToolsEnabled()` (config.ts; reads
  `MCP_ENABLE_LEGACY_WRITE_TOOLS`, default OFF). Off the default surface; the
  governed write-flow is the path; recoverable via env for migration windows.
  `capture_payment`/`apply_credit` kept (no governed scope yet — follow-up).
- **Composites B2/B3/B5** (aggregators.ts): `get_service_lifecycle`
  (GetClientsProducts+GetOrders+GetAutomationLog), `get_revenue_report`
  (GetInvoices Paid + GetTransactions, cash vs accrual), `get_reconciliation_export`
  (normalized invoice↔transaction ledger for bank/26AS). Capability-gated +
  fault-isolated.
- **Pagination cursors** on all 7 `list_*` tools (listTools + reportingListTools):
  opaque base64 `nextCursor` replaces silent `limitnum` truncation; bad cursor →
  page 0; backward compatible; outputSchema extended.
- Compliance test: added legacyWriteToolsEnabled mock + serviceid arg for
  get_service_lifecycle. Full suite **959 pass**. Authored by 2 parallel agents
  (composites, pagination) + main thread (retirement). tsc/eslint/build clean.

## 2026-06-03 (Track C write-migration + more reads + MCP Prompts)
- **Track C — legacy service writes migrated into the tiered governed model.**
  New scopes: `service:suspend` (med, ModuleSuspend), `service:unsuspend` (med,
  ModuleUnsuspend), `service:terminate` (high, ModuleTerminate — perma-blocked
  in prod at BOTH action + scope level), `domain:nameservers:update` (med,
  DomainUpdateNameservers). Strict mappers + validation (serviceid/domainid
  positive int; nameservers 2–5 valid hosts). **RETIRED** the legacy
  direct-`mutate` tools `suspend_service`/`unsuspend_service`/`terminate_service`
  (deleted services.ts + its test + golden; removed from index + compliance
  test). Suspend/terminate now ONLY via the governed write-flow.
- **Reads (parallel agents):** `get_quotes` (GetQuotes), `get_currencies` /
  `list_payment_methods` / `get_whmcs_details` (GetCurrencies/GetPaymentMethods/
  WhmcsDetails). Allowlisted, capability `unverified`.
- **MCP Prompts** (`src/prompts/whmcsPrompts.ts`, SDK 1.29 `registerPrompt`):
  month_end_reconciliation, phantom_tds_sweep, suspend_for_nonpayment (drafts
  service:suspend via the governed flow — forbids direct mutate),
  new_client_onboarding, domain_renewal_review.
- Full suite **939 pass**. tsc/eslint/build clean.

## 2026-06-03 (Phase 1/2 batch — parallel)
- **A3 get_client_contacts** (GetContacts; canonical/contact.ts — PII classed).
- **A5 get_pay_methods + get_credits** (GetPayMethods/GetCredits;
  canonical/payMethod.ts — **card/bank/token → secret.credential, dropped**;
  masked last4 only if WHMCS-provided).
- **A6 get_ticket_counts + list_support_statuses** (GetTicketCounts/
  GetSupportStatuses; canonical/ticketMeta.ts — operational, no PII).
- **B4 get_accounts_receivable_aging** (aggregators.ts) — unpaid+overdue
  invoices bucketed current/1-30/31-60/61-90/90+ with per-bucket count+amount,
  dedup overlap, total. Fault-isolated.
- 5 actions allowlisted, capability `unverified`. Authored by 3 parallel agents
  (disjoint files); central wiring (actionPolicy/capabilities/index) integrated
  by main thread. Full suite 901 pass.
- **MCP spec/SDK adoption review** added to DECISIONS.md (Elicitation, Prompts,
  pagination cursors, completions, progress, logging, _meta, Streamable
  HTTP+OAuth). Not yet implemented — backlog.

## 2026-06-03 (Phase 2 B1)
- **get_domain_portfolio_snapshot** (aggregators.ts) — composes GetClientsDomains
  + GetTLDPricing → per-domain status/registrar/expiry/days-to-expiry/lock/
  id-protection + estimated 1-yr renewal cost (longest-suffix TLD match). Summary
  (total, expiring≤30d, total renewal cost, priced count). Pricing best-effort
  (fault-isolated → partial_errors). Shares AGGREGATOR_OUTPUT_SCHEMA (`truncated`
  is an object). Tests: longest-suffix match (.co.uk vs .uk), unpriced TLD,
  pricing-failure degradation. Full suite 862 pass.

## 2026-06-03 (Phase 1 reads + cache + review fixes)
- **A1 get_server_health** ← GetServers (+GetHealthStatus allowlisted, unused).
  Canonical `server` (hostname/IP→system.diagnostic, counts→public.safe).
- **A2 get_tld_pricing** ← GetTLDPricing (+GetRegistrars enrichment). Canonical
  `tldPricing` (prices→financial.amount). Both capability `unverified` (not
  prod-probed); real governed reads. Files: canonical/{server,tldPricing}.ts,
  tools/infraTools.ts, actionPolicy/capabilities/types/index. Shape assumptions
  need prod verification (see agent notes / mappers).
- **F1 read-cache** — `src/whmcs/readCache.ts`, per-WhmcsClient, default OFF
  (`MCP_READ_CACHE_TTL_MS=0`). Caches only static-ref reads in
  `MCP_READ_CACHE_ACTIONS` (TLD/registrars/depts/products/currencies). Never
  caches mutate; assertReadAction runs before cache. Bounded (256, oldest-evict).
- **Review fixes (from parallel audit of Phase 0):**
  - MED: price_restore batch cap FLOOR — `caps.perAction<=0||daily<=0` now
    blocks (zero/equal-amount target could slip default {0,0}). writeFlow.ts:638.
  - LOW: one-call `write` no longer auto-approves for non-`execution_allowed`
    consumers — returns 'validated' for the explicit ceremony (no spurious
    approve audit). Regression tests added for both.
- **Read-cache RCA fixes (post-build review):**
  - MED M1: cache key now built from `transformParams(params)` (drop-undefined +
    bool-normalize) so key-space == request-space — `{x:undefined}` and `{}`
    share one entry. WhmcsClient.read.
  - MED M2: cache deep-clones on set AND get (structuredClone) — a caller
    mutating a returned/original object can no longer poison the cached value.
  - LOW: tldPricing rejects fractional/garbage periods (`Number.isInteger`,
    >0); price 0 retained, -1/negative dropped.
  - Edge tests added: transformed-key equivalence, clone-poisoning (both sides),
    cross-instance isolation, tld period/price boundaries.
- Full suite 860 pass.

## 2026-06-03 (Phase 0 governance rebalance)
- **D1 one-call `write` tool.** Single tool: draft→validate→(auto-approve
  low/med)→execute in one round-trip, always audited. High-risk is validated
  then returned for the approve→execute ceremony (not auto-run). Execute body
  extracted to a shared `executeRun` closure reused by `execute_write_intent`
  and `write`. Test: writeFlow.oneCall (low/med/high). 6 flow tools now.
- **D4 scope-level permanent block.** `PROD_NEVER_EXECUTABLE_SCOPES` (seeded
  service:terminate, domain:transfer, domain:release) checked in gate step 6
  alongside the action set — hard-blocks one scope even when its action is
  shared with a safe sibling. Test in executionGate.
- **MCP_WRITE_STRICT_SCOPES** env — per-scope tighten; defaults to gating
  `billing:invoice:create`. Resolves the open invoice-tier question
  (env-configurable, not hardcoded).
- **F3 projection fast-path: DEFERRED.** Under allow-all contracts the walk is
  already cheap (no mask/summarize), unmapped-key drop makes a blind fast-path
  unsafe, and governance is off by default — marginal value, real risk. Speed
  work better served by F1 read-cache (Phase 1).
- Full suite 817 pass. Files: write/{types,executionGate}, config.ts,
  tools/writeFlow.ts; tests writeFlow.oneCall/test/prodsafety, executionGate.
- **D2 tiered-friction authorizer.** Allowlist/approval/caps now apply to
  HIGH-RISK scopes only; low/medium are audit-gated. Added
  `ExecutionRequest.strictAllowlist` + `MCP_WRITE_STRICT_ALLOWLIST` env to
  restore strict mode. Keystone narrowed to high-risk. Tests: executionGate
  (tiered + keystone-high-risk), writeFlow.prodsafety (now high-risk). Full
  suite 812 pass. See DECISIONS.md (open: billing:invoice:create tier).
- **service:domain_rename scope** + per-scope allowlist gating
  (`allowlistAuthorizes`), `preAuthorizeIntent` extraction, price_restore
  batch-path allowlist fix, scope-in-idempotency-key, domain normalization,
  precondition+read-back+output-assertion. Runbook §6/§7.
