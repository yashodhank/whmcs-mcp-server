# DECISIONS (AI) — architectural decisions log

Append-only. One entry per decision. Newest last.

---

## 2026-06-03 — Tiered-friction governance (replaces uniform deny-by-default)

**Decision:** The execution authorizer applies the per-environment allowlist +
human approval + monetary caps to **HIGH-RISK scopes only**. LOW/MEDIUM scopes
are audit-gated: they execute once the consumer is `execution_allowed` and the
universal gates pass (killswitch off, not read_only, intent approved, no replay,
action not in `PROD_NEVER_EXECUTABLE`). `MCP_WRITE_STRICT_ALLOWLIST=true`
restores allowlist-for-all (legacy posture).

**Why:** Uniform 4-step + allowlist friction was blocking ordinary work. Risk
should be proportionate: ceremony only where money/destruction is involved.

**Keystone (revised):** still holds for HIGH-RISK — empty `MCP_PROD_WRITE_AUTHORIZED`
⇒ high-risk production money/destruction sealed by default.

**Files:** `src/write/executionGate.ts` (preAuthorizeIntent step 7 now
risk-conditional), `src/write/types.ts` (ExecutionRequest.strictAllowlist),
`src/config.ts` (MCP_WRITE_STRICT_ALLOWLIST), `src/tools/writeFlow.ts` (pass
strictAllowlist).

**RESOLVED (env-configurable, not hardcoded):** added `MCP_WRITE_STRICT_SCOPES`
(comma list) — scopes that ALWAYS require the allowlist regardless of risk tier.
Defaults to `billing:invoice:create` (gated by default; operator can change/empty
it). Can only TIGHTEN, never loosen a high-risk scope. Field:
`ExecutionRequest.strictScopes`; gate folds it into `allowlistRequired`.

---

## (prior, pre-log) — Per-scope allowlist gating

Allowlist entry authorizes by WHMCS action (broad) OR write scope (narrow), so
two scopes sharing one action (service:price_restore, service:domain_rename →
UpdateClientProduct) gate independently. Idempotency key includes `scope`.
See `allowlistAuthorizes`, `src/write/idempotency.ts`.
