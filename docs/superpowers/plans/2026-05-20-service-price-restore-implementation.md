# `service:price_restore` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a narrow, high-risk WHMCS MCP write scope `service:price_restore` that restores service `recurringamount` via `UpdateClientProduct`, integrated with the merged risk-tiered authorizer + param mapper. Production stays sealed by default.

**Architecture:** New `service:price_restore` write scope (9th in `WRITE_SCOPES`) → `UpdateClientProduct`, risk `high`. **Batch intent** (`params.targets: [{serviceid, new_amount, expected_old_amount?}, ...]`, optional `dry_run`). Execute: **Phase 1** read-only snapshot + precondition check (always); optional dry-run early-exit; **Phase 2** sequential per-target mutate with per-target idempotency, fail-fast, per-target durable audit, read-back verify. Caps reinterpreted: per-action = max `|new−old|` delta magnitude; daily = sum of executed deltas. Defense-in-depth scope-output assertion at the mutation boundary.

**Tech Stack:** TypeScript, Vitest, Zod, MCP SDK (already pinned). No new deps. No new env vars (reuses `MCP_PROD_WRITE_AUTHORIZED`, `MCP_PROD_HIGH_RISK_PER_ACTION_CAP`, `MCP_PROD_HIGH_RISK_DAILY_CAP`).

**Spec:** `docs/superpowers/specs/2026-05-20-service-price-restore-design.md` (committed locally as `efe92dd`).

---

## File structure

| File | Responsibility |
|---|---|
| `src/write/types.ts` | Frozen-seam additions: scope entry in `WRITE_SCOPES`/`SCOPE_ACTION`/`SCOPE_RISK`; 4 new `ExecutionDeniedReason` members. ~10 LoC delta. |
| `src/write/validation.ts` | `REQUIRED_PARAMS['service:price_restore'] = ['targets']` + custom batch-shape check. ~25 LoC delta. |
| `src/write/paramMapping.ts` | Module-level `RECURRING_FIELD` constant (pinned by Spike); new exported per-target mapper `mapServicePriceRestoreTarget`; dispatcher case that throws (defensive — batch scope). ~25 LoC delta. |
| `src/tools/writeFlow.ts` | New helper `executePriceRestoreBatch` (~120 LoC); execute-handler branch on `scope === 'service:price_restore'`; `toToolResult` branch to compute per-target `whmcs_params` array for batch scopes; small scope-output assertion helper. ~150 LoC delta. |
| **NEW** `tests/write/priceRestoreMapping.test.ts` | Mapper + scope-output assertion truth table. ~100 LoC. |
| **NEW** `tests/write/priceRestoreValidation.test.ts` | Validation rejection/acceptance truth table. ~80 LoC. |
| **NEW** `tests/tools/writeFlow.priceRestore.test.ts` | End-to-end batch flow with mocked `whmcs.read`/`mutate` — Phase 1 abort, dry_run, Phase 2 fail-fast, per-target idempotency, daily cap accumulation, scope-output assertion. ~200 LoC. |
| `docs/superpowers/specs/2026-05-19-whmcs-prod-write-RUNBOOK.md` | Append §6 "Price restore operations" with env, dry-run pattern, client-50 worked example. ~40 LoC. |
| **NEW** `scripts/price-restore-spike.ts` | Read-only dev probe to pin canonical `recurringamount` vs `amount` param name. ~30 LoC. **Run BEFORE any code.** |
| **NEW** `scripts/price-restore-dev-proof.ts` | Live dev end-to-end proof on a benign throwaway service. ~120 LoC, mirrors `track-e-proof.ts` pattern. |

---

## Task 1: Spike — pin `UpdateClientProduct` recurring-amount param name

**Why first:** Without this, the mapper can't be authored correctly. Read-only probe; no mutation.

**Files:**
- Create: `scripts/price-restore-spike.ts`

- [ ] **Step 1.1: Write the spike script**

`scripts/price-restore-spike.ts`:

```typescript
/* eslint-disable no-console -- one-off CLI probe; stdout IS the output */
/**
 * SPIKE — dev WHMCS9 only — probes UpdateClientProduct field-name shape.
 *
 * No mutation: we deliberately send an INVALID serviceid so WHMCS rejects
 * before mutating, but the error message reveals which param names it
 * recognises (`recurringamount` vs `amount`).
 *
 * Run:
 *   set -a; . ./.env.local; set +a
 *   npx tsx scripts/price-restore-spike.ts
 */
import { fileURLToPath } from 'node:url';

interface ProbeResult {
  field: 'recurringamount' | 'amount';
  message: string;
}

async function probe(field: 'recurringamount' | 'amount'): Promise<ProbeResult> {
  const url = process.env.WHMCS_API_URL ?? 'http://localhost:8890';
  const identifier = process.env.WHMCS_IDENTIFIER ?? '';
  const secret = process.env.WHMCS_SECRET ?? '';
  const body = new URLSearchParams({
    identifier,
    secret,
    action: 'UpdateClientProduct',
    responsetype: 'json',
    serviceid: '0', // invalid → WHMCS rejects without mutating
    [field]: '1.00',
  });
  const res = await fetch(`${url}/includes/api.php`, { method: 'POST', body });
  const text = await res.text();
  return { field, message: text.slice(0, 400) };
}

const r1 = await probe('recurringamount');
const r2 = await probe('amount');
console.log('=== UpdateClientProduct probe ===');
console.log('with recurringamount:', r1.message);
console.log('with amount:        :', r2.message);
console.log();
console.log('Interpretation:');
console.log('  "Invalid API Action" → action not exposed (escalate scope; abort plan)');
console.log('  "Service ID not found" / "Invalid serviceid" → field name is honored');
console.log('  "Missing required field <X>" → field <X> is the canonical recurring-amount key');
```

- [ ] **Step 1.2: Run the spike**

```bash
cd /Users/kritananda/Downloads/Projects/securiace-dev/whmcs-mcp-server
set -a; . ./.env.local; set +a
npx tsx scripts/price-restore-spike.ts
```

Expected: one of the two probes returns a "Service ID not found" / "Invalid serviceid" style error (the field name WHMCS recognised); the other may return an unrecognised-field error. The recognised one is **pinned** for the rest of the plan.

- [ ] **Step 1.3: Record the result + commit the spike**

Record the pinned field name in the commit message and in your working notes. If both probes return "Invalid API Action: updateclientproduct" — STOP and report; the action is not exposed on this WHMCS, and the entire plan needs re-evaluation.

```bash
git add scripts/price-restore-spike.ts
git commit -m "spike(write): probe canonical UpdateClientProduct recurring-amount param

Result: <recurringamount|amount> is the canonical field name (verified
via dev WHMCS9 read-only probe with deliberately invalid serviceid).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

> **For the remaining tasks below: substitute `<RECURRING_FIELD>` with whichever field name the Spike confirmed.** The plan uses `recurringamount` as the default; change the constant in Task 5 if the Spike pins `amount`.

---

## Task 2: Branch hygiene — move spec onto feature branch

**Files:**
- Move: `docs/superpowers/specs/2026-05-20-service-price-restore-design.md` (currently committed on local `main` as `efe92dd`; needs to live on the feature branch)

- [ ] **Step 2.1: Verify current state**

```bash
git log --oneline -3
# Expected:
# <spike-sha> spike(write): probe canonical UpdateClientProduct ...
# efe92dd     docs(spec): service:price_restore — new high-risk write scope design
# 7d66513     Merge pull request #21 ...
```

- [ ] **Step 2.2: Create the feature branch at current HEAD**

```bash
git branch feat/service-price-restore
```

This puts the new branch at `<spike-sha>`, preserving both the spec and the spike commits.

- [ ] **Step 2.3: Reset local main to origin/main (drop the divergent commits from main)**

```bash
git fetch origin -q
git checkout main
git reset --hard origin/main   # drops spec+spike from local main
git log --oneline -2
# Expected:
# 7d66513 Merge pull request #21 ...
# 56e5337 chore(types): lift inline tool handlers behind ToolCallback cast ...
```

- [ ] **Step 2.4: Switch to feature branch**

```bash
git checkout feat/service-price-restore
git log --oneline -3
# Expected: spike commit + spec commit + 7d66513 base
```

---

## Task 3: types.ts — add scope to frozen seam + new denial reasons (TDD)

**Files:**
- Create: `tests/write/priceRestoreTypes.test.ts`
- Modify: `src/write/types.ts` (3 small edits: `WRITE_SCOPES`, `SCOPE_ACTION`, `SCOPE_RISK`, `ExecutionDeniedReason`)

- [ ] **Step 3.1: Write the failing test**

`tests/write/priceRestoreTypes.test.ts`:

```typescript
/**
 * Frozen-seam additions for service:price_restore. Type-only assertions +
 * runtime presence checks.
 */
import { describe, it, expect } from 'vitest';
import {
  WRITE_SCOPES,
  SCOPE_ACTION,
  SCOPE_RISK,
  type ExecutionDeniedReason,
} from '../../src/write/types.js';

