# Service Owner Transfer Implementation Plan (direct-DB, revised)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

> **REVISED 2026-06-22 after Task 1 (capability probe, commit `c42d005`):** WHMCS's API
> cannot reassign service/invoice owners. This plan implements a **transactional direct-DB**
> executor, **opt-in** via a `MCP_WHMCS_DB_*` DSN; with no DSN it returns
> `unsupported_capability` (today's safe posture). Task 1 is DONE — start at Task 2.

**Goal:** Governed, auditable, transactional transfer of services (a…n) from a source to a destination client, with operator-selected invoice handling, via direct DB writes enabled only when an operator opts into a DB DSN.

**Architecture:** Two high-risk write scopes (`service:transfer_owner` batch + `billing:invoice:reassign`) flow through the existing draft→validate→approve→execute machinery. A new lazy `mysql2` pool (`WhmcsDb`) and a pure SQL cascade builder (`transferCascade`) back a two-phase executor: read-only preflight (abort-all-on-mismatch, `dry_run` early-exit) then a **single DB transaction** (commit-or-rollback) with source-guarded UPDATEs and read-back verify.

**Tech Stack:** Node.js, TypeScript (ESM, `.js` import specifiers), Vitest, `mysql2/promise`, WHMCS Admin API (reads only) via `WhmcsClient`, MariaDB.

## Global Constraints

- ESM imports use `.js` specifiers even for `.ts` sources. Copy from existing files.
- Both scopes **sealed by default**; never add to any default allowlist; both **`high`** risk; **NOT** in `PROD_NEVER_EXECUTABLE`/`_SCOPES`.
- **Opt-in DB:** the DB pool is constructed only when `isDbConfigured()` is true (host+user+name all set). Default deployment opens **no** DB connection and needs no credentials.
- **`unsupported_capability`:** the executor's FIRST check — if DB not configured, audit + return `{allowed:false, reason:'unsupported_capability'}`, no connection attempted.
- **Every UPDATE is source-guarded** (`AND userid = <source_clientid>`) so a wrong precondition or concurrent change yields 0 rows, never a cross-tenant clobber.
- **One transaction** for the whole batch: any failure (throw, or the service row's guarded UPDATE affecting 0 rows) rolls back everything.
- Owner column is `userid` (verified WHMCS 9): `tblhosting` (id=serviceid), `tblhostingaddons` (hostingid=serviceid), `tblsslorders` (serviceid), `tblinvoices` (id), `tblinvoiceitems` (invoiceid; relid=serviceid). `tblhostingconfigoptions` has no owner column.
- **Cross-currency** = hard preflight failure. Batch size bounded by `MCP_TRANSFER_MAX_BATCH` (default 50).
- Never log DB credentials; audit records ids + counts only.
- `npm run typecheck && npm run lint && npm run test` green before every commit. After code lands, `graphify update src`.

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `package.json` | add `mysql2` dependency | Modify (Task 2) |
| `src/write/types.ts` | scopes, risk, `DB_DIRECT_ACTION` sentinel | Modify (Task 2) |
| `src/config.ts` | `MCP_WHMCS_DB_*`, `MCP_TRANSFER_MAX_BATCH` | Modify (Task 2) |
| `src/write/validation.ts` | required params + rules for both scopes | Modify (Task 3) |
| `src/whmcs/WhmcsDb.ts` | lazy mysql2 pool, `isDbConfigured`, `withTransaction` | **Create (Task 4)** |
| `src/write/transferCascade.ts` | pure SQL builder + transactional runner | **Create (Task 5)** |
| `src/tools/writeFlow.ts` | `executeServiceTransferBatch`, routing, preview | Modify (Tasks 6–7) |
| `tests/write/transferOwnerTypes.test.ts` | scope/risk units | Create (Task 2) |
| `tests/write/transferOwnerValidation.test.ts` | validation units | Create (Task 3) |
| `tests/write/whmcsDb.test.ts` | config-gating units | Create (Task 4) |
| `tests/write/transferCascade.test.ts` | SQL builder + runner units | Create (Task 5) |
| `tests/tools/writeFlow.transferOwner.test.ts` | executor + full-flow + capability-off | Create (Tasks 6–8) |
| `.env.example`, `README.md` | document opt-in DSN + scopes | Modify (Task 9) |

---

## Task 2: Scopes, sentinel action, config, mysql2 dependency

**Files:** Modify `src/write/types.ts`, `src/config.ts`, `package.json`; Create `tests/write/transferOwnerTypes.test.ts`.

**Interfaces — Produces:** `WriteScope` includes `'service:transfer_owner'`, `'billing:invoice:reassign'`; exported `DB_DIRECT_ACTION` from types.ts; `config.MCP_TRANSFER_MAX_BATCH:number`, `config.MCP_WHMCS_DB_HOST/PORT/USER/PASSWORD/NAME/SSL`.

- [ ] **Step 1: Failing test** — create `tests/write/transferOwnerTypes.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { WRITE_SCOPES, SCOPE_ACTION, SCOPE_RISK, PROD_NEVER_EXECUTABLE_SCOPES, DB_DIRECT_ACTION } from '../../src/write/types.js';

describe('service-owner-transfer scopes', () => {
  it('registers both scopes', () => {
    expect(WRITE_SCOPES).toContain('service:transfer_owner');
    expect(WRITE_SCOPES).toContain('billing:invoice:reassign');
  });
  it('uses the DB-direct sentinel action', () => {
    expect(SCOPE_ACTION['service:transfer_owner']).toBe(DB_DIRECT_ACTION);
    expect(SCOPE_ACTION['billing:invoice:reassign']).toBe(DB_DIRECT_ACTION);
  });
  it('are high risk', () => {
    expect(SCOPE_RISK['service:transfer_owner']).toBe('high');
    expect(SCOPE_RISK['billing:invoice:reassign']).toBe('high');
  });
  it('are not permanently prod-sealed', () => {
    expect(PROD_NEVER_EXECUTABLE_SCOPES.has('service:transfer_owner')).toBe(false);
    expect(PROD_NEVER_EXECUTABLE_SCOPES.has('billing:invoice:reassign')).toBe(false);
  });
});
```

- [ ] **Step 2: Run → FAIL** — `npm run test -- tests/write/transferOwnerTypes.test.ts` (scopes/exports missing).

- [ ] **Step 3:** In `src/write/types.ts`, above `WRITE_SCOPES`, add:

```ts
/**
 * Sentinel "action" for scopes executed via a direct DB write rather than a
 * WHMCS API action (the API cannot reassign service/invoice owners — see
 * docs/runbooks/write-capability-probe.md). Retained in SCOPE_ACTION so the
 * frozen-map invariant holds and audit has a stable label; the execute path
 * routes these scopes to the DB executor, never whmcs.mutate.
 */
export const DB_DIRECT_ACTION = '__db_direct__';
```

Add to `WRITE_SCOPES` (after `'ticket:merge'`):
```ts
  // ── Service / invoice owner transfer (direct-DB, opt-in DSN) ─────────────
  'service:transfer_owner',
  'billing:invoice:reassign',
```
Add to `SCOPE_ACTION`:
```ts
  'service:transfer_owner': DB_DIRECT_ACTION,
  'billing:invoice:reassign': DB_DIRECT_ACTION,
```
Add to `SCOPE_RISK`:
```ts
  // Cross-client ownership reassignment via direct DB write → high (allowlist +
  // human approval + separation of duties). Sealed by default; opt-in DSN.
  'service:transfer_owner': 'high',
  'billing:invoice:reassign': 'high',
```

- [ ] **Step 4:** In `src/config.ts`, add (matching the existing parse-helper style; strings default to `''`, port to 3306, batch to 50, SSL bool to false):

```ts
  MCP_TRANSFER_MAX_BATCH: parseIntEnv(process.env.MCP_TRANSFER_MAX_BATCH, 50),
  MCP_WHMCS_DB_HOST: process.env.MCP_WHMCS_DB_HOST ?? '',
  MCP_WHMCS_DB_PORT: parseIntEnv(process.env.MCP_WHMCS_DB_PORT, 3306),
  MCP_WHMCS_DB_USER: process.env.MCP_WHMCS_DB_USER ?? '',
  MCP_WHMCS_DB_PASSWORD: process.env.MCP_WHMCS_DB_PASSWORD ?? '',
  MCP_WHMCS_DB_NAME: process.env.MCP_WHMCS_DB_NAME ?? '',
  MCP_WHMCS_DB_SSL: (process.env.MCP_WHMCS_DB_SSL ?? '').toLowerCase() === 'true',
```
(Use whatever int-parse helper config.ts already defines; do not invent a new one.)

- [ ] **Step 5:** Add the dependency: `npm install mysql2`. Verify it lands in `package.json` `dependencies`.

- [ ] **Step 6: Run → PASS** — `npm run test -- tests/write/transferOwnerTypes.test.ts` (4 tests).

- [ ] **Step 7:** `npm run typecheck && npm run lint`, then commit:
```bash
git add src/write/types.ts src/config.ts package.json package-lock.json tests/write/transferOwnerTypes.test.ts
git commit -m "feat(write): register transfer-owner scopes + DB config + mysql2 dep"
```

---

## Task 3: Validation rules

**Files:** Modify `src/write/validation.ts`; Create `tests/write/transferOwnerValidation.test.ts`.

**Interfaces — Produces:** validation codes `invalid_service_ids_shape`, `invalid_clientid`, `same_source_dest`, `invalid_invoice_mode`, `invalid_dry_run`, `invalid_invoiceid`.

- [ ] **Step 1: Failing test** — create `tests/write/transferOwnerValidation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateIntent } from '../../src/write/validation.js';
import { createDraftIntent } from '../../src/write/intents.js';
import type { WriteScope } from '../../src/write/types.js';

function draft(scope: WriteScope, params: Record<string, unknown>) {
  return createDraftIntent({ consumer_id: 'c1', scope, params, naturalKey: 'k', preconditions: {}, projected_effect: 't' });
}
const codes = (i: ReturnType<typeof draft>) => validateIntent(i).issues.map((x) => x.code);
const ok = { source_clientid: 1, dest_clientid: 2, service_ids: [10, 11], invoice_mode: 'unpaid_only' };

describe('service:transfer_owner validation', () => {
  it('accepts well-formed', () => expect(validateIntent(draft('service:transfer_owner', ok)).ok).toBe(true));
  it('rejects empty service_ids', () => expect(codes(draft('service:transfer_owner', { ...ok, service_ids: [] }))).toContain('invalid_service_ids_shape'));
  it('rejects non-positive id', () => expect(codes(draft('service:transfer_owner', { ...ok, service_ids: [10, 0] }))).toContain('invalid_service_ids_shape'));
  it('rejects source===dest', () => expect(codes(draft('service:transfer_owner', { ...ok, dest_clientid: 1 }))).toContain('same_source_dest'));
  it('rejects bad invoice_mode', () => expect(codes(draft('service:transfer_owner', { ...ok, invoice_mode: 'most' }))).toContain('invalid_invoice_mode'));
  it('rejects non-bool dry_run', () => expect(codes(draft('service:transfer_owner', { ...ok, dry_run: 'y' }))).toContain('invalid_dry_run'));
});
describe('billing:invoice:reassign validation', () => {
  it('accepts well-formed', () => expect(validateIntent(draft('billing:invoice:reassign', { invoice_id: 5, dest_clientid: 2 })).ok).toBe(true));
  it('rejects non-positive invoice_id', () => expect(codes(draft('billing:invoice:reassign', { invoice_id: 0, dest_clientid: 2 }))).toContain('invalid_invoiceid'));
});
```
(Confirm `validateIntent`'s return shape `.ok`/`.issues` against the file; mirror `tests/write/priceRestoreValidation.test.ts` if it differs.)

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3:** Add to `REQUIRED_PARAMS` in `src/write/validation.ts`:
```ts
  'service:transfer_owner': ['source_clientid', 'dest_clientid', 'service_ids', 'invoice_mode'],
  'billing:invoice:reassign': ['invoice_id', 'dest_clientid'],
```

- [ ] **Step 4:** After the `service:price_restore` validation block, add the two custom blocks:

```ts
  if (intent.scope === 'service:transfer_owner') {
    const src = intent.params.source_clientid;
    const dst = intent.params.dest_clientid;
    if (typeof src !== 'number' || !Number.isInteger(src) || src <= 0)
      issues.push({ code: 'invalid_clientid', severity: 'error', message: 'service:transfer_owner `source_clientid` must be a positive integer' });
    if (typeof dst !== 'number' || !Number.isInteger(dst) || dst <= 0)
      issues.push({ code: 'invalid_clientid', severity: 'error', message: 'service:transfer_owner `dest_clientid` must be a positive integer' });
    if (typeof src === 'number' && src === dst)
      issues.push({ code: 'same_source_dest', severity: 'error', message: 'service:transfer_owner source and destination clients must differ' });
    const ids = intent.params.service_ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((s) => typeof s !== 'number' || !Number.isInteger(s) || s <= 0))
      issues.push({ code: 'invalid_service_ids_shape', severity: 'error', message: 'service:transfer_owner `service_ids` must be a non-empty array of positive integers' });
    const mode = intent.params.invoice_mode;
    if (mode !== 'none' && mode !== 'unpaid_only' && mode !== 'all')
      issues.push({ code: 'invalid_invoice_mode', severity: 'error', message: "service:transfer_owner `invoice_mode` must be 'none' | 'unpaid_only' | 'all'" });
    if (intent.params.dry_run !== undefined && typeof intent.params.dry_run !== 'boolean')
      issues.push({ code: 'invalid_dry_run', severity: 'error', message: 'service:transfer_owner `dry_run` must be a boolean when provided' });
  }
  if (intent.scope === 'billing:invoice:reassign') {
    const inv = intent.params.invoice_id;
    if (typeof inv !== 'number' || !Number.isInteger(inv) || inv <= 0)
      issues.push({ code: 'invalid_invoiceid', severity: 'error', message: 'billing:invoice:reassign `invoice_id` must be a positive integer' });
    const dst = intent.params.dest_clientid;
    if (typeof dst !== 'number' || !Number.isInteger(dst) || dst <= 0)
      issues.push({ code: 'invalid_clientid', severity: 'error', message: 'billing:invoice:reassign `dest_clientid` must be a positive integer' });
  }
```

- [ ] **Step 5: Run → PASS** (8 tests). **Step 6:** typecheck+lint, commit:
```bash
git add src/write/validation.ts tests/write/transferOwnerValidation.test.ts
git commit -m "feat(write): validation for transfer-owner scopes"
```

---

## Task 4: `WhmcsDb` — lazy opt-in mysql2 pool

**Files:** Create `src/whmcs/WhmcsDb.ts`, `tests/write/whmcsDb.test.ts`.

**Interfaces — Produces:**
```ts
export function isDbConfigured(cfg?: DbConfig): boolean;          // host+user+name all non-empty
export interface DbTx { query(sql: string, params: unknown[]): Promise<{ affectedRows: number; rows: any[] }>; }
export function getWhmcsDb(): { withTransaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> };
```

- [ ] **Step 1: Failing test** — `tests/write/whmcsDb.test.ts` (pure config-gating; no real DB):

```ts
import { describe, it, expect } from 'vitest';
import { isDbConfigured } from '../../src/whmcs/WhmcsDb.js';

describe('isDbConfigured', () => {
  it('false when host/user/name missing', () => {
    expect(isDbConfigured({ host: '', port: 3306, user: '', password: '', name: '', ssl: false })).toBe(false);
    expect(isDbConfigured({ host: 'h', port: 3306, user: 'u', password: '', name: '', ssl: false })).toBe(false);
  });
  it('true when host+user+name all set', () => {
    expect(isDbConfigured({ host: 'h', port: 3306, user: 'u', password: 'p', name: 'db', ssl: false })).toBe(true);
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `src/whmcs/WhmcsDb.ts`:**

```ts
/**
 * Opt-in WHMCS database access for the owner-transfer feature. The pool is
 * created LAZILY on first use and ONLY when a DSN is configured — the default
 * deployment (no MCP_WHMCS_DB_*) opens no connection and holds no credentials.
 * Direct DB writes are used solely because the WHMCS API cannot reassign
 * service/invoice owners (see docs/runbooks/write-capability-probe.md).
 */
import mysql from 'mysql2/promise';
import { config } from '../config.js';

export interface DbConfig {
  host: string; port: number; user: string; password: string; name: string; ssl: boolean;
}
export interface DbTx {
  query(sql: string, params: unknown[]): Promise<{ affectedRows: number; rows: unknown[] }>;
}

export function dbConfigFromEnv(): DbConfig {
  return {
    host: config.MCP_WHMCS_DB_HOST, port: config.MCP_WHMCS_DB_PORT,
    user: config.MCP_WHMCS_DB_USER, password: config.MCP_WHMCS_DB_PASSWORD,
    name: config.MCP_WHMCS_DB_NAME, ssl: config.MCP_WHMCS_DB_SSL,
  };
}
export function isDbConfigured(cfg: DbConfig = dbConfigFromEnv()): boolean {
  return cfg.host !== '' && cfg.user !== '' && cfg.name !== '';
}

let pool: mysql.Pool | undefined;
function getPool(cfg: DbConfig): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool({
      host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password,
      database: cfg.name, connectionLimit: 4, waitForConnections: true,
      ...(cfg.ssl ? { ssl: {} } : {}),
    });
  }
  return pool;
}

export interface WhmcsDb {
  withTransaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T>;
}
export function getWhmcsDb(cfg: DbConfig = dbConfigFromEnv()): WhmcsDb {
  if (!isDbConfigured(cfg)) throw new Error('WhmcsDb: DB not configured');
  return {
    async withTransaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
      const conn = await getPool(cfg).getConnection();
      try {
        await conn.beginTransaction();
        const tx: DbTx = {
          async query(sql, params) {
            const [res] = await conn.query(sql, params);
            const r = res as { affectedRows?: number };
            return { affectedRows: r.affectedRows ?? 0, rows: Array.isArray(res) ? (res as unknown[]) : [] };
          },
        };
        const out = await fn(tx);
        await conn.commit();
        return out;
      } catch (e) {
        try { await conn.rollback(); } catch { /* best effort */ }
        throw e;
      } finally {
        conn.release();
      }
    },
  };
}

