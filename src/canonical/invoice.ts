/**
 * Canonical mapper — WHMCS GetInvoice → Canonical<CanonicalInvoice>.
 * Unwraps items.item / transactions.transaction (numeric-keyed, single-object,
 * empty {}/[]). Data is COMPLETE; projection happens at the output boundary.
 * See docs/design/governance.md §3.
 */
import type { Canonical } from '../governance/types.js';
import { asRecord, str, num, listOf, ClassMapBuilder } from './_shared.js';

export interface CanonicalInvoiceItem {
  itemId: number | null;
  type: string | null;
  relatedId: number | null;
  description: string | null;
  amount: number | null;
  taxed: boolean | null;
}

export interface CanonicalInvoiceTransaction {
  transactionRowId: number | null;
  transactionId: string | null;
  date: string | null;
  gateway: string | null;
  amount: number | null;
  amountIn: number | null;
  amountOut: number | null;
}

export interface CanonicalInvoice {
  invoiceId: number | null;
  invoiceNumber: string | null;
  clientId: number | null;
  date: string | null;
  dueDate: string | null;
  datePaid: string | null;
  status: string | null;
  subtotal: number | null;
  tax: number | null;
  tax2: number | null;
  total: number | null;
  balance: number | null;
  credit: number | null;
  paymentMethod: string | null;
  notes: string | null;
  items: CanonicalInvoiceItem[];
  transactions: CanonicalInvoiceTransaction[];
}

export function mapToCanonicalInvoice(
  raw: unknown
): Canonical<CanonicalInvoice> {
  const src = asRecord(raw);

  const items: CanonicalInvoiceItem[] = listOf(src.items, 'item').map(
    (i) => ({
      itemId: num(i, 'id') ?? null,
      type: str(i, 'type') ?? null,
      relatedId: num(i, 'relid') ?? null,
      description: str(i, 'description') ?? null,
      amount: num(i, 'amount') ?? null,
      taxed: num(i, 'taxed') === undefined ? null : num(i, 'taxed') !== 0,
    })
  );

  const transactions: CanonicalInvoiceTransaction[] = listOf(
    src.transactions,
    'transaction'
  ).map((t) => ({
    transactionRowId: num(t, 'id') ?? null,
    transactionId: str(t, 'transid') ?? null,
    date: str(t, 'date') ?? null,
    gateway: str(t, 'gateway') ?? null,
    amount: num(t, 'amount') ?? null,
    amountIn: num(t, 'amountin') ?? null,
    amountOut: num(t, 'amountout') ?? null,
  }));

  const data: CanonicalInvoice = {
    invoiceId: num(src, 'invoiceid') ?? num(src, 'id') ?? null,
    invoiceNumber: str(src, 'invoicenum') ?? null,
    clientId: num(src, 'userid') ?? num(src, 'clientid') ?? null,
    date: str(src, 'date') ?? null,
    dueDate: str(src, 'duedate') ?? null,
    datePaid: str(src, 'datepaid') ?? null,
    status: str(src, 'status') ?? null,
    subtotal: num(src, 'subtotal') ?? null,
    tax: num(src, 'tax') ?? null,
    tax2: num(src, 'tax2') ?? null,
    total: num(src, 'total') ?? null,
    balance: num(src, 'balance') ?? null,
    credit: num(src, 'credit') ?? null,
    paymentMethod: str(src, 'paymentmethod') ?? null,
    notes: str(src, 'notes') ?? null,
    items,
    transactions,
  };

  const classes = new ClassMapBuilder()
    .set('invoiceId', 'business.identifier')
    .set('clientId', 'business.identifier')
    .set('invoiceNumber', 'financial.reference')
    .set('paymentMethod', 'financial.reference')
    .many(
      ['subtotal', 'tax', 'tax2', 'total', 'balance', 'credit'],
      'financial.amount'
    )
    .many(['date', 'dueDate', 'datePaid', 'status'], 'public.safe')
    .set('notes', 'untrusted.free_text')
    .set('items', 'public.safe')
    .set('items[].itemId', 'business.identifier')
    .set('items[].relatedId', 'business.identifier')
    .many(
      ['items[].type', 'items[].description', 'items[].taxed'],
      'public.safe'
    )
    .set('items[].amount', 'financial.amount')
    .set('transactions', 'financial.reference')
    .set('transactions[].transactionRowId', 'business.identifier')
    .set('transactions[].transactionId', 'financial.reference')
    .set('transactions[].gateway', 'financial.reference')
    .set('transactions[].date', 'public.safe')
    .many(
      [
        'transactions[].amount',
        'transactions[].amountIn',
        'transactions[].amountOut',
      ],
      'financial.amount'
    )
    .build();

  return { entity: 'invoice', data, classes };
}
