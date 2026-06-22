# Service Owner Transfer — Design Spec

- **Date:** 2026-06-22
- **Status:** Draft (awaiting capability probe to bind execution)
- **Author:** brainstormed via Claude Code
- **Project:** whmcs-mcp-server

## 1. Problem

Operators need to move one or more services (a, b, … n) from a **source client**
to a **destination client** in WHMCS, optionally bringing the associated invoices
along. Today this is a manual, error-prone admin-UI task with no governed,
auditable, batchable path through the MCP server.

## 2. Goals / Non-goals

**Goals**
- Move N services from `source_clientid` → `dest_clientid` in one governed,
  auditable operation.
- Per-transfer control over invoices: `none`, `unpaid_only`, or `all`.
- All-or-nothing *preflight* (validate everything before mutating), fail-fast
  commit, and a precise per-item outcome report.
- Reuse the existing tiered write-intent governance (draft → validate → approve
  → execute), high-risk gate, idempotency ledger, and fail-closed audit.

**Non-goals**
- Merging clients, deleting clients, or moving non-service assets (tickets,
  domains-as-domains, quotes). Out of scope for v1.
- Re-issuing / credit-noting invoices when WHMCS cannot re-own them directly
  (the probe decides whether that fallback is even needed; if so it is a
  separate future spec).
- Cross-currency transfers (explicitly blocked — see §6).

## 3. Key decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Move mechanism | **Capability-probe the devbox first**; bind `SCOPE_ACTION` from verified findings. |
| Invoice handling | Operator-selected per transfer: `invoice_mode ∈ {none, unpaid_only, all}`. |
| Partial failure | **Preflight-then-commit**: validate all items + destination in a read-only pass; only commit if everything passes; commit phase is sequential **fail-fast (stop-on-error)**. |
| Risk / sealing | **High-risk**, full deny-by-default gate. **All invoice modes executable** in prod once an operator opts in (not in `PROD_NEVER_EXECUTABLE`). |
| Cross-currency | **Hard block** in preflight (source/dest currency mismatch is a precondition failure). |
| Scope granularity | **Two scopes**: `service:transfer_owner` + reusable `billing:invoice:reassign`, composed by the transfer executor. |

## 4. Capability probe (prerequisite)

Run a `docs/runbooks/write-capability-probe.md`-style probe on **whmcs-devbox**
before binding any executor. Questions to answer:

1. **Service owner reassignment** — does `UpdateClientProduct` accept a
   `clientid`/`userid` to change ownership? (Likely **no** on stock WHMCS.)
   If not, is there an admin/internal action (e.g. a `moveproduct`-style call)
   reachable via the API role, or a documented alternative?
2. **Invoice reassignment** — is there a supported action to change an invoice's
   owning client (e.g. `UpdateInvoice` with `userid`)? If not, `unpaid_only` /
   `all` may be infeasible without credit-note + re-issue (out of scope v1).
3. **Side-effects** — what happens to addons, configurable options, and the
   service's linked domain on a move? Capture for validation rules.

**Probe outcome binds the design:** the discovered action(s) populate
`SCOPE_ACTION`. If no clean action exists, the scope(s) ship
**defined + validating + drafting**, but the executor returns
`unsupported_capability` until an install proves the action — the same posture
the repo already uses for `ticket:merge` (see `src/write/types.ts`).

## 5. Scopes (`src/write/types.ts`)

Add two entries to `WRITE_SCOPES`:

### 5.1 `service:transfer_owner`
- `SCOPE_ACTION`: bound from probe (placeholder until then).
- `SCOPE_RISK`: **`high`** → allowlist (`MCP_PROD_WRITE_AUTHORIZED`) +
  `HumanApprovalRecord` + `HighRiskCaps`. **Not** in `PROD_NEVER_EXECUTABLE`.

### 5.2 `billing:invoice:reassign`
- `SCOPE_ACTION`: bound from probe (e.g. `UpdateInvoice`).
- `SCOPE_RISK`: **`high`** — re-owning an invoice (especially a settled one
  under `invoice_mode:all`) changes a financial record's ownership. Reusable on
  its own; also invoked by the transfer executor per service.

Both are sealed by default by the existing keystone (empty
`MCP_PROD_WRITE_AUTHORIZED`); no change to the seal mechanism.

## 6. Params & validation

### `service:transfer_owner` (batch-shaped, mirrors `PriceRestoreBatchArgs`)
```jsonc
{
  "source_clientid": 123,            // positive int
  "dest_clientid":   456,            // positive int, != source
  "service_ids":     [11, 12, 13],   // non-empty array of positive ints (a…n)
  "invoice_mode":    "unpaid_only",  // 'none' | 'unpaid_only' | 'all'
  "dry_run":         false           // boolean (optional)
}
```

