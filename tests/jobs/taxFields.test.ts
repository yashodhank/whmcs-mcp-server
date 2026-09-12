import { describe, it, expect } from 'vitest';
import { TAX_AMOUNTS_NOT_COMPUTED, taxFieldsFromClientDetails } from '../../src/jobs/taxFields.js';

describe('taxFieldsFromClientDetails', () => {
  it('copies identity fields and does not invent GST/TDS amounts', () => {
    const tax = taxFieldsFromClientDetails({
      tax_id: '27AAAAA0000A1Z5',
      country: 'IN',
      countrycode: 'IN',
      taxexempt: '0',
    });
    expect(tax.tax_id).toBe('27AAAAA0000A1Z5');
    expect(tax.country).toBe('IN');
    expect(tax.gst_tds_amounts).toBe(TAX_AMOUNTS_NOT_COMPUTED);
    expect(tax.taxexempt).toBe(false);
  });
});
