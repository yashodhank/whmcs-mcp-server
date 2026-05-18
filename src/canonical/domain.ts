/**
 * Canonical mapper — WHMCS GetClientsDomains domain row →
 * Canonical<CanonicalDomain>. Unwraps domains.domain. COMPLETE; projection
 * happens at the output boundary. See docs/PHASE_B_GOVERNANCE.md §3.
 */
import type { Canonical } from '../governance/types.js';
import { asRecord, str, num, bool, listOf, ClassMapBuilder } from './_shared.js';

export interface CanonicalDomain {
  domainId: number | null;
  clientId: number | null;
  domain: string | null;
  registrar: string | null;
  registrationDate: string | null;
  expiryDate: string | null;
  nextDueDate: string | null;
  nextInvoiceDate: string | null;
  status: string | null;
  registrationPeriod: number | null;
  recurringAmount: number | null;
  firstPaymentAmount: number | null;
  paymentMethod: string | null;
  idProtection: boolean | null;
  doNotRenew: boolean | null;
  dnsManagement: boolean | null;
  emailForwarding: boolean | null;
  notes: string | null;
}

const CLASSES = new ClassMapBuilder()
  .many(['domainId', 'clientId'], 'business.identifier')
  // Track B: a domain name is a non-sensitive business DISPLAY label, not
  // generic "public.safe" metadata (and certainly not a person name).
  .set('domain', 'business.label')
  .many(
    [
      'registrar',
      'registrationDate',
      'expiryDate',
      'nextDueDate',
      'nextInvoiceDate',
      'status',
      'registrationPeriod',
      'idProtection',
      'doNotRenew',
      'dnsManagement',
      'emailForwarding',
    ],
    'public.safe'
  )
  .many(['recurringAmount', 'firstPaymentAmount'], 'financial.amount')
  .set('paymentMethod', 'financial.reference')
  .set('notes', 'untrusted.free_text')
  .build();

function mapOne(src: Record<string, unknown>): CanonicalDomain {
  return {
    domainId: num(src, 'id') ?? num(src, 'domainid') ?? null,
    clientId: num(src, 'userid') ?? num(src, 'clientid') ?? null,
    domain: str(src, 'domain') ?? str(src, 'domainname') ?? null,
    registrar: str(src, 'registrar') ?? null,
    registrationDate: str(src, 'registrationdate') ?? str(src, 'regdate') ?? null,
    expiryDate: str(src, 'expirydate') ?? null,
    nextDueDate: str(src, 'nextduedate') ?? null,
    nextInvoiceDate: str(src, 'nextinvoicedate') ?? null,
    status: str(src, 'status') ?? null,
    registrationPeriod: num(src, 'registrationperiod') ?? null,
    recurringAmount: num(src, 'recurringamount') ?? null,
    firstPaymentAmount: num(src, 'firstpaymentamount') ?? null,
    paymentMethod: str(src, 'paymentmethod') ?? null,
    idProtection: bool(src, 'idprotection') ?? null,
    doNotRenew: bool(src, 'donotrenew') ?? null,
    dnsManagement: bool(src, 'dnsmanagement') ?? null,
    emailForwarding: bool(src, 'emailforwarding') ?? null,
    notes: str(src, 'notes') ?? null,
  };
}

export function mapToCanonicalDomain(
  raw: unknown
): Canonical<CanonicalDomain> {
  return { entity: 'domain', data: mapOne(asRecord(raw)), classes: CLASSES };
}

export function mapToCanonicalDomains(
  raw: unknown
): Canonical<CanonicalDomain>[] {
  const src = asRecord(raw);
  return listOf(src.domains, 'domain').map((r) => ({
    entity: 'domain' as const,
    data: mapOne(r),
    classes: CLASSES,
  }));
}
