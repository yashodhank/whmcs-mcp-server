# WHMCS MCP — Risk-Tiered Production Write Enablement (Cowork Operations Gateway)

- **Date:** 2026-05-19
- **Status:** Approved with amendments — implementation in progress
- **Branch:** `feat/prod-write-gateway`
- **Scope boundary:** WHMCS MCP **only**. This repo gives Claude Cowork *governed
  WHMCS context* and *controlled WHMCS actions*. **No Google Ads / Meta Ads /
  GA4 / GTM / marketing-platform code** belongs here — those are external Cowork
  use cases, referenced as context only.

## 1. Goal

Replace the WHMCS MCP's absolute production-write block with a **deny-by-default,
risk-tiered production authorizer**, so Claude Cowork can perform a *narrow,
explicitly-allowlisted* set of WHMCS actions in production — starting with
`AddClientNote` only — while every higher-risk action stays sealed until
explicitly and incrementally enabled.

**Keystone safety invariant:** with no new environment variables set, behaviour
is **byte-identical to today** — production fully sealed, zero live mutation.

## 2. Locked decisions (amended)

| Topic | Decision |
|---|---|
| Overall design | Approved with amendments |
| `promotion:create` | Implement **only if Spike 0 proves a safe supported API/localAPI path** |
| `promotion:update` / `:delete` | **Not now** |
| No-API promo fallback | Manual promo creation in WHMCS admin; MCP may *read/verify* only if safe; **no DB-write promotion automation in production** |
| High-risk money cap | Default **0 unless explicitly configured** via env; require human approval + per-action cap + daily cap |
| Initial prod-executable | **`AddClientNote` only**, then ticket actions; money/service/domain/module later |
| `PROD_NEVER_EXECUTABLE` | Expanded — destructive client/service/domain/config/admin/raw-DB/bulk actions |
| Cowork consumer | One `execution_allowed` consumer, **scoped by action**, not god-mode; synthetic token via env only |

## 3. Rollout order (staged enablement)

```
S0  Probe promotion API on dev WHMCS 9 (localhost:8890)      ← blocking spike
S1  Risk-tiered production authorizer (sealed by default)
S2  Durable audit + durable idempotency
S3  Dev/staging full-cycle writes
S4  Production canary: AddClientNote only
S5  Production canary: ticket reply/status only
S6  Promotion create — only if API proven
S7  Money actions — later, human approval + caps
S8  Service/domain/payment actions — last
```

S1–S3 + tests are environment-independent and implemented now. S0/S3 need the
dev WHMCS up. S4+ require explicit, separate production authorization (not in
this work item).

## 4. Architecture — the policy gate

`defaultExecutionAuthorizer` (`src/write/executionGate.ts`) — the absolute
`if (env==='production') deny production_execution_forbidden` is **removed and
replaced** by a deny-by-default policy table. Pure function: **never calls
WHMCS** (invariant preserved). `WhmcsClient.mutate()`'s `read_only`
`MODE_RESTRICTED` throw remains an independent backstop.

Evaluation order (first failing gate wins; default posture denies):

```
1. MCP_WRITE_KILL_SWITCH on            → deny kill_switch_engaged
2. mcpMode == read_only                → deny read_only_mode
3. intent.state != approved            → deny intent_not_approved
4. consumer != execution_allowed       → deny consumer_not_execution_allowed
5. idempotency replay                  → deny idempotency_replay
6. action ∈ PROD_NEVER_EXECUTABLE      → deny action_permanently_blocked
7. env==production:
     action ∉ MCP_PROD_WRITE_AUTHORIZED → deny action_not_prod_authorized   (default [] ⇒ SEALED)
   env!=production:
     action ∉ MCP_WRITE_EXECUTION_AUTHORIZED → deny action_not_runtime_authorized
8. risk tier (SCOPE_RISK):
     high   → require humanApproval record
                AND amount ≤ perActionCap (default 0 ⇒ deny)
                AND dayTotal+amount ≤ dailyCap (default 0 ⇒ deny)
              else deny human_approval_required / amount_cap_exceeded
     medium → allow (optional medium cap)
     low    → allow
9. ALLOW → execute → read-back verify → durable audit
           (audit unwritable for an executable prod mutation ⇒ deny audit_write_failed, fail CLOSED)
```

## 5. Components & files