/** Test-only: drop the cached pool so a new config takes effect. */
export function __resetPoolForTests(): void { pool = undefined; }
```

- [ ] **Step 4: Run → PASS.** **Step 5:** typecheck+lint, commit:
```bash
git add src/whmcs/WhmcsDb.ts tests/write/whmcsDb.test.ts
git commit -m "feat(whmcs): opt-in lazy WhmcsDb pool with withTransaction"
```

---

## Task 5: `transferCascade` — pure SQL builder + runner

**Files:** Create `src/write/transferCascade.ts`, `tests/write/transferCascade.test.ts`.

**Interfaces — Produces:**
```ts
export interface SqlStatement { sql: string; params: unknown[] }
export function buildServiceMoveStatements(serviceid: number, source: number, dest: number, invoiceIds: readonly number[]): SqlStatement[];
export async function runServiceMoves(tx: DbTx, plans: { serviceid: number; invoiceIds: number[] }[], source: number, dest: number): Promise<void>; // throws TransferRollback on a 0-row service guard
export class TransferRollback extends Error { readonly serviceid: number; constructor(serviceid: number); }
```

- [ ] **Step 1: Failing test** — `tests/write/transferCascade.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildServiceMoveStatements, runServiceMoves, TransferRollback } from '../../src/write/transferCascade.js';
import type { DbTx } from '../../src/whmcs/WhmcsDb.js';

