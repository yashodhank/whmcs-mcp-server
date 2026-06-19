/**
 * Canonical mappers — WHMCS operational SYSTEM REFERENCE reads:
 *   - GetCurrencies     → Canonical<CanonicalCurrencies>
 *   - GetPaymentMethods → Canonical<CanonicalPaymentMethods>
 *   - WhmcsDetails      → Canonical<CanonicalWhmcsDetails>
 *
 * These are GLOBAL/admin reads of INSTALL-LEVEL reference data. They are not
 * client-scoped and carry NO per-customer PII — currency tables, payment-gateway
 * module labels, and the WHMCS version string are operational configuration,
 * never an individual's data.
 *
 * Canonical-entity assumption: the frozen CanonicalEntity union
 * (governance/types.ts) is NOT extended. A system-reference snapshot is an admin
 * operational record → it reuses the EXISTING frozen 'activity' entity, exactly
 * as the GetStats mapper (systemStats.ts) does. Single object per response —
 * there is no plural form.
 *
 * WHMCS shapes are loosely typed (numeric strings, single-object-instead-of-array,
 * nested singular wrappers), so every value is narrowed defensively via the
 * _shared helpers and dynamic lists are collapsed into typed arrays so the
 * classmap is COMPLETE and stable. See docs/design/governance.md §2/§3.
 *
 * Field classification:
 *   GetCurrencies
 *     - currencies[].id / .code            → business.identifier
 *     - currencies[].prefix/.suffix/.format → business.label (display affixes)
 *     - currencies[].rate                  → financial.amount
 *     - currencies[].isDefault             → public.safe (non-sensitive flag)
 *   GetPaymentMethods
 *     - methods[].module / .displayName    → business.label
 *   WhmcsDetails
 *     - version / release                  → public.safe (system info; no secrets)
 */
import type { Canonical } from '../governance/types.js';
import { asRecord, str, num, bool, listOf, ClassMapBuilder } from './_shared.js';

/* ─────────────────────────────  GetCurrencies  ───────────────────────────── */

export interface CanonicalCurrency {
  id: number | null;
  code: string | null;
  prefix: string | null;
  suffix: string | null;
  format: string | null;
  rate: number | null;
  isDefault: boolean;
}

export interface CanonicalCurrencies {
  currencies: CanonicalCurrency[];
}

const CURRENCY_CLASSES = new ClassMapBuilder()
  .many(['currencies[].id', 'currencies[].code'], 'business.identifier')
  .many(
    ['currencies[].prefix', 'currencies[].suffix', 'currencies[].format'],
    'business.label'
  )
  .set('currencies[].rate', 'financial.amount')
  .set('currencies[].isDefault', 'public.safe')
  // Empty-array container collapses to the array path itself — classify it.
  .set('currencies', 'public.safe')
  .build();

function mapCurrency(row: Record<string, unknown>): CanonicalCurrency {
  return {
    id: num(row, 'id') ?? null,
    code: str(row, 'code') ?? null,
    prefix: str(row, 'prefix') ?? null,
    suffix: str(row, 'suffix') ?? null,
    format: str(row, 'format') ?? null,
    rate: num(row, 'rate') ?? null,
    // WHMCS marks the install default with `default` (1/0). Absent ⇒ false.
    isDefault: bool(row, 'default') ?? false,
  };
}

export function mapToCanonicalCurrencies(
  raw: unknown
): Canonical<CanonicalCurrencies> {
  const src = asRecord(raw);
  // GetCurrencies → { currencies: { currency: [...] } }; tolerate a flat
  // `currency` fallback and single-object rows.
  const nested =
    'currencies' in src ? src.currencies : (src as { currency?: unknown });
  const rows = listOf(nested, 'currency');

  return {
    entity: 'activity',
    data: { currencies: rows.map(mapCurrency) },
    classes: CURRENCY_CLASSES,
  };
}

/* ───────────────────────────  GetPaymentMethods  ─────────────────────────── */

export interface CanonicalPaymentMethod {
  module: string | null;
  displayName: string | null;
}

export interface CanonicalPaymentMethods {
  methods: CanonicalPaymentMethod[];
}

const PAYMENT_METHOD_CLASSES = new ClassMapBuilder()
  .many(['methods[].module', 'methods[].displayName'], 'business.label')
  // Empty-array container collapses to the array path itself — classify it.
  .set('methods', 'public.safe')
  .build();

function mapPaymentMethod(
  row: Record<string, unknown>
): CanonicalPaymentMethod {
  return {
    module: str(row, 'module') ?? null,
    displayName: str(row, 'displayname') ?? null,
  };
}

export function mapToCanonicalPaymentMethods(
  raw: unknown
): Canonical<CanonicalPaymentMethods> {
  const src = asRecord(raw);
  // GetPaymentMethods → { paymentmethods: { paymentmethod: [...] } }; tolerate
  // a flat `paymentmethod` fallback and single-object rows.
  const nested =
    'paymentmethods' in src
      ? src.paymentmethods
      : (src as { paymentmethod?: unknown });
  const rows = listOf(nested, 'paymentmethod');

  return {
    entity: 'activity',
    data: { methods: rows.map(mapPaymentMethod) },
    classes: PAYMENT_METHOD_CLASSES,
  };
}

/* ─────────────────────────────  WhmcsDetails  ────────────────────────────── */

export interface CanonicalWhmcsDetails {
  /** WHMCS version string, e.g. "8.10.1". */
  version: string | null;
  /** Release/canonical version string, e.g. "8.10.1-release.1". */
  release: string | null;
}

const WHMCS_DETAILS_CLASSES = new ClassMapBuilder()
  // System info only — version/release are non-sensitive and contain no secrets.
  .many(['version', 'release'], 'public.safe')
  .build();

export function mapToCanonicalWhmcsDetails(
  raw: unknown
): Canonical<CanonicalWhmcsDetails> {
  const src = asRecord(raw);
  // WhmcsDetails → { whmcs: { version, canonicalversion }, ... }; tolerate the
  // fields being hoisted to the top level on some builds.
  const whmcs = 'whmcs' in src ? asRecord(src.whmcs) : src;

  return {
    entity: 'activity',
    data: {
      version: str(whmcs, 'version') ?? null,
      release:
        str(whmcs, 'canonicalversion') ?? str(whmcs, 'release') ?? null,
    },
    classes: WHMCS_DETAILS_CLASSES,
  };
}