| File | Change |
|---|---|
| `src/write/types.ts` | (Conditional on Spike 0) add `promotion:create`→`AddPromotion`, risk `medium`. Extend `ExecutionRequest` (`killSwitch`, `prodAuthorizedActions`, `humanApproval?`, `amountContext?`, `caps`). Add `ExecutionDeniedReason`: `kill_switch_engaged`, `action_not_prod_authorized`, `human_approval_required`, `amount_cap_exceeded`, `action_permanently_blocked`, `audit_write_failed`, `verification_failed`. Add `PROD_NEVER_EXECUTABLE` frozen set. Keep `production_execution_forbidden` member (legacy/no longer emitted) for compat. |
| `src/write/executionGate.ts` | Replace absolute prod block with §4 policy table. Inputs supplied by caller; still pure. |
| `src/write/audit.ts` | `AuditLog` → append-only JSONL: durable `append` (write+flush), load-on-startup, in-memory mirror for queries. Redaction unchanged (no tokens/PII). |
| `src/write/idempotency.ts` | `IdempotencyLedger` → optional durable backing file; `seen`/`record` persist; survive restart; replay denied + audited. |
| `src/tools/writeFlow.ts` | Replace `LOW_RISK_EXECUTABLE` with authorizer-owned policy; add `PROD_NEVER_EXECUTABLE` backstop check; feed new authorizer inputs; durable store init; audit-write-failure → fail closed. Reuse existing `draft→validate→approve→execute`; **no new tool surface**. |
| `src/write/validation.ts` | (Conditional) add `promotion:create` to `REQUIRED_PARAMS`. |
| `src/governance/consumers.ts` | No logic change; example `execution_allowed` Cowork consumer documented (config/env only). |
| `src/config.ts` | New env: `MCP_PROD_WRITE_AUTHORIZED` (csv, default []), `MCP_WRITE_KILL_SWITCH` (bool, default false), `MCP_WRITE_AUDIT_PATH` (default `./data/write-audit.jsonl`), `MCP_PROD_HIGH_RISK_PER_ACTION_CAP` (number, default 0), `MCP_PROD_HIGH_RISK_DAILY_CAP` (number, default 0). |
| `tests/write/*.test.ts` | §7 truth table incl. keystone regression. |

## 6. `PROD_NEVER_EXECUTABLE` (permanently blocked in production)

```
DeleteClient, DeleteInvoice, DeleteTransaction, DeletePayMethod,
TerminateService, ModuleTerminate, MassTerminate (and any mass/bulk action),
DomainTransfer, DomainRelease, DeleteDomain,
SetConfigurationValue, UpdateAdmin, CreateAdmin, DeleteAdmin,
admin/API credential/security/config mutations,
raw SQL / custom DB write paths,
any destructive action without safe rollback
```

Blocked even if mistakenly added to the prod allowlist (gate 6 precedes gate 7).

**Not never, but not enabled yet** (later, under explicit caps/approvals):
`CapturePayment, RefundTransaction, AddCredit, ApplyCredit, AddInvoicePayment,
CreateInvoice, AcceptOrder, RegisterDomain, RenewDomain, SuspendService,
UnsuspendService`.

## 7. Testing (Track H)

Full `executionGate` truth table:
- **Keystone regression:** no env vars ⇒ production fully sealed, identical to today.
- Kill switch blocks everything; `read_only` blocks everything.
- Unapproved intent denied; non-execution consumer denied.
- Action not in prod allowlist denied; `PROD_NEVER_EXECUTABLE` denied even if allowlisted.
- High-risk without human approval denied; cap-exceeded denied (default cap 0 ⇒ all money denied).
- Idempotency replay denied **after simulated restart** (durable ledger).
- Audit-write failure ⇒ fail closed.
- Read-back verification failure ⇒ blocks / marks failed.
- `AddClientNote` prod canary path eligible **only** when explicitly allowlisted.
- No production execution by default.

Plus durable audit/idempotency survive simulated restart.

## 8. Spike 0 — promotion API probe (Track A, blocking)

Probe **dev WHMCS 9 (localhost:8890) only**. Test `AddPromotion`/`UpdatePromotion`
only if such actions exist; test localAPI/custom only if safe. Do **not** assume
a public API. No production promo write. Output exactly one of:
`supported_create | unsupported | partial | unsafe | not_authorized`.
Branch the promo plan on the result (none ⇒ pragmatic manual-admin split, MCP
read/verify only).

## 9. Hard stops / allowed

**Hard stops:** live production mutation; push/merge; raw DB writes; committing
secrets/PII/raw WHMCS responses; broad unsafe allowlist expansion; destructive
deletion of unmerged work; pulling production DB into dev (PII).

**Allowed automatically:** create branch, write spec, implement code, add tests,
run dev probes, run dev/staging execution tests, commit locally, run full gates.

## 10. Out of scope (YAGNI)

`promotion:update`/`:delete`; new MCP tools; `MCP_ACCESS_MODE`/projection
changes; any non-WHMCS (ads/tracking/website) code; production canary execution
(separate later authorization).
