import { describe, it, expect } from 'vitest';
import { validateIntent } from '../../src/write/validation.js';
import { createDraftIntent } from '../../src/write/intents.js';
import type { WriteIntent } from '../../src/write/types.js';

function draft(params: Record<string, unknown>): WriteIntent {
  return createDraftIntent({
    consumer_id: 'c1',
    scope: 'service:price_restore',
    params,
    naturalKey: 'restore-test',
    preconditions: {},
    projected_effect: 'restore',
  });
}

describe('service:price_restore validation', () => {
  it('rejects when targets is missing', () => {
    const r = validateIntent(draft({}), {});
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'missing_required_param')).toBe(true);
  });

  it('rejects when targets is not an array', () => {
    const r = validateIntent(draft({ targets: 'oops' }), {});
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'invalid_targets_shape')).toBe(true);
  });

  it('rejects when targets is empty', () => {
    const r = validateIntent(draft({ targets: [] }), {});
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'invalid_targets_shape')).toBe(true);
  });

  it('rejects when a target is missing serviceid', () => {
    const r = validateIntent(draft({ targets: [{ new_amount: 100 }] }), {});
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'invalid_target_entry')).toBe(true);
  });

  it('rejects when a target has non-positive serviceid', () => {
    const r = validateIntent(draft({ targets: [{ serviceid: 0, new_amount: 100 }] }), {});
    expect(r.ok).toBe(false);
  });

  it('rejects when new_amount is non-positive', () => {
    const r = validateIntent(draft({ targets: [{ serviceid: 1, new_amount: 0 }] }), {});
    expect(r.ok).toBe(false);
  });

  it('rejects when expected_old_amount is non-positive', () => {
    const r = validateIntent(
      draft({ targets: [{ serviceid: 1, new_amount: 100, expected_old_amount: -1 }] }),
      {}
    );
    expect(r.ok).toBe(false);
  });

  it('rejects when dry_run is not a boolean', () => {
    const r = validateIntent(
      draft({ targets: [{ serviceid: 1, new_amount: 100 }], dry_run: 'yes' }),
      {}
    );
    expect(r.ok).toBe(false);
  });

  it('accepts a minimal valid batch (no expected_old_amount, no dry_run)', () => {
    const r = validateIntent(draft({ targets: [{ serviceid: 1, new_amount: 100 }] }), {});
    expect(r.ok).toBe(true);
  });

  it('accepts a valid batch with expected_old_amount and dry_run=true', () => {
    const r = validateIntent(
      draft({
        targets: [{ serviceid: 1, new_amount: 100, expected_old_amount: 200 }],
        dry_run: true,
      }),
      {}
    );
    expect(r.ok).toBe(true);
  });
});
