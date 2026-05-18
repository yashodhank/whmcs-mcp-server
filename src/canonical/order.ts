/**
 * Canonical mapper — WHMCS GetOrders order row → Canonical<CanonicalOrder>.
 * Unwraps orders.order + lineitems.lineitem. COMPLETE; projection happens at
 * the output boundary. See docs/PHASE_B_GOVERNANCE.md §3.
 */
import type { Canonical } from '../governance/types.js';
import { asRecord, str, num, listOf, ClassMapBuilder } from './_shared.js';

export interface CanonicalOrderLineItem {
  type: string | null;
  product: string | null;
  domain: string | null;
  billingCycle: string | null;
  amount: number | null;
  status: string | null;
}

export interface CanonicalOrder {
  orderId: number | null;
  orderNumber: string | null;
  clientId: number | null;
  contactId: number | null;
  date: string | null;
  nameservers: string | null;
  amount: number | null;
  paymentMethod: string | null;
  paymentStatus: string | null;
  status: string | null;
  invoiceId: number | null;
  ipAddress: string | null;
  fraudOutput: string | null;
  notes: string | null;
  lineItems: CanonicalOrderLineItem[];
}

const CLASSES = new ClassMapBuilder()
  .many(['orderId', 'clientId', 'contactId', 'invoiceId'], 'business.identifier')
  .set('orderNumber', 'business.identifier')
  .set('amount', 'financial.amount')
  .set('paymentMethod', 'financial.reference')
  .many(
    ['date', 'nameservers', 'paymentStatus', 'status'],
    'public.safe'
  )
  .set('ipAddress', 'pii.address')
  .set('fraudOutput', 'system.audit')
  .set('notes', 'untrusted.free_text')
  .set('lineItems', 'public.safe')
  // Track B: line-item product / domain are business DISPLAY labels.
  .many(['lineItems[].product', 'lineItems[].domain'], 'business.label')
  .many(
    [
      'lineItems[].type',
      'lineItems[].billingCycle',
      'lineItems[].status',
    ],
    'public.safe'
  )
  .set('lineItems[].amount', 'financial.amount')
  .build();

function mapLineItem(li: Record<string, unknown>): CanonicalOrderLineItem {
  return {
    type: str(li, 'type') ?? null,
    product: str(li, 'product') ?? null,
    domain: str(li, 'domain') ?? null,
    billingCycle: str(li, 'billingcycle') ?? null,
    amount: num(li, 'amount') ?? null,
    status: str(li, 'status') ?? null,
  };
}

function mapOne(src: Record<string, unknown>): CanonicalOrder {
  const lineItems = listOf(src.lineitems, 'lineitem').map(mapLineItem);
  return {
    orderId: num(src, 'id') ?? num(src, 'orderid') ?? null,
    orderNumber: str(src, 'ordernum') ?? null,
    clientId: num(src, 'userid') ?? num(src, 'clientid') ?? null,
    contactId: num(src, 'contactid') ?? null,
    date: str(src, 'date') ?? null,
    nameservers: str(src, 'nameservers') ?? null,
    amount: num(src, 'amount') ?? null,
    paymentMethod: str(src, 'paymentmethod') ?? null,
    paymentStatus: str(src, 'paymentstatus') ?? null,
    status: str(src, 'status') ?? null,
    invoiceId: num(src, 'invoiceid') ?? null,
    ipAddress: str(src, 'ipaddress') ?? null,
    fraudOutput: str(src, 'fraudoutput') ?? null,
    notes: str(src, 'notes') ?? null,
    lineItems,
  };
}

export function mapToCanonicalOrder(
  raw: unknown
): Canonical<CanonicalOrder> {
  return { entity: 'order', data: mapOne(asRecord(raw)), classes: CLASSES };
}

export function mapToCanonicalOrders(
  raw: unknown
): Canonical<CanonicalOrder>[] {
  const src = asRecord(raw);
  return listOf(src.orders, 'order').map((r) => ({
    entity: 'order' as const,
    data: mapOne(r),
    classes: CLASSES,
  }));
}
