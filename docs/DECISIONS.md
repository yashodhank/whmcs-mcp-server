# DECISIONS (AI) — architectural decisions log

Append-only. One entry per decision. Newest last.

---

## 2026-06-03 — MCP spec/SDK adoption backlog (research, not yet built)

Reviewed github.com/modelcontextprotocol (spec rev **2025-11-25**, TS SDK 1.x).
Adopt, ranked; amends the plan tracks:
- **write-flow:** form-mode **Elicitation** (`server.elicitInput`) to confirm
  high-risk writes inline instead of draft→approve; URL-mode elicitation to keep
  WHMCS/payment creds out of model context. Align validation errors to
  `isError:true` per **SEP-1303** (let the model self-correct).
- **composites:** **Prompts** (`registerPrompt`) shipping WHMCS/audit playbooks
  (month-end reconciliation, phantom/inverse-phantom TDS sweep); **progress
  notifications** on snapshot/360 fan-outs; **Tasks** (experimental) flagged
  fast-follow for long writes.
- **reads:** **pagination cursors** (`nextCursor`/`cursor`) to replace
  `limitnum` truncation; **resource templates** (`whmcs://client/{id}/...`) +
  **completions** on id/domain/dept args.
- **governance:** **logging utility** to surface governance/audit decisions to
  the client; move tier/field-class/risk into tool **`_meta`**; audit that all
  four annotation hints (readOnly/destructive/idempotent/openWorld) are set on
  every tool. JSON Schema default is now **2020-12** — confirm schemas validate.
- **transport (strategic):** **Streamable HTTP + OAuth 2.1 resource-server +
  CIMD** for hosted multi-client. Maps consumer→OAuth client, field-class→scope.
  Stdio + in-house tokens remain correct per spec until then. Old HTTP+SSE
  transport + DCR are deprecated — don't build on them.
- **Skip:** Roots (no workspace concept), Sampling (conflicts with the
  governed read/write audit boundary) unless a concrete need appears.
- **Keep in-house (no spec equivalent):** field-class projection, capability
  registry, per-consumer rules, rate limiting, audit log.

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
