# WHMCS MCP — `service:price_restore` Write Scope (Design)

- **Date:** 2026-05-20
- **Status:** Approved by user (brainstorming round complete) — implementation plan pending
- **Branch:** to be created (`feat/service-price-restore`) when build is authorized
- **Scope boundary:** WHMCS-only. Adds a single new high-risk write scope to the merged risk-tiered authorizer. Production stays sealed by default.

## 1. Goal

Add a narrow, governed, audited, fail-closed path for restoring a WHMCS service's
recurring price via `UpdateClientProduct`, integrated with the just-merged
deny-by-default risk-tiered authorizer (PR #17) and intent→WHMCS param mapper
(PR #20). Designed around the immediate operational need to undo the 2026-04-12
manual price increase on client-50 VPS L SSD services (svc 555/569/586:
₹31,350/qtr → ₹45,000/qtr) without manual WHMCS admin edits, and as a reusable
governed restore path for the future.

**Keystone safety invariant** (unchanged): with no new env configured, production
remains byte-identical-sealed. Adding this scope does not relax the keystone.

## 2. Locked decisions (from brainstorming round)

| # | Decision | Source |
|---|---|---|
| 1 | New scope `service:price_restore` (9th in `WRITE_SCOPES`) | user directive |
| 2 | Backend action: `UpdateClientProduct`. **Narrow output** strictly limited to `{serviceid, <recurring-field>}` | user directive |
| 3 | `expected_old_amount` precondition is **optional**; when provided, must match current state or Phase 1 aborts | user directive |
| 4 | Risk tier: **high** (financial state change) | user directive |
| 5 | Intent shape: **batch** — `params.targets: [{serviceid, new_amount, expected_old_amount?}, ...]`, one approval per batch | AskUserQuestion (batch) |
| 6 | Execution model: **Phase 1 (read-only snapshot) always**; optional `dry_run` opt-in stops at Phase 1; else **Phase 2 fail-fast** with per-target idempotency | AskUserQuestion (Combine) |
| 7 | Cap interpretation: **per-action cap = max |new−old| delta magnitude per target; daily cap = sum of executed per-target deltas today** (reuses existing `MCP_PROD_HIGH_RISK_PER_ACTION_CAP` + `MCP_PROD_HIGH_RISK_DAILY_CAP`; no new env) | AskUserQuestion (recommended) |
| 8 | Architecture: **A2 — minimal + scope-output assertion** at the mutation boundary in writeFlow.ts (defense in depth against future scopes piggybacking on the `UpdateClientProduct` action allowlist) | AskUserQuestion (A2) |
| 9 | Merge requires PR review (same pattern as PR #17/#20/#19/#21). Prod canary application = explicit separate operator decision. | user directive |

## 3. Architecture

`draft → validate → approve → execute(LIVE, two-phase)`

```
PHASE 1 — always; read-only; pure precondition check
   ─ for each target ∈ params.targets:
       ─ whmcsClient.read('GetClientsProducts', { serviceid: target.serviceid })
       ─ assert service exists, not Terminated/Cancelled
       ─ if target.expected_old_amount provided: assert it matches current
   ─ if any precondition fails → return execution_blocked
       reason: precondition_mismatch, detail: { failedTargets: [...] }
       NO mutation performed; NO idempotency consumed.

(if intent.params.dry_run === true)
   ─ return phase_1 snapshots as preview; audit "dry_run_completed"; exit.

PHASE 2 — sequential per-target mutation; fail-fast; per-target idempotency
   ─ for each target (in order):
       ─ delta = |target.new_amount − snapshot.current_amount|
       ─ per-target authorizer-equivalent check:
            delta ≤ MCP_PROD_HIGH_RISK_PER_ACTION_CAP
            (dayTotal + delta) ≤ MCP_PROD_HIGH_RISK_DAILY_CAP
            if cap violation → halt with target_amount_cap_exceeded;
            audit, return (later targets untouched)
       ─ per-target idempotency key:
            sha256(intent.idempotency_key + '|' + target.serviceid)
         if ledger.seen(perTargetKey) → audit "replay_skipped", continue
       ─ scope-output assertion:
            mapped = intentToWhmcsParams('service:price_restore', { target }, ctx)
            assert Object.keys(mapped) ⊂ { 'serviceid', <recurring-field-name> }
            else → halt target_output_assertion_failed
       ─ audit.appendDurable("executing target N") — fail-closed
       ─ ledger.record(perTargetKey)
       ─ whmcs.mutate('UpdateClientProduct', mapped)
       ─ read-back: GetClientsProducts(serviceid) — verify recurring matches
       ─ audit per-target outcome (verified | executed | failed)
       ─ on failure → halt; audit halt_after_target N; later targets untouched.
   ─ accumulate executed deltas into the day tally for future intents.

return per-target outcomes (status, old, new) + phase summaries
```

**The existing authorizer wraps the whole intent** with the standard gates (kill
switch → read_only → approved → execution_allowed consumer → idempotency
replay → PROD_NEVER_EXECUTABLE → per-env allowlist → high-risk: human approval
+ batch-level caps). The high-risk amountContext at batch level is interpreted
as `amount = max(per-target |new−old| in the batch)`, `dayTotal = running sum
of executed deltas today`. Per-target caps are checked again inside Phase 2.

**Mapper architecture note.** The merged paramMapping module is
one-intent-to-one-WHMCS-call. This scope's batch semantics require an
execute-side loop that calls the per-target mapper N times. The mapper itself
stays pure and per-target (`mapServicePriceRestoreParams(target)`); the loop
lives in writeFlow.ts. Generalizing the mapper to return `Array<{action,
params, key}>` is **deferred** until a second batch scope appears (YAGNI).

## 4. Components

| File | Change | Approx. size |
|---|---|---|
| `src/write/types.ts` | Add `'service:price_restore'` to `WRITE_SCOPES`. `SCOPE_ACTION` maps to `'UpdateClientProduct'`. `SCOPE_RISK` = `'high'`. Add new `ExecutionDeniedReason` members: `precondition_mismatch`, `halt_after_target`, `target_amount_cap_exceeded`, `target_output_assertion_failed`. | +10 LoC |
| `src/write/validation.ts` | Add `REQUIRED_PARAMS['service:price_restore'] = ['targets']`. Custom check: `targets` is non-empty array; each element has positive-int `serviceid` + positive-number `new_amount` + optional positive-number `expected_old_amount`. Optional intent-level `dry_run: boolean = false`. Surface mapping errors via existing `mapping_error` backstop. | +25 LoC |
| `src/write/paramMapping.ts` | Add 9th case `mapServicePriceRestoreParams(target) → { serviceid, <recurring-field>: new_amount }`. Pure per-target. Module-level constant `RECURRING_FIELD = 'recurringamount'` (or `'amount'`, pinned by the Spike). | +15 LoC |
| `src/tools/writeFlow.ts` | Special-case execute branch for `intent.scope === 'service:price_restore'`: new helper `executePriceRestoreBatch(intent, whmcs, audit, ledger, dayAmounts)` implementing Phase 1, optional dry_run early-exit, Phase 2 loop with per-target idempotency + scope-output assertion + per-target durable audit + read-back. | +120 LoC |
| `src/config.ts` | **No new env.** Reuses `MCP_PROD_WRITE_AUTHORIZED` (gets `UpdateClientProduct`), `MCP_PROD_HIGH_RISK_PER_ACTION_CAP`, `MCP_PROD_HIGH_RISK_DAILY_CAP`. Zero schema surface change. | 0 LoC |
| **NEW** `tests/write/priceRestore.test.ts` | Mapper unit + validation + scope-output assertion truth table | ~200 LoC |
| **NEW** `tests/tools/writeFlow.priceRestore.test.ts` | End-to-end batch flow with mocked `whmcs.read`/`mutate` | ~150 LoC |
| `docs/superpowers/specs/2026-05-19-whmcs-prod-write-RUNBOOK.md` | New §6 "Price restore operations" with env table, dry-run preview pattern, and the client-50 worked example | +40 LoC |
| **NEW** `scripts/price-restore-spike.ts` | Read-only dev probe to confirm canonical recurring-amount param name (`amount` vs `recurringamount`) on dev WHMCS9. **Run before build.** | ~30 LoC |

## 5. Data flow / intent shapes

**Draft input** (operator submits via `draft_write_intent`):

```jsonc
{
  "scope": "service:price_restore",
  "params": {
    "targets": [
      { "serviceid": 555, "new_amount": 31350, "expected_old_amount": 45000 },
      { "serviceid": 569, "new_amount": 31350, "expected_old_amount": 45000 },
      { "serviceid": 586, "new_amount": 31350, "expected_old_amount": 45000 }
    ],
    "dry_run": false
  },
  "naturalKey": "client50-vps-l-ssd-restore-q1-2026",
  "projected_effect": "Restore client-50 VPS L SSD svc 555/569/586 recurring ₹45,000→₹31,350/qtr"
}
```

**`would_call.whmcs_params`** (computed at draft via the mapper; surfaces the per-target call shapes for operator preview):

```jsonc
[
  { "action": "UpdateClientProduct", "params": { "serviceid": 555, "recurringamount": 31350 } },
  { "action": "UpdateClientProduct", "params": { "serviceid": 569, "recurringamount": 31350 } },
  { "action": "UpdateClientProduct", "params": { "serviceid": 586, "recurringamount": 31350 } }
]
```

**Execute result** (post-Phase-2):

```jsonc
{
  "executed": true,
  "execution": {
    "attempted": true,
    "phase_1": {
      "snapshots": [
        { "serviceid": 555, "current_amount": 45000 },
        { "serviceid": 569, "current_amount": 45000 },
        { "serviceid": 586, "current_amount": 45000 }
      ],
      "ok": true
    },
    "phase_2": {
      "outcomes": [
        { "serviceid": 555, "status": "verified", "old": 45000, "new": 31350, "delta": 13650 },
        { "serviceid": 569, "status": "verified", "old": 45000, "new": 31350, "delta": 13650 },
        { "serviceid": 586, "status": "verified", "old": 45000, "new": 31350, "delta": 13650 }
      ],
      "halted_after": null
    }
  }
}
```

## 6. Error handling

Additive `ExecutionDeniedReason` members:

| Reason | Cause | When emitted | State |
|---|---|---|---|
| `precondition_mismatch` | Phase 1 found drift vs `expected_old_amount`, or service doesn't exist / is terminated | After Phase 1 read of all targets | No mutation, no idempotency consumed |
| `target_amount_cap_exceeded` | A target's per-action delta exceeds cap, OR daily cumulative would exceed daily cap | Before attempting that target in Phase 2 | Earlier targets preserved; later targets untouched |
| `target_output_assertion_failed` | Mapper produced output keys outside the strict whitelist `{serviceid, <recurring-field>}` — defense-in-depth backstop | Before whmcs.mutate of the offending target | Hard halt; should never fire normally; alert |
| `halt_after_target` | Phase 2 mutate succeeded for some targets, then whmcs.mutate failed | After per-target outcome audit | Audited per-target; operator re-submits remainder; per-target idempotency makes succeeded targets no-ops on resubmit |

Existing reasons still apply: `kill_switch_engaged`, `read_only_mode`,
`intent_not_approved`, `consumer_not_execution_allowed`, `idempotency_replay`
(at the batch level), `action_permanently_blocked`, `action_not_prod_authorized`,
`action_not_runtime_authorized`, `human_approval_required`, `amount_cap_exceeded`
(at the batch level via the existing high-risk path), `audit_write_failed`.

**Fail-closed durable audit** at each Phase 2 step (mirrors the merged
framework): if durable audit can't be written for the "executing target N"
event, execution refuses and reports `audit_write_failed`. No unauditable
production mutation can occur.

## 7. Testing

**Spike (do FIRST, blocking; read-only):** `scripts/price-restore-spike.ts`
runs a no-op `UpdateClientProduct` against dev WHMCS9 (localhost:8890) using
`.env.local` creds to confirm whether the canonical parameter name for setting
the recurring price is `recurringamount` or `amount`. Pins the module-level
constant in `paramMapping.ts`. Without this confirmed, the mapper can't be
correctly authored. **No build agent dispatch before the Spike returns.**

**Unit tests** (in `tests/write/priceRestore.test.ts`):

- Keystone preserved (no env ⇒ prod sealed, even with this scope present in `WRITE_SCOPES`).
- Validation rejects empty targets[]; missing serviceid; non-positive new_amount; non-array targets; non-positive expected_old_amount.
- Mapper output for one target = exactly 2 keys (`serviceid`, recurring-field), nothing else.
- Scope-output assertion catches an intentionally-leaky mapper output (regression test against a future bug).
- Per-target idempotency: same `(intent.idempotency_key, serviceid)` → ledger hit → skip; different serviceid → different key.

**Integration tests** (in `tests/tools/writeFlow.priceRestore.test.ts`, with mocked `whmcs.read`/`whmcs.mutate`):

- High-risk authorizer rejects without human approval; rejects with caps=0 default; allows with caps set + approval + within bounds.
- Phase 1 precondition fail → no mutation, audit `precondition_mismatch`.
- `dry_run=true` → Phase 1 only, returns preview, audit "dry_run_completed", `whmcs.mutate` NEVER called.
- Phase 2 mid-batch failure → halt-after-target N, audit per-target outcomes, no later mutations.
- Per-target cap violation in Phase 2 → halt before that target; earlier targets preserved.
- Daily cap accumulates across multiple batches in the same UTC day.
- Re-submitting the same intent → ledger sees all per-target keys → all targets become no-ops; `whmcs.mutate` not called again.

**Live dev proof** (after Spike + unit/integration tests green; analogous to
`scripts/track-e-proof.ts`): `scripts/price-restore-dev-proof.ts` exercises the
full draft → validate → approve → execute against dev WHMCS9 on a benign
throwaway service (NOT client 50). First runs with `dry_run=true` (preview),
then runs for real with a tiny delta. Confirms WHMCS actually mutates
`tblhosting.amount` via a fresh `GetClientsProducts` read-back.

## 8. Rollout

**This PR ships the capability with production fully sealed by default.**
Activating it on production is a **separate, explicit operator decision** —
the merge of this PR alone changes no production behaviour.

**Build path** (after spec approval, awaiting separate build authorization):

1. Run Spike (read-only on dev). Pin recurring-amount field name.
2. Branch `feat/service-price-restore` from `main`.
3. Implement per §4 — unit + integration tests green.
4. Live dev proof script — passes on dev WHMCS9.
5. Open PR; reviewed via the same automated-review-then-merge pattern as PR #17/#20/#19/#21.

**Production activation** (operator action; NOT part of this PR's autonomous flow):

1. `MCP_PROD_WRITE_AUTHORIZED=UpdateClientProduct`
2. `MCP_PROD_HIGH_RISK_PER_ACTION_CAP=20000` (comfortably > ₹13,650 delta, well under any catastrophic value)
3. `MCP_PROD_HIGH_RISK_DAILY_CAP=50000` (bounds 3-service restore @ ₹40,950 sum)
4. Add a Cowork consumer to `MCP_CONSUMER_REGISTRY` with `writeCapability='execution_allowed'` + `allowedWriteScopes=['service:price_restore']`.
5. Draft the client-50 batch intent with `expected_old_amount=45000` per target.
6. Execute with `dry_run=true` first; review preview.
7. Approve via `approve_write_intent` with a real human approver identity; execute (real).
8. After completion, clear `MCP_PROD_WRITE_AUTHORIZED` and caps to re-seal.

`MCP_WRITE_KILL_SWITCH=1` re-seals everything instantly at any point.

## 9. Risks

- **Spike outcome uncertainty.** If `UpdateClientProduct` doesn't accept either
  `recurringamount` or `amount` as a recurring-price setter on this WHMCS
  version, the entire approach is moot and we fall back to manual WHMCS admin
  edits (which is also the today behaviour). Mitigation: run the Spike first.
- **Per-target idempotency window.** The existing `IdempotencyLedger` window
  defaults to 5 min; same per-target key 5 min later is no longer caught.
  Acceptable for restore operations (operator-driven, not auto-retried at
  scale). Documented behaviour.
- **Daily-cap day-boundary.** `dayAmounts` Map keyed by UTC date string; a
  restore spanning a UTC midnight could see daily-cap accounting reset mid-batch
  (target 1 in day N, target 2 in day N+1 would both contribute to a fresh
  dayTotal). For batches of practical size this is unlikely to matter, but
  documented.
- **`UpdateClientProduct` is over-powered.** This action can do many things
  (status change, billing cycle, etc.). Defenses against future-scope
  piggybacking: scope-output assertion (this PR); `PROD_NEVER_EXECUTABLE`
  could include destructive `domainstatus=Terminated` field equivalents in
  future if any scope ever exposes them; PR review on any future scope adding.
- **Read-back can stale-cache.** If WHMCS caches `GetClientsProducts` aggressively
  during write+read sequences, read-back could return stale data. Observed
  behaviour: WHMCS reflects writes immediately on `GetClientsProducts`. If a
  flake is seen, treat `verified=false` as a soft flag (mutation succeeded;
  verification couldn't immediately confirm) — matches the Track-E pattern.

## 10. Out of scope (YAGNI)

- Generalizing the mapper to return `Array<{action, params, key}>` (deferred
  until a second batch scope appears).
- A `MCP_PROD_SCOPES_AUTHORIZED` scope-level allowlist (the A3 option not chosen).
- New env vars (none added).
- Rollback-via-compensating-mutation semantics (explicitly rejected during
  brainstorming — wrong for restore use case).
- Other `UpdateClientProduct`-backed scopes (e.g. `service:status_change`,
  `service:billing_cycle_change`). Each future scope is a separate brainstorm + PR.
- Multi-currency caps (caps are interpreted in the service's billing currency;
  no currency conversion).