describe('service:price_restore frozen-seam additions', () => {
  it('is registered in WRITE_SCOPES', () => {
    expect(WRITE_SCOPES as readonly string[]).toContain('service:price_restore');
  });

  it('maps to UpdateClientProduct in SCOPE_ACTION', () => {
    expect(SCOPE_ACTION['service:price_restore']).toBe('UpdateClientProduct');
  });

  it('is high-risk in SCOPE_RISK', () => {
    expect(SCOPE_RISK['service:price_restore']).toBe('high');
  });

  it('declares new denied reasons in the type union', () => {
    const reasons: ExecutionDeniedReason[] = [
      'precondition_mismatch',
      'halt_after_target',
      'target_amount_cap_exceeded',
      'target_output_assertion_failed',
    ];
    expect(reasons).toHaveLength(4);
  });
});
```

- [ ] **Step 3.2: Run test to verify it fails**

```bash
npx vitest run tests/write/priceRestoreTypes.test.ts
```

Expected: 3 tests FAIL — `WRITE_SCOPES` doesn't contain the new entry; `SCOPE_ACTION`/`SCOPE_RISK` lookups return undefined. The 4th test will fail at compile-time (TS unknown literals).

- [ ] **Step 3.3: Implement — edit src/write/types.ts**

In the `WRITE_SCOPES` array (top of the scopes block), append:

```typescript
export const WRITE_SCOPES = [
  'client_note:write',
  'ticket:create',
  'ticket:reply',
  'ticket:status',
  'billing:invoice:create',
  'billing:payment:add',
  'billing:credit:add',
  'billing:refund:record',
  'service:price_restore',
] as const;
```

In `SCOPE_ACTION`, add:

```typescript
'service:price_restore': 'UpdateClientProduct',
```

In `SCOPE_RISK`, add:

```typescript
'service:price_restore': 'high',
```

In the `ExecutionDeniedReason` union, add the 4 new members (preserve existing members; keep alphabetical or grouped — match surrounding style):

```typescript
export type ExecutionDeniedReason =
  // ... existing members preserved verbatim ...
  | 'precondition_mismatch'
  | 'halt_after_target'
  | 'target_amount_cap_exceeded'
  | 'target_output_assertion_failed';
```

- [ ] **Step 3.4: Run test to verify it passes**

```bash
npx vitest run tests/write/priceRestoreTypes.test.ts
```

Expected: 4 tests PASS.

- [ ] **Step 3.5: Verify dispatcher exhaustiveness still compiles**

```bash
npx tsc --noEmit src/write/paramMapping.ts 2>&1 | head -5
```

Expected: TS error pointing at the `default` branch's `const _exhaustive: never = scope;` — because `'service:price_restore'` is now in the `WriteScope` union and unhandled. Confirmed ✓ — Task 5 will resolve it.

- [ ] **Step 3.6: Commit**

```bash
git add src/write/types.ts tests/write/priceRestoreTypes.test.ts
git commit -m "feat(write/types): add service:price_restore scope to frozen seam

WRITE_SCOPES + SCOPE_ACTION (→ UpdateClientProduct) + SCOPE_RISK (high)
+ 4 new ExecutionDeniedReason members. Mapper dispatcher will TS-error
on the new scope until Task 5 adds a case (deliberate exhaustiveness
trip).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: validation.ts — REQUIRED_PARAMS + custom batch-shape check (TDD)

**Files:**
- Create: `tests/write/priceRestoreValidation.test.ts`
- Modify: `src/write/validation.ts`

- [ ] **Step 4.1: Write the failing tests**

`tests/write/priceRestoreValidation.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { validateIntent } from '../../src/write/validation.js';
import { createDraftIntent } from '../../src/write/intents.js';
import type { WriteIntent } from '../../src/write/types.js';

function draft(params: Record<string, unknown>): WriteIntent {
  return createDraftIntent({
    consumer_id: 'c1',
    scope: 'service:price_restore',
    params,
    naturalKey: 'restore-test',
    preconditions: {},
    projected_effect: 'restore',
  });
}

describe('service:price_restore validation', () => {
  it('rejects when targets is missing', () => {
    const r = validateIntent(draft({}), {});
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'missing_required_param')).toBe(true);
  });

  it('rejects when targets is not an array', () => {
    const r = validateIntent(draft({ targets: 'oops' }), {});
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'invalid_targets_shape')).toBe(true);
  });

  it('rejects when targets is empty', () => {
    const r = validateIntent(draft({ targets: [] }), {});
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'invalid_targets_shape')).toBe(true);
  });

  it('rejects when a target is missing serviceid', () => {
    const r = validateIntent(draft({ targets: [{ new_amount: 100 }] }), {});
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'invalid_target_entry')).toBe(true);
  });

  it('rejects when a target has non-positive serviceid', () => {
    const r = validateIntent(draft({ targets: [{ serviceid: 0, new_amount: 100 }] }), {});
    expect(r.ok).toBe(false);
  });

  it('rejects when new_amount is non-positive', () => {
    const r = validateIntent(draft({ targets: [{ serviceid: 1, new_amount: 0 }] }), {});
    expect(r.ok).toBe(false);
  });

  it('rejects when expected_old_amount is non-positive', () => {
    const r = validateIntent(
      draft({ targets: [{ serviceid: 1, new_amount: 100, expected_old_amount: -1 }] }),
      {}
    );
    expect(r.ok).toBe(false);
  });

  it('rejects when dry_run is not a boolean', () => {
    const r = validateIntent(
      draft({ targets: [{ serviceid: 1, new_amount: 100 }], dry_run: 'yes' }),
      {}
    );
    expect(r.ok).toBe(false);
  });

  it('accepts a minimal valid batch (no expected_old_amount, no dry_run)', () => {
    const r = validateIntent(draft({ targets: [{ serviceid: 1, new_amount: 100 }] }), {});
    expect(r.ok).toBe(true);
  });

  it('accepts a valid batch with expected_old_amount and dry_run=true', () => {
    const r = validateIntent(
      draft({
        targets: [{ serviceid: 1, new_amount: 100, expected_old_amount: 200 }],
        dry_run: true,
      }),
      {}
    );
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 4.2: Run tests to verify they fail**

```bash
npx vitest run tests/write/priceRestoreValidation.test.ts
```

Expected: 10 tests FAIL (REQUIRED_PARAMS entry missing; custom checks absent).

- [ ] **Step 4.3: Implement — edit src/write/validation.ts**

In `REQUIRED_PARAMS`, add:

```typescript
'service:price_restore': ['targets'],
```

After the existing custom-validation blocks (e.g., after the `ticket:status` enum check and the `billing:refund:record` `refund_type` enum check), append the new batch-shape check. **Insertion point:** before the final `return { ok, issues, compat_warnings };` return statement. Copy in:

```typescript
// service:price_restore — batch-shape: targets is a non-empty array of
// { serviceid:int>0, new_amount:number>0, expected_old_amount?:number>0 };
// optional intent-level dry_run:boolean.
if (intent.scope === 'service:price_restore') {
  const targets = intent.params.targets;
  if (!Array.isArray(targets) || targets.length === 0) {
    issues.push({
      code: 'invalid_targets_shape',
      severity: 'error',
      message: 'service:price_restore requires a non-empty `targets` array',
    });
  } else {
    targets.forEach((t, i) => {
      if (!isPlainObject(t)) {
        issues.push({
          code: 'invalid_target_entry',
          severity: 'error',
          message: `targets[${String(i)}] must be an object`,
        });
        return;
      }
      const sid = t.serviceid;
      const na = t.new_amount;
      const eoa = t.expected_old_amount;
      if (typeof sid !== 'number' || !Number.isInteger(sid) || sid <= 0) {
        issues.push({
          code: 'invalid_target_entry',
          severity: 'error',
          message: `targets[${String(i)}].serviceid must be a positive integer`,
        });
      }
      if (typeof na !== 'number' || !Number.isFinite(na) || na <= 0) {
        issues.push({
          code: 'invalid_target_entry',
          severity: 'error',
          message: `targets[${String(i)}].new_amount must be a positive number`,
        });
      }
      if (eoa !== undefined) {
        if (typeof eoa !== 'number' || !Number.isFinite(eoa) || eoa <= 0) {
          issues.push({
            code: 'invalid_target_entry',
            severity: 'error',
            message: `targets[${String(i)}].expected_old_amount must be a positive number when provided`,
          });
        }
      }
    });
  }
  if (intent.params.dry_run !== undefined && typeof intent.params.dry_run !== 'boolean') {
    issues.push({
      code: 'invalid_dry_run',
      severity: 'error',
      message: 'service:price_restore `dry_run` must be a boolean when provided',
    });
  }
}
```

- [ ] **Step 4.4: Run tests to verify they pass**

```bash
npx vitest run tests/write/priceRestoreValidation.test.ts
```

Expected: 10 tests PASS.

- [ ] **Step 4.5: Run the full write-suite to confirm no regression**

```bash
npx vitest run tests/write/
```

Expected: all previously-passing write tests still green; +10 new tests; 0 failed.

- [ ] **Step 4.6: Commit**

```bash
git add src/write/validation.ts tests/write/priceRestoreValidation.test.ts
git commit -m "feat(write/validation): batch-shape check for service:price_restore

REQUIRED_PARAMS entry + custom validator: targets[] non-empty;
per-target serviceid:int>0, new_amount>0, expected_old_amount?:>0;
optional intent-level dry_run:boolean.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: paramMapping.ts — per-target mapper + dispatcher defensive case (TDD)

**Files:**
- Create: `tests/write/priceRestoreMapping.test.ts`
- Modify: `src/write/paramMapping.ts`

- [ ] **Step 5.1: Write the failing tests**

