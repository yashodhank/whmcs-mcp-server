# Service Owner Transfer — Design Spec

- **Date:** 2026-06-22
- **Status:** Revised after capability probe — **direct-DB approach, opt-in DSN, sealed by default**
- **Author:** brainstormed via Claude Code
- **Project:** whmcs-mcp-server

> **Revision note (2026-06-22):** The capability probe (Task 1, commit `c42d005`) proved
> the WHMCS **API cannot** reassign a service or invoice owner — `UpdateClientProduct`
> and `UpdateInvoice` accept owner fields, return `success`, and silently ignore them; no
> alternative API action exists. The **only** working mechanism is a direct database write.
> This spec therefore replaces the original API-action design with a transactional,
> schema-aware **direct-DB executor** that is **opt-in** (enabled only when an operator
> sets a `MCP_WHMCS_DB_*` DSN) and otherwise returns `unsupported_capability` — preserving
> the project's sealed, API-mediated default posture.

## 1. Problem

Operators need to move one or more services (a…n) from a **source client** to a
**destination client** in WHMCS, optionally bringing the associated invoices. The admin
UI can do it; the public API cannot. Today this is a manual, error-prone task with no
governed, auditable, batchable path.

## 2. Goals / Non-goals

**Goals**
- Move N services from `source_clientid` → `dest_clientid` in one governed, auditable,
  **transactional** operation.
