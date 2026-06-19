/**
 * Canonical mapper — WHMCS `GetTLDPricing` → Canonical<CanonicalTldPricing>.
 * Optionally annotated with `GetRegistrars` (the active registrar module name).
 *
 * This is STATIC REFERENCE DATA: per-TLD register/renew/transfer pricing for a
 * single currency. There is NO per-customer PII here.
 *  - currencyCode / currencyId → business.identifier (the price book's currency)
 *  - registrar → business.label (the registrar module display name)
 *  - prices[].tld → business.label (the TLD string, e.g. ".com")
 *  - prices[].register/renew/transfer[].period → public.safe (an integer of years)
 *  - prices[].*[].price → financial.amount
 *  - prices[].addons.* (dns/email/idprotect flags) → system.status
 *
 * WHMCS shapes are inconsistent: `pricing` is an OBJECT keyed by TLD (not an
 * array); each operation (register/renew/transfer) is an OBJECT keyed by period
 * ("1","2",…) → price string; prices are numeric STRINGS, and "-1" means
 * "not offered" (dropped). Parsed defensively with _shared helpers. The
 * canonical shape collapses these dynamic keys into typed arrays so the
 * classmap is COMPLETE and stable (dynamic keys would otherwise be unmappable).
 *
 * Canonical entity: the frozen CanonicalEntity union is extended with
 * 'tldPricing' (a reference-data entity). See docs/design/governance.md §2/§3.
 */
import type { Canonical } from '../governance/types.js';
import { asRecord, str, num, bool, listOf, ClassMapBuilder } from './_shared.js';

export interface CanonicalTldPrice {
  /** Term length in years for this price point. */
  period: number;
  /** Price for the term in the price book's currency. */
  price: number;
}

export interface CanonicalTldAddons {
  dnsManagement: boolean | null;
  emailForwarding: boolean | null;
  idProtection: boolean | null;
}

export interface CanonicalTldEntry {
  tld: string;
  register: CanonicalTldPrice[];
  renew: CanonicalTldPrice[];
  transfer: CanonicalTldPrice[];
  addons: CanonicalTldAddons;
}

export interface CanonicalTldPricing {
  currencyCode: string | null;
  currencyId: number | null;
  registrar: string | null;
  prices: CanonicalTldEntry[];
}

const CLASSES = new ClassMapBuilder()
  .many(['currencyCode', 'currencyId'], 'business.identifier')
  .set('registrar', 'business.label')
  .set('prices[].tld', 'business.label')
  .many(
    [
      'prices[].register[].period',
      'prices[].renew[].period',
      'prices[].transfer[].period',
    ],
    'public.safe'
  )
  .many(
    [
      'prices[].register[].price',
      'prices[].renew[].price',
      'prices[].transfer[].price',
    ],
    'financial.amount'
  )
  .many(
    [
      'prices[].addons.dnsManagement',
      'prices[].addons.emailForwarding',
      'prices[].addons.idProtection',
    ],
    'system.status'
  )
  // Empty-array containers collapse to the array path itself — classify them.
  .many(
    ['prices', 'prices[].register', 'prices[].renew', 'prices[].transfer'],
    'public.safe'
  )
  .build();

/**
 * A WHMCS operation block ("register"/"renew"/"transfer") is an object keyed by
 * period → price string. "-1" / negative ⇒ "not offered", dropped. Periods are
 * emitted in ascending numeric order for stable output.
 */
function mapPriceBlock(value: unknown): CanonicalTldPrice[] {
  const block = asRecord(value);
  const out: CanonicalTldPrice[] = [];
  for (const key of Object.keys(block)) {
    const period = Number(key);
    // WHMCS registration periods are whole years — reject fractional/garbage
    // keys ("1.5", "abc") rather than emit a nonsense period.
    if (!Number.isInteger(period) || period <= 0) {
      continue;
    }
    const price = num(block, key);
    if (price === undefined || price < 0) {
      continue;
    }
    out.push({ period, price });
  }
  return out.sort((a, b) => a.period - b.period);
}

function mapAddons(src: Record<string, unknown>): CanonicalTldAddons {
  return {
    dnsManagement: bool(src, 'dnsmanagement') ?? null,
    emailForwarding: bool(src, 'emailforwarding') ?? null,
    idProtection: bool(src, 'idprotection') ?? null,
  };
}

function mapEntry(tld: string, value: unknown): CanonicalTldEntry {
  const src = asRecord(value);
  return {
    tld,
    register: mapPriceBlock(src.register),
    renew: mapPriceBlock(src.renew),
    transfer: mapPriceBlock(src.transfer),
    addons: mapAddons(asRecord(src.addons)),
  };
}

/**
 * Resolve the registrar label. `GetRegistrars` returns `registrars.registrar[]`
 * with `module`/`displayname`; we accept a pre-resolved string or that raw
 * shape and pick the first module name. Pricing reference is registrar-scoped
 * at the install level, so a single label is sufficient.
 */
function resolveRegistrar(registrar: unknown): string | null {
  if (typeof registrar === 'string' && registrar.trim() !== '') {
    return registrar;
  }
  const rec = asRecord(registrar);
  const list = listOf(rec.registrars, 'registrar');
  if (list.length === 0) {
    return null;
  }
  const first = list[0];
  return str(first, 'module') ?? str(first, 'displayname') ?? null;
}

export function mapToCanonicalTldPricing(
  raw: unknown,
  registrar?: unknown
): Canonical<CanonicalTldPricing> {
  const src = asRecord(raw);
  const currency = asRecord(src.currency);
  const pricing = asRecord(src.pricing);

  const prices: CanonicalTldEntry[] = Object.entries(pricing)
    .map(([tld, value]) => mapEntry(tld, value))
    .sort((a, b) => a.tld.localeCompare(b.tld));

  return {
    entity: 'tldPricing',
    data: {
      currencyCode: str(currency, 'code') ?? str(currency, 'prefix') ?? null,
      currencyId: num(currency, 'id') ?? null,
      registrar: resolveRegistrar(registrar),
      prices,
    },
    classes: CLASSES,
  };
}
