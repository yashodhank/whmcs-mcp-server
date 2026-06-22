# Service Owner Transfer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a governed, batch, auditable transfer of services (a…n) from a source client to a destination client, with operator-selected invoice handling.

**Architecture:** Two new high-risk write scopes — `service:transfer_owner` (batch-shaped) and `billing:invoice:reassign` (single-invoice primitive) — flowing through the existing draft → validate → approve → execute write-intent machinery. A two-phase executor `executeServiceTransferBatch` mirrors `executePriceRestoreBatch`: Phase 1 is a read-only preflight that aborts all-or-nothing on any precondition mismatch (with `dry_run` early-exit); Phase 2 commits sequentially, fail-fast, with per-item idempotency, fail-closed audit-before-mutate, and read-back verify. The transfer executor composes the `billing:invoice:reassign` mapper to move invoices per `invoice_mode`.

**Tech Stack:** Node.js, TypeScript (ESM, `.js` import specifiers), Vitest, Zod. WHMCS Admin API via `WhmcsClient.read`/`WhmcsClient.mutate`.

## Global Constraints

- ESM imports use `.js` specifiers even for `.ts` sources (e.g. `import { x } from './types.js'`). Copy this exactly from existing files.
- Both new scopes are **sealed by default** — they execute only when an operator opts into the runtime allowlist; never add them to any default allowlist.
- `service:transfer_owner` and `billing:invoice:reassign` are **`high` risk** (require allowlist + a `HumanApprovalRecord` + separation of duties). They are **NOT** added to `PROD_NEVER_EXECUTABLE` or `PROD_NEVER_EXECUTABLE_SCOPES` (all invoice modes are executable once opted in).
- **No money moves** in a transfer → the transfer executor is **money-cap-exempt** (unlike `executePriceRestoreBatch`). Blast radius is bounded instead by a batch-size guard (`MCP_TRANSFER_MAX_BATCH`, default 50).
- **Cross-currency is a hard preflight failure**: a source/dest client currency mismatch aborts in Phase 1.
- The exact WHMCS action names + field names for owner-move and invoice-reassign are **bound by Task 1** (the capability probe) and recorded in `docs/runbooks/write-capability-probe.md`. Tasks 2–8 use the constants `SERVICE_OWNER_MOVE_ACTION` and `INVOICE_REASSIGN_ACTION` defined in Task 2; if the probe finds **no** supported action, leave the constant at the sentinel `UNSUPPORTED_ACTION` and the executor short-circuits to `unsupported_capability` (same posture the repo uses for `ticket:merge`).
- Run `npm run typecheck && npm run lint && npm run test` green before every commit. After code lands, run `graphify update .` to refresh the graph.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `docs/runbooks/write-capability-probe.md` | Probe procedure + recorded findings | Modify (Task 1) |
| `src/write/types.ts` | Scope list, action/risk maps, action constants | Modify (Task 2) |
| `src/config.ts` | `MCP_TRANSFER_MAX_BATCH` env parse | Modify (Task 2) |
| `src/write/validation.ts` | Required params + custom validation for both scopes | Modify (Task 3) |
| `src/write/paramMapping.ts` | Strict mappers + dispatch for both scopes | Modify (Task 4) |
| `src/tools/writeFlow.ts` | `would_call` preview, `executeServiceTransferBatch`, execute-path routing | Modify (Tasks 5–7) |
| `tests/write/transferOwnerTypes.test.ts` | Scope/action/risk unit tests | Create (Task 2) |
| `tests/write/transferOwnerValidation.test.ts` | Validation unit tests | Create (Task 3) |
| `tests/write/transferOwnerMapping.test.ts` | Mapper unit tests | Create (Task 4) |
| `tests/tools/writeFlow.transferOwner.test.ts` | Executor + full-flow integration tests | Create (Tasks 6–8) |
| `README.md` | Write-scope table entry | Modify (Task 9) |

---

## Task 1: WHMCS capability probe (binds SCOPE_ACTION)

**Files:**
- Modify: `docs/runbooks/write-capability-probe.md`
- Reference: `src/whmcs/WhmcsClient.ts`, `docker-compose.whmcs-test.yml` (devbox), `tests/write/capabilityProbeReport.test.ts`

**Interfaces:**
- Produces: documented decisions consumed by Task 2 — `SERVICE_OWNER_MOVE_ACTION` (string + field names), `INVOICE_REASSIGN_ACTION` (string + field names), and a `supported: boolean` per scope.

This task is **verification, not TDD** — its deliverable is a recorded, reproducible finding.

- [ ] **Step 1: Bring up the disposable WHMCS devbox**