- Per-transfer invoice control: `none`, `unpaid_only`, or `all`.
- All-or-nothing preflight, then a single DB transaction that either fully commits or
  rolls back (true atomicity — unlike the API's per-call model).
- Reuse the existing tiered write-intent governance (draft → validate → approve → execute),
  high-risk gate, idempotency ledger, and fail-closed audit.
- **Default-safe:** with no DB DSN configured, the feature is fully defined/validated/
  audited but returns `unsupported_capability` at execute (the `ticket:merge` posture).

**Non-goals**
- Moving domains-as-domains, addons-as-independent-products, tickets, or quotes.
  (Addons and SSL orders attached to a moved service DO follow it — see cascade §6.)
- Merging or deleting clients.
- Re-issuing / credit-noting invoices.
- Providing DB access in production by default — operators opt in explicitly and own that
  deployment/security decision.

## 3. Key decisions

| Decision | Choice |
|---|---|
| Mechanism | **Direct DB** (API proven incapable by Task 1). |
| Enablement | **Opt-in** via `MCP_WHMCS_DB_*` DSN config. Unset ⇒ `unsupported_capability`. |
| Invoice handling | Operator-selected: `invoice_mode ∈ {none, unpaid_only, all}`. |
| Atomicity | **Preflight (read-only) → single DB transaction** (commit-or-rollback). |
| Risk / sealing | **High-risk** gate (allowlist + `HumanApprovalRecord` + separation of duties). Not in `PROD_NEVER_EXECUTABLE`; all invoice modes executable once opted in. |
| Cross-currency | **Hard block** in preflight. |
| Scope granularity | **Two scopes**: `service:transfer_owner` (batch) + `billing:invoice:reassign` (single-invoice primitive), both DB-backed. |
| Domains | Out of scope v1 (separate products); documented non-goal. |

## 4. Verified WHMCS schema (probe, WHMCS 9)

Owner column is `userid` on every relevant table. Confirmed columns:

| Table | Owner col | Links to service | Action on move |
|-------|-----------|------------------|----------------|
| `tblhosting` | `userid` | `id` = serviceid | UPDATE userid |
| `tblhostingaddons` | `userid` | `hostingid` = serviceid | UPDATE userid |
| `tblsslorders` | `userid` | `serviceid` | UPDATE userid |
| `tblhostingconfigoptions` | *(none)* | `relid` = serviceid | none — follows service |
| `tblinvoices` | `userid` | (via items) | UPDATE userid (in-scope invoices) |
| `tblinvoiceitems` | `userid` | `invoiceid`, `relid` = serviceid | UPDATE userid |

## 5. Scopes (`src/write/types.ts`)

Add `'service:transfer_owner'` and `'billing:invoice:reassign'` to `WRITE_SCOPES`.
- `SCOPE_RISK`: both **`high`**.
- `SCOPE_ACTION`: there is **no WHMCS API action** — set both to the sentinel
  `DB_DIRECT_ACTION = '__db_direct__'` (a new exported const). The execute path routes
  these scopes to the DB executor instead of `whmcs.mutate`; `SCOPE_ACTION` is retained
  only so the frozen-map invariant holds and audit records a stable action label.
- Both **sealed by default** (empty allowlist keystone). **Not** in `PROD_NEVER_EXECUTABLE`.

## 6. DB layer (new) — `src/whmcs/WhmcsDb.ts`

A small, lazily-constructed `mysql2/promise` pool, configured from new env in `config.ts`:
`MCP_WHMCS_DB_HOST`, `MCP_WHMCS_DB_PORT` (default 3306), `MCP_WHMCS_DB_USER`,
`MCP_WHMCS_DB_PASSWORD`, `MCP_WHMCS_DB_NAME`, `MCP_WHMCS_DB_SSL` (optional).

- `isDbConfigured(): boolean` — true only when host+user+name are all set.
- `getWhmcsDb(): WhmcsDb` — returns a wrapper exposing `withTransaction(fn)` and
  `query(sql, params)`; throws if not configured (callers must check `isDbConfigured()`).
- The pool is **never created** unless a transfer executes with a configured DSN — so the
  default deployment opens no DB connection and carries no DB credentials.
- Credentials are referenced only via env; never logged (audit records ids + counts, never
  connection details).

## 7. Cascade move — `src/write/transferCascade.ts`

Pure SQL-builder + a transactional runner, isolated from the tool layer for testability.

`buildServiceMoveStatements(serviceid, source, dest, invoiceIds)` → ordered list of
`{ sql, params }`:
```
UPDATE tblhosting          SET userid=? WHERE id=?         AND userid=?   -- service
UPDATE tblhostingaddons    SET userid=? WHERE hostingid=?  AND userid=?   -- addons
UPDATE tblsslorders        SET userid=? WHERE serviceid=?  AND userid=?   -- ssl
-- per in-scope invoice id:
UPDATE tblinvoices         SET userid=? WHERE id=?         AND userid=?
UPDATE tblinvoiceitems     SET userid=? WHERE invoiceid=?  AND userid=?
```
Every statement is guarded by `AND userid=<source>` so a concurrent change or a wrong
precondition results in 0 affected rows (detected and treated as a mismatch), never a
cross-tenant clobber. `tblhostingconfigoptions` needs no update (no owner column).

## 8. Two-phase executor `executeServiceTransferBatch`

**Capability gate (first):** if `!isDbConfigured()` → audit `unsupported_capability`, return
`{ allowed:false, reason:'unsupported_capability' }`. No DB connection attempted.

**Phase 1 — preflight (read-only, abort-all-on-any-failure):** for each service confirm via
SELECT that it exists, `tblhosting.userid === source_clientid`, and status not
`Terminated`/`Cancelled`; confirm dest client exists + Active + **same currency** as source
(`tblclients`); enumerate in-scope invoices (`invoice_mode`: `unpaid_only` → join
`tblinvoiceitems` on `relid=serviceid` AND `tblinvoices.status='Unpaid'`; `all` → drop the
status filter; `none` → empty). Any failure → `precondition_mismatch`, nothing mutates.
`dry_run:true` returns the preview and stops.

**Phase 2 — commit (single transaction):** `withTransaction` runs all cascade statements for
all services + invoices; if any statement throws or any guarded UPDATE for the service row
itself affects 0 rows, **roll back the whole batch** and return `transfer_rolled_back` with
the offending service. `invoice_mode:all` emits an explicit audit warning (settled history).
After commit, read-back verify each service's `userid === dest`. Per-item idempotency via
the ledger keeps a re-run from double-applying (guarded UPDATEs are already idempotent).

> Atomicity is **stronger** than the original API design: the whole batch is one DB
> transaction, so there is no partial-move state to reconcile.

## 9. Result shape

```ts
export interface ServiceTransferBatchResult {
  allowed: boolean;
  reason?: string;            // unsupported_capability | precondition_mismatch | transfer_rolled_back | audit_write_failed | batch_too_large
  dry_run?: boolean;
  phase_1?: {
    services: { serviceid: number; owned_by: number; status: string }[];
    invoices_in_scope?: { serviceid: number; invoice_ids: number[] }[];
    failed?: { serviceid?: number; invoice_id?: number; why: string }[];
    ok: boolean;
  };
  phase_2?: {
    committed: boolean;
    outcomes: { serviceid: number; status: 'verified' | 'committed' | 'skipped'; invoices_moved: number }[];
  };
}
```

## 10. Tool surface

Both scopes flow through the existing generic write-intent tools (`draft → validate →
approve → execute`). `service:transfer_owner` is batch-shaped (mirrors `PriceRestoreBatchArgs`).
No bespoke top-level tool.

## 11. Params & validation (unchanged from original)

`service:transfer_owner`: `{ source_clientid, dest_clientid, service_ids[], invoice_mode, dry_run? }`.
`billing:invoice:reassign`: `{ invoice_id, dest_clientid }`. Validation: positive ints,
non-empty `service_ids`, `source ≠ dest`, `invoice_mode` enum, `dry_run` boolean. Blast
radius bounded by `MCP_TRANSFER_MAX_BATCH` (default 50).

## 12. Testing

- Unit: validation, cascade SQL builder (exact statements + params + source-guard), executor
  with a **fake DB** (preflight rejections incl. currency mismatch + wrong owner; dry_run;
  rollback on mid-transaction failure; idempotent re-run; each invoice_mode).
- Capability gate: with no DSN configured, execute returns `unsupported_capability` and opens
  no connection.
- High-risk gate: sealed without allowlist + approval; self-approval forbidden.
- Integration (opt-in, gated on a configured test DSN against the devbox DB): real move +
  read-back. Skipped when no test DSN — never runs in CI by default.

## 13. Files

- `src/write/types.ts` — scopes, risk, `DB_DIRECT_ACTION` sentinel.
- `src/config.ts` — `MCP_WHMCS_DB_*` + `MCP_TRANSFER_MAX_BATCH`.
- `src/whmcs/WhmcsDb.ts` *(new)* — lazy pool, `isDbConfigured`, `withTransaction`.
- `src/write/transferCascade.ts` *(new)* — SQL builder + transactional runner.
- `src/write/validation.ts`, `src/write/paramMapping.ts` — param rules + (DB-target) mappers.
- `src/tools/writeFlow.ts` — `executeServiceTransferBatch`, execute-path routing, preview.
- `tests/write/*`, `tests/tools/writeFlow.transferOwner.test.ts` — per §12.
- `package.json` — add `mysql2`.
- `README.md`, `.env.example` — document the opt-in DSN + scopes.

## 14. Security posture

Direct DB writes **bypass WHMCS hooks/business logic** by design (no API action exists). This
is acceptable for ownership reassignment (a pure relational re-parenting) but means: (a) the
feature is opt-in and high-risk-gated; (b) every UPDATE is `source`-guarded; (c) the whole
move is one transaction; (d) operators accept that the MCP host must reach the WHMCS DB. The
default deployment (no DSN) is unchanged from today — no DB driver connection, no credentials.
