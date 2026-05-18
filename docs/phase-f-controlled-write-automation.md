# Phase F — Controlled Write Automation (DESIGN ONLY)

> **Status: design stub. NOT implemented. No code, no production write path,
> no mutation tools exist or are enabled by this document.** Production
> remains read-only. Phase F is gated on explicit review + approval before
> any implementation begins.

## 0. Principles

- Default-deny. Writes are off until a specific consumer, scope, action, and
  approval all line up.
- Reuse, don't fork: build on the existing capability registry, consumer
  registry, projection boundary, and the verified two-layer read-only block.
- Every write is **draft → validate → approve → execute → verify**, idempotent,
  audited, and reversible-or-compensatable.
- The existing `whmcs.mutate()` `MODE_RESTRICTED` guard stays; Phase F adds a
  *narrow, per-action, per-consumer* authorized path — never a global switch.

## 1. Write intent object

A pure, non-executing description of a proposed mutation:

```
WriteIntent {
  intent_id            // uuid
  consumer_id          // resolved registered consumer (never token)
  action               // WHMCS action, e.g. "AddClientNote"
  scope                // e.g. "client_note:write"
  params               // validated, projected (no secrets echoed)
  idempotency_key      // deterministic: sha256(consumer_id+action+natural_key+window)
  preconditions        // read-derived expectations (e.g. ticket status == Open)
  projected_effect     // human + structured summary of what will change
  created_at, expires_at
  state                // draft | validated | approved | executed | verified | rejected | failed
}
```

Stored server-side (short TTL). Never auto-advances state.

## 2. Draft-only tools

`draft_<action>` tools produce a `WriteIntent` (state=`draft`) and **call no
mutating API**. They may do read calls to compute preconditions/effect.
Output is the intent + projected effect under the consumer's contract.

## 3. Validate-only tools

`validate_intent(intent_id)`: schema + business-rule + capability + consumer
scope + precondition re-check (re-read current WHMCS state) + WHMCS-9 rules
(immutable non-draft invoices ⇒ credit/debit note path) + idempotency-key
collision check. No mutation. Sets `validated` or `rejected(reason[])`.

## 4. Approval-required execution

- Execution requires `state=validated` **and** an explicit approval:
  - human approval (out-of-band) or
  - a consumer whose profile grants `writeCapability ∈ {approval_required→approved, draft_only(stops here), false/disabled(never)}`.
- Approval records `approver`, `consumer_id`, `intent_id`, timestamp, decision.
- Execution is a single idempotent `whmcs.mutate(action, params)` **only** when
  an explicit per-action prod-write authorization is present for that scope.
  Never broad; never implied by mode alone.

## 5. Idempotency keys

Deterministic key per intent; an in-store ledger of `{key → result}` with a
window. Re-execute with the same key ⇒ return the cached prior result, never a
second mutation. High-risk actions (payments, refunds, terminations) require a
key and a short replay window.

## 6. Per-consumer write scopes

`ConsumerProfile` already carries `writeCapability` (currently inert) and
`allowedActions`. Phase F adds `allowedWriteScopes: string[]` (e.g.
`["client_note:write","ticket:create"]`). A write is permitted only if the
action's scope ∈ profile scopes **and** `writeCapability` allows it **and**
the per-action prod-write authorization is enabled.

## 7. WHMCS action allowlist per consumer

A second, **write-specific** allowlist (separate from the read
`READ_ALLOWLIST`), keyed per consumer profile. Default empty. An action absent
from a consumer's write allowlist is rejected at validate time. No global
write allowlist; no broad expansion.

## 8. Audit logging

Append-only audit record per state transition: `intent_id, consumer_id,
action, scope, idempotency_key, decision, actor, before-hash, after-hash,
timestamp`. Tokens never logged. Redaction via the existing projection rules.
Auditable independent of WHMCS admin accounts.

## 9. Post-action verification

After execute, re-read the affected entity and assert the
`projected_effect`/preconditions hold (e.g. note present, ticket status moved).
Mismatch ⇒ `failed`, surfaced as a structured error + audit entry; never
silently trusted.

## 10. Duplicate prevention

(a) idempotency ledger (§5); (b) natural-key precondition checks at validate +
execute (e.g. don't open a second ticket with identical subject+client within
window); (c) intent TTL so stale drafts can't be replayed late.

## 11. Rollback / compensation

WHMCS has no general transaction rollback. Per action document a
**compensating action** where one exists (e.g. unsuspend ↔ suspend; credit
note for an erroneous invoice on WHMCS 9). Where no safe compensation exists
(payments/terminations), require human approval + post-verify + manual runbook;
do not auto-retry.

## 12. Recommended write rollout order (lowest blast radius first)

1. `add_client_note` — additive, no financial/state impact, easily ignored.
2. `create_ticket` — additive; dedupe by subject+client window.
3. `reply_ticket` — additive to an existing thread; ownership-checked.
4. `update_ticket_status` — small reversible state change.
5. **Billing writes** (invoices/credit notes) — only after 1–4 are proven;
   WHMCS-9 immutable-invoice + credit/debit-note semantics mandatory.
6. **Service / domain / payment writes** — last; highest risk; per-action
   human approval + idempotency + post-verify + compensation runbook required.

## 13. Out of scope for this document

No implementation, no tool registration, no schema code, no enabling of any
prod-write path. Each step above becomes its own reviewed, TDD, separately
approved change when Phase F is explicitly authorized.
