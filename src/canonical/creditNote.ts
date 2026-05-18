/**
 * Canonical mapper — WHMCS 9 credit/debit note row → Canonical<CanonicalCreditNote>.
 *
 * WHMCS 8 corrected billing by editing invoices in place. WHMCS 9 makes
 * non-draft invoices IMMUTABLE; a correction is recorded as a separate
 * credit (reduces what the client owes) or debit (increases it) note that
 * references the affected invoice. This module models that ledger record so
 * `get_reconciliation_snapshot` can REPRESENT credit/debit notes once the
 * underlying read action is capability-verified.
 *
 * READ-ONLY. PURE. This file never calls WHMCS, never registers a tool, and
 * does NOT assert the read action is supported — promotion is the capability
 * registry's job (docs/whmcs9-credit-debit-notes.md, PHASE_B_GOVERNANCE §6).
 *
 * Canonical-entity assumption: the frozen CanonicalEntity union
 * (governance/types.ts) is NOT extended. A credit/debit note is a financial
 * ledger record (same governance shape as a transaction: identifiers +
 * amount + reference + free-text memo), so it maps to the EXISTING
 * 'transaction' entity. See docs/PHASE_B_GOVERNANCE.md §3.
 */
import type { Canonical } from '../governance/types.js';
import { asRecord, str, num, listOf, ClassMapBuilder } from './_shared.js';

export type CreditNoteType = 'credit' | 'debit';

export interface CanonicalCreditNote {
  noteId: number | null;
  clientId: number | null;
  invoiceId: number | null;
  type: CreditNoteType;
  date: string | null;
  currency: string | null;
  amount: number | null;
  reference: string | null;
  status: string | null;
  description: string | null;
}

const CLASSES = new ClassMapBuilder()
  .many(['noteId', 'clientId', 'invoiceId'], 'business.identifier')
  .set('amount', 'financial.amount')
  .set('reference', 'financial.reference')
  .set('description', 'untrusted.free_text')
  .many(['date', 'currency', 'status', 'type'], 'public.safe')
  .build();

/** WHMCS sends type loosely; anything not explicitly debit is treated credit. */
function normalizeType(src: Record<string, unknown>): CreditNoteType {
  const raw = (str(src, 'type') ?? '').trim().toLowerCase();
  return raw === 'debit' ? 'debit' : 'credit';
}

function mapOne(src: Record<string, unknown>): CanonicalCreditNote {
  return {
    noteId: num(src, 'id') ?? num(src, 'creditnoteid') ?? null,
    clientId: num(src, 'clientid') ?? num(src, 'userid') ?? null,
    invoiceId: num(src, 'invoiceid') ?? null,
    type: normalizeType(src),
    date: str(src, 'date') ?? null,
    currency: str(src, 'currency') ?? null,
    amount: num(src, 'amount') ?? null,
    reference: str(src, 'reference') ?? str(src, 'transid') ?? null,
    status: str(src, 'status') ?? null,
    description: str(src, 'description') ?? str(src, 'notes') ?? null,
  };
}

export function mapToCanonicalCreditNote(
  raw: unknown
): Canonical<CanonicalCreditNote> {
  return {
    entity: 'transaction',
    data: mapOne(asRecord(raw)),
    classes: CLASSES,
  };
}

export function mapToCanonicalCreditNotes(
  raw: unknown
): Canonical<CanonicalCreditNote>[] {
  const src = asRecord(raw);
  const rows = listOf(src.creditnotes, 'creditnote');
  return rows.map((r) => ({
    entity: 'transaction' as const,
    data: mapOne(r),
    classes: CLASSES,
  }));
}
