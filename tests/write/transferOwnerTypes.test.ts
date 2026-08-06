import { describe, it, expect } from 'vitest';
import { WRITE_SCOPES, SCOPE_ACTION, SCOPE_RISK, PROD_NEVER_EXECUTABLE_SCOPES, DB_DIRECT_ACTION } from '../../src/write/types.js';

describe('service-owner-transfer scopes', () => {
  it('registers both scopes', () => {
    expect(WRITE_SCOPES).toContain('service:transfer_owner');
    expect(WRITE_SCOPES).toContain('billing:invoice:reassign');
  });
  it('uses the DB-direct sentinel action', () => {
    expect(SCOPE_ACTION['service:transfer_owner']).toBe(DB_DIRECT_ACTION);
    expect(SCOPE_ACTION['billing:invoice:reassign']).toBe(DB_DIRECT_ACTION);
  });
  it('are high risk', () => {
    expect(SCOPE_RISK['service:transfer_owner']).toBe('high');
    expect(SCOPE_RISK['billing:invoice:reassign']).toBe('high');
  });
  it('are not permanently prod-sealed', () => {
    expect(PROD_NEVER_EXECUTABLE_SCOPES.has('service:transfer_owner')).toBe(false);
    expect(PROD_NEVER_EXECUTABLE_SCOPES.has('billing:invoice:reassign')).toBe(false);
  });
});