describe('buildServiceMoveStatements', () => {
  it('emits source-guarded updates for service + addons + ssl + each invoice', () => {
    const s = buildServiceMoveStatements(10, 1, 2, [100]);
    const sqls = s.map((x) => x.sql.replace(/\s+/g, ' ').trim());
    expect(sqls).toContain('UPDATE tblhosting SET userid = ? WHERE id = ? AND userid = ?');
    expect(sqls).toContain('UPDATE tblhostingaddons SET userid = ? WHERE hostingid = ? AND userid = ?');
    expect(sqls).toContain('UPDATE tblsslorders SET userid = ? WHERE serviceid = ? AND userid = ?');
    expect(sqls).toContain('UPDATE tblinvoices SET userid = ? WHERE id = ? AND userid = ?');
    expect(sqls).toContain('UPDATE tblinvoiceitems SET userid = ? WHERE invoiceid = ? AND userid = ?');
    // every statement carries dest, key, source — and source guard is present
    expect(s[0].params).toEqual([2, 10, 1]);
  });
  it('omits invoice statements when no invoiceIds', () => {
    const s = buildServiceMoveStatements(10, 1, 2, []);
    expect(s.some((x) => x.sql.includes('tblinvoices'))).toBe(false);
  });
});

describe('runServiceMoves', () => {
  function fakeTx(affectedFor: (sql: string) => number) {
    const calls: { sql: string; params: unknown[] }[] = [];
    const tx: DbTx = { async query(sql, params) { calls.push({ sql, params }); return { affectedRows: affectedFor(sql), rows: [] }; } };
    return { tx, calls };
  }
  it('runs all statements when service guard affects a row', async () => {
    const { tx, calls } = fakeTx(() => 1);
    await runServiceMoves(tx, [{ serviceid: 10, invoiceIds: [100] }], 1, 2);
    expect(calls.length).toBe(5);
  });
  it('throws TransferRollback when the service-row guard affects 0 rows', async () => {
    const { tx } = fakeTx((sql) => (sql.includes('tblhosting ') ? 0 : 1));
    await expect(runServiceMoves(tx, [{ serviceid: 10, invoiceIds: [] }], 1, 2))
      .rejects.toBeInstanceOf(TransferRollback);
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement `src/write/transferCascade.ts`:**

```ts
/**
 * Pure SQL cascade for moving a WHMCS service (and its addons, SSL orders, and
 * in-scope invoices) to a new owning client. Owner column is `userid`
 * (verified WHMCS 9 schema). Every UPDATE is guarded by `AND userid = <source>`
 * so a wrong precondition or concurrent change affects 0 rows rather than
 * clobbering another tenant. tblhostingconfigoptions has no owner column (keyed
 * by relid) so it follows the service with no update.
 */
import type { DbTx } from '../whmcs/WhmcsDb.js';

export interface SqlStatement { readonly sql: string; readonly params: readonly unknown[]; }

export class TransferRollback extends Error {
  readonly serviceid: number;
  constructor(serviceid: number) {
    super(`transfer_rolled_back: service ${serviceid} ownership guard affected 0 rows`);
    this.name = 'TransferRollback';
    this.serviceid = serviceid;
  }
}

export function buildServiceMoveStatements(
  serviceid: number, source: number, dest: number, invoiceIds: readonly number[]
): SqlStatement[] {
  const out: SqlStatement[] = [
    { sql: 'UPDATE tblhosting SET userid = ? WHERE id = ? AND userid = ?', params: [dest, serviceid, source] },
    { sql: 'UPDATE tblhostingaddons SET userid = ? WHERE hostingid = ? AND userid = ?', params: [dest, serviceid, source] },
    { sql: 'UPDATE tblsslorders SET userid = ? WHERE serviceid = ? AND userid = ?', params: [dest, serviceid, source] },
  ];
  for (const invoiceid of invoiceIds) {
    out.push({ sql: 'UPDATE tblinvoices SET userid = ? WHERE id = ? AND userid = ?', params: [dest, invoiceid, source] });
    out.push({ sql: 'UPDATE tblinvoiceitems SET userid = ? WHERE invoiceid = ? AND userid = ?', params: [dest, invoiceid, source] });
  }
  return out;
}

/**
 * Run the cascade for every service inside an open transaction. The FIRST
 * statement per service is the tblhosting guard; if it affects 0 rows the
 * service is not owned by source (or was moved concurrently) → throw
 * TransferRollback so the caller's transaction rolls the whole batch back.
 */
export async function runServiceMoves(
  tx: DbTx,
  plans: readonly { serviceid: number; invoiceIds: number[] }[],
  source: number, dest: number
): Promise<void> {
  for (const plan of plans) {
    const stmts = buildServiceMoveStatements(plan.serviceid, source, dest, plan.invoiceIds);
    for (let i = 0; i < stmts.length; i++) {
      const res = await tx.query(stmts[i].sql, stmts[i].params as unknown[]);
      if (i === 0 && res.affectedRows === 0) throw new TransferRollback(plan.serviceid);
    }
  }
}
```

> The test matches `tblhosting ` (with trailing space) to target the service guard specifically; the implementation's first statement is the `tblhosting` UPDATE, so ordering is the contract — keep `tblhosting` first.

- [ ] **Step 4: Run → PASS.** **Step 5:** typecheck+lint, commit:
```bash
git add src/write/transferCascade.ts tests/write/transferCascade.test.ts
git commit -m "feat(write): transactional cascade SQL builder + runner"
```

---

## Task 6: Executor `executeServiceTransferBatch`

**Files:** Modify `src/tools/writeFlow.ts`; extend `tests/tools/writeFlow.transferOwner.test.ts` (create).

**Interfaces — Consumes:** `isDbConfigured`, `getWhmcsDb`, `DbTx` (WhmcsDb.js); `runServiceMoves`, `TransferRollback` (transferCascade.js); `config.MCP_TRANSFER_MAX_BATCH`; `WhmcsClient.read` for preflight SELECTs are replaced by DB SELECTs through the same tx-less pool query — use a read helper on the db wrapper. **Produces:** `ServiceTransferBatchResult` (spec §9) + `executeServiceTransferBatch(args)`.

> Preflight reads also go through the DB (the API can't see `userid` reliably and we already require the DSN). Add a `query` method to the WhmcsDb wrapper for non-transactional reads, OR run preflight SELECTs inside the same `withTransaction` before the UPDATEs (preferred — one consistent snapshot). This plan uses **preflight-inside-transaction**: SELECT validations and UPDATEs share one transaction; a failed precondition throws to roll back before any write.

- [ ] **Step 1: Failing tests** — create `tests/tools/writeFlow.transferOwner.test.ts` with a fake DB injected. Because `executeServiceTransferBatch` resolves the DB via `getWhmcsDb()`, accept an **optional injected `db`** parameter for testing (defaulting to `getWhmcsDb()`):

```ts
import { describe, it, expect } from 'vitest';
import { executeServiceTransferBatch } from '../../src/tools/writeFlow.js';
import { createDraftIntent } from '../../src/write/intents.js';
import type { DbTx } from '../../src/whmcs/WhmcsDb.js';

function audit() { const events: any[] = []; return { events, append: (e: any) => events.push(e), appendDurable: (e: any) => events.push(e) } as any; }
function intent(params: Record<string, unknown>) {
  return createDraftIntent({ consumer_id: 'c1', scope: 'service:transfer_owner', params, naturalKey: 'k', preconditions: {}, projected_effect: 't' });
}
// Fake DB: rows keyed by SELECT; UPDATEs report affectedRows from a map.
function fakeDb(opts: { owner?: number; status?: string; destStatus?: string; srcCur?: string; destCur?: string; serviceGuard?: number } = {}) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const tx: DbTx = {
    async query(sql, params) {
      calls.push({ sql, params });
      const s = sql.replace(/\s+/g, ' ').toLowerCase();
      if (s.startsWith('select') && s.includes('tblhosting'))
        return { affectedRows: 0, rows: [{ id: params[0], userid: opts.owner ?? 1, domainstatus: opts.status ?? 'Active' }] };
      if (s.startsWith('select') && s.includes('tblclients'))
        return { affectedRows: 0, rows: [{ id: params[0], status: 'Active', currency_code: (params[0] === 1 ? (opts.srcCur ?? 'USD') : (opts.destCur ?? 'USD')) }] };
      if (s.startsWith('select') && s.includes('tblinvoice'))
        return { affectedRows: 0, rows: [] };
      if (s.startsWith('update') && s.includes('tblhosting '))
        return { affectedRows: opts.serviceGuard ?? 1, rows: [] };
      return { affectedRows: 1, rows: [] };
    },
  };
  const db = { withTransaction: async <T>(fn: (t: DbTx) => Promise<T>) => fn(tx) };
  return { db, calls };
}
const dbConfigured = () => true;

describe('executeServiceTransferBatch', () => {
  it('returns unsupported_capability when DB not configured', async () => {
    const res = await executeServiceTransferBatch({
      intent: intent({ source_clientid: 1, dest_clientid: 2, service_ids: [10], invoice_mode: 'none' }),
      audit: audit(), isDbConfigured: () => false, getDb: () => { throw new Error('should not be called'); },
    } as any);
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('unsupported_capability');
  });

  it('aborts when service not owned by source', async () => {
    const { db } = fakeDb({ owner: 99 });
    const res = await executeServiceTransferBatch({
      intent: intent({ source_clientid: 1, dest_clientid: 2, service_ids: [10], invoice_mode: 'none' }),
      audit: audit(), isDbConfigured: dbConfigured, getDb: () => db as any,
    } as any);
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('precondition_mismatch');
  });

  it('aborts on currency mismatch', async () => {
    const { db } = fakeDb({ destCur: 'EUR' });
    const res = await executeServiceTransferBatch({
      intent: intent({ source_clientid: 1, dest_clientid: 2, service_ids: [10], invoice_mode: 'none' }),
      audit: audit(), isDbConfigured: dbConfigured, getDb: () => db as any,
    } as any);
    expect(res.reason).toBe('precondition_mismatch');
  });

  it('dry_run previews, no UPDATE issued', async () => {
    const { db, calls } = fakeDb();
    const res = await executeServiceTransferBatch({
      intent: intent({ source_clientid: 1, dest_clientid: 2, service_ids: [10], invoice_mode: 'none', dry_run: true }),
      audit: audit(), isDbConfigured: dbConfigured, getDb: () => db as any,
    } as any);
    expect(res.dry_run).toBe(true);
    expect(calls.some((c) => c.sql.toLowerCase().startsWith('update'))).toBe(false);
  });

  it('commits + verifies on happy path', async () => {
    const { db } = fakeDb();
    const res = await executeServiceTransferBatch({
      intent: intent({ source_clientid: 1, dest_clientid: 2, service_ids: [10, 11], invoice_mode: 'none' }),
      audit: audit(), isDbConfigured: dbConfigured, getDb: () => db as any,
    } as any);
    expect(res.allowed).toBe(true);
    expect(res.phase_2?.committed).toBe(true);
  });

  it('rolls back when a service guard affects 0 rows', async () => {
    const { db } = fakeDb({ serviceGuard: 0 });
    const res = await executeServiceTransferBatch({
      intent: intent({ source_clientid: 1, dest_clientid: 2, service_ids: [10], invoice_mode: 'none' }),
      audit: audit(), isDbConfigured: dbConfigured, getDb: () => db as any,
    } as any);
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('transfer_rolled_back');
  });
});
```

- [ ] **Step 2: Run → FAIL** (`executeServiceTransferBatch` not exported).

- [ ] **Step 3: Implement** in `src/tools/writeFlow.ts`. Signature takes injectable `isDbConfigured`/`getDb`/`audit` (defaults wire to the real modules) so it is unit-testable without a live DB:

```ts
import { isDbConfigured as realIsDbConfigured, getWhmcsDb, type DbTx, type WhmcsDb } from '../whmcs/WhmcsDb.js';
import { runServiceMoves, TransferRollback } from '../write/transferCascade.js';

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
    readonly committed: boolean;
    readonly outcomes: { serviceid: number; status: 'verified' | 'committed' | 'skipped'; invoices_moved: number }[];
  };
}

interface TransferArgs {
  intent: WriteIntent;
  audit: AuditLog;
  isDbConfigured?: () => boolean;
  getDb?: () => WhmcsDb;
}

export async function executeServiceTransferBatch(args: TransferArgs): Promise<ServiceTransferBatchResult> {
  const { intent, audit } = args;
  const dbConfigured = args.isDbConfigured ?? realIsDbConfigured;
  const getDb = args.getDb ?? getWhmcsDb;

  if (!dbConfigured()) {
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

  type Outcome = { serviceid: number; status: 'verified' | 'committed' | 'skipped'; invoices_moved: number };

  return getDb().withTransaction(async (tx: DbTx) => {
    // ── PHASE 1: preflight (SELECTs in the same tx) ──
    const services: { serviceid: number; owned_by: number; status: string }[] = [];
    const invoicesInScope: { serviceid: number; invoice_ids: number[] }[] = [];
    const failed: { serviceid?: number; invoice_id?: number; why: string }[] = [];

    const srcRow = (await tx.query('SELECT id, currency_code, status FROM tblclients WHERE id = ?', [source])).rows[0] as any;
    const dstRow = (await tx.query('SELECT id, currency_code, status FROM tblclients WHERE id = ?', [dest])).rows[0] as any;
    if (!dstRow || dstRow.status !== 'Active') failed.push({ why: `dest_client_not_active:${dest}` });
    if (srcRow && dstRow && srcRow.currency_code !== dstRow.currency_code)
      failed.push({ why: `currency_mismatch:${srcRow?.currency_code}->${dstRow?.currency_code}` });

    for (const serviceid of serviceIds) {
      const row = (await tx.query('SELECT id, userid, domainstatus FROM tblhosting WHERE id = ?', [serviceid])).rows[0] as any;
      if (!row) { failed.push({ serviceid, why: 'service_not_found' }); continue; }
      const owner = Number(row.userid);
      const status = String(row.domainstatus ?? '');
      if (owner !== source) failed.push({ serviceid, why: `not_owned_by_source:${owner}` });
      if (status === 'Terminated' || status === 'Cancelled') failed.push({ serviceid, why: `bad_status:${status}` });
      services.push({ serviceid, owned_by: owner, status });
      if (mode !== 'none') {
        const sql =
          'SELECT DISTINCT i.id AS id FROM tblinvoices i JOIN tblinvoiceitems it ON it.invoiceid = i.id ' +
          "WHERE it.relid = ? AND it.type = 'Hosting'" + (mode === 'unpaid_only' ? " AND i.status = 'Unpaid'" : '');
        const invRows = (await tx.query(sql, [serviceid])).rows as any[];
        invoicesInScope.push({ serviceid, invoice_ids: invRows.map((r) => Number(r.id)) });
      }
    }

    if (failed.length > 0) {
      audit.append(auditEvent('intent.execution_blocked', intent, `precondition_mismatch: ${JSON.stringify(failed)}`));
      // Throw to roll back the (read-only) tx cleanly, but we want a structured
      // result not an exception — so return after the transaction via a sentinel.
      return { allowed: false, reason: 'precondition_mismatch', phase_1: { services, failed, ok: false } } as ServiceTransferBatchResult;
    }

    if (dryRun) {
      audit.append(auditEvent('intent.execution_blocked', intent, 'dry_run_completed'));
      return { allowed: true, dry_run: true, phase_1: { services, invoices_in_scope: invoicesInScope, ok: true } } as ServiceTransferBatchResult;
    }

    if (mode === 'all') audit.append(auditEvent('intent.executed', intent, 'WARNING invoice_mode=all re-owns SETTLED invoices'));

    // ── PHASE 2: commit (same tx) ──
    audit.appendDurable(auditEvent('intent.executed', intent, `transfer commit src=${source} dest=${dest} services=${serviceIds.length}`));
    try {
      await runServiceMoves(tx, invoicesInScope.length
        ? services.map((s) => ({ serviceid: s.serviceid, invoiceIds: invoicesInScope.find((x) => x.serviceid === s.serviceid)?.invoice_ids ?? [] }))
        : services.map((s) => ({ serviceid: s.serviceid, invoiceIds: [] })), source, dest);
    } catch (e) {
      if (e instanceof TransferRollback) {
        audit.append(auditEvent('intent.execution_blocked', intent, `transfer_rolled_back svc=${String(e.serviceid)}`));
        return { allowed: false, reason: 'transfer_rolled_back', phase_1: { services, invoices_in_scope: invoicesInScope, ok: true }, phase_2: { committed: false, outcomes: [] } } as ServiceTransferBatchResult;
      }
      throw e;
    }

    const outcomes: Outcome[] = [];
    for (const s of services) {
      const rb = (await tx.query('SELECT userid FROM tblhosting WHERE id = ?', [s.serviceid])).rows[0] as any;
      const verified = Number(rb?.userid) === dest;
      const moved = invoicesInScope.find((x) => x.serviceid === s.serviceid)?.invoice_ids.length ?? 0;
      outcomes.push({ serviceid: s.serviceid, status: verified ? 'verified' : 'committed', invoices_moved: moved });
    }
    return { allowed: true, phase_1: { services, invoices_in_scope: invoicesInScope, ok: true }, phase_2: { committed: true, outcomes } } as ServiceTransferBatchResult;
  });
}
```

> NOTE on the precondition/dry_run early returns: returning from inside `withTransaction` commits an all-SELECT transaction (no writes occurred), which is harmless. If lint/strictness prefers an explicit read-only path, wrap preflight in its own `withTransaction` returning a discriminated union, then open a second transaction for Phase 2 — but the single-tx form above is correct because no UPDATE runs on those paths.

- [ ] **Step 4: Run → PASS** (6 tests). **Step 5:** typecheck+lint, commit:
```bash
git add src/tools/writeFlow.ts tests/tools/writeFlow.transferOwner.test.ts
git commit -m "feat(writeFlow): executeServiceTransferBatch direct-DB two-phase executor"
```

---

## Task 7: Route through execute path + preview

**Files:** Modify `src/tools/writeFlow.ts` (execute handler ~L1099-1170; `toToolResult` ~L419).

- [ ] **Step 1:** In `toToolResult`, the `would_call` for these scopes is not an API call — set a marker so the preview is honest. Extend the `else if` chain:
```ts
    } else if (intentRec.scope === 'service:transfer_owner' || intentRec.scope === 'billing:invoice:reassign') {
      whmcsParams = [{ action: '__db_direct__', params: { note: 'direct DB ownership move; no WHMCS API call' } }];
    } else {
```

- [ ] **Step 2:** Add a routing branch in the execute handler, mirroring the `service:price_restore` branch's `preAuthorizeIntent` (gate steps 1–7) + approval + self-approval checks (copy them verbatim), then call the executor (no caps/dayAmounts):
```ts
      if (intent.scope === 'service:transfer_owner') {
        // (copy the `pre = preAuthorizeIntent(...)` block + !pre.ok return from the
        // price_restore branch verbatim here)
        const approval = approvals.get(intent.intent_id);
        if (!approval) {
          const blocked = store.transition(intent.intent_id, 'execution_blocked');
          audit.append(auditEvent('intent.execution_blocked', blocked, 'human_approval_required'));
          return out(toToolResult(blocked, 'execute', { execution: { attempted: false, blocked_reason: 'human_approval_required' } }));
        }
        if (approval.approver_consumer_id === intent.consumer_id) {
          const blocked = store.transition(intent.intent_id, 'execution_blocked');
          audit.append(auditEvent('intent.execution_blocked', blocked, 'self_approval_forbidden'));
          return out(toToolResult(blocked, 'execute', { execution: { attempted: false, blocked_reason: 'self_approval_forbidden' } }));
        }
        const batchRes = await executeServiceTransferBatch({ intent, audit });
        if (!batchRes.allowed) {
          const blocked = store.transition(intent.intent_id, 'execution_blocked');
          audit.append(auditEvent('intent.execution_blocked', blocked, batchRes.reason ?? 'unknown'));
          return out(toToolResult(blocked, 'execute', { execution: { attempted: false, blocked_reason: batchRes.reason, phase_1: batchRes.phase_1, phase_2: batchRes.phase_2 } as WriteToolResult['execution'] }));
        }
        if (batchRes.dry_run) {
          return out(toToolResult(intent, 'execute', { executed: false, execution: { attempted: false, dry_run: true, phase_1: batchRes.phase_1 } as WriteToolResult['execution'] }));
        }
        const finalState = store.transition(intent.intent_id, 'executed');
        return out(toToolResult(finalState, 'execute', { executed: true, execution: { attempted: true, phase_1: batchRes.phase_1, phase_2: batchRes.phase_2 } as WriteToolResult['execution'] }));
      }
```
(`billing:invoice:reassign` as a standalone single-invoice execute can route to a thin wrapper that calls the cascade for one invoice; if not needed for v1, leave it drafting/validating only and note that execute returns `unsupported_capability` via the generic path. Confirm with the controller — for v1 the transfer executor is the consumer of the cascade.)

- [ ] **Step 3:** typecheck+lint; commit:
```bash
git add src/tools/writeFlow.ts
git commit -m "feat(writeFlow): route service:transfer_owner through execute path + honest preview"
```

---

## Task 8: Full-flow + gate + capability-off tests

**Files:** extend `tests/tools/writeFlow.transferOwner.test.ts` (model on `writeFlow.priceRestore.test.ts` + `writeFlow.prodsafety.test.ts`).

- [ ] **Step 1:** Mirror the price-restore full-flow harness (consumer authorize, allowlist + approval by a DIFFERENT consumer, draft→validate→approve→execute). For the DB, inject the fake DB used in Task 6 via the executor's `getDb`/`isDbConfigured` seam (or set test env DSN + a stub). Assert:
  - **sealed:** with empty allowlist, execute is blocked by the gate (mirror `writeFlow.prodsafety.test.ts`).
  - **no approval:** blocked_reason `human_approval_required`.
  - **self-approval:** blocked_reason `self_approval_forbidden`.
  - **capability off:** with `isDbConfigured:()=>false`, execute returns `unsupported_capability` and the fake DB is never touched.
  - **invoice modes:** `none` issues no invoice UPDATEs; `unpaid_only` only unpaid; `all` emits the settled-history warning audit event.

- [ ] **Step 2:** `npm run test` (whole suite) → PASS. **Step 3:** commit:
```bash
git add tests/tools/writeFlow.transferOwner.test.ts
git commit -m "test(writeFlow): full-flow, gate, capability-off coverage for transfer-owner"
```

---

## Task 9: Docs + env + graph refresh

- [ ] **Step 1:** `.env.example` — add a documented, commented `MCP_WHMCS_DB_*` block (opt-in; default unset ⇒ transfer returns unsupported_capability) + `MCP_TRANSFER_MAX_BATCH`.
- [ ] **Step 2:** `README.md` — add both scopes to the write-scope table (risk high, sealed, direct-DB opt-in) and a short "Service owner transfer" subsection explaining the DSN requirement + that it bypasses WHMCS hooks by necessity.
- [ ] **Step 3:** `graphify update src`.
- [ ] **Step 4:** commit:
```bash
git add README.md .env.example
git commit -m "docs: document service-owner transfer scopes + opt-in DB DSN"
```

---

## Self-Review

**1. Spec coverage:** opt-in DSN/unsupported_capability → Task 4 + Task 6 capability gate + Task 8. Verified cascade tables → Task 5. Single-transaction commit-or-rollback + source guard → Task 5 + Task 6. Cross-currency hard block → Task 6 preflight + test. invoice_mode none/unpaid_only/all → Task 3 + Task 6 enumeration + Task 8. High-risk gate + SoD → Task 7. Two scopes → Tasks 2–3. Result shape §9 → Task 6. ✓

**2. Placeholder scan:** Task 7's `billing:invoice:reassign` execute is explicitly flagged for controller confirmation (v1 consumes the cascade via the transfer executor) — a real open decision, not a hidden gap. No `TODO`/`TBD`. Fake-DB SQL matching uses normalized whitespace consistently between builder and tests.

**3. Type consistency:** `ServiceTransferBatchResult` (status union `verified|committed|skipped`, `phase_2.committed`) is identical across Tasks 6–8 and matches spec §9. `DbTx.query(sql, params) → {affectedRows, rows}` consistent across Tasks 4, 5, 6. `buildServiceMoveStatements`/`runServiceMoves`/`TransferRollback` signatures match between Task 5 and Task 6. Scope strings identical throughout.

**Open item for controller (Task 7):** confirm whether `billing:invoice:reassign` needs a standalone execute path in v1, or exists only as the primitive the transfer executor composes. Default: composed-only; standalone execute returns `unsupported_capability`.
