# Phase F/G — Controlled Write Automation (design + current implementation)

> **Status: IMPLEMENTED and SEALED BY DEFAULT.** The write machinery described
> here is live in `src/write/*` and `src/tools/writeFlow.ts` (six MCP tools:
> `draft_write_intent`, `validate_write_intent`, `approve_write_intent`,
> `execute_write_intent`, `write`, `get_write_intent`). It is **sealed by
> default**: with no write-specific env configured, `MCP_MODE=read_only` and an
> empty `MCP_PROD_WRITE_AUTHORIZED` mean zero live production mutation — the
> keystone invariant, verified by `tests/write/executionGate.test.ts`.
> **No production action is ungated by this document.** Ungating any production
> action is a separate, explicitly-authorized decision (currently **NO-GO** —
> see `docs/design/controlled-writes-phase-i.md`). This file is the
> design-of-record AND the accurate description of what is built; when the code
> and this doc disagree, the code wins and this doc must be corrected.
>
> Naming: "Phase F" is the design; "Phase G+" is the shipped implementation and
> the tiered-friction governance decided in `docs/design/decisions.md` (2026-06-03).
> They share this document.

## 0. Principles

- **Sealed by default.** Production live mutation is off until a specific
  consumer capability, scope, environment authorization, and (for high-risk)
  human approval + monetary caps all line up. Default `MCP_MODE=read_only`
  blocks all execution on its own.
- **Risk-proportionate friction (tiered).** Friction matches risk, it is not
  uniform (decisions.md 2026-06-03). LOW/MEDIUM scopes are *audit-gated*: they
  execute once the consumer is `execution_allowed` and the universal safety
  gates pass (kill switch off, not read_only, intent approved, no replay, action
  not permanently blocked) — no per-action allowlist required. HIGH-RISK scopes
  (money + destructive) keep the *full* gate: per-environment allowlist + human
  approval + monetary caps. `MCP_WRITE_STRICT_ALLOWLIST=true` restores
  allowlist-for-all (the legacy posture) as a deployment lever.
- **Reuse, don't fork.** Built on the existing capability registry, consumer
  registry, projection boundary, and the read-only `WhmcsClient.mutate()`
  `MODE_RESTRICTED` backstop, which remains an independent layer beneath the
  gate.
- Every write is **draft → validate → approve → execute → verify**, idempotent,
  audited, and reversible-or-compensatable. The real state machine adds
  `rejected`, `execution_blocked`, and `failed` terminal states (§4).

## 1. Write intent object

A pure, non-executing description of a proposed mutation (`src/write/types.ts`
`WriteIntent`):

```
WriteIntent {
  intent_id          // uuid
  consumer_id        // resolved registered consumer (never the token)
  scope              // a member of WRITE_SCOPES (e.g. "client_note:write")
  action             // derived from SCOPE_ACTION (e.g. "AddClientNote")
  risk               // 'low' | 'medium' | 'high', from SCOPE_RISK
  params             // validated, projection-safe (no secrets echoed)
  idempotency_key    // sha256(consumer_id|action|scope|naturalKey|windowBucket)
  preconditions      // read-derived expectations, re-checked at validate/execute
  projected_effect   // human + structured summary of the change
  state              // see §4
  created_at, expires_at   // default TTL 15 min (intents.ts DEFAULT_TTL_MS)
  contract?          // optional governance contract name
}
```

Stored server-side **in memory** (`IntentStore`, `src/write/intents.ts`), pruned
on TTL. The store is intentionally NOT persisted: a dropped intent is simply
re-drafted, and ephemerality shrinks the replay surface. `action` and `risk` are
read from the FROZEN `SCOPE_ACTION` / `SCOPE_RISK` maps, never caller-supplied.
Never auto-advances state.

## 2. Draft-only tools

`draft_write_intent` (and the draft phase of the one-call `write` tool) produce a
`state='draft'` `WriteIntent` and **call no mutating WHMCS API**. They may do
read calls to compute preconditions/effect. The draft is gated by the consumer's
`writeCapability` and `allowedWriteScopes` (`assertWriteScopeAllowed`,
`src/governance/consumers.ts`). Output is the intent + projected effect under the
consumer's contract.

## 3. Validate-only tools

`validate_write_intent(intent_id)` (`src/write/validation.ts`): per-scope
required-param checks, scope/action consistency against the frozen `SCOPE_ACTION`
map, risk + idempotency-key presence, precondition-shape sanity, per-scope
business rules (enum/sign/range/identity-disjunction checks), and a
**mapping-error backstop** — it runs the intent→WHMCS param mapper inside a
try/catch so any structural mapping problem surfaces here (`code='mapping_error'`,
severity error) *before* approval, not at execute time. Emits non-blocking WHMCS
8/9 compatibility advisories (`compat_warnings`). No mutation. Sets `validated`
or stays drafted with `ok=false` issues.

