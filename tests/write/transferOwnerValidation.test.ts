import { describe, it, expect } from 'vitest';
import { validateIntent } from '../../src/write/validation.js';
import { createDraftIntent } from '../../src/write/intents.js';
import type { WriteScope } from '../../src/write/types.js';

function draft(scope: WriteScope, params: Record<string, unknown>) {
  return createDraftIntent({ consumer_id: 'c1', scope, params, naturalKey: 'k', preconditions: {}, projected_effect: 't' });
}
const codes = (i: ReturnType<typeof draft>) => validateIntent(i).issues.map((x) => x.code);
const ok = { source_clientid: 1, dest_clientid: 2, service_ids: [10, 11], invoice_mode: 'unpaid_only' };

describe('service:transfer_owner validation', () => {
  it('accepts well-formed', () => expect(validateIntent(draft('service:transfer_owner', ok)).ok).toBe(true));
  it('rejects empty service_ids', () => expect(codes(draft('service:transfer_owner', { ...ok, service_ids: [] }))).toContain('invalid_service_ids_shape'));
  it('rejects non-positive id', () => expect(codes(draft('service:transfer_owner', { ...ok, service_ids: [10, 0] }))).toContain('invalid_service_ids_shape'));
  it('rejects source===dest', () => expect(codes(draft('service:transfer_owner', { ...ok, dest_clientid: 1 }))).toContain('same_source_dest'));
  it('rejects bad invoice_mode', () => expect(codes(draft('service:transfer_owner', { ...ok, invoice_mode: 'most' }))).toContain('invalid_invoice_mode'));
  it('rejects non-bool dry_run', () => expect(codes(draft('service:transfer_owner', { ...ok, dry_run: 'y' }))).toContain('invalid_dry_run'));
});
describe('billing:invoice:reassign validation', () => {
  it('accepts well-formed', () => expect(validateIntent(draft('billing:invoice:reassign', { invoice_id: 5, dest_clientid: 2 })).ok).toBe(true));
  it('rejects non-positive invoice_id', () => expect(codes(draft('billing:invoice:reassign', { invoice_id: 0, dest_clientid: 2 }))).toContain('invalid_invoiceid'));
});
