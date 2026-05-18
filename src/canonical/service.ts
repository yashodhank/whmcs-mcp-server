/**
 * Canonical mapper — WHMCS GetClientsProducts product row →
 * Canonical<CanonicalService>. Unwraps products.product + customfields.
 * COMPLETE; credentials are classified secret.credential (dropped at the
 * projection boundary in every prod contract). See PHASE_B_GOVERNANCE.md §3.
 */
import type { Canonical } from '../governance/types.js';
import { asRecord, str, num, listOf, ClassMapBuilder } from './_shared.js';
import type { CanonicalCustomField } from './client.js';

export interface CanonicalService {
  serviceId: number | null;
  clientId: number | null;
  productId: number | null;
  productName: string | null;
  groupName: string | null;
  domain: string | null;
  status: string | null;
  regDate: string | null;
  nextDueDate: string | null;
  nextInvoiceDate: string | null;
  terminationDate: string | null;
  recurringAmount: number | null;
  firstPaymentAmount: number | null;
  paymentMethod: string | null;
  billingCycle: string | null;
  username: string | null;
  password: string | null;
  dedicatedIp: string | null;
  assignedIps: string | null;
  serverId: number | null;
  serverName: string | null;
  notes: string | null;
  customFields: CanonicalCustomField[];
}

const CLASSES = new ClassMapBuilder()
  .many(
    ['serviceId', 'clientId', 'productId', 'serverId'],
    'business.identifier'
  )
  // Track B: product / group / domain are business DISPLAY labels.
  .set('productName', 'business.label')
  .set('groupName', 'business.label')
  .set('domain', 'business.label')
  .many(
    [
      'status',
      'regDate',
      'nextDueDate',
      'nextInvoiceDate',
      'terminationDate',
      'billingCycle',
      'serverName',
    ],
    'public.safe'
  )
  .many(['recurringAmount', 'firstPaymentAmount'], 'financial.amount')
  .set('paymentMethod', 'financial.reference')
  .many(['username', 'password'], 'secret.credential')
  .many(['dedicatedIp', 'assignedIps'], 'secret.credential')
  .set('notes', 'untrusted.free_text')
  .set('customFields', 'pii.custom_field')
  .set('customFields[].id', 'business.identifier')
  .set('customFields[].name', 'public.safe')
  .set('customFields[].value', 'pii.custom_field')
  .build();

function mapOne(src: Record<string, unknown>): CanonicalService {
  const customFields: CanonicalCustomField[] = listOf(
    src.customfields,
    'customfield'
  ).map((cf) => ({
    id: num(cf, 'id') ?? null,
    name: str(cf, 'fieldname') ?? null,
    value: str(cf, 'value') ?? null,
  }));

  return {
    serviceId: num(src, 'id') ?? num(src, 'serviceid') ?? null,
    clientId: num(src, 'clientid') ?? num(src, 'userid') ?? null,
    productId: num(src, 'pid') ?? null,
    productName: str(src, 'name') ?? str(src, 'productname') ?? null,
    groupName: str(src, 'groupname') ?? null,
    domain: str(src, 'domain') ?? null,
    status: str(src, 'status') ?? null,
    regDate: str(src, 'regdate') ?? null,
    nextDueDate: str(src, 'nextduedate') ?? null,
    nextInvoiceDate: str(src, 'nextinvoicedate') ?? null,
    terminationDate: str(src, 'terminationdate') ?? null,
    recurringAmount: num(src, 'recurringamount') ?? null,
    firstPaymentAmount: num(src, 'firstpaymentamount') ?? null,
    paymentMethod: str(src, 'paymentmethod') ?? null,
    billingCycle: str(src, 'billingcycle') ?? null,
    username: str(src, 'username') ?? null,
    password: str(src, 'password') ?? null,
    dedicatedIp: str(src, 'dedicatedip') ?? null,
    assignedIps: str(src, 'assignedips') ?? null,
    serverId: num(src, 'serverid') ?? null,
    serverName: str(src, 'servername') ?? null,
    notes: str(src, 'notes') ?? null,
    customFields,
  };
}

export function mapToCanonicalService(
  raw: unknown
): Canonical<CanonicalService> {
  return { entity: 'service', data: mapOne(asRecord(raw)), classes: CLASSES };
}

export function mapToCanonicalServices(
  raw: unknown
): Canonical<CanonicalService>[] {
  const src = asRecord(raw);
  // GetClientsProducts nests under products.product (services is an alias).
  const rows = listOf(src.products, 'product');
  const alt = rows.length === 0 ? listOf(src.services, 'service') : rows;
  return alt.map((r) => ({
    entity: 'service' as const,
    data: mapOne(r),
    classes: CLASSES,
  }));
}