> **Enhancement (future):** precondition *re-read* against live WHMCS at validate
> time is described here as intent but is partly caller-supplied today
> (`ValidationContext.preconditionSnapshots`). When precondition re-read is
> wired server-side, document which scopes re-read what.

## 4. Approval-required execution + the real state machine

State machine (`src/write/intents.ts` `TRANSITIONS`):

```
draft       → validated | rejected
validated   → approved  | rejected
approved    → executed  | execution_blocked
executed    → verified  | failed
rejected | execution_blocked | verified | failed → (terminal)
```

- Execution requires `state='approved'` AND, depending on tier, the gates in §6.
- `approve_write_intent` records an `{approver, approver_consumer_id, at}`
  approval record and moves `validated → approved`. The `approver_consumer_id` is
  **server-derived** (the authenticated approving consumer), never caller-supplied.
  HIGH-RISK execution additionally requires this human approval record to be
  present at execute time (`executionGate.ts` step 8).
- **Separation of duties (enforced).** A HIGH-RISK intent can never be
  self-approved: the gate denies `self_approval_forbidden` when the approval's
  `approver_consumer_id` equals the drafting consumer — enforced unconditionally,
  after the keystone allowlist, so sealing is preserved. The approver may be a
  *distinct* authorized consumer (still capability- and scope-gated); the drafter
  remains the only party that can execute. `MCP_WRITE_REQUIRE_DISTINCT_APPROVER`
  (default `true`) extends the distinct-approver rule to LOW/MEDIUM intents that
  carry an explicit approval record; the low-friction one-call `write` path (no
  approval record) is unaffected.
- Execution is a single idempotent `WhmcsClient.mutate(action, params)` reached
  ONLY when the execution gate returns `allowed:true`. Never broad; never implied
  by mode alone.

## 5. Idempotency keys

Deterministic key per intent: `sha256(consumer_id | action | scope | naturalKey |
windowBucket)` (`src/write/idempotency.ts`). `scope` is in the material because
two scopes can map to one WHMCS action (`service:price_restore` and
`service:domain_rename` → `UpdateClientProduct`); without it they would collide.
A windowed ledger dedupes within the window.

**Durability (precise):** in a single process the ledger caches `{key → result}`
and returns the full prior result on replay. The optional durable backing
(`MCP_WRITE_IDEMPOTENCY_PATH`) persists `{key, expiresAt}` plus a **redacted
`PersistedReplay` envelope** (`intent_id, action, scope, executed, verified, at`)
derived through a fixed field allowlist — it **never** persists `params`,
`would_call`, or any free-form/PII field. So after a restart a replayed key is
both *denied* (`idempotency_replay`) AND can recall the safe outcome summary, with
no sensitive data written to disk. High-risk actions (payments, refunds,
terminations) require a key and a short replay window.

## 6. Per-consumer write scopes + the tiered gate

`ConsumerProfile` carries `writeCapability ∈ {false|disabled, draft_only,
approval_required, execution_allowed}` and `allowedWriteScopes: WriteScope[]`
(`src/governance/types.ts`, `consumers.ts`). A draft is permitted only if the
scope ∈ the consumer's `allowedWriteScopes` and `writeCapability` is not
off/draft-only as appropriate. Execution additionally requires
`writeCapability='execution_allowed'`.

The execution gate (`src/write/executionGate.ts`, first-failing-gate-wins):

```
1. killSwitch on                     → kill_switch_engaged
2. mcpMode==='read_only'             → read_only_mode
3. state!=='approved'                → intent_not_approved
4. consumer!=='execution_allowed'    → consumer_not_execution_allowed
5. idempotency replay                → idempotency_replay
6. action ∈ PROD_NEVER_EXECUTABLE
   or scope ∈ *_SCOPES               → action_permanently_blocked
7. allowlist (HIGH-RISK, scope ∈ strictScopes, or strictAllowlist):
     production : not in MCP_PROD_WRITE_AUTHORIZED → action_not_prod_authorized
     non-prod   : not in MCP_WRITE_EXECUTION_AUTHORIZED → action_not_runtime_authorized
8. risk==='high': no humanApproval   → human_approval_required
                  over caps (dflt 0) → amount_cap_exceeded
```

An allowlist entry authorizes by WHMCS **action** (broad — every scope mapping to
that action) OR by **scope** string (narrow — only that scope); this is how
sibling scopes sharing one action gate independently (`allowlistAuthorizes`).

> **Scope-timing note:** `allowedWriteScopes` is enforced at draft/validate time
> AND **re-checked at execute time** — `executeRun` re-asserts the consumer's
> current scope grant before the batch/single-call branch, so a scope revoked
> after approval (within the 15-minute TTL) blocks execution (`scope_not_allowed`)
> instead of mutating WHMCS.

## 7. WHMCS action allowlist per consumer / per environment

