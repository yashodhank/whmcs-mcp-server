/**
 * Frozen-seam additions for service:price_restore. Type-only assertions +
 * runtime presence checks.
 */
import { describe, it, expect } from 'vitest';
import {
  WRITE_SCOPES,
  SCOPE_ACTION,
  SCOPE_RISK,
  type ExecutionDeniedReason,
} from '../../src/write/types.js';

describe('service:price_restore frozen-seam additions', () => {
  it('is registered in WRITE_SCOPES', () => {
    expect(WRITE_SCOPES as readonly string[]).toContain('service:price_restore');
  });

  it('maps to UpdateClientProduct in SCOPE_ACTION', () => {
    expect(SCOPE_ACTION['service:price_restore']).toBe('UpdateClientProduct');
  });

  it('is high-risk in SCOPE_RISK', () => {
    expect(SCOPE_RISK['service:price_restore']).toBe('high');
  });

  it('declares new denied reasons in the type union', () => {
    const reasons: ExecutionDeniedReason[] = [
      'precondition_mismatch',
      'halt_after_target',
      'target_amount_cap_exceeded',
      'target_output_assertion_failed',
    ];
    expect(reasons).toHaveLength(4);
  });
});
