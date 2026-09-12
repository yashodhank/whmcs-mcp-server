/**
 * GST/TDS identity fields from GetClientsDetails.
 *
 * Amounts live on WHMCS invoice line tax fields. This MCP does not invent
 * tax math (ADR Phase 4).
 */

import { str } from '../canonical/_shared.js';

export const TAX_AMOUNTS_NOT_COMPUTED = 'not_computed' as const;

export const TAX_FIELDS_NOTE =
  'GST/TDS amounts live on WHMCS invoice line tax fields. This MCP does not invent tax math.';

export function taxFieldsFromClientDetails(
  details: Record<string, unknown>
): Record<string, unknown> {
  const exempt = details.taxexempt;
  return {
    tax_id:
      str(details, 'tax_id') ??
      str(details, 'vatnumber') ??
      str(details, 'gstin') ??
      str(details, 'taxid'),
    country: str(details, 'country'),
    countrycode: str(details, 'countrycode'),
    taxexempt: exempt === true || exempt === 1 || exempt === '1' || exempt === 'on',
    gst_tds_amounts: TAX_AMOUNTS_NOT_COMPUTED,
    note: TAX_FIELDS_NOTE,
  };
}