Two write-specific allowlists, separate from the read `READ_ALLOWLIST`:
`MCP_PROD_WRITE_AUTHORIZED` (production) and `MCP_WRITE_EXECUTION_AUTHORIZED`
(non-prod runtime). Both default empty. They gate HIGH-RISK scopes always, and
ALL scopes when `MCP_WRITE_STRICT_ALLOWLIST=true` or the scope is in
`MCP_WRITE_STRICT_SCOPES` (default `billing:invoice:create`). An action/scope
absent from the applicable allowlist is rejected at the gate. No global write
allowlist; entries are explicit action or scope strings.

## 8. Audit logging

Append-only audit record per state transition (`src/write/audit.ts`,
`AuditEvent`): `event, intent_id, consumer_id, scope, action, idempotency_key,
at, detail?`. Tokens/secrets/PII are never recorded (params are redacted upstream
and not copied into events). Optional durable JSONL backing
(`MCP_WRITE_AUDIT_PATH`) reloads on startup. At the production execution commit
point the log uses `appendDurable` — **persist-or-throw**, so an unauditable
production mutation fails CLOSED. Config fail-fast requires a durable audit path
whenever `MCP_PROD_WRITE_AUTHORIZED` is non-empty.

## 9. Post-action verification

After execute, the write-flow re-reads the affected entity and asserts the
projected effect / preconditions hold; the result is surfaced as
`execution.verified`. Mismatch ⇒ `failed`, surfaced as a structured error + audit
entry; never silently trusted.

## 10. Duplicate prevention

(a) idempotency ledger (§5); (b) natural-key precondition checks at validate +
execute; (c) intent TTL (15 min) so stale drafts can't be replayed late.

## 11. Rollback / compensation

WHMCS has no general transaction rollback. Per action, document a compensating
action where one exists (unsuspend ↔ suspend; credit note for an erroneous
invoice on WHMCS 9; note edits are additive — annotate, no destructive rollback).
Where no safe compensation exists (payments/terminations), require human approval
+ post-verify + a manual runbook; do not auto-retry. Destructive actions are
additionally hard-blocked by `PROD_NEVER_EXECUTABLE` /
`PROD_NEVER_EXECUTABLE_SCOPES` and can never execute in production even if
mistakenly allowlisted.

## 12. Production *ungating* order (lowest blast radius first)

The full scope catalogue (`WRITE_SCOPES`, 40+ scopes across Tracks C/C2) is
**built and sealed**. This list is therefore the order in which production
authorization should be *granted*, not the order in which code is written:

1. `client_note:write` — additive, no financial/state impact.
2. `ticket:create` — additive; dedupe by subject+client window.
3. `ticket:reply` / `ticket:note` — additive to an existing thread.
4. `ticket:status` — small reversible state change.
5. **Billing writes** (invoice/credit/quote) — only after 1–4 are proven on real
   production data; WHMCS-9 immutable-invoice + credit/debit-note semantics
   mandatory.
6. **Service / domain / payment writes** — last; highest risk; per-action human
   approval + caps + post-verify + compensation runbook required. Money/
   destructive shapes should be capability-probed on a dev WHMCS first (see
   `docs/runbooks/write-capability-probe.md`).

Today, **zero** production actions are ungated; the active recommendation
(`docs/design/controlled-writes-phase-i.md`) is NO-GO pending a Phase H.1
authoritative-projection re-pilot, after which `client_note:write` alone is the
first candidate.

## 13. Complexity ledger — what is deliberate vs. what to watch

Recorded so future reviewers don't re-litigate settled tradeoffs, and so genuine
debt is tracked:

- **Deliberate (do not "simplify" away):** tiered-friction (decisions.md
  2026-06-03); the dual `PROD_NEVER_EXECUTABLE` action-set *and* scope-set
  (needed because scopes share actions); action-OR-scope allowlist grants;
  `scope` in the idempotency material; in-memory `IntentStore` (re-drafted on
  loss); building all scopes sealed rather than one at a time (each is TDD'd and
  prod-sealed).
- **Shipped hardening (closed):** (a) separation-of-duties on approval — HIGH-RISK
  self-approval blocked (`self_approval_forbidden`), identity-bound
  `approver_consumer_id`, `MCP_WRITE_REQUIRE_DISTINCT_APPROVER` (§4); (b) durable
  redacted idempotency replay envelope, no PII on disk (§5); (c) `allowedWriteScopes`
  re-checked at execute (`scope_not_allowed`, §6).
- **Watch / candidate hardening (tracked, not closed here):** (d) legacy
  `ExecutionDeniedReason` members (`production_execution_forbidden`,
  `action_not_low_risk_executable`) are retained but no longer emitted — prune
  when safe; (e) `MCP_WRITE_STRICT_SCOPES` ships with a non-empty default
  (`billing:invoice:create`) — a hidden default worth surfacing in operator docs.
- **Out of scope for this document:** wiring any new prod-write path. Each
  production ungating is a separate, reviewed, TDD, explicitly-authorized change.