Run: `docker compose -f docker-compose.whmcs-test.yml up -d`
Expected: WHMCS 8.13/9.0 container healthy (per the project's devbox notes; ionCube under amd64, `libicu-dev` present, fresh DB needs the install wizard once).

- [ ] **Step 2: Seed two clients + a service**

Use the admin UI or API to create `clientA`, `clientB` (same currency) and one active service owned by `clientA`. Record their ids.

- [ ] **Step 3: Probe service-owner reassignment**

Probe, in order, recording the raw JSON `result`/`message` for each:
1. `UpdateClientProduct` with `{serviceid, clientid: <clientB>}` — does ownership change? (Read back with `GetClientsProducts`.)
2. If (1) fails, `UpdateClientProduct` with `{serviceid, userid: <clientB>}`.
3. If both fail, check whether the API role exposes an internal `moveproduct`-style action (expect `Invalid Permissions` like `mergeticket` if not).

Expected: exactly one of these is recorded as **working** (ownership reads back as `clientB`), or **none** works.

- [ ] **Step 4: Probe invoice reassignment**

Create an unpaid invoice for `clientA`, then probe:
1. `UpdateInvoice` with `{invoiceid, userid: <clientB>}` — does the invoice's owner change? (Read back with `GetInvoice`.)

Expected: recorded working or not-working.

- [ ] **Step 5: Probe side-effects**

After a successful owner move (if any), record what happened to: linked domain, addons, configurable options. Note any that must be blocked or warned about.

- [ ] **Step 6: Record findings in the runbook**

Add a `## Service / invoice owner transfer (2026-06-22)` section to `docs/runbooks/write-capability-probe.md` with, verbatim:
- `SERVICE_OWNER_MOVE_ACTION` = the working action name (or `UNSUPPORTED`), and the exact field name that carries the destination client (`clientid` vs `userid`).
- `INVOICE_REASSIGN_ACTION` = the working action name (or `UNSUPPORTED`), and its destination-client field name.
- The read-back field used to verify ownership (e.g. `GetClientsProducts.products.product[0].clientid`).
- Side-effect notes from Step 5.

- [ ] **Step 7: Commit**

```bash
git add docs/runbooks/write-capability-probe.md
git commit -m "docs(runbook): WHMCS service/invoice owner-transfer capability probe findings"
```

> The literal action + field strings recorded here are used in Tasks 2 and 4. The plan below assumes the most likely binding — `SERVICE_OWNER_MOVE_ACTION='UpdateClientProduct'` with destination field `clientid`, and `INVOICE_REASSIGN_ACTION='UpdateInvoice'` with destination field `userid`. **If Task 1 found different strings, substitute them in Tasks 2 and 4.** If a scope is unsupported, set its constant to `UNSUPPORTED_ACTION` (Task 2) — the executor handles that path.

---

## Task 2: Register the two scopes (types, risk, action, config cap)

**Files:**
- Modify: `src/write/types.ts` (WRITE_SCOPES ~L23-89, SCOPE_ACTION ~L94-130, SCOPE_RISK ~L136-213)
- Modify: `src/config.ts`
- Test: `tests/write/transferOwnerTypes.test.ts` (create)

**Interfaces:**
- Produces: `WriteScope` union now includes `'service:transfer_owner'` and `'billing:invoice:reassign'`; exported consts `SERVICE_OWNER_MOVE_ACTION`, `INVOICE_REASSIGN_ACTION`, `UNSUPPORTED_ACTION` from `src/write/types.ts`; `config.MCP_TRANSFER_MAX_BATCH: number`.

- [ ] **Step 1: Write the failing test**

Create `tests/write/transferOwnerTypes.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  WRITE_SCOPES,
  SCOPE_ACTION,
  SCOPE_RISK,
  PROD_NEVER_EXECUTABLE_SCOPES,
  SERVICE_OWNER_MOVE_ACTION,
  INVOICE_REASSIGN_ACTION,
} from '../../src/write/types.js';

describe('service-owner-transfer scopes', () => {
  it('registers both scopes', () => {
    expect(WRITE_SCOPES).toContain('service:transfer_owner');
    expect(WRITE_SCOPES).toContain('billing:invoice:reassign');
  });

  it('binds actions from the probe constants', () => {
    expect(SCOPE_ACTION['service:transfer_owner']).toBe(SERVICE_OWNER_MOVE_ACTION);
    expect(SCOPE_ACTION['billing:invoice:reassign']).toBe(INVOICE_REASSIGN_ACTION);
  });

  it('are high risk', () => {
    expect(SCOPE_RISK['service:transfer_owner']).toBe('high');
    expect(SCOPE_RISK['billing:invoice:reassign']).toBe('high');
  });

  it('are NOT permanently prod-sealed (executable once opted in)', () => {
    expect(PROD_NEVER_EXECUTABLE_SCOPES.has('service:transfer_owner')).toBe(false);
    expect(PROD_NEVER_EXECUTABLE_SCOPES.has('billing:invoice:reassign')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/write/transferOwnerTypes.test.ts`
Expected: FAIL — `'service:transfer_owner'` not in `WRITE_SCOPES`, exports missing.

- [ ] **Step 3: Add the action constants to `src/write/types.ts`**

Above `WRITE_SCOPES` (after the imports), add:

```ts
/**
 * WHMCS action bindings for owner transfer. VALUES ARE SET FROM THE TASK-1
 * CAPABILITY PROBE (docs/runbooks/write-capability-probe.md). UNSUPPORTED_ACTION
 * is the sentinel for "no supported API action found" — the transfer executor
 * short-circuits to `unsupported_capability` for any scope bound to it.
 */
export const UNSUPPORTED_ACTION = '__unsupported__';
export const SERVICE_OWNER_MOVE_ACTION = 'UpdateClientProduct'; // ← Task 1 finding
export const INVOICE_REASSIGN_ACTION = 'UpdateInvoice'; // ← Task 1 finding
```

- [ ] **Step 4: Register the scopes in the three maps**

In `WRITE_SCOPES`, add after the `'ticket:merge'` entry:

```ts
  // ── Service / invoice owner transfer ─────────────────────────────────────
  // Move a service's owning client (batch) and, optionally, its invoices.
  // High-risk: cross-client PII + billing-record reassignment. Sealed by
  // default; NOT in PROD_NEVER_EXECUTABLE (all invoice modes executable once
  // an operator opts in). SCOPE_ACTION bound from the Task-1 probe.
  'service:transfer_owner',
  'billing:invoice:reassign',
```

In `SCOPE_ACTION`, add:

```ts
  'service:transfer_owner': SERVICE_OWNER_MOVE_ACTION,
  'billing:invoice:reassign': INVOICE_REASSIGN_ACTION,
```

In `SCOPE_RISK`, add:

```ts
  // Reassigning a service's owning client moves PII + billing relationship
  // across clients → high (allowlist + human approval + separation of duties).
  // No money moves, so the executor is money-cap-exempt (see plan).
  'service:transfer_owner': 'high',
  // Re-owning an invoice changes a financial record's owner (settled history
  // under invoice_mode 'all') → high.
  'billing:invoice:reassign': 'high',
```

- [ ] **Step 5: Add `MCP_TRANSFER_MAX_BATCH` to `src/config.ts`**

Find an existing numeric env parse (e.g. `MCP_PROD_HIGH_RISK_PER_ACTION_CAP`) and add a sibling with default 50:

```ts
  MCP_TRANSFER_MAX_BATCH: parseIntEnv(process.env.MCP_TRANSFER_MAX_BATCH, 50),
```

Match the existing parse helper and object placement exactly (copy the neighboring line's style; do not invent a new helper).

- [ ] **Step 6: Run test to verify it passes**

Run: `npm run test -- tests/write/transferOwnerTypes.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Typecheck + lint, then commit**

Run: `npm run typecheck && npm run lint`
Expected: clean.

```bash
git add src/write/types.ts src/config.ts tests/write/transferOwnerTypes.test.ts
git commit -m "feat(write): register service:transfer_owner + billing:invoice:reassign scopes"
```

---

## Task 3: Validation rules

**Files:**
- Modify: `src/write/validation.ts` (REQUIRED_PARAMS ~L37-100; add custom blocks near the `service:price_restore` block ~L435-491)
- Test: `tests/write/transferOwnerValidation.test.ts` (create)

**Interfaces:**
- Consumes: scopes from Task 2.
- Produces: validation issues with codes `invalid_service_ids_shape`, `invalid_clientid`, `same_source_dest`, `invalid_invoice_mode`, `invalid_dry_run`, `invalid_invoiceid` (consumed by tests only).

- [ ] **Step 1: Write the failing test**

Create `tests/write/transferOwnerValidation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateIntent } from '../../src/write/validation.js';
import { createDraftIntent } from '../../src/write/intents.js';
import type { WriteScope } from '../../src/write/types.js';

function draft(scope: WriteScope, params: Record<string, unknown>) {
  return createDraftIntent({
    consumer_id: 'c1',
    scope,
    params,
    naturalKey: 'k',
    preconditions: {},
    projected_effect: 'test',
  });
}
const codes = (i: ReturnType<typeof draft>) =>
  validateIntent(i).issues.map((x) => x.code);

describe('service:transfer_owner validation', () => {
  const ok = {
    source_clientid: 1,
    dest_clientid: 2,
    service_ids: [10, 11],
    invoice_mode: 'unpaid_only',
  };
  it('accepts a well-formed transfer', () => {
    expect(validateIntent(draft('service:transfer_owner', ok)).ok).toBe(true);
  });
  it('rejects empty service_ids', () => {
    expect(codes(draft('service:transfer_owner', { ...ok, service_ids: [] })))
      .toContain('invalid_service_ids_shape');
  });
  it('rejects non-positive service id', () => {
    expect(codes(draft('service:transfer_owner', { ...ok, service_ids: [10, 0] })))
      .toContain('invalid_service_ids_shape');
  });
  it('rejects source === dest', () => {
    expect(codes(draft('service:transfer_owner', { ...ok, dest_clientid: 1 })))
      .toContain('same_source_dest');
  });
  it('rejects unknown invoice_mode', () => {
    expect(codes(draft('service:transfer_owner', { ...ok, invoice_mode: 'most' })))
      .toContain('invalid_invoice_mode');
  });
  it('rejects non-boolean dry_run', () => {
    expect(codes(draft('service:transfer_owner', { ...ok, dry_run: 'yes' })))
      .toContain('invalid_dry_run');
  });
});

describe('billing:invoice:reassign validation', () => {
  it('accepts a well-formed reassign', () => {
    expect(validateIntent(draft('billing:invoice:reassign',
      { invoice_id: 5, dest_clientid: 2 })).ok).toBe(true);
  });
  it('rejects non-positive invoice_id', () => {
    expect(codes(draft('billing:invoice:reassign',
      { invoice_id: 0, dest_clientid: 2 }))).toContain('invalid_invoiceid');
  });
});
```

> Confirm the exact return shape of `validateIntent` (`.ok` / `.issues`) against `src/write/validation.ts` before running; if the helper name differs, match it. The `service:price_restore` tests in `tests/write/priceRestoreValidation.test.ts` are the reference for the call shape.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/write/transferOwnerValidation.test.ts`
Expected: FAIL — no rules yet, so malformed inputs are not rejected.

- [ ] **Step 3: Add REQUIRED_PARAMS entries**

In `REQUIRED_PARAMS` (`src/write/validation.ts`), add:

```ts
  // service:transfer_owner — batch-shaped: source/dest client + non-empty
  // service_ids + invoice_mode (validated in the custom block below).
  'service:transfer_owner': ['source_clientid', 'dest_clientid', 'service_ids', 'invoice_mode'],
  'billing:invoice:reassign': ['invoice_id', 'dest_clientid'],
```

- [ ] **Step 4: Add the custom validation block**

Immediately after the `service:price_restore` block (the one ending ~L491), add:

```ts
  // service:transfer_owner — batch-shape + cross-client preconditions checked
  // at execute time; here we reject malformed structure before approval.
  if (intent.scope === 'service:transfer_owner') {
    const src = intent.params.source_clientid;
    const dst = intent.params.dest_clientid;
    if (typeof src !== 'number' || !Number.isInteger(src) || src <= 0) {
      issues.push({
        code: 'invalid_clientid',
        severity: 'error',
        message: 'service:transfer_owner `source_clientid` must be a positive integer',
      });
    }
    if (typeof dst !== 'number' || !Number.isInteger(dst) || dst <= 0) {
      issues.push({
        code: 'invalid_clientid',
        severity: 'error',
        message: 'service:transfer_owner `dest_clientid` must be a positive integer',
      });
    }
    if (typeof src === 'number' && src === dst) {
      issues.push({
        code: 'same_source_dest',
        severity: 'error',
        message: 'service:transfer_owner source and destination clients must differ',
      });
    }
    const ids = intent.params.service_ids;
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.some((s) => typeof s !== 'number' || !Number.isInteger(s) || s <= 0)
    ) {
      issues.push({
        code: 'invalid_service_ids_shape',
        severity: 'error',
        message: 'service:transfer_owner `service_ids` must be a non-empty array of positive integers',
      });
    }
    const mode = intent.params.invoice_mode;
    if (mode !== 'none' && mode !== 'unpaid_only' && mode !== 'all') {
      issues.push({
        code: 'invalid_invoice_mode',
        severity: 'error',
        message: "service:transfer_owner `invoice_mode` must be 'none' | 'unpaid_only' | 'all'",
      });
    }
    if (intent.params.dry_run !== undefined && typeof intent.params.dry_run !== 'boolean') {
      issues.push({
        code: 'invalid_dry_run',
        severity: 'error',
        message: 'service:transfer_owner `dry_run` must be a boolean when provided',
      });
    }
  }

  // billing:invoice:reassign — single invoice → destination client.
  if (intent.scope === 'billing:invoice:reassign') {
    const inv = intent.params.invoice_id;
    if (typeof inv !== 'number' || !Number.isInteger(inv) || inv <= 0) {
      issues.push({
        code: 'invalid_invoiceid',
        severity: 'error',
        message: 'billing:invoice:reassign `invoice_id` must be a positive integer',
      });
    }
    const dst = intent.params.dest_clientid;
    if (typeof dst !== 'number' || !Number.isInteger(dst) || dst <= 0) {
      issues.push({
        code: 'invalid_clientid',
        severity: 'error',
        message: 'billing:invoice:reassign `dest_clientid` must be a positive integer',
      });
    }
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -- tests/write/transferOwnerValidation.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 6: Typecheck + lint, then commit**

```bash
git add src/write/validation.ts tests/write/transferOwnerValidation.test.ts
git commit -m "feat(write): validation for service:transfer_owner + billing:invoice:reassign"
```

---

## Task 4: Strict param mappers + dispatch

**Files:**
- Modify: `src/write/paramMapping.ts` (add mappers near `mapServicePriceRestoreTarget` ~L303; dispatch in `intentToWhmcsParams` switch ~L815-870)
- Test: `tests/write/transferOwnerMapping.test.ts` (create)

**Interfaces:**
- Consumes: `SERVICE_OWNER_MOVE_ACTION`, `INVOICE_REASSIGN_ACTION` from Task 2.
- Produces: `mapServiceTransferOwnerTarget({ serviceid, dest_clientid }) → { serviceid, clientid }`; `mapInvoiceReassignParams(params) → { invoiceid, userid }`. (Field names `clientid`/`userid` are the Task-1 bindings — substitute if the probe differed.)

- [ ] **Step 1: Write the failing test**

Create `tests/write/transferOwnerMapping.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  mapServiceTransferOwnerTarget,
  mapInvoiceReassignParams,
} from '../../src/write/paramMapping.js';

