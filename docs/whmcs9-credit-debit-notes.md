# WHMCS 9 Credit / Debit Notes — Canonical Modeling (READ-ONLY)

> Status: B1 canonical modeling + design only. **No WHMCS call is made, no
> tool is registered, and the underlying read action is NOT claimed supported.**

## 1. WHMCS 8 vs 9

| | WHMCS 8 | WHMCS 9 |
|---|---|---|
| Non-draft invoice | Editable in place | **Immutable** |
| Correcting a billed amount | Edit the invoice total/items | Issue a separate **credit note** (reduces what the client owes) or **debit note** (increases it) that references the affected invoice |
| Ledger shape | Invoice mutation | Append-only correction record |

Consequence: in WHMCS 9 a true financial picture of a client is
`invoices + transactions + credit/debit notes`. Reconciliation that only sums
invoices/transactions will mis-state balances whenever a correction exists.

## 2. What this delivers

`src/canonical/creditNote.ts` — a pure mapper:
`mapToCanonicalCreditNote(raw)` and `mapToCanonicalCreditNotes(raw)` →
`Canonical<CanonicalCreditNote>`. It unwraps a `creditnotes.creditnote`
WHMCS-style envelope and tolerates numeric-keyed objects, a single
(non-array) object, and empty `{}` / `[]` — identical defensive behavior to
`transaction.ts`.

### Canonical-entity assumption (verified design choice)

The `CanonicalEntity` union in `src/governance/types.ts` is a **FROZEN**
seam and is **not** extended. A credit/debit note is a financial ledger
record with the same governance surface as a transaction (business
identifiers + a financial amount + a financial reference + an untrusted
free-text memo). It therefore maps to the **existing `'transaction'`
entity**. This is an explicit, documented assumption — not a verified WHMCS
fact — and it keeps the frozen union untouched.

### Field classification (PHASE_B_GOVERNANCE §3)

| Field | Class |
|---|---|
| `noteId`, `clientId`, `invoiceId` | `business.identifier` |
| `amount` | `financial.amount` |
| `reference` | `financial.reference` |
| `description` | `untrusted.free_text` |
| `date`, `currency`, `status`, `type` | `public.safe` |

Every emitted path is classified (completeness is the governance contract;
an unmapped path is treated RESTRICTED downstream).

## 3. Capability status — UNVERIFIED on this build

There is no probed evidence on this deployment that a WHMCS action returning
credit/debit notes exists, is allowlisted, or is authorized. Per
PHASE_B_GOVERNANCE §6 the action is therefore **`unverified`**:

- It must be promoted to `supported` / `unsupported` / `not_authorized`
  **only by a real read-only capability probe**, cached by the capability
  registry (B4).
- Until a probe succeeds it stays `unverified`, and any consumer of this
  model must surface a structured `CapabilityUnavailable` — **never** fake,
  synthesize, or imply credit-note data.
- This mapper performs **zero** WHMCS I/O; it cannot and does not promote the
  capability itself.

**Verified vs assumption:** verified — the canonical shape, classification,
purity, and tolerance behavior (tested). Assumption — the WHMCS response
envelope (`creditnotes.creditnote`) and field names; the existence and
authorization of the read action. The mapper degrades safely (all-null
canonical) if the assumed shape is wrong.

## 4. How reconciliation would compose this (once verified)

`get_reconciliation_snapshot` already reports `transactions` as
`capability_unavailable`. The intended composition, **only after the credit-
note read action is capability-verified**, is:

1. Capability gate first: `capability(<credit-note action>)`. If not
   `supported` ⇒ keep emitting a structured `capability_unavailable`
   (status carried through) for the credit/debit-notes section. No data.
2. If supported: a governed read produces canonical credit notes via
   `mapToCanonicalCreditNotes`. These canonical objects are complete and
   never mutated.
3. Reconciliation aggregates over canonical (invoices + transactions +
   credit/debit notes) to derive corrected balances.
4. Projection (B2) is applied **once at the output boundary** from the
   authenticated consumer + contract + environment — e.g.
   `billing_reconciliation` keeps amounts and the financial `reference`,
   drops the untrusted `description`.

No live-write implications: this is a read-only ledger record. Credit/debit
notes are never *created* by this gateway — modeling them only lets
reconciliation **read and represent** existing corrections. The existing
two-layer write block is unaffected and unreferenced here.