### `billing:invoice:reassign`
```jsonc
{
  "invoice_id":    9001,   // positive int
  "dest_clientid": 456     // positive int
}
```

**Validation (`src/write/validation.ts`)** — positive-int checks, non-empty
`service_ids`, `source_clientid != dest_clientid`, `invoice_mode` enum,
`dry_run` boolean. Strict mappers in `src/write/paramMapping.ts` emit only the
WHMCS fields the bound action accepts (no high-impact field passthrough), the
same discipline as the existing `service:price_restore` / `client:update`
mappers.

## 7. Two-phase executor `executeServiceTransferBatch`

Cloned from `executePriceRestoreBatch` (`src/tools/writeFlow.ts:597`).

**Phase 1 — preflight (read-only; abort-all on any failure):** for each
`service_id`:
- `GetClientsProducts` → service exists, **currently owned by `source_clientid`**,
  status not `Terminated`/`Cancelled`.
- (once) `GetClients`/`GetClientsDetails` → `dest_clientid` exists and is `Active`.
- **Currency match** between source and dest client → mismatch is a hard
  `precondition_mismatch` (WHMCS ties service/invoice currency to the client).
- If `invoice_mode != none`, enumerate in-scope invoices (`GetInvoices` filtered
  by service / status) — `unpaid_only` → `Unpaid`/open statuses; `all` →
  unpaid + paid.

Any failure → append `intent.execution_blocked` audit event with the failing
service/invoice ids and return `{ allowed:false, reason:'precondition_mismatch', phase_1 }`.
`dry_run === true` → return the full preview (services + invoices that *would*
move) and stop; **no Phase 2, no mutations**.

**Phase 2 — commit (sequential, fail-fast):** per service, in order:
1. Per-item idempotency key `${intent.idempotency_key}|${serviceid}`; if seen →
   mark `skipped`.
2. Per-action + daily cap check (`HighRiskCaps`).
3. **Fail-closed durable audit append _before_ mutate.**
4. Reassign service owner (bound action).
5. Reassign that service's in-scope invoices via the `billing:invoice:reassign`
   path, per `invoice_mode`. `invoice_mode:all` emits an explicit audit warning
   that **settled financial history is being re-owned**.
6. Read-back verify (ownership now `dest_clientid`).
7. Halt on first failure; record `halted_after`.

## 8. Result shape

Extend `PriceRestoreBatchResult`:
```ts
interface ServiceTransferBatchResult {
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
    outcomes: {
      serviceid: number;
      status: 'verified' | 'executed' | 'failed' | 'skipped';
      invoices_moved: number;
    }[];
    halted_after?: number | null;
  };
}
```

## 9. Tool surface

Both scopes flow through the **existing generic** write-intent MCP tools
(`draft_write_intent` → `validate_write_intent` → `approve_write_intent` →
`execute_write_intent`, with `get_write_intent`). `service:transfer_owner` gets
a typed batch draft entry in `writeFlow.ts` alongside the price-restore batch
draft (`PriceRestoreBatchArgs` precedent). No bespoke top-level tool is added.

## 10. Testing (Vitest, mirroring `tests/tools/` price-restore coverage)

- Preflight rejections: wrong/foreign owner, missing or inactive dest,
  **currency mismatch**, terminated/cancelled service, empty `service_ids`,
  `source == dest`.
- `dry_run` preview returns services + invoices, mutates nothing.
- Idempotent re-run: already-moved service → `skipped`.
- Fail-fast: failure on service k halts; services > k untouched; `halted_after === k`.
- Each `invoice_mode` (`none` moves no invoices; `unpaid_only` moves only open;
  `all` moves paid + emits the settled-history audit warning).
- High-risk gate: sealed without allowlist + `HumanApprovalRecord`; cap
  enforcement.
- Devbox integration test, gated on the probe outcome (skipped/`unsupported_capability`
  until the action is proven on an install).

## 11. Files touched

- `src/write/types.ts` — two new scopes in `WRITE_SCOPES`, `SCOPE_ACTION`,
  `SCOPE_RISK`.
- `src/write/validation.ts` — required params + rules for both scopes.
- `src/write/paramMapping.ts` — strict mappers for both scopes.
- `src/tools/writeFlow.ts` — `executeServiceTransferBatch`, batch draft entry,
  result type.
- `docs/runbooks/write-capability-probe.md` — add the owner/invoice-move probe.
- `tests/tools/` + `tests/write/` — coverage per §10.

## 12. Open items (resolved by the probe, before implementation)

- Exact WHMCS action(s) for service-owner and invoice reassignment → binds
  `SCOPE_ACTION`.
- Behavior of addons / configurable options / linked domain on a move → may add
  preflight checks or an explicit "stays with source" note.