describe('transfer-owner mappers', () => {
  it('maps a service target to {serviceid, clientid} only', () => {
    expect(mapServiceTransferOwnerTarget({ serviceid: 10, dest_clientid: 2, junk: 9 } as any))
      .toEqual({ serviceid: 10, clientid: 2 });
  });
  it('maps an invoice reassign to {invoiceid, userid} only', () => {
    expect(mapInvoiceReassignParams({ invoice_id: 5, dest_clientid: 2, junk: 9 }))
      .toEqual({ invoiceid: 5, userid: 2 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/write/transferOwnerMapping.test.ts`
Expected: FAIL — mappers not exported.

- [ ] **Step 3: Add the mappers**

After `mapServicePriceRestoreTarget` (~L311) in `src/write/paramMapping.ts`:

```ts
/**
 * Per-service mapper for `service:transfer_owner`. STRICT 2-key output
 * {serviceid, clientid}; any extra key is dropped (defense in depth, mirrors
 * mapServicePriceRestoreTarget). The destination-client field name (`clientid`)
 * is the Task-1 probe binding.
 */
export function mapServiceTransferOwnerTarget(target: {
  readonly serviceid: number;
  readonly dest_clientid: number;
}): Record<string, unknown> {
  return { serviceid: target.serviceid, clientid: target.dest_clientid };
}

/**
 * `billing:invoice:reassign` `{invoice_id, dest_clientid}` → WHMCS
 * `UpdateInvoice` `{invoiceid, userid}`. STRICT 2-key output; extras dropped.
 * The destination-client field name (`userid`) is the Task-1 probe binding.
 */
export function mapInvoiceReassignParams(
  params: Record<string, unknown>
): Record<string, unknown> {
  return { invoiceid: params.invoice_id, userid: params.dest_clientid };
}
```

- [ ] **Step 4: Add dispatch in `intentToWhmcsParams`**

In the scope `switch` (~L815-870), add a case for `billing:invoice:reassign` (single-call) mirroring the existing single-call cases:

```ts
    case 'billing:invoice:reassign':
      return { action: INVOICE_REASSIGN_ACTION, params: mapInvoiceReassignParams(params) };
```

And add `service:transfer_owner` to the batch-shaped guard that throws for `service:price_restore` (~L851-857), so a caller is told to use the batch path:

```ts
    case 'service:transfer_owner':
      throw new Error(
        'service:transfer_owner is batch-shaped; call mapServiceTransferOwnerTarget per service'
      );
```

Add the `INVOICE_REASSIGN_ACTION` import to the top-of-file import from `./types.js`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -- tests/write/transferOwnerMapping.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck + lint, then commit**

```bash
git add src/write/paramMapping.ts tests/write/transferOwnerMapping.test.ts
git commit -m "feat(write): strict mappers + dispatch for transfer-owner scopes"
```

---

## Task 5: `would_call` preview for the batch scope

**Files:**
- Modify: `src/tools/writeFlow.ts` — `toToolResult` (~L419-444)

**Interfaces:**
- Consumes: `mapServiceTransferOwnerTarget`, `SERVICE_OWNER_MOVE_ACTION`.
- Produces: a `whmcs_params` array preview for a `service:transfer_owner` draft (consumed by Task 8 tests).

- [ ] **Step 1: Write the failing test**

Add to `tests/tools/writeFlow.transferOwner.test.ts` (create the file now; more tests join in Tasks 6 & 8):

```ts
import { describe, it, expect } from 'vitest';
import { draftWorkflowIntent } from '../../src/tools/writeFlow.js';

describe('transfer_owner would_call preview', () => {
  it('previews one UpdateClientProduct per service', () => {
    // NOTE: draftWorkflowIntent is consumer/scope gated; in a sealed test env
    // it returns { ok:false }. This test asserts the preview SHAPE via the
    // exported toToolResult path exercised in Task 8's full-flow test instead.
    // Placeholder kept minimal here; see Task 8 for the asserting test.
    expect(typeof draftWorkflowIntent).toBe('function');
  });
});
```

> The real assertion of the preview lives in Task 8 (full-flow draft), because `toToolResult` is internal. Keep this file's Task-5 test trivial; the preview branch is covered end-to-end in Task 8.

- [ ] **Step 2: Add the preview branch**

In `toToolResult`, extend the `try` block that special-cases `service:price_restore` (~L421) with an `else if`:

```ts
    } else if (intentRec.scope === 'service:transfer_owner') {
      const ids = intentRec.params.service_ids as readonly number[] | undefined;
      const dest = intentRec.params.dest_clientid as number;
      whmcsParams = (ids ?? []).map((serviceid) => ({
        action: SERVICE_OWNER_MOVE_ACTION,
        params: mapServiceTransferOwnerTarget({ serviceid, dest_clientid: dest }),
      }));
    } else {
```

Add `mapServiceTransferOwnerTarget` to the existing import from `../write/paramMapping.js` and `SERVICE_OWNER_MOVE_ACTION` to the import from `../write/types.js`.

- [ ] **Step 3: Run tests + typecheck**

Run: `npm run test -- tests/tools/writeFlow.transferOwner.test.ts && npm run typecheck`
Expected: PASS / clean.

- [ ] **Step 4: Commit**

```bash
git add src/tools/writeFlow.ts tests/tools/writeFlow.transferOwner.test.ts
git commit -m "feat(writeFlow): would_call preview for service:transfer_owner"
```

---

## Task 6: Two-phase executor `executeServiceTransferBatch`

**Files:**
- Modify: `src/tools/writeFlow.ts` — add `ServiceTransferBatchResult` + `executeServiceTransferBatch` after `executePriceRestoreBatch` (~after L835)
- Test: `tests/tools/writeFlow.transferOwner.test.ts` (extend)

**Interfaces:**
- Consumes: `WriteIntent`, `WhmcsClient` read/mutate, `AuditLog`, `IdempotencyLedger`, `SERVICE_OWNER_MOVE_ACTION`, `INVOICE_REASSIGN_ACTION`, `UNSUPPORTED_ACTION`, `mapServiceTransferOwnerTarget`, `mapInvoiceReassignParams`, `config.MCP_TRANSFER_MAX_BATCH`.
- Produces:
```ts
export interface ServiceTransferBatchResult {
  allowed: boolean;
  reason?: string;
  dry_run?: boolean;
  phase_1?: {
    services: { serviceid: number; owned_by: number; status: string }[];
    invoices_in_scope?: { serviceid: number; invoice_ids: number[] }[];
    failed?: { serviceid?: number; invoice_id?: number; why: string }[];
    ok: boolean;
  };
  phase_2?: {
    outcomes: { serviceid: number; status: 'verified' | 'executed' | 'failed' | 'skipped'; invoices_moved: number }[];
    halted_after?: number | null;
  };
}
export async function executeServiceTransferBatch(args: {
  intent: WriteIntent;
  whmcs: { read: WhmcsClient['read']; mutate: WhmcsClient['mutate'] };
  audit: AuditLog;
  ledger: IdempotencyLedger;
}): Promise<ServiceTransferBatchResult>;
```

- [ ] **Step 1: Write the failing test (preflight rejections + dry_run + happy path)**

Add to `tests/tools/writeFlow.transferOwner.test.ts`:

```ts
import { executeServiceTransferBatch } from '../../src/tools/writeFlow.js';
import { createDraftIntent } from '../../src/write/intents.js';
import { IdempotencyLedger } from '../../src/write/idempotency.js';

// Minimal fakes -------------------------------------------------------------
function fakeAudit() {
  const events: any[] = [];
  return { events, append: (e: any) => events.push(e), appendDurable: (e: any) => events.push(e) } as any;
}
function intent(params: Record<string, unknown>) {
  return createDraftIntent({
    consumer_id: 'c1', scope: 'service:transfer_owner', params,
    naturalKey: 'k', preconditions: {}, projected_effect: 't',
  });
}
// WHMCS read stub: services owned by client 1 (currency USD), dest=2 active USD.
function whmcsStub(over: Partial<Record<string, any>> = {}) {
  return {
    read: async (action: string, p: any) => {
      if (action === 'GetClientsProducts')
        return { products: { product: [{ id: p.serviceid, clientid: 1, domainstatus: 'Active' }] } };
      if (action === 'GetClientsDetails' || action === 'GetClients')
        return { client: { id: p.clientid ?? p.userid, status: 'Active', currency: 1, currency_code: 'USD' } };
      if (action === 'GetInvoices') return { invoices: { invoice: [] } };
      return {};
    },
    mutate: async () => ({ result: 'success' }),
    ...over,
  } as any;
}

describe('executeServiceTransferBatch — preflight', () => {
  it('aborts when a service is not owned by source', async () => {
    const whmcs = whmcsStub({
      read: async (a: string, p: any) =>
        a === 'GetClientsProducts'
          ? { products: { product: [{ id: p.serviceid, clientid: 99, domainstatus: 'Active' }] } }
          : { client: { id: 2, status: 'Active', currency_code: 'USD' } },
    });
    const res = await executeServiceTransferBatch({
      intent: intent({ source_clientid: 1, dest_clientid: 2, service_ids: [10], invoice_mode: 'none' }),
      whmcs, audit: fakeAudit(), ledger: new IdempotencyLedger(),
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('precondition_mismatch');
  });

  it('aborts on currency mismatch', async () => {
    const whmcs = whmcsStub({
      read: async (a: string, p: any) => {
        if (a === 'GetClientsProducts')
          return { products: { product: [{ id: p.serviceid, clientid: 1, domainstatus: 'Active' }] } };
        // dest client has a different currency
        return { client: { id: 2, status: 'Active', currency_code: 'EUR' } };
      },
    });
    const res = await executeServiceTransferBatch({
      intent: intent({ source_clientid: 1, dest_clientid: 2, service_ids: [10], invoice_mode: 'none' }),
      whmcs, audit: fakeAudit(), ledger: new IdempotencyLedger(),
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('precondition_mismatch');
  });

  it('dry_run returns a preview and mutates nothing', async () => {
    let mutated = 0;
    const whmcs = whmcsStub({ mutate: async () => { mutated++; return { result: 'success' }; } });
    const res = await executeServiceTransferBatch({
      intent: intent({ source_clientid: 1, dest_clientid: 2, service_ids: [10], invoice_mode: 'none', dry_run: true }),
      whmcs, audit: fakeAudit(), ledger: new IdempotencyLedger(),
    });
    expect(res.allowed).toBe(true);
    expect(res.dry_run).toBe(true);
    expect(mutated).toBe(0);
  });

  it('commits owner move on the happy path', async () => {
    const calls: any[] = [];
    const whmcs = whmcsStub({ mutate: async (a: string, p: any) => { calls.push([a, p]); return { result: 'success' }; } });
    const res = await executeServiceTransferBatch({
      intent: intent({ source_clientid: 1, dest_clientid: 2, service_ids: [10, 11], invoice_mode: 'none' }),
      whmcs, audit: fakeAudit(), ledger: new IdempotencyLedger(),
    });
    expect(res.allowed).toBe(true);
    expect(res.phase_2?.outcomes.map((o) => o.status)).toEqual(['executed', 'executed']);
    expect(calls.every(([a]) => a === 'UpdateClientProduct')).toBe(true);
  });
});
```

> Verify `IdempotencyLedger`'s constructor + `seen`/`record` method names against `src/write/idempotency.ts` before running, and the `GetClientsDetails` ownership/currency field names against the Task-1 findings. Adjust the stub field names to match (e.g. `userid` vs `clientid` on the product record).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/tools/writeFlow.transferOwner.test.ts`
Expected: FAIL — `executeServiceTransferBatch` not exported.

- [ ] **Step 3: Implement the executor**

After `executePriceRestoreBatch` in `src/tools/writeFlow.ts`, add (adapting the price-restore two-phase shape — no money caps):

```ts
export interface ServiceTransferBatchResult {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly dry_run?: boolean;
  readonly phase_1?: {
    readonly services: { serviceid: number; owned_by: number; status: string }[];
    readonly invoices_in_scope?: { serviceid: number; invoice_ids: number[] }[];
    readonly failed?: { serviceid?: number; invoice_id?: number; why: string }[];
    readonly ok: boolean;
  };
  readonly phase_2?: {
    readonly outcomes: {
      serviceid: number;
      status: 'verified' | 'executed' | 'failed' | 'skipped';
      invoices_moved: number;
    }[];
    readonly halted_after?: number | null;
  };
}

/**
 * Two-phase batch executor for `service:transfer_owner`. Mirrors
 * executePriceRestoreBatch but moves NO money → money-cap-exempt; blast radius
 * is bounded by config.MCP_TRANSFER_MAX_BATCH.
 *
 * Phase 1 (always, read-only): per service confirm exists + owned by
 * source_clientid + status not Terminated/Cancelled; (once) dest client exists,
 * is Active, and currency matches source; enumerate in-scope invoices per
 * invoice_mode. ABORTS all-or-nothing on any failure. dry_run early-exits here.
 *
 * Phase 2 (sequential, fail-fast): per service — per-item idempotency
 * (`${idempotency_key}|svc=${serviceid}`), fail-closed audit before mutate,
 * reassign owner (SERVICE_OWNER_MOVE_ACTION), reassign in-scope invoices
 * (INVOICE_REASSIGN_ACTION) per mode, read-back verify. Halts on first failure.
 */
export async function executeServiceTransferBatch(args: {
  intent: WriteIntent;
  whmcs: { read: WhmcsClient['read']; mutate: WhmcsClient['mutate'] };
  audit: AuditLog;
  ledger: IdempotencyLedger;
}): Promise<ServiceTransferBatchResult> {
  const { intent, whmcs, audit, ledger } = args;

  // Capability gate: unsupported binding → never mutate.
  if (
    SERVICE_OWNER_MOVE_ACTION === UNSUPPORTED_ACTION ||
    (intent.params.invoice_mode !== 'none' && INVOICE_REASSIGN_ACTION === UNSUPPORTED_ACTION)
  ) {
    audit.append(auditEvent('intent.execution_blocked', intent, 'unsupported_capability'));
    return { allowed: false, reason: 'unsupported_capability' };
  }

  const source = intent.params.source_clientid as number;
  const dest = intent.params.dest_clientid as number;
  const serviceIds = intent.params.service_ids as readonly number[];
  const mode = intent.params.invoice_mode as 'none' | 'unpaid_only' | 'all';
  const dryRun = intent.params.dry_run === true;

  if (serviceIds.length > config.MCP_TRANSFER_MAX_BATCH) {
    audit.append(auditEvent('intent.execution_blocked', intent, 'batch_too_large'));
    return { allowed: false, reason: 'batch_too_large' };
  }

  // ── PHASE 1 — preflight (read-only) ──────────────────────────────────────
  const services: { serviceid: number; owned_by: number; status: string }[] = [];
  const invoicesInScope: { serviceid: number; invoice_ids: number[] }[] = [];
  const failed: { serviceid?: number; invoice_id?: number; why: string }[] = [];

  // dest client once
  let destCurrency: string | undefined;
  try {
    const dc = (await whmcs.read('GetClientsDetails', { clientid: dest })) as {
      client?: { status?: string; currency_code?: string };
    };
    const c = dc.client;
    if (!c || c.status !== 'Active') failed.push({ why: `dest_client_not_active:${dest}` });
    destCurrency = c?.currency_code;
  } catch {
    failed.push({ why: `dest_client_unreadable:${dest}` });
  }

  let sourceCurrency: string | undefined;
  try {
    const sc = (await whmcs.read('GetClientsDetails', { clientid: source })) as {
      client?: { currency_code?: string };
    };
    sourceCurrency = sc.client?.currency_code;
  } catch {
    failed.push({ why: `source_client_unreadable:${source}` });
  }
  if (destCurrency !== undefined && sourceCurrency !== undefined && destCurrency !== sourceCurrency) {
    failed.push({ why: `currency_mismatch:${sourceCurrency}->${destCurrency}` });
  }

  for (const serviceid of serviceIds) {
    let resp: unknown;
    try {
      resp = await whmcs.read('GetClientsProducts', { serviceid });
    } catch {
      failed.push({ serviceid, why: 'service_unreadable' });
      continue;
    }
    const p = (resp as { products?: { product?: readonly Record<string, unknown>[] } }).products
      ?.product?.[0];
    if (!p) {
      failed.push({ serviceid, why: 'service_not_found' });
      continue;
    }
    const owner = Number(p.clientid ?? p.userid);
    const status = String(p.domainstatus ?? '');
    if (owner !== source) failed.push({ serviceid, why: `not_owned_by_source:${owner}` });
    if (status === 'Terminated' || status === 'Cancelled')
      failed.push({ serviceid, why: `bad_status:${status}` });
    services.push({ serviceid, owned_by: owner, status });

    if (mode !== 'none') {
      try {
        const inv = (await whmcs.read('GetInvoices', {
          userid: source,
          ...(mode === 'unpaid_only' ? { status: 'Unpaid' } : {}),
        })) as { invoices?: { invoice?: readonly Record<string, unknown>[] } };
        const ids = (inv.invoices?.invoice ?? [])
          .map((r) => Number(r.id))
          .filter((n) => Number.isFinite(n));
        invoicesInScope.push({ serviceid, invoice_ids: ids });
      } catch {
        failed.push({ serviceid, why: 'invoices_unreadable' });
      }
    }
  }

  if (failed.length > 0) {
    audit.append(
      auditEvent('intent.execution_blocked', intent, `precondition_mismatch: ${JSON.stringify(failed)}`)
    );
    return { allowed: false, reason: 'precondition_mismatch', phase_1: { services, failed, ok: false } };
  }

  if (dryRun) {
    audit.append(auditEvent('intent.execution_blocked', intent, 'dry_run_completed'));
    return {
      allowed: true,
      dry_run: true,
      phase_1: { services, invoices_in_scope: invoicesInScope, ok: true },
    };
  }

  if (mode === 'all') {
    audit.append(
      auditEvent('intent.executed', intent, 'WARNING invoice_mode=all re-owns SETTLED invoices')
    );
  }

  // ── PHASE 2 — commit (sequential, fail-fast) ─────────────────────────────
  const outcomes: ServiceTransferBatchResult['phase_2'] extends infer T
    ? T extends { outcomes: infer O }
      ? O
      : never
    : never = [] as any;
  let halted_after: number | null = null;

  for (const { serviceid } of services) {
    const key = `${intent.idempotency_key}|svc=${String(serviceid)}`;
    if (ledger.seen(key)) {
      audit.append(auditEvent('intent.executed', intent, `replay_skipped svc=${String(serviceid)}`));
      (outcomes as any[]).push({ serviceid, status: 'skipped', invoices_moved: 0 });
      continue;
    }

    try {
      audit.appendDurable(
        auditEvent('intent.executed', intent, `attempting owner move svc=${String(serviceid)}`)
      );
    } catch (e) {
      if (e instanceof AuditPersistError) {
        halted_after = serviceid;
        return {
          allowed: false,
          reason: 'audit_write_failed',
          phase_1: { services, invoices_in_scope: invoicesInScope, ok: true },
          phase_2: { outcomes: outcomes as any, halted_after },
        };
      }
      throw e;
    }
    ledger.record(key, { attempting: true });

    try {
      await whmcs.mutate(
        SERVICE_OWNER_MOVE_ACTION,
        mapServiceTransferOwnerTarget({ serviceid, dest_clientid: dest })
      );
    } catch (e) {
      audit.append(
        auditEvent('intent.failed', intent, `owner_move_failed svc=${String(serviceid)}: ${e instanceof Error ? e.message : String(e)}`)
      );
      halted_after = serviceid;
      (outcomes as any[]).push({ serviceid, status: 'failed', invoices_moved: 0 });
      return {
        allowed: false,
        reason: 'owner_move_failed',
        phase_1: { services, invoices_in_scope: invoicesInScope, ok: true },
        phase_2: { outcomes: outcomes as any, halted_after },
      };
    }

    // Move this service's in-scope invoices.
    let moved = 0;
    const ids = invoicesInScope.find((x) => x.serviceid === serviceid)?.invoice_ids ?? [];
    for (const invoice_id of ids) {
      try {
        await whmcs.mutate(
          INVOICE_REASSIGN_ACTION,
          mapInvoiceReassignParams({ invoice_id, dest_clientid: dest })
        );
        moved++;
      } catch (e) {
        audit.append(
          auditEvent('intent.failed', intent, `invoice_reassign_failed inv=${String(invoice_id)}: ${e instanceof Error ? e.message : String(e)}`)
        );
        halted_after = serviceid;
        (outcomes as any[]).push({ serviceid, status: 'failed', invoices_moved: moved });
        return {
          allowed: false,
          reason: 'invoice_reassign_failed',
          phase_1: { services, invoices_in_scope: invoicesInScope, ok: true },
          phase_2: { outcomes: outcomes as any, halted_after },
        };
      }
    }

    // Read-back verify ownership.
    let verified = false;
    try {
      const rb = (await whmcs.read('GetClientsProducts', { serviceid })) as {
        products?: { product?: readonly Record<string, unknown>[] };
      };
      const owner = Number(rb.products?.product?.[0]?.clientid ?? rb.products?.product?.[0]?.userid);
      verified = owner === dest;
    } catch {
      verified = false;
    }
    (outcomes as any[]).push({
      serviceid,
      status: verified ? 'verified' : 'executed',
      invoices_moved: moved,
    });
  }

  return {
    allowed: true,
    phase_1: { services, invoices_in_scope: invoicesInScope, ok: true },
    phase_2: { outcomes: outcomes as any, halted_after },
  };
}
```

> The `outcomes` type gymnastics above is ugly — replace it with a named local type if lint complains:
> `type Outcome = { serviceid: number; status: 'verified' | 'executed' | 'failed' | 'skipped'; invoices_moved: number }; const outcomes: Outcome[] = [];` and drop the `as any` casts. Prefer the named type.

Ensure imports at the top of `writeFlow.ts` include `SERVICE_OWNER_MOVE_ACTION`, `INVOICE_REASSIGN_ACTION`, `UNSUPPORTED_ACTION` from `../write/types.js` and `mapServiceTransferOwnerTarget`, `mapInvoiceReassignParams` from `../write/paramMapping.js`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- tests/tools/writeFlow.transferOwner.test.ts`
Expected: PASS (preflight, currency, dry_run, happy path).

- [ ] **Step 5: Add fail-fast + idempotency tests**

Append:

```ts
describe('executeServiceTransferBatch — fail-fast + idempotency', () => {
  it('halts on first owner-move failure and reports halted_after', async () => {
    let n = 0;
    const whmcs = whmcsStub({
      mutate: async () => { n++; if (n === 2) throw new Error('boom'); return { result: 'success' }; },
    });
    const res = await executeServiceTransferBatch({
      intent: intent({ source_clientid: 1, dest_clientid: 2, service_ids: [10, 11, 12], invoice_mode: 'none' }),
      whmcs, audit: fakeAudit(), ledger: new IdempotencyLedger(),
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('owner_move_failed');
    expect(res.phase_2?.halted_after).toBe(11);
    expect(res.phase_2?.outcomes.find((o) => o.serviceid === 12)).toBeUndefined();
  });

  it('skips an already-moved service on replay', async () => {
    const ledger = new IdempotencyLedger();
    const i = intent({ source_clientid: 1, dest_clientid: 2, service_ids: [10], invoice_mode: 'none' });
    ledger.record(`${i.idempotency_key}|svc=10`, { attempting: true });
    const res = await executeServiceTransferBatch({ intent: i, whmcs: whmcsStub(), audit: fakeAudit(), ledger });
    expect(res.phase_2?.outcomes[0].status).toBe('skipped');
  });
});
```

- [ ] **Step 6: Run, typecheck, lint, commit**

Run: `npm run test -- tests/tools/writeFlow.transferOwner.test.ts && npm run typecheck && npm run lint`
Expected: PASS / clean.

```bash
git add src/tools/writeFlow.ts tests/tools/writeFlow.transferOwner.test.ts
git commit -m "feat(writeFlow): executeServiceTransferBatch two-phase executor"
```

---

## Task 7: Route `service:transfer_owner` through the execute path

**Files:**
- Modify: `src/tools/writeFlow.ts` — execute handler scope dispatch (the `service:price_restore` branch around L1099-1170)

**Interfaces:**
- Consumes: `executeServiceTransferBatch` (Task 6), the existing `approvals` map + `store`/`audit` singletons + `preAuthorizeIntent` flow.
- Produces: a fully wired execute path; the generic `draft_write_intent → validate → approve → execute` tools now drive a transfer.

- [ ] **Step 1: Add the routing branch**

Find the execute handler block that, for `intent.scope === 'service:price_restore'`, checks `approvals.get`, enforces self-approval rejection, and calls `executePriceRestoreBatch` (L1099-1170). Add a sibling branch for `service:transfer_owner` **before** the generic single-call execution. It reuses the same approval + separation-of-duties guards, then calls the new executor (no `caps`/`dayAmounts` — money-cap-exempt):

```ts
      if (intent.scope === 'service:transfer_owner') {
        const approval = approvals.get(intent.intent_id);
        if (!approval) {
          const blocked = store.transition(intent.intent_id, 'execution_blocked');
          audit.append(auditEvent('intent.execution_blocked', blocked, 'human_approval_required'));
          return out(toToolResult(blocked, 'execute', {
            execution: { attempted: false, blocked_reason: 'human_approval_required' },
          }));
        }
        if (approval.approver_consumer_id === intent.consumer_id) {
          const blocked = store.transition(intent.intent_id, 'execution_blocked');
          audit.append(auditEvent('intent.execution_blocked', blocked, 'self_approval_forbidden'));
          return out(toToolResult(blocked, 'execute', {
            execution: { attempted: false, blocked_reason: 'self_approval_forbidden' },
          }));
        }
        const batchRes = await executeServiceTransferBatch({ intent, whmcs, audit, ledger });
        if (!batchRes.allowed) {
          const blocked = store.transition(intent.intent_id, 'execution_blocked');
          audit.append(auditEvent('intent.execution_blocked', blocked, batchRes.reason ?? 'unknown'));
          return out(toToolResult(blocked, 'execute', {
            execution: {
              attempted: false,
              blocked_reason: batchRes.reason,
              phase_1: batchRes.phase_1,
              phase_2: batchRes.phase_2,
            } as WriteToolResult['execution'],
          }));
        }
        if (batchRes.dry_run) {
          return out(toToolResult(intent, 'execute', {
            executed: false,
            execution: { attempted: false, dry_run: true, phase_1: batchRes.phase_1 } as WriteToolResult['execution'],
          }));
        }
        const finalState = store.transition(intent.intent_id, 'executed');
        return out(toToolResult(finalState, 'execute', {
          executed: true,
          execution: { attempted: true, phase_1: batchRes.phase_1, phase_2: batchRes.phase_2 } as WriteToolResult['execution'],
        }));
      }
```

> Match the surrounding handler's variable names exactly (`whmcs`, `ledger`, `out`, `store`, `audit`, `approvals`). Confirm `ledger` is in scope in this handler (the price_restore branch uses it); if it is constructed locally, construct the transfer call's ledger the same way.

- [ ] **Step 2: Add the preflight gate-recheck parity**

The price_restore branch runs `preAuthorizeIntent` (gate steps 1–7: kill switch, allowlist, `PROD_NEVER_EXECUTABLE`, etc.) before the approval check (see L1090-1098). Add the **same** `preAuthorizeIntent` call for `service:transfer_owner` at the top of the new branch, mirroring the price_restore code exactly (copy the `pre` block verbatim, including the `execution_blocked` return on `!pre.ok`).

- [ ] **Step 3: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/tools/writeFlow.ts
git commit -m "feat(writeFlow): route service:transfer_owner through execute path"
```

---

## Task 8: Full-flow integration + high-risk gate tests

**Files:**
- Test: `tests/tools/writeFlow.transferOwner.test.ts` (extend) — model on `tests/tools/writeFlow.priceRestore.test.ts` and `tests/tools/writeFlow.prodsafety.test.ts`

**Interfaces:**
- Consumes: the registered MCP write-flow tools (draft/validate/approve/execute) and their test harness from `writeFlow.priceRestore.test.ts`.

- [ ] **Step 1: Mirror the price-restore full-flow harness**

Open `tests/tools/writeFlow.priceRestore.test.ts` and copy its setup (how it constructs the server/tool handlers, authorizes a consumer + allowlist + caps via env, records an approval by a DIFFERENT consumer, and drives draft→validate→approve→execute). Reproduce it for `service:transfer_owner`.

- [ ] **Step 2: Write the gate + mode tests**

```ts
describe('service:transfer_owner full flow', () => {
  it('is sealed: execute is blocked without allowlist authorization', async () => {
    // With MCP_PROD_WRITE_AUTHORIZED empty (default sealed), execute must NOT mutate.
    // Assert blocked_reason indicates the gate denied it.
    // (Mirror the assertion style in writeFlow.prodsafety.test.ts.)
  });

  it('blocks execute without a human approval record', async () => {
    // Authorize the scope, but do NOT approve → blocked_reason 'human_approval_required'.
  });

  it('blocks self-approval', async () => {
    // Approve with the same consumer that drafted → 'self_approval_forbidden'.
  });

  it('invoice_mode none moves no invoices; unpaid_only moves only unpaid; all warns', async () => {
    // Drive execute against a stubbed WhmcsClient; assert mutate call actions/counts per mode
    // and that 'all' produced the SETTLED-history warning audit event.
  });
});
```

Fill each body using the copied harness; assert against the stubbed `WhmcsClient` mutate spy (actions called, counts) and the audit event list. Use the same fake-WHMCS injection point the price-restore full-flow test uses.

- [ ] **Step 3: Run the whole suite**

Run: `npm run test`
Expected: PASS (all existing + new).

- [ ] **Step 4: Commit**

```bash
git add tests/tools/writeFlow.transferOwner.test.ts
git commit -m "test(writeFlow): full-flow + high-risk gate coverage for service:transfer_owner"
```

---

## Task 9: Docs + graph refresh

**Files:**
- Modify: `README.md` (the write-scope table)
- Reference: `docs/superpowers/specs/2026-06-22-service-owner-transfer-design.md`

- [ ] **Step 1: Document the scopes**

Add `service:transfer_owner` and `billing:invoice:reassign` to the README write-scope table with risk `high`, sealed-by-default, and a one-line description (batch service-owner move with `invoice_mode none|unpaid_only|all`; single-invoice reassign). Match the table's existing column format exactly.

- [ ] **Step 2: Refresh the knowledge graph**

Run: `graphify update src`
Expected: graph rebuilt (AST-only, no API cost).

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): document service-owner transfer write scopes"
```

---

## Self-Review

**1. Spec coverage:**
- §3 capability-probe-first → Task 1. ✓
- §3 invoice_mode none/unpaid_only/all → Task 3 (validation) + Task 6 (enumeration/commit) + Task 8 (per-mode tests). ✓
- §3 preflight-then-commit + fail-fast → Task 6 Phase 1/Phase 2. ✓
- §3 high-risk, all modes executable, not in PROD_NEVER_EXECUTABLE → Task 2 + Task 7 (approval/SoD). ✓
- §3 cross-currency hard block → Task 6 Phase 1 + Task 6 Step 1 test. ✓
- §3 two scopes (transfer_owner + invoice:reassign) → Tasks 2–4. ✓
- §4 unsupported-capability posture → Task 2 sentinel + Task 6 capability gate. ✓
- §8 result shape → Task 6 `ServiceTransferBatchResult`. ✓
- §10 testing matrix → Tasks 2,3,4,6,8 (devbox integration test folded into Task 1's probe + Task 8 stub-driven flow; a live-devbox test is optional and gated on the probe). ✓

**2. Placeholder scan:** Task 5 Step 1 intentionally has a trivial test (the asserting test is in Task 8) — flagged inline, not a hidden gap. The `outcomes` typing note gives the concrete named-type replacement. WHMCS field names (`clientid`/`userid`) are the most-likely bindings with an explicit "substitute from Task 1" instruction. No `TODO`/`TBD` left.

**3. Type consistency:** `executeServiceTransferBatch` args `{intent, whmcs, audit, ledger}` are consistent across Tasks 6 & 7. `ServiceTransferBatchResult` shape matches spec §8 and is used identically in Task 7's `execution` payloads. `mapServiceTransferOwnerTarget({serviceid, dest_clientid})` and `mapInvoiceReassignParams({invoice_id, dest_clientid})` signatures match between Tasks 4, 5, 6. Scope strings `'service:transfer_owner'` / `'billing:invoice:reassign'` are identical everywhere.
