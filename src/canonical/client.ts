/**
 * Canonical mapper — WHMCS GetClientsDetails → Canonical<CanonicalClient>.
 *
 * WHMCS documents the flat top-level shape as deprecated and nests the record
 * under `client` (with counts under `client.stats`). We parse defensively from
 * BOTH: nested wins when present, falling back to root. Data is COMPLETE;
 * projection/redaction happens later at the output boundary (not here).
 *
 * See docs/design/governance.md §3.
 */
import type { Canonical } from '../governance/types.js';
import { resolveClientCustomFieldLabel } from '../clientCustomFieldLabels.js';
import { asRecord, str, num, listOf, ClassMapBuilder } from './_shared.js';

export interface CanonicalCustomField {
  id: number | null;
  name: string | null;
  value: string | null;
}

export interface CanonicalClientStats {
  productCountActive: number | null;
  productCountTotal: number | null;
  domainCountActive: number | null;
  domainCountTotal: number | null;
}

export interface CanonicalClient {
  clientId: number | null;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  companyName: string | null;
  email: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  country: string | null;
  phoneNumber: string | null;
  taxId: string | null;
  status: string | null;
  creditBalance: number | null;
  currencyCode: string | null;
  paymentGateway: string | null;
  dateCreated: string | null;
  lastLogin: string | null;
  stats: CanonicalClientStats;
  customFields: CanonicalCustomField[];
}

export function mapToCanonicalClient(
  raw: unknown
): Canonical<CanonicalClient> {
  const root = asRecord(raw);
  // Nested `client` wins (current WHMCS shape); root is the deprecated path.
  const nested = asRecord(root.client);
  const src: Record<string, unknown> =
    Object.keys(nested).length > 0 ? nested : root;

  const statsSrc = asRecord(src.stats);
  const stats: CanonicalClientStats = {
    productCountActive: num(statsSrc, 'productsnumactive') ?? null,
    productCountTotal: num(statsSrc, 'productsnumtotal') ?? null,
    domainCountActive: num(statsSrc, 'numactivedomains') ?? null,
    domainCountTotal: num(statsSrc, 'numdomains') ?? null,
  };

  const customFields: CanonicalCustomField[] = listOf(
    src.customfields,
    'customfield'
  ).map((cf) => {
    const id = num(cf, 'id');
    const value = str(cf, 'value') ?? null;
    const whmcsName = str(cf, 'fieldname') ?? str(cf, 'name') ?? str(cf, 'label');
    const resolvedName =
      id !== undefined && value !== null
        ? resolveClientCustomFieldLabel({
            id,
            value,
            name: str(cf, 'name') ?? undefined,
            label: str(cf, 'label') ?? undefined,
            fieldname: str(cf, 'fieldname') ?? undefined,
          })
        : whmcsName;
    return {
      id: id ?? null,
      name: resolvedName ?? whmcsName ?? null,
      value,
    };
  });

  const data: CanonicalClient = {
    clientId: num(src, 'id') ?? num(src, 'userid') ?? num(src, 'clientid') ?? null,
    firstName: str(src, 'firstname') ?? null,
    lastName: str(src, 'lastname') ?? null,
    fullName: str(src, 'fullname') ?? null,
    companyName: str(src, 'companyname') ?? null,
    email: str(src, 'email') ?? null,
    address1: str(src, 'address1') ?? null,
    address2: str(src, 'address2') ?? null,
    city: str(src, 'city') ?? null,
    state: str(src, 'state') ?? null,
    postcode: str(src, 'postcode') ?? null,
    country: str(src, 'country') ?? null,
    phoneNumber: str(src, 'phonenumber') ?? null,
    taxId: str(src, 'tax_id') ?? str(src, 'vatnumber') ?? str(src, 'gstin') ?? null,
    status: str(src, 'status') ?? null,
    creditBalance: num(src, 'credit') ?? null,
    currencyCode: str(src, 'currency_code') ?? str(src, 'currencycode') ?? null,
    paymentGateway: str(src, 'defaultgateway') ?? null,
    dateCreated: str(src, 'datecreated') ?? null,
    lastLogin: str(src, 'lastlogin') ?? null,
    stats,
    customFields,
  };

  const classes = new ClassMapBuilder()
    .set('clientId', 'business.identifier')
    .many(
      ['firstName', 'lastName', 'fullName', 'companyName'],
      'pii.name'
    )
    .set('email', 'pii.email')
    .set('phoneNumber', 'pii.phone')
    .many(
      ['address1', 'address2', 'city', 'state', 'postcode', 'country'],
      'pii.address'
    )
    .set('taxId', 'pii.tax')
    .set('creditBalance', 'financial.amount')
    .set('paymentGateway', 'financial.reference')
    .many(
      [
        'status',
        'currencyCode',
        'dateCreated',
        'lastLogin',
        'stats.productCountActive',
        'stats.productCountTotal',
        'stats.domainCountActive',
        'stats.domainCountTotal',
      ],
      'public.safe'
    )
    .set('customFields[].id', 'business.identifier')
    .set('customFields[].name', 'public.safe')
    .set('customFields[].value', 'pii.custom_field')
    // Empty-array fallback path (assertClassmapComplete collapses [] → path).
    .set('customFields', 'pii.custom_field')
    .set('stats', 'public.safe')
    .build();

  return { entity: 'client', data, classes };
}
