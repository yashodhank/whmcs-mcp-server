/**
 * Canonical mapper — WHMCS `GetContacts` contact row → Canonical<CanonicalContact>.
 *
 * A WHMCS *contact* is a sub-record of a client (a sub-account / additional
 * contact). It carries the same per-person PII as a client (name, email,
 * phone, postal address) plus a company display label and a set of
 * permission / sub-account flags:
 *  - id                                  → business.identifier
 *  - firstName / lastName                → pii.name
 *  - email                               → pii.email
 *  - phoneNumber                         → pii.phone
 *  - address1/2 / city / state /
 *    postcode / country                  → pii.address (a person's postal address)
 *  - companyName                         → business.label (display label, not PII)
 *  - subAccount / permissions/flags      → public.safe (non-sensitive booleans/labels)
 *
 * NO secrets are emitted: `GetContacts` never returns passwords via this path
 * and we deliberately do not map any credential-ish field.
 *
 * Data is COMPLETE — projection/redaction happens later at the output boundary
 * (not here). The classmap covers EVERY emitted path (completeness is the
 * governance contract; an unmapped path is RESTRICTED downstream).
 *
 * Entity: the frozen CanonicalEntity union has no 'contact' member, so a
 * contact is packaged under the closest owning entity, 'client' (a contact is
 * a client contact record). contracts.ts is unaffected — every FieldClass used
 * here already exists.
 *
 * WHMCS list shapes are inconsistent (`contacts.contact` may be an array OR a
 * single object; numbers/booleans arrive as strings) — parsed defensively with
 * the shared _shared helpers.
 *
 * See docs/design/governance.md §2/§3.
 */
import type { Canonical } from '../governance/types.js';
import { asRecord, str, num, bool, listOf, ClassMapBuilder } from './_shared.js';

export interface CanonicalContact {
  contactId: number | null;
  clientId: number | null;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  email: string | null;
  phoneNumber: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  country: string | null;
  subAccount: boolean | null;
  permissions: string | null;
}

const CLASSES = new ClassMapBuilder()
  .set('contactId', 'business.identifier')
  .set('clientId', 'business.identifier')
  .many(['firstName', 'lastName'], 'pii.name')
  .set('email', 'pii.email')
  .set('phoneNumber', 'pii.phone')
  .many(
    ['address1', 'address2', 'city', 'state', 'postcode', 'country'],
    'pii.address'
  )
  // Company is a display label for an operator/console, not a person's PII.
  .set('companyName', 'business.label')
  // Sub-account flag + the comma-separated permission list are non-sensitive
  // capability metadata, never credentials.
  .many(['subAccount', 'permissions'], 'public.safe')
  .build();

function mapOne(src: Record<string, unknown>): CanonicalContact {
  return {
    contactId: num(src, 'id') ?? num(src, 'contactid') ?? null,
    clientId: num(src, 'userid') ?? num(src, 'clientid') ?? null,
    firstName: str(src, 'firstname') ?? null,
    lastName: str(src, 'lastname') ?? null,
    companyName: str(src, 'companyname') ?? null,
    email: str(src, 'email') ?? null,
    phoneNumber: str(src, 'phonenumber') ?? null,
    address1: str(src, 'address1') ?? null,
    address2: str(src, 'address2') ?? null,
    city: str(src, 'city') ?? null,
    state: str(src, 'state') ?? null,
    postcode: str(src, 'postcode') ?? null,
    country: str(src, 'country') ?? null,
    subAccount: bool(src, 'subaccount') ?? null,
    // WHMCS exposes the sub-account capability set as a comma-separated string.
    permissions: str(src, 'permissions') ?? null,
  };
}

export function mapToCanonicalContact(
  raw: unknown
): Canonical<CanonicalContact> {
  return { entity: 'client', data: mapOne(asRecord(raw)), classes: CLASSES };
}

export function mapToCanonicalContacts(
  raw: unknown
): Canonical<CanonicalContact>[] {
  const src = asRecord(raw);
  // GetContacts nests under contacts.contact (defensive: single object too).
  // Some builds flatten to a top-level `contact` key — accept that too, but
  // never treat the whole response object as a contact row.
  const rows = listOf(src.contacts, 'contact');
  const finalRows = rows.length === 0 ? listOf(src.contact, 'contact') : rows;
  return finalRows.map((r) => ({
    entity: 'client' as const,
    data: mapOne(r),
    classes: CLASSES,
  }));
}
