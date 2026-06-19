/**
 * Canonical mapper — WHMCS GetTransactions row → Canonical<CanonicalTransaction>.
 * Also exposes mapToCanonicalTransactions for the transactions.transaction
 * wrapper (numeric-keyed / single-object / empty). COMPLETE; projection later.
 * See docs/design/governance.md §3.
 */
import type { Canonical } from '../governance/types.js';
import { asRecord, str, num, listOf, ClassMapBuilder } from './_shared.js';

export interface CanonicalTransaction {
  transactionRowId: number | null;
  clientId: number | null;
  invoiceId: number | null;
  transactionId: string | null;
  date: string | null;
  gateway: string | null;
  currency: string | null;
  amountIn: number | null;
  amountOut: number | null;
  fees: number | null;
  rate: number | null;
  description: string | null;
}

const CLASSES = new ClassMapBuilder()
  .many(['clientId', 'invoiceId'], 'business.identifier')
  .set('transactionRowId', 'business.identifier')
  .many(['transactionId', 'gateway'], 'financial.reference')
  .many(['amountIn', 'amountOut', 'fees'], 'financial.amount')
  .many(['date', 'currency', 'rate'], 'public.safe')
  .set('description', 'untrusted.free_text')
  .build();

function mapOne(src: Record<string, unknown>): CanonicalTransaction {
  return {
    transactionRowId: num(src, 'id') ?? null,
    clientId: num(src, 'userid') ?? num(src, 'clientid') ?? null,
    invoiceId: num(src, 'invoiceid') ?? null,
    transactionId: str(src, 'transid') ?? null,
    date: str(src, 'date') ?? null,
    gateway: str(src, 'gateway') ?? null,
    currency: str(src, 'currency') ?? null,
    amountIn: num(src, 'amountin') ?? null,
    amountOut: num(src, 'amountout') ?? null,
    fees: num(src, 'fees') ?? null,
    rate: num(src, 'rate') ?? null,
    description: str(src, 'description') ?? null,
  };
}

export function mapToCanonicalTransaction(
  raw: unknown
): Canonical<CanonicalTransaction> {
  return { entity: 'transaction', data: mapOne(asRecord(raw)), classes: CLASSES };
}

export function mapToCanonicalTransactions(
  raw: unknown
): Canonical<CanonicalTransaction>[] {
  const src = asRecord(raw);
  const rows = listOf(src.transactions, 'transaction');
  return rows.map((r) => ({
    entity: 'transaction' as const,
    data: mapOne(r),
    classes: CLASSES,
  }));
}