`tests/write/priceRestoreMapping.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  intentToWhmcsParams,
  mapServicePriceRestoreTarget,
  PRICE_RESTORE_RECURRING_FIELD,
} from '../../src/write/paramMapping.js';

describe('mapServicePriceRestoreTarget', () => {
  it('returns exactly { serviceid, <recurring-field>: new_amount }', () => {
    const out = mapServicePriceRestoreTarget({ serviceid: 555, new_amount: 31350 });
    expect(Object.keys(out).sort()).toEqual(['serviceid', PRICE_RESTORE_RECURRING_FIELD].sort());
    expect(out.serviceid).toBe(555);
    expect(out[PRICE_RESTORE_RECURRING_FIELD]).toBe(31350);
  });

  it('ignores extra fields on the target input (defense in depth)', () => {
    const out = mapServicePriceRestoreTarget({
      serviceid: 555,
      new_amount: 31350,
      // The validator forbids these, but the mapper must also drop them:
      domainstatus: 'Terminated',
      paymentmethod: 'evil',
      billingcycle: 'Annually',
    } as never);
    expect(Object.keys(out).sort()).toEqual(['serviceid', PRICE_RESTORE_RECURRING_FIELD].sort());
  });

  it('passes serviceid and new_amount through without coercion', () => {
    const out = mapServicePriceRestoreTarget({ serviceid: 1, new_amount: 0.01 });
    expect(out.serviceid).toBe(1);
    expect(out[PRICE_RESTORE_RECURRING_FIELD]).toBe(0.01);
  });
});

describe('intentToWhmcsParams dispatcher: service:price_restore defensive case', () => {
  it('throws — the dispatcher does not support batch scopes', () => {
    expect(() =>
      intentToWhmcsParams('service:price_restore', { targets: [{ serviceid: 1, new_amount: 100 }] })
    ).toThrow(/batch.*mapServicePriceRestoreTarget/i);
  });
});
```

- [ ] **Step 5.2: Run tests to verify they fail**

```bash
npx vitest run tests/write/priceRestoreMapping.test.ts
```

Expected: tests FAIL — `mapServicePriceRestoreTarget` is not exported; `PRICE_RESTORE_RECURRING_FIELD` constant doesn't exist; dispatcher hits the default branch (which today returns `{ ...params }`, not throws).

- [ ] **Step 5.3: Implement — edit src/write/paramMapping.ts**

Near the top of the helpers section, add a module-level constant. **Use whatever field name the Spike (Task 1) confirmed** — defaulting to `'recurringamount'`:

```typescript
/**
 * Canonical WHMCS UpdateClientProduct field for setting a service's recurring
 * price. Pinned by `scripts/price-restore-spike.ts` against dev WHMCS9.
 */
export const PRICE_RESTORE_RECURRING_FIELD = 'recurringamount';
```

Below the existing per-scope mappers (e.g., after `mapRefundRecordParams`), add the new per-target mapper:

```typescript
/**
 * Per-target mapper for `service:price_restore`. Pure; strict 2-key output.
 * Any extra keys on the input target are intentionally dropped (defense in
 * depth against future-scope or operator leakage).
 */
export function mapServicePriceRestoreTarget(target: {
  readonly serviceid: number;
  readonly new_amount: number;
}): Record<string, unknown> {
  return {
    serviceid: target.serviceid,
    [PRICE_RESTORE_RECURRING_FIELD]: target.new_amount,
  };
}
```

In `intentToWhmcsParams`, replace the existing `default:` block with a new case + the existing default (preserve exhaustiveness):

```typescript
    case 'billing:refund:record':
      return mapRefundRecordParams(params, ctx);
    case 'service:price_restore': {
      // Batch scope — the dispatcher's single-call contract doesn't fit.
      // The write-flow's executePriceRestoreBatch helper calls
      // mapServicePriceRestoreTarget per target directly. This case throws
      // to surface any accidental dispatcher use as a clear bug.
      throw new Error(
        'service:price_restore is batch-shaped; call mapServicePriceRestoreTarget per target'
      );
    }
    default: {
      const _exhaustive: never = scope;
      void _exhaustive;
      return { ...params };
    }
```

- [ ] **Step 5.4: Run tests to verify they pass**

```bash
npx vitest run tests/write/priceRestoreMapping.test.ts
```

Expected: 4 tests PASS.

- [ ] **Step 5.5: Verify the dispatcher exhaustiveness TS error from Task 3 is gone**

```bash
npx tsc --noEmit src/write/paramMapping.ts 2>&1 | head -5
```

Expected: no errors (was complaining the new scope was unhandled — now it is).

- [ ] **Step 5.6: Run the full write-suite**

```bash
npx vitest run tests/write/
```

Expected: all green; +4 new tests on top of Task 4's total.

- [ ] **Step 5.7: Commit**

```bash
git add src/write/paramMapping.ts tests/write/priceRestoreMapping.test.ts
git commit -m "feat(write/paramMapping): per-target mapper for service:price_restore

New exported mapServicePriceRestoreTarget (strict 2-key output; drops
extra fields) + module-level PRICE_RESTORE_RECURRING_FIELD constant
(pinned by Spike). Dispatcher case throws defensively — batch scope
doesn't fit the single-call contract; write-flow calls the per-target
mapper directly.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: writeFlow.ts — scope-output assertion helper (TDD)

**Files:**
- Modify: `src/tools/writeFlow.ts` (add a small helper near the top of the file or near the imports of paramMapping)
- Modify: `tests/write/priceRestoreMapping.test.ts` (extend with assertion-helper tests)

- [ ] **Step 6.1: Extend the mapping test file with scope-output assertion tests**

Append to `tests/write/priceRestoreMapping.test.ts`:

```typescript
import {
  assertPriceRestoreOutput,
  PriceRestoreOutputAssertionError,
} from '../../src/tools/writeFlow.js';

describe('assertPriceRestoreOutput (defense-in-depth)', () => {
  it('passes when output is exactly { serviceid, <recurring-field> }', () => {
    expect(() =>
      assertPriceRestoreOutput({ serviceid: 555, [PRICE_RESTORE_RECURRING_FIELD]: 31350 })
    ).not.toThrow();
  });

  it('throws on any extra key (e.g., a leak of domainstatus)', () => {
    expect(() =>
      assertPriceRestoreOutput({
        serviceid: 555,
        [PRICE_RESTORE_RECURRING_FIELD]: 31350,
        domainstatus: 'Terminated',
      })
    ).toThrow(PriceRestoreOutputAssertionError);
  });

  it('throws on missing serviceid', () => {
    expect(() =>
      assertPriceRestoreOutput({ [PRICE_RESTORE_RECURRING_FIELD]: 31350 })
    ).toThrow(PriceRestoreOutputAssertionError);
  });

  it('throws on missing recurring-amount field', () => {
    expect(() => assertPriceRestoreOutput({ serviceid: 555 })).toThrow(
      PriceRestoreOutputAssertionError
    );
  });
});
```

- [ ] **Step 6.2: Run tests to verify they fail (export not yet present)**

```bash
npx vitest run tests/write/priceRestoreMapping.test.ts
```

Expected: 4 new tests FAIL (import errors / undefined symbol).

- [ ] **Step 6.3: Implement in src/tools/writeFlow.ts**

Add an import near the existing paramMapping import:

```typescript
import {
  intentToWhmcsParams,
  mapServicePriceRestoreTarget,
  PRICE_RESTORE_RECURRING_FIELD,
} from '../write/paramMapping.js';
```

Add a small named-export error class + assertion helper, near the top of the file (after imports, before the module-state declarations):

```typescript
/** Defense-in-depth: ensures the per-target mapper never leaks extra keys. */
export class PriceRestoreOutputAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PriceRestoreOutputAssertionError';
  }
}

const PRICE_RESTORE_ALLOWED_KEYS = new Set<string>([
  'serviceid',
  PRICE_RESTORE_RECURRING_FIELD,
]);

/**
 * Scope-output assertion for `service:price_restore`. Verifies the mapper
 * produced exactly `{ serviceid, <recurring-field> }` and nothing else.
 * Throws PriceRestoreOutputAssertionError on any extra/missing key.
 */
export function assertPriceRestoreOutput(out: Record<string, unknown>): void {
  const keys = Object.keys(out);
  // Reject extras.
  for (const k of keys) {
    if (!PRICE_RESTORE_ALLOWED_KEYS.has(k)) {
      throw new PriceRestoreOutputAssertionError(
        `scope-output assertion: unexpected key "${k}" in service:price_restore mapper output`
      );
    }
  }
  // Require both.
  if (!('serviceid' in out)) {
    throw new PriceRestoreOutputAssertionError(
      'scope-output assertion: missing serviceid in service:price_restore mapper output'
    );
  }
  if (!(PRICE_RESTORE_RECURRING_FIELD in out)) {
    throw new PriceRestoreOutputAssertionError(
      `scope-output assertion: missing ${PRICE_RESTORE_RECURRING_FIELD} in service:price_restore mapper output`
    );
  }
}
```

- [ ] **Step 6.4: Run tests to verify they pass**

```bash
npx vitest run tests/write/priceRestoreMapping.test.ts
```

Expected: all tests in this file PASS (8 total: 3 mapper + 1 dispatcher-defensive + 4 assertion).

- [ ] **Step 6.5: Commit**

```bash
git add src/tools/writeFlow.ts tests/write/priceRestoreMapping.test.ts
git commit -m "feat(writeFlow): scope-output assertion for service:price_restore

assertPriceRestoreOutput verifies the mapper produced exactly
{serviceid, <recurring-field>} and nothing else. Defense-in-depth
against future-scope leakage on the powerful UpdateClientProduct
WHMCS action. Throws PriceRestoreOutputAssertionError on violation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: writeFlow.ts — executePriceRestoreBatch helper (Phase 1 + dry_run + Phase 2) (TDD)

**Files:**
- Create: `tests/tools/writeFlow.priceRestore.test.ts`
- Modify: `src/tools/writeFlow.ts` (add helper; not yet wired into execute)

This is the largest task. Implement in 3 sub-steps: Phase 1 + dry_run, Phase 2 per-target loop, then wire the cap+idempotency+verify pieces.

- [ ] **Step 7.1: Create the integration test file with the harness skeleton**

`tests/tools/writeFlow.priceRestore.test.ts`:

```typescript
/**
 * service:price_restore end-to-end via executePriceRestoreBatch.
 *
 * Mocks WhmcsClient.read (GetClientsProducts) + WhmcsClient.mutate
 * (UpdateClientProduct). Drives full Phase 1 / dry_run / Phase 2.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executePriceRestoreBatch } from '../../src/tools/writeFlow.js';
import { createDraftIntent, IntentStore } from '../../src/write/intents.js';
import { AuditLog } from '../../src/write/audit.js';
import { IdempotencyLedger } from '../../src/write/idempotency.js';
import type { WriteIntent } from '../../src/write/types.js';

function approvedBatch(
  targets: Array<{ serviceid: number; new_amount: number; expected_old_amount?: number }>,
  dry_run = false
): WriteIntent {
  const store = new IntentStore();
  const draft = createDraftIntent({
    consumer_id: 'cowork-test',
    scope: 'service:price_restore',
    params: { targets, dry_run },
    naturalKey: `restore-${String(Date.now())}`,
    preconditions: {},
    projected_effect: 'restore batch',
  });
  store.put(draft);
  store.transition(draft.intent_id, 'validated');
  return store.transition(draft.intent_id, 'approved');
}

interface Harness {
  audit: AuditLog;
  ledger: IdempotencyLedger;
  read: ReturnType<typeof vi.fn>;
  mutate: ReturnType<typeof vi.fn>;
}

function harness(): Harness {
  return {
    audit: new AuditLog(),
    ledger: new IdempotencyLedger(),
    read: vi.fn(),
    mutate: vi.fn(),
  };
}

const CAPS = { perAction: 20000, daily: 50000 };
const APPROVAL = { approver: 'ops', at: new Date().toISOString() };

describe('executePriceRestoreBatch — Phase 1 (snapshot + precondition)', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('aborts with precondition_mismatch when expected_old_amount does not match current', async () => {
    const intent = approvedBatch([
      { serviceid: 555, new_amount: 31350, expected_old_amount: 45000 },
    ]);
    h.read.mockResolvedValueOnce({
      products: { product: [{ id: 555, recurringamount: '999', domainstatus: 'Active' }] },
    });
    const res = await executePriceRestoreBatch({
      intent,
      whmcs: { read: h.read, mutate: h.mutate } as never,
      audit: h.audit,
      ledger: h.ledger,
      caps: CAPS,
      approval: APPROVAL,
      dayAmounts: new Map(),
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('precondition_mismatch');
    expect(h.mutate).not.toHaveBeenCalled();
    expect(res.phase_1?.failedTargets).toEqual([555]);
  });

  it('aborts when a service is Terminated', async () => {
    const intent = approvedBatch([{ serviceid: 555, new_amount: 31350 }]);
    h.read.mockResolvedValueOnce({
      products: { product: [{ id: 555, recurringamount: '45000', domainstatus: 'Terminated' }] },
    });
    const res = await executePriceRestoreBatch({
      intent,
      whmcs: { read: h.read, mutate: h.mutate } as never,
      audit: h.audit,
      ledger: h.ledger,
      caps: CAPS,
      approval: APPROVAL,
      dayAmounts: new Map(),
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('precondition_mismatch');
    expect(h.mutate).not.toHaveBeenCalled();
  });

  it('aborts when a service is not found', async () => {
    const intent = approvedBatch([{ serviceid: 999, new_amount: 31350 }]);
    h.read.mockResolvedValueOnce({ products: { product: [] } });
    const res = await executePriceRestoreBatch({
      intent,
      whmcs: { read: h.read, mutate: h.mutate } as never,
      audit: h.audit,
      ledger: h.ledger,
      caps: CAPS,
      approval: APPROVAL,
      dayAmounts: new Map(),
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('precondition_mismatch');
  });
});

describe('executePriceRestoreBatch — dry_run', () => {
  it('returns a preview without invoking mutate', async () => {
    const h = harness();
    const intent = approvedBatch(
      [
        { serviceid: 555, new_amount: 31350, expected_old_amount: 45000 },
        { serviceid: 569, new_amount: 31350, expected_old_amount: 45000 },
      ],
      /* dry_run */ true
    );
    h.read
      .mockResolvedValueOnce({
        products: { product: [{ id: 555, recurringamount: '45000', domainstatus: 'Active' }] },
      })
      .mockResolvedValueOnce({
        products: { product: [{ id: 569, recurringamount: '45000', domainstatus: 'Active' }] },
      });
    const res = await executePriceRestoreBatch({
      intent,
      whmcs: { read: h.read, mutate: h.mutate } as never,
      audit: h.audit,
      ledger: h.ledger,
      caps: CAPS,
      approval: APPROVAL,
      dayAmounts: new Map(),
    });
    expect(res.allowed).toBe(true);
    expect(res.dry_run).toBe(true);
    expect(h.mutate).not.toHaveBeenCalled();
    expect(res.phase_1?.snapshots).toEqual([
      { serviceid: 555, current_amount: 45000 },
      { serviceid: 569, current_amount: 45000 },
    ]);
  });
});

describe('executePriceRestoreBatch — Phase 2 (per-target mutate)', () => {
  it('succeeds on a single-target batch, mutates once, read-back verifies', async () => {
    const h = harness();
    const intent = approvedBatch([
      { serviceid: 555, new_amount: 31350, expected_old_amount: 45000 },
    ]);
    h.read
      // Phase 1 snapshot
      .mockResolvedValueOnce({
        products: { product: [{ id: 555, recurringamount: '45000', domainstatus: 'Active' }] },
      })
      // Phase 2 read-back
      .mockResolvedValueOnce({
        products: { product: [{ id: 555, recurringamount: '31350', domainstatus: 'Active' }] },
      });
    h.mutate.mockResolvedValueOnce({ result: 'success' });

    const res = await executePriceRestoreBatch({
      intent,
      whmcs: { read: h.read, mutate: h.mutate } as never,
      audit: h.audit,
      ledger: h.ledger,
      caps: CAPS,
      approval: APPROVAL,
      dayAmounts: new Map(),
    });
    expect(res.allowed).toBe(true);
    expect(h.mutate).toHaveBeenCalledTimes(1);
    expect(h.mutate).toHaveBeenCalledWith('UpdateClientProduct', {
      serviceid: 555,
      recurringamount: 31350,
    });
    expect(res.phase_2?.outcomes).toEqual([
      { serviceid: 555, status: 'verified', old: 45000, new: 31350, delta: 13650 },
    ]);
  });

  it('halts mid-batch on first mutate failure; later targets untouched', async () => {
    const h = harness();
    const intent = approvedBatch([
      { serviceid: 555, new_amount: 31350 },
      { serviceid: 569, new_amount: 31350 },
      { serviceid: 586, new_amount: 31350 },
    ]);
    // Phase 1: all three succeed
    h.read
      .mockResolvedValueOnce({
        products: { product: [{ id: 555, recurringamount: '45000', domainstatus: 'Active' }] },
      })
      .mockResolvedValueOnce({
        products: { product: [{ id: 569, recurringamount: '45000', domainstatus: 'Active' }] },
      })
      .mockResolvedValueOnce({
        products: { product: [{ id: 586, recurringamount: '45000', domainstatus: 'Active' }] },
      })
      // Phase 2 read-back for 555
      .mockResolvedValueOnce({
        products: { product: [{ id: 555, recurringamount: '31350', domainstatus: 'Active' }] },
      });
    // Phase 2: 555 succeeds, 569 throws
    h.mutate
      .mockResolvedValueOnce({ result: 'success' })
      .mockRejectedValueOnce(new Error('whmcs boom'));

    const res = await executePriceRestoreBatch({
      intent,
      whmcs: { read: h.read, mutate: h.mutate } as never,
      audit: h.audit,
      ledger: h.ledger,
      caps: CAPS,
      approval: APPROVAL,
      dayAmounts: new Map(),
    });
    expect(res.allowed).toBe(true);
    expect(res.phase_2?.halted_after).toBe(569);
    expect(h.mutate).toHaveBeenCalledTimes(2); // 555 + 569 attempt; 586 never tried
    expect(res.phase_2?.outcomes).toEqual([
      { serviceid: 555, status: 'verified', old: 45000, new: 31350, delta: 13650 },
      { serviceid: 569, status: 'failed', old: 45000, new: 31350, delta: 13650 },
    ]);
  });

  it('rejects a target whose per-action delta exceeds cap', async () => {
    const h = harness();
    const intent = approvedBatch([{ serviceid: 555, new_amount: 100, expected_old_amount: 45000 }]);
    h.read.mockResolvedValueOnce({
      products: { product: [{ id: 555, recurringamount: '45000', domainstatus: 'Active' }] },
    });
    const res = await executePriceRestoreBatch({
      intent,
      whmcs: { read: h.read, mutate: h.mutate } as never,
      audit: h.audit,
      ledger: h.ledger,
      caps: { perAction: 20000, daily: 50000 }, // delta of 44900 > 20000
      approval: APPROVAL,
      dayAmounts: new Map(),
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('target_amount_cap_exceeded');
    expect(h.mutate).not.toHaveBeenCalled();
  });

  it('rejects when running daily delta sum would exceed daily cap', async () => {
    const h = harness();
    const intent = approvedBatch([{ serviceid: 555, new_amount: 31350, expected_old_amount: 45000 }]);
    h.read.mockResolvedValueOnce({
      products: { product: [{ id: 555, recurringamount: '45000', domainstatus: 'Active' }] },
    });
    const dayAmounts = new Map<string, number>();
    // Pre-load today's tally near the daily cap.
    const todayKey = `UpdateClientProduct|${new Date().toISOString().slice(0, 10)}`;
    dayAmounts.set(todayKey, 40000);

    const res = await executePriceRestoreBatch({
      intent,
      whmcs: { read: h.read, mutate: h.mutate } as never,
      audit: h.audit,
      ledger: h.ledger,
      caps: { perAction: 20000, daily: 50000 }, // 40000 + 13650 = 53650 > 50000
      approval: APPROVAL,
      dayAmounts,
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('target_amount_cap_exceeded');
    expect(h.mutate).not.toHaveBeenCalled();
  });

  it('per-target idempotency: re-running the same intent skips already-done targets', async () => {
    const h = harness();
    const intent = approvedBatch([
      { serviceid: 555, new_amount: 31350, expected_old_amount: 45000 },
      { serviceid: 569, new_amount: 31350, expected_old_amount: 45000 },
    ]);
    // Pre-record per-target idempotency for service 555 (already done).
    const perTargetKey555 = `${intent.idempotency_key}|555`;
    h.ledger.record(perTargetKey555, { status: 'verified', new: 31350 });

    // Phase 1 (both snapshots)
    h.read
      .mockResolvedValueOnce({
        products: { product: [{ id: 555, recurringamount: '31350', domainstatus: 'Active' }] },
      })
      .mockResolvedValueOnce({
        products: { product: [{ id: 569, recurringamount: '45000', domainstatus: 'Active' }] },
      })
      // Phase 2 read-back for 569
      .mockResolvedValueOnce({
        products: { product: [{ id: 569, recurringamount: '31350', domainstatus: 'Active' }] },
      });
    h.mutate.mockResolvedValueOnce({ result: 'success' });

    const res = await executePriceRestoreBatch({
      intent,
      whmcs: { read: h.read, mutate: h.mutate } as never,
      audit: h.audit,
      ledger: h.ledger,
      caps: CAPS,
      approval: APPROVAL,
      dayAmounts: new Map(),
    });
    expect(res.allowed).toBe(true);
    expect(h.mutate).toHaveBeenCalledTimes(1); // only 569; 555 skipped
    expect(h.mutate).toHaveBeenCalledWith('UpdateClientProduct', {
      serviceid: 569,
      recurringamount: 31350,
    });
  });
});
```

