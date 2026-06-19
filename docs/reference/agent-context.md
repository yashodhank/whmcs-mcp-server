# AGENT_CONTEXT — WHMCS MCP server (read first)

Purpose: orient an AI agent fast so it does NOT re-scan the repo. Update only on
architectural change.

## What this is
MCP server fronting the WHMCS API. Read-heavy, governed. Default posture is
read-only + audited; mutations flow through a tiered governance model.

## Layers (frozen seams — don't redesign unless task says so)
- **Reads**: `src/whmcs/actionPolicy.ts` (READ_ALLOWLIST + deny-by-default) →
  `src/canonical/*` (raw→canonical + field-class map, `_shared.ts` helpers) →
  `src/governance/{contracts,projection,pipeline}.ts` (per-consumer field-class
  projection) → tools in `src/tools/*`. Read tools incl. clients, billing,
  domains, support, list/reporting (cursor-paginated), aggregators, infra
  (server-health, tld-pricing), contacts, billing-reads (pay-methods/credits),
  ticket-meta, quotes, system-refs.
- **Read cache**: `src/whmcs/readCache.ts` — per-instance, default OFF
  (`MCP_READ_CACHE_TTL_MS`), static-ref actions only, deep-clone, never mutate.
- **Capability shells**: unverified actions return `capability_unavailable`,
  never call WHMCS; promoted via probe → `src/governance/capabilities.ts`.
  (Many newer reads are capability `unverified` pending prod-probe.)
- **Writes (tiered governance)**: `src/write/{types,validation,paramMapping,
  executionGate,idempotency,audit,intents}.ts` + `src/tools/writeFlow.ts`.
  Flow: draft → validate → approve → execute, PLUS one-call `write` tool
  (auto-approve low/med; high routes to the explicit ceremony). PCI PAN input
  guard (`assertNoPAN`) + optional MCP Elicitation inline-confirm (medium) in
  the write-flow wrapper.
- **MCP surface extras**: Prompts (`src/prompts/whmcsPrompts.ts`), resource
  templates + arg completions (`src/resources/`), logging utility
  (`src/mcpLogging.ts`), progress notifications on heavy aggregators.
- **Consumers/auth**: `src/governance/consumers.ts` (bearer-token registry,
  writeCapability tiers, allowedWriteScopes).
- **Legacy direct-write tools** (create_ticket/reply_ticket/create_invoice/
  mark_invoice_paid/add_credit/record_refund/capture_payment/apply_credit/
  suspend/unsuspend/terminate_service + register/renew/transfer_domain/
  accept_order/create_client/update_client) are RETIRED from the default
  surface, gated by `legacyWriteToolsEnabled()` (`MCP_ENABLE_LEGACY_WRITE_TOOLS`,
  default off). Governed scopes are the path. (service:terminate scopes etc.
  exist; a few — client:create/update — still pending governed equivalents.)

## Write model (current)
- Scopes: `src/write/types.ts` WRITE_SCOPES / SCOPE_ACTION / SCOPE_RISK.
- **Tiered friction (active):** the per-env allowlist + human approval + caps
  apply to **HIGH-RISK only**. LOW/MEDIUM are audit-gated (consumer
  `execution_allowed` + always-on audit; killswitch/read_only/approved/replay/
  `PROD_NEVER_EXECUTABLE` still apply). `MCP_WRITE_STRICT_ALLOWLIST=true`
  restores allowlist-for-all.
- Keystone (now high-risk): empty `MCP_PROD_WRITE_AUTHORIZED` ⇒ high-risk prod
  money/destruction sealed.
- Allowlist entry = WHMCS action (broad, all scopes on it) OR scope (narrow).
- Idempotency key: `consumer | action | scope | naturalKey | window`.
- **No new direct `whmcs.mutate()` paths** — all mutations go through the flow.
  (Legacy direct-write tools in clients/billing/domains/services.ts predate the
  flow; migration is backlog Track C/D3.)

## Adding things (cheat-sheet)
- New READ: allowlist action → canonical mapper → capability shell → probe →
  promote in capabilities.ts → governed tool.
- New WRITE scope: types.ts (3 maps) → validation.ts REQUIRED_PARAMS + checks →
  paramMapping.ts STRICT mapper (+ dispatcher case) → writeFlow.ts (precondition
  /output-assertion/read-back like service:domain_rename) → consumer
  allowedWriteScopes. Risk tier decides friction.

## Tests / validation
- Targeted first; full suite (`npx vitest run`, ~1000+ pass) only when
  governance/canonical/projection/write-flow/shared-client change.
- `npx tsc --noEmit`, `npx eslint`, `npm run build`.
- Patterns to mirror: `tests/write/*.test.ts`, `tests/tools/writeFlow*.test.ts`.

## Roadmap
See approved plan + backlog in `~/.claude/plans/flickering-pondering-feather.md`
(Phase 0 governance rebalance → A reads → B composites → accounting → C write
migration). `docs/design/decisions.md` records posture choices.
