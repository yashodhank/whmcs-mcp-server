/**
 * Canonical mapper — WHMCS GetQuotes quote row → Canonical<CanonicalInvoice-
 * adjacent quote>. A quote is invoice-adjacent (proposed billing that has not
 * yet become an invoice), so it reuses the `'invoice'` CanonicalEntity rather
 * than introducing a new entity into the frozen union.
 *
 * Unwraps quotes.quote (array / numeric-keyed object / single object / empty)
 * and lineitems.lineitem with the same defensive _shared helpers as the other
 * B1 mappers. Data is COMPLETE; projection/redaction happens at the output
 * boundary. See docs/PHASE_B_GOVERNANCE.md §3.
 */
import type { Canonical } from '../governance/types.js';
import { asRecord, str, num, listOf, ClassMapBuilder } from './_shared.js';

export interface CanonicalQuoteLineItem {
  description: string | null;
  amount: number | null;
}

export interface CanonicalQuote {
  quoteId: number | null;
  subject: string | null;
  stage: string | null;
  status: string | null;
  date: string | null;
  validUntil: string | null;
  currency: string | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  customerNotes: string | null;
  lineItems: CanonicalQuoteLineItem[];
}

const CLASSES = new ClassMapBuilder()
  .set('quoteId', 'business.identifier')
  .set('subject', 'business.label')
  .many(['stage', 'status', 'date', 'validUntil'], 'public.safe')
  .set('currency', 'business.identifier')
  .many(['subtotal', 'tax', 'total'], 'financial.amount')
  .set('customerNotes', 'untrusted.free_text')
  .set('lineItems', 'public.safe')
  .set('lineItems[].description', 'business.label')
  .set('lineItems[].amount', 'financial.amount')
  .build();

function mapLineItem(li: Record<string, unknown>): CanonicalQuoteLineItem {
  return {
    description: str(li, 'description') ?? null,
    amount: num(li, 'amount') ?? null,
  };
}

function mapOne(src: Record<string, unknown>): CanonicalQuote {
  const lineItems = listOf(src.lineitems, 'lineitem').map(mapLineItem);
  return {
    quoteId: num(src, 'id') ?? num(src, 'quoteid') ?? null,
    subject: str(src, 'subject') ?? null,
    stage: str(src, 'stage') ?? null,
    status: str(src, 'status') ?? null,
    date: str(src, 'datecreated') ?? str(src, 'date') ?? null,
    validUntil: str(src, 'validuntil') ?? null,
    // WHMCS reports the currency as a code on the quote; fall back to the
    // nested currency record's code if present.
    currency:
      str(src, 'currencycode') ??
      str(asRecord(src.currency), 'code') ??
      str(src, 'currency') ??
      null,
    subtotal: num(src, 'subtotal') ?? null,
    tax: num(src, 'tax') ?? null,
    total: num(src, 'total') ?? null,
    customerNotes: str(src, 'customernotes') ?? null,
    lineItems,
  };
}

export function mapToCanonicalQuote(raw: unknown): Canonical<CanonicalQuote> {
  return { entity: 'invoice', data: mapOne(asRecord(raw)), classes: CLASSES };
}

export function mapToCanonicalQuotes(
  raw: unknown
): Canonical<CanonicalQuote>[] {
  const src = asRecord(raw);
  return listOf(src.quotes, 'quote').map((r) => ({
    entity: 'invoice' as const,
    data: mapOne(r),
    classes: CLASSES,
  }));
}