- [ ] **Step 7.2: Run the new test file (should fail — helper not yet implemented)**

```bash
npx vitest run tests/tools/writeFlow.priceRestore.test.ts 2>&1 | tail -15
```

Expected: import error / undefined `executePriceRestoreBatch`.

- [ ] **Step 7.3: Implement executePriceRestoreBatch in src/tools/writeFlow.ts**

Add this helper (location: after the existing helpers, before `registerWriteFlowTools`). It is **exported** for testability:

```typescript
import { AuditPersistError } from '../write/audit.js';
import type { AuditLog } from '../write/audit.js';
import type { IdempotencyLedger } from '../write/idempotency.js';
import type { WriteIntent, HumanApprovalRecord, HighRiskCaps } from '../write/types.js';
import { auditEvent } from '../write/audit.js';

/** Result of executePriceRestoreBatch — explicit shape for tests + UI. */
export interface PriceRestoreBatchResult {
  readonly allowed: boolean;
  readonly reason?: string; // when allowed=false
  readonly dry_run?: boolean;
  readonly phase_1?: {
    readonly snapshots: ReadonlyArray<{ serviceid: number; current_amount: number }>;
    readonly failedTargets?: readonly number[];
    readonly ok: boolean;
  };
  readonly phase_2?: {
    readonly outcomes: ReadonlyArray<{
      serviceid: number;
      status: 'verified' | 'executed' | 'failed' | 'skipped';
      old: number;
      new: number;
      delta: number;
    }>;
    readonly halted_after?: number | null;
  };
}

interface PriceRestoreBatchArgs {
  readonly intent: WriteIntent;
  readonly whmcs: { read: WhmcsClient['read']; mutate: WhmcsClient['mutate'] };
  readonly audit: AuditLog;
  readonly ledger: IdempotencyLedger;
  readonly caps: HighRiskCaps;
  readonly approval: HumanApprovalRecord;
  readonly dayAmounts: Map<string, number>;
}

/**
 * Phase 1 (always) + optional dry_run + Phase 2 (sequential, fail-fast,
 * per-target idempotency). Pure-ish: side effects are scoped to the supplied
 * audit/ledger/dayAmounts and to the supplied whmcs client.
 */
export async function executePriceRestoreBatch(
  args: PriceRestoreBatchArgs
): Promise<PriceRestoreBatchResult> {
  const { intent, whmcs, audit, ledger, caps, dayAmounts } = args;
  const targets = (intent.params.targets as ReadonlyArray<{
    serviceid: number;
    new_amount: number;
    expected_old_amount?: number;
  }>);
  const dryRun = intent.params.dry_run === true;

  // ===== PHASE 1 =====
  const snapshots: Array<{ serviceid: number; current_amount: number }> = [];
  const failedTargets: number[] = [];

  for (const t of targets) {
    let resp: unknown;
    try {
      resp = await whmcs.read('GetClientsProducts', { serviceid: t.serviceid });
    } catch {
      failedTargets.push(t.serviceid);
      continue;
    }
    const r = resp as { products?: { product?: ReadonlyArray<Record<string, unknown>> } };
    const p = r?.products?.product?.[0];
    if (!p) {
      failedTargets.push(t.serviceid);
      continue;
    }
    const statusRaw = p.domainstatus;
    if (statusRaw === 'Terminated' || statusRaw === 'Cancelled') {
      failedTargets.push(t.serviceid);
      continue;
    }
    const currentRaw = p[PRICE_RESTORE_RECURRING_FIELD] ?? p.recurringamount;
    const current = typeof currentRaw === 'number' ? currentRaw : Number(currentRaw);
    if (!Number.isFinite(current) || current < 0) {
      failedTargets.push(t.serviceid);
      continue;
    }
    if (t.expected_old_amount !== undefined && t.expected_old_amount !== current) {
      failedTargets.push(t.serviceid);
      continue;
    }
    snapshots.push({ serviceid: t.serviceid, current_amount: current });
  }

  if (failedTargets.length > 0) {
    audit.append(
      auditEvent(
        'intent.execution_blocked',
        intent,
        `precondition_mismatch: failedTargets=${failedTargets.join(',')}`
      )
    );
    return {
      allowed: false,
      reason: 'precondition_mismatch',
      phase_1: { snapshots, failedTargets, ok: false },
    };
  }

  if (dryRun) {
    audit.append(auditEvent('intent.execution_blocked', intent, 'dry_run_completed'));
    return {
      allowed: true,
      dry_run: true,
      phase_1: { snapshots, ok: true },
    };
  }

  // ===== PHASE 2 =====
  const outcomes: Array<{
    serviceid: number;
    status: 'verified' | 'executed' | 'failed' | 'skipped';
    old: number;
    new: number;
    delta: number;
  }> = [];
  let halted_after: number | null = null;

  const dayKey = `UpdateClientProduct|${new Date().toISOString().slice(0, 10)}`;
  const dayBefore = dayAmounts.get(dayKey) ?? 0;
  let dayRunning = dayBefore;

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const snap = snapshots[i];
    const delta = Math.abs(t.new_amount - snap.current_amount);

    // Per-target idempotency check.
    const perTargetKey = `${intent.idempotency_key}|${String(t.serviceid)}`;
    if (ledger.seen(perTargetKey)) {
      audit.append(auditEvent('intent.executed', intent, `replay_skipped serviceid=${String(t.serviceid)}`));
      outcomes.push({
        serviceid: t.serviceid,
        status: 'skipped',
        old: snap.current_amount,
        new: t.new_amount,
        delta,
      });
      continue;
    }

    // Per-target cap check.
    if (delta > caps.perAction || dayRunning + delta > caps.daily) {
      audit.append(
        auditEvent(
          'intent.execution_blocked',
          intent,
          `target_amount_cap_exceeded serviceid=${String(t.serviceid)} delta=${String(delta)}`
        )
      );
      return {
        allowed: false,
        reason: 'target_amount_cap_exceeded',
        phase_1: { snapshots, ok: true },
        phase_2: { outcomes, halted_after: t.serviceid },
      };
    }

    // Map + scope-output assertion.
    const mapped = mapServicePriceRestoreTarget({ serviceid: t.serviceid, new_amount: t.new_amount });
    try {
      assertPriceRestoreOutput(mapped);
    } catch (e) {
      audit.append(
        auditEvent(
          'intent.execution_blocked',
          intent,
          `target_output_assertion_failed serviceid=${String(t.serviceid)}: ${e instanceof Error ? e.message : String(e)}`
        )
      );
      return {
        allowed: false,
        reason: 'target_output_assertion_failed',
        phase_1: { snapshots, ok: true },
        phase_2: { outcomes, halted_after: t.serviceid },
      };
    }

    // Fail-closed durable audit before any mutation.
    try {
      audit.appendDurable(
        auditEvent('intent.executed', intent, `attempting target serviceid=${String(t.serviceid)} delta=${String(delta)}`)
      );
    } catch (e) {
      if (e instanceof AuditPersistError) {
        return {
          allowed: false,
          reason: 'audit_write_failed',
          phase_1: { snapshots, ok: true },
          phase_2: { outcomes, halted_after: t.serviceid },
        };
      }
      throw e;
    }

    ledger.record(perTargetKey, { attempting: true });

    // Mutate.
    try {
      await whmcs.mutate('UpdateClientProduct', mapped);
    } catch (e) {
      audit.append(
        auditEvent(
          'intent.failed',
          intent,
          `serviceid=${String(t.serviceid)}: ${e instanceof Error ? e.message : String(e)}`
        )
      );
      outcomes.push({
        serviceid: t.serviceid,
        status: 'failed',
        old: snap.current_amount,
        new: t.new_amount,
        delta,
      });
      halted_after = t.serviceid;
      break;
    }

    // Read-back verify.
    let verified = false;
    try {
      const verifyResp = (await whmcs.read('GetClientsProducts', { serviceid: t.serviceid })) as {
        products?: { product?: ReadonlyArray<Record<string, unknown>> };
      };
      const vp = verifyResp?.products?.product?.[0];
      const after = vp ? Number(vp[PRICE_RESTORE_RECURRING_FIELD] ?? vp.recurringamount) : NaN;
      verified = Number.isFinite(after) && after === t.new_amount;
    } catch {
      verified = false;
    }
    outcomes.push({
      serviceid: t.serviceid,
      status: verified ? 'verified' : 'executed',
      old: snap.current_amount,
      new: t.new_amount,
      delta,
    });

    // Tally the daily sum for the next iteration / future intents.
    dayRunning += delta;
    dayAmounts.set(dayKey, dayRunning);
    audit.append(
      auditEvent(
        verified ? 'intent.verified' : 'intent.executed',
        intent,
        `serviceid=${String(t.serviceid)} ${snap.current_amount}→${String(t.new_amount)}`
      )
    );
  }

  return {
    allowed: true,
    phase_1: { snapshots, ok: true },
    phase_2: { outcomes, halted_after },
  };
}
```

