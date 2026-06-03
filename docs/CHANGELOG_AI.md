# CHANGELOG (AI) — concise implementation notes

Newest first.

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