- [ ] **Step 7.4: Run the new test file**

```bash
npx vitest run tests/tools/writeFlow.priceRestore.test.ts
```

Expected: all tests PASS (Phase 1 abort, dry_run, single-target success, mid-batch halt, per-action cap reject, daily cap reject, idempotency skip).

- [ ] **Step 7.5: Run the full suite**

```bash
npx vitest run
```

Expected: all green, +9 new tests (from this task).

- [ ] **Step 7.6: Commit**

```bash
git add src/tools/writeFlow.ts tests/tools/writeFlow.priceRestore.test.ts
git commit -m "feat(writeFlow): executePriceRestoreBatch helper (Phase 1 + dry_run + Phase 2)

Two-phase batch executor. Phase 1: read-only snapshot per target +
precondition (expected_old_amount, status, presence). Optional dry_run
early-exit returning preview. Phase 2: sequential per-target mutate
with per-target idempotency (intent.idempotency_key|serviceid),
delta+daily cap check, scope-output assertion, fail-closed durable
audit, read-back verify. Fail-fast on first mutate error.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: writeFlow.ts — wire executePriceRestoreBatch into the execute handler (TDD)

**Files:**
- Modify: `src/tools/writeFlow.ts` (execute handler + toToolResult branch for batch scopes)
- Extend: `tests/tools/writeFlow.priceRestore.test.ts` (end-to-end via the registered tool handlers)

- [ ] **Step 8.1: Append end-to-end tests to the existing test file**

Append to `tests/tools/writeFlow.priceRestore.test.ts`:

```typescript
import { registerWriteFlowTools } from '../../src/tools/writeFlow.js';
import { createHash } from 'node:crypto';

const RAW_TOKEN = 'PRICE-RESTORE-E2E-SYNTHETIC';
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

beforeEach(() => {
  process.env.MCP_CONSUMER_REGISTRY = JSON.stringify([
    {
      id: 'pr-test',
      token_sha256: sha(RAW_TOKEN),
      allowedScopes: ['read'],
      defaultContract: 'ops_operator',
      allowedContracts: ['ops_operator'],
      allowedActions: [],
      writeCapability: 'execution_allowed',
      allowedWriteScopes: ['service:price_restore'],
      envRestrictions: [],
      anonymous: false,
    },
  ]);
});

vi.mock('../../src/config.js', () => ({
  config: {
    MCP_MODE: 'full',
    MCP_ENV: 'local',
    MCP_MAX_PAGE_SIZE: 100,
    MCP_WRITE_KILL_SWITCH: false,
    MCP_PROD_WRITE_AUTHORIZED: [],
    MCP_WRITE_EXECUTION_AUTHORIZED: 'UpdateClientProduct',
    MCP_PROD_HIGH_RISK_PER_ACTION_CAP: 20000,
    MCP_PROD_HIGH_RISK_DAILY_CAP: 50000,
    MCP_WRITE_AUDIT_PATH: '',
    MCP_WRITE_IDEMPOTENCY_PATH: '',
  },
  isToolAllowed: () => true,
}));
vi.mock('../../src/security.js', () => ({ AUTH_SHAPE: {} }));

describe('service:price_restore end-to-end via registered handlers', () => {
  it('completes a 3-target restore on dev/staging path', async () => {
    const handlers: Record<string, (a: Record<string, unknown>) => Promise<{ content: { text: string }[] }>> = {};
    const server = {
      registerTool: (n: string, _c: unknown, cb: unknown) => {
        handlers[n] = cb as never;
      },
    };
    const read = vi.fn();
    const mutate = vi.fn().mockResolvedValue({ result: 'success' });
    // Phase 1 + Phase 2 read-back for 3 targets
    for (const sid of [555, 569, 586]) {
      read.mockResolvedValueOnce({
        products: { product: [{ id: sid, recurringamount: '45000', domainstatus: 'Active' }] },
      });
    }
    for (const sid of [555, 569, 586]) {
      read.mockResolvedValueOnce({
        products: { product: [{ id: sid, recurringamount: '31350', domainstatus: 'Active' }] },
      });
    }
    const logger = { child: () => logger, logToolCall: vi.fn(), logToolResult: vi.fn(), info: vi.fn(), error: vi.fn() };
    registerWriteFlowTools(
      server as never,
      { mutate, read } as never,
      logger as never,
      { tryConsume: () => true } as never
    );
    const tok = { auth_token: RAW_TOKEN };
    const params = {
      targets: [
        { serviceid: 555, new_amount: 31350, expected_old_amount: 45000 },
        { serviceid: 569, new_amount: 31350, expected_old_amount: 45000 },
        { serviceid: 586, new_amount: 31350, expected_old_amount: 45000 },
      ],
    };
    const d = await handlers.draft_write_intent({
      scope: 'service:price_restore',
      params,
      naturalKey: 'e2e-3-target',
      projected_effect: 'restore 3 services',
      ...tok,
    });
    const draftBody = JSON.parse(d.content[0].text) as Record<string, unknown>;
    const id = (draftBody.intent as Record<string, unknown>).intent_id as string;
    // would_call.whmcs_params should be an array of 3 per-target call shapes.
    const wouldCall = draftBody.would_call as Record<string, unknown>;
    expect(Array.isArray(wouldCall.whmcs_params)).toBe(true);
    expect(wouldCall.whmcs_params).toHaveLength(3);

    await handlers.validate_write_intent({ intent_id: id, ...tok });
    await handlers.approve_write_intent({ intent_id: id, approver: 'op', decision: 'approved', ...tok });
    const e = await handlers.execute_write_intent({ intent_id: id, ...tok });
    const execBody = JSON.parse(e.content[0].text) as Record<string, unknown>;
    expect(execBody.executed).toBe(true);
    expect(mutate).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 8.2: Run — expect failure (handler not yet wired)**

```bash
npx vitest run tests/tools/writeFlow.priceRestore.test.ts -t "end-to-end"
```

Expected: fails — `would_call.whmcs_params` is not an array, or execute doesn't dispatch to the batch helper.

- [ ] **Step 8.3: Wire into `toToolResult` (would_call.whmcs_params batch shape)**

In `src/tools/writeFlow.ts`, in the `toToolResult` function, replace the existing `intentToWhmcsParams(...)` call block with a scope-aware branch. Find this block (approx lines 243-255):

```typescript
  // Best-effort mapper preview for would_call. The validate-stage mapping_error
  // backstop will surface real mapping bugs; here we tolerate to keep draft UX clean.
  let whmcsParams: Record<string, unknown> | undefined;
  try {
    whmcsParams = intentToWhmcsParams(
      intent.scope,
      intent.params as Record<string, unknown>,
      { idempotency_key: intent.idempotency_key }
    );
  } catch {
    whmcsParams = undefined;
  }
```

Replace with:

```typescript
  // Best-effort mapper preview for would_call.
  // For batch scopes (service:price_restore), produce an ARRAY of per-target
  // call shapes. For single-call scopes, the dispatcher returns one object.
  let whmcsParams: Record<string, unknown> | Array<Record<string, unknown>> | undefined;
  try {
    if (intent.scope === 'service:price_restore') {
      const targets = (intent.params.targets as ReadonlyArray<{
        serviceid: number;
        new_amount: number;
      }>) ?? [];
      whmcsParams = targets.map((t) => ({
        action: 'UpdateClientProduct',
        params: mapServicePriceRestoreTarget({
          serviceid: t.serviceid,
          new_amount: t.new_amount,
        }),
      })) as never;
    } else {
      whmcsParams = intentToWhmcsParams(
        intent.scope,
        intent.params as Record<string, unknown>,
        { idempotency_key: intent.idempotency_key }
      );
    }
  } catch {
    whmcsParams = undefined;
  }
```

Also update `RESULT_OUTPUT_SHAPE.would_call.whmcs_params` Zod typing (approx line 172) to permit either a record or an array:

```typescript
      whmcs_params: z.union([
        z.record(z.string(), z.unknown()),
        z.array(z.record(z.string(), z.unknown())),
      ]).optional(),
```

- [ ] **Step 8.4: Wire into the execute handler**

Find the execute branch in `registerWriteFlowTools` (approx line 560-580 — where `intentToWhmcsParams(...)` is called and `whmcs.mutate(...)` follows). Insert a batch-scope branch at the TOP of the execute handler's mutate-stage block, BEFORE the existing single-call path. Specifically, after the authorizer's `decision.allowed === true` check passes but BEFORE `intentToWhmcsParams(...)`, add:

```typescript
      // Batch scope dispatch — service:price_restore uses its own two-phase helper.
      if (intent.state === 'approved' && intent.scope === 'service:price_restore') {
        const approval = approvals.get(intent.intent_id);
        if (!approval) {
          const blocked = store.transition(intent.intent_id, 'execution_blocked');
          audit.append(auditEvent('intent.execution_blocked', blocked, 'human_approval_required'));
          return out(
            toToolResult(blocked, 'execute', {
              execution: { attempted: false, blocked_reason: 'human_approval_required' },
            })
          );
        }
        const batchRes = await executePriceRestoreBatch({
          intent,
          whmcs,
          audit,
          ledger,
          caps: {
            perAction: config.MCP_PROD_HIGH_RISK_PER_ACTION_CAP,
            daily: config.MCP_PROD_HIGH_RISK_DAILY_CAP,
          },
          approval,
          dayAmounts,
        });
        if (!batchRes.allowed) {
          const blocked = store.transition(intent.intent_id, 'execution_blocked');
          audit.append(
            auditEvent('intent.execution_blocked', blocked, batchRes.reason ?? 'unknown')
          );
          return out(
            toToolResult(blocked, 'execute', {
              execution: {
                attempted: false,
                blocked_reason: batchRes.reason,
                phase_1: batchRes.phase_1,
                phase_2: batchRes.phase_2,
              },
            })
          );
        }
        // dry_run successful preview path
        if (batchRes.dry_run) {
          return out(
            toToolResult(intent, 'execute', {
              executed: false,
              execution: { attempted: false, dry_run: true, phase_1: batchRes.phase_1 },
            })
          );
        }
        const finalState = store.transition(intent.intent_id, 'executed');
        return out(
          toToolResult(finalState, 'execute', {
            executed: true,
            execution: {
              attempted: true,
              phase_1: batchRes.phase_1,
              phase_2: batchRes.phase_2,
            },
          })
        );
      }
```

- [ ] **Step 8.5: Update the RESULT_OUTPUT_SHAPE for `execution` to permit phase_1/phase_2/dry_run**

Around line 174-186, find the `execution: z.object({...})` block. Add:

```typescript
      phase_1: z.unknown().optional(),
      phase_2: z.unknown().optional(),
      dry_run: z.boolean().optional(),
```

- [ ] **Step 8.6: Run the full test file**

```bash
npx vitest run tests/tools/writeFlow.priceRestore.test.ts
```

Expected: all tests in the file PASS (Phase 1 + dry_run + Phase 2 unit tests AND the e2e end-to-end test).

- [ ] **Step 8.7: Run the full repo suite**

```bash
npx vitest run
```

Expected: all green; no regression on the 680-passing baseline.

- [ ] **Step 8.8: Type-check**

```bash
npx tsc --noEmit 2>&1 | grep -c "error TS"
```

Expected: `0` (we resolved the dispatcher exhaustiveness; no new errors).

- [ ] **Step 8.9: Lint changed files**

```bash
npx eslint src/write/types.ts src/write/validation.ts src/write/paramMapping.ts src/tools/writeFlow.ts tests/write/priceRestoreTypes.test.ts tests/write/priceRestoreValidation.test.ts tests/write/priceRestoreMapping.test.ts tests/tools/writeFlow.priceRestore.test.ts 2>&1 | grep -cE "error" | sed 's/^/changed-file lint errors: /'
```

Expected: 0 (or document any pre-existing baseline that this PR does not modify).

- [ ] **Step 8.10: Prettier**

```bash
npx prettier --write src/write/types.ts src/write/validation.ts src/write/paramMapping.ts src/tools/writeFlow.ts tests/write/priceRestoreTypes.test.ts tests/write/priceRestoreValidation.test.ts tests/write/priceRestoreMapping.test.ts tests/tools/writeFlow.priceRestore.test.ts
```

- [ ] **Step 8.11: Commit**

```bash
git add src/tools/writeFlow.ts tests/tools/writeFlow.priceRestore.test.ts
git commit -m "feat(writeFlow): wire executePriceRestoreBatch into execute handler

Execute branches on intent.scope === 'service:price_restore' to the
new batch helper (with human approval pulled from the approvals map);
returns per-phase outcome in execution.{phase_1,phase_2,dry_run}.
would_call.whmcs_params for batch scopes is an ARRAY of per-target
call shapes. RESULT_OUTPUT_SHAPE widened additively.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: RUNBOOK doc — add §6 "Price restore operations"

**Files:**
- Modify: `docs/superpowers/specs/2026-05-19-whmcs-prod-write-RUNBOOK.md`

- [ ] **Step 9.1: Append §6 to the RUNBOOK**

At the end of the RUNBOOK file, add:

```markdown
## 6. Price restore operations (`service:price_restore`)

A narrow, governed, audited path to restore a service's `recurringamount`
through `UpdateClientProduct`. Production stays sealed unless explicitly
allowlisted.

### Env for prod activation (operator action)

```
MCP_PROD_WRITE_AUTHORIZED=UpdateClientProduct
MCP_PROD_HIGH_RISK_PER_ACTION_CAP=20000   # max |new−old| delta per target
MCP_PROD_HIGH_RISK_DAILY_CAP=50000        # sum of executed deltas per UTC day
```

### Worked example — client 50 (svc 555/569/586) ₹45,000 → ₹31,350

1. Draft (`draft_write_intent`):
   ```jsonc
   {
     "scope": "service:price_restore",
     "params": {
       "targets": [
         { "serviceid": 555, "new_amount": 31350, "expected_old_amount": 45000 },
         { "serviceid": 569, "new_amount": 31350, "expected_old_amount": 45000 },
         { "serviceid": 586, "new_amount": 31350, "expected_old_amount": 45000 }
       ],
       "dry_run": true
     },
     "naturalKey": "client50-vps-l-ssd-restore",
     "projected_effect": "Restore svc 555/569/586 ₹45000→₹31350/qtr"
   }
   ```
2. Validate, approve.
3. Execute (with `dry_run: true`) → review the Phase 1 `snapshots`.
4. Draft a fresh intent identical but with `dry_run: false` (or omit `dry_run`).
5. Validate, approve (with a real human approver token), execute.
6. Confirm `execution.phase_2.outcomes[*].status === 'verified'`.

### Re-seal after completion

```
unset MCP_PROD_WRITE_AUTHORIZED
unset MCP_PROD_HIGH_RISK_PER_ACTION_CAP
unset MCP_PROD_HIGH_RISK_DAILY_CAP
```

Or `MCP_WRITE_KILL_SWITCH=1` instantly re-seals everything.
```

- [ ] **Step 9.2: Commit**

```bash
git add docs/superpowers/specs/2026-05-19-whmcs-prod-write-RUNBOOK.md
git commit -m "docs(runbook): §6 service:price_restore operations

Env table + worked example (client-50 VPS L SSD restore) +
re-seal pattern.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Live dev proof script

**Files:**
- Create: `scripts/price-restore-dev-proof.ts`

- [ ] **Step 10.1: Write the proof script (one-off; CLI; mirrors `track-e-proof.ts`)**

`scripts/price-restore-dev-proof.ts`:

```typescript
/* eslint-disable no-console -- one-off CLI proof script: stdout IS the output */
/**
 * Live dev proof of service:price_restore on a benign throwaway service.
 *
 * Pre-reqs:
 *   - dev WHMCS9 up at localhost:8890 (post-install-fixup.sh ran).
 *   - A throwaway service exists on dev (NOT client 50). Set TPR_SERVICEID + TPR_NEW_AMOUNT env vars.
 *
 * Run:
 *   set -a; . ./.env.local; set +a
 *   MCP_ENV=local MCP_MODE=full WHMCS_ALLOW_HTTP=true \
 *   MCP_WRITE_EXECUTION_AUTHORIZED=UpdateClientProduct \
 *   TPR_SERVICEID=<dev-service-id> TPR_NEW_AMOUNT=1.00 \
 *   npx tsx scripts/price-restore-dev-proof.ts
 */
import { createHash } from 'node:crypto';

const RAW = 'PRICE-RESTORE-DEV-PROOF-SYNTHETIC';
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

process.env.MCP_CONSUMER_REGISTRY = JSON.stringify([
  {
    id: 'pr-dev',
    token_sha256: sha(RAW),
    allowedScopes: ['read'],
    defaultContract: 'ops_operator',
    allowedContracts: ['ops_operator'],
    allowedActions: [],
    writeCapability: 'execution_allowed',
    allowedWriteScopes: ['service:price_restore'],
    envRestrictions: [],
    anonymous: false,
  },
]);

const { config } = await import('../src/config.js');
const { WhmcsClient } = await import('../src/whmcs/WhmcsClient.js');
const { registerWriteFlowTools } = await import('../src/tools/writeFlow.js');

interface Res {
  content: { text: string }[];
  isError?: boolean;
}
const J = (r: Res) => JSON.parse(r.content[0].text) as Record<string, unknown>;
const rec = (v: unknown) => v as Record<string, unknown>;

const noop = (): void => undefined;
const log: Record<string, unknown> = {
  child: () => log,
  logToolCall: noop,
  logToolResult: noop,
  logWhmcsCall: noop,
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
};

const handlers: Record<string, (a: Record<string, unknown>) => Promise<Res>> = {};
const server = {
  registerTool: (n: string, _c: unknown, cb: unknown) => {
    handlers[n] = cb as never;
  },
};

const whmcs = new WhmcsClient(config, log as never);
registerWriteFlowTools(server as never, whmcs, log as never, { tryConsume: () => true } as never);

const tok = { auth_token: RAW };
const SID = Number(process.env.TPR_SERVICEID ?? 0);
const NEW = Number(process.env.TPR_NEW_AMOUNT ?? 1);
if (!Number.isInteger(SID) || SID <= 0) {
  console.error('Set TPR_SERVICEID to a positive integer (dev service id, NOT client 50).');
  process.exit(2);
}

console.log('env:', config.MCP_ENV, '| mode:', config.MCP_MODE, '| api:', config.WHMCS_API_URL);

// 1. dry_run preview
const dDry = await handlers.draft_write_intent({
  scope: 'service:price_restore',
  params: { targets: [{ serviceid: SID, new_amount: NEW }], dry_run: true },
  naturalKey: `dev-proof-dry-${String(Date.now())}`,
  projected_effect: 'dev proof dry-run',
  ...tok,
});
const dId = rec(J(dDry).intent).intent_id as string;
await handlers.validate_write_intent({ intent_id: dId, ...tok });
await handlers.approve_write_intent({ intent_id: dId, approver: 'pr-dev', decision: 'approved', ...tok });
const eDry = await handlers.execute_write_intent({ intent_id: dId, ...tok });
console.log('dry_run result:', JSON.stringify(J(eDry).execution));

// 2. real execute
const dReal = await handlers.draft_write_intent({
  scope: 'service:price_restore',
  params: { targets: [{ serviceid: SID, new_amount: NEW }] },
  naturalKey: `dev-proof-real-${String(Date.now())}`,
  projected_effect: 'dev proof real',
  ...tok,
});
const rId = rec(J(dReal).intent).intent_id as string;
await handlers.validate_write_intent({ intent_id: rId, ...tok });
await handlers.approve_write_intent({ intent_id: rId, approver: 'pr-dev', decision: 'approved', ...tok });
const eReal = await handlers.execute_write_intent({ intent_id: rId, ...tok });
const realBody = J(eReal);
const exec = rec(realBody.execution);
console.log('real result   :', JSON.stringify(exec));

const phase2 = rec(exec.phase_2);
const outcomes = phase2.outcomes as Array<{ status: string; serviceid: number }>;
const ok = realBody.executed === true && outcomes.every((o) => o.status === 'verified');
console.log('\nRESULT:', ok ? 'PASS — live restore succeeded + verified' : 'INVESTIGATE');
```

- [ ] **Step 10.2: (Manual gate — DO NOT auto-run in CI)** Operator may run this against dev:

```bash
set -a; . ./.env.local; set +a
MCP_ENV=local MCP_MODE=full WHMCS_ALLOW_HTTP=true \
MCP_WRITE_EXECUTION_AUTHORIZED=UpdateClientProduct \
TPR_SERVICEID=<dev-service> TPR_NEW_AMOUNT=1.00 \
npx tsx scripts/price-restore-dev-proof.ts
```

Expected: `RESULT: PASS`. If FAIL, investigate the printed execution payload before opening the PR.

- [ ] **Step 10.3: Lint + format**

```bash
npx prettier --write scripts/price-restore-dev-proof.ts
```

- [ ] **Step 10.4: Commit**

```bash
git add scripts/price-restore-dev-proof.ts
git commit -m "test(scripts): live dev proof for service:price_restore

Mirrors track-e-proof pattern — drives draft→validate→approve→execute
against dev WHMCS9 in MCP_MODE=full with a synthetic
execution_allowed consumer. Runs dry_run preview, then real, then
verifies. Operator-run only (no CI).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Final gates + push + open PR (NO MERGE)

**Files:**
- (verification only)

- [ ] **Step 11.1: Full gates**

```bash
npx tsc --noEmit 2>&1 | grep -c "error TS" | sed 's/^/tsc errors: /'
# Expected: 0

npx vitest run 2>&1 | grep -E "Test Files|Tests" | tail -3
# Expected: 0 failed; the count rose by ~25-30 new tests

npx prettier --check src/write/types.ts src/write/validation.ts src/write/paramMapping.ts src/tools/writeFlow.ts tests/write/priceRestoreTypes.test.ts tests/write/priceRestoreValidation.test.ts tests/write/priceRestoreMapping.test.ts tests/tools/writeFlow.priceRestore.test.ts scripts/price-restore-spike.ts scripts/price-restore-dev-proof.ts
# Expected: All matched files use Prettier code style!

npx eslint src/write/types.ts src/write/validation.ts src/write/paramMapping.ts src/tools/writeFlow.ts tests/write/priceRestoreTypes.test.ts tests/write/priceRestoreValidation.test.ts tests/write/priceRestoreMapping.test.ts tests/tools/writeFlow.priceRestore.test.ts 2>&1 | grep -cE "error|warning" | sed 's/^/changed-file eslint problems: /'
# Expected: 0 introduced (the repo's pre-existing baseline is unaffected)
```

- [ ] **Step 11.2: Push the branch (will require explicit user authorization in the calling agent's flow)**

```bash
git push -u origin feat/service-price-restore 2>&1 | tail -3
```

Expected: branch pushed with upstream tracking.

- [ ] **Step 11.3: Open PR (do NOT merge)**

```bash
cat > /tmp/pr-body-price-restore.md <<'EOF'
## What

New WHMCS MCP high-risk write scope `service:price_restore` for restoring a
service's `recurringamount` via `UpdateClientProduct`.

## Why

Concrete need: undo the 2026-04-12 manual price increase on client 50's VPS L
SSD services (svc 555/569/586): ₹31,350/qtr → ₹45,000/qtr. The new scope
provides a reusable, audited, governed restore path that is **production
sealed by default** — activation is an explicit, separate operator action,
not part of this PR.

## Design

Spec: `docs/superpowers/specs/2026-05-20-service-price-restore-design.md`.
Brainstorming round complete; design approved by user before build.

- **Batch intent**: `params.targets: [{serviceid, new_amount, expected_old_amount?}, ...]`, optional `dry_run`.
- **Phase 1** (always): read-only snapshot per target + precondition (`expected_old_amount` match, service status). Aborts with `precondition_mismatch` on any failure — zero mutation.
- **Optional `dry_run`** opt-in: stop after Phase 1, return preview.
- **Phase 2** (sequential, fail-fast): per-target mutate with per-target idempotency (key = `intent.idempotency_key|serviceid`); delta+daily cap check; **scope-output assertion** (defense in depth — verifies mapper produced exactly `{serviceid, recurringamount}`); fail-closed durable audit; read-back verify.
- **Caps**: reuses existing `MCP_PROD_HIGH_RISK_PER_ACTION_CAP` + `MCP_PROD_HIGH_RISK_DAILY_CAP`. Interpretation: per-action = max `|new−old|` delta; daily = sum of executed deltas. **Default 0 ⇒ all money actions denied** (keystone preserved).

## Keystone invariant

With no new env configured, production stays sealed. Authorizer gate ordering
unchanged. PROD_NEVER_EXECUTABLE unchanged. `MCP_WRITE_KILL_SWITCH=1` still
re-seals everything instantly.

## Out of scope

- Production activation (separate operator decision).
- Generalizing the mapper to return `Array<{action, params, key}>` (deferred until a 2nd batch scope appears).
- Rollback-via-compensating-mutation (explicitly rejected in brainstorming — wrong for restore use case).

## Spike result

`scripts/price-restore-spike.ts` ran read-only on dev WHMCS9 (`localhost:8890`)
to pin the canonical recurring-amount field name. Result: `<filled in by Task 1>`.

## Tests + gates

- `vitest run`: <total> tests / 0 failed.
- `tsc --noEmit`: 0 errors.
- Changed-file `eslint`/`prettier`: 0 new problems.
- Live dev proof script (`scripts/price-restore-dev-proof.ts`): operator-runnable; not auto-run in CI.

## Not for auto-merge

Opened for review only. Merge to main is a separate explicit decision after
human review (matches the PR #17/#19/#20/#21 pattern in this repo).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
gh pr create --base main --head feat/service-price-restore \
  --title "feat(write): service:price_restore — gated audited batch price-restore scope" \
  --body-file /tmp/pr-body-price-restore.md 2>&1 | tail -3
```

Expected: PR URL printed.

- [ ] **Step 11.4: Report**

Summary line containing:
- PR URL.
- vitest count (before/after).
- tsc error count (should be 0).
- Spike result (the pinned field name).
- Files changed (count).
- Explicit "NOT MERGED" note.

---

## Self-Review

1. **Spec coverage:**
   - Goal/architecture/lock decisions table — covered by Tasks 3-8.
   - Components table — every file listed maps to a task.
   - Data flow / intent shape — covered by validation tests (Task 4) + e2e test (Task 8).
   - Error handling / new denial reasons — covered by Task 3 (types) + Task 7 (executePriceRestoreBatch emissions) + tests asserting each reason.
   - Testing strategy — Tasks 4-8 cover unit + integration; Task 10 covers live dev proof.
   - Rollout — RUNBOOK (Task 9) + operator-only Task 10 + explicit non-merge in Task 11.
   - Risks — Spike risk addressed by Task 1; idempotency window, day boundary, over-powered action, read-back stale documented in the spec.

2. **Placeholder scan:** None. Every step has concrete code or commands. `<RECURRING_FIELD>` notation in Task 5/6 is a deliberate substitution placeholder explicitly defined in Task 1; not a TODO.

3. **Type consistency:** `mapServicePriceRestoreTarget` (Task 5) — used by Task 6 (assertion test) + Task 7 (helper) + Task 8 (toToolResult). `PRICE_RESTORE_RECURRING_FIELD` (Task 5) — used by Task 6 (assertion) + Task 7 (read-back). `PriceRestoreOutputAssertionError` (Task 6) — used by Task 7 (caught and audited). `executePriceRestoreBatch` (Task 7) — used by Task 8 (wired into execute). All consistent.

4. **Sequencing:** Task 1 (Spike) pins the field name; Tasks 5-10 reference it; Task 11 packages. Tasks 3-8 are TDD. Task 11 push/PR is gated on explicit user authorization at execution time.

Self-review pass. Plan is concrete, sequenced, TDD-shaped, scoped to one PR.

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-20-service-price-restore-implementation.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Matches this session's established pattern (subagent for build + subagent for review). Each task → its own commit, traceable.

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints. More compact context but slower per-task iteration.

**Which approach?**
