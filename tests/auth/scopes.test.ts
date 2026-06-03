/**
 * OAuth scope vocabulary + enforcement helpers (component 4) — unit tests.
 *
 * Pure helpers, no I/O. We exercise: the frozen vocabulary; the read/write tier
 * mappings; the fine-grained write-scope → OAuth-scope mapping for EVERY frozen
 * WRITE_SCOPE (driven off SCOPE_RISK so it can't drift); the privilege
 * hierarchy implications (a higher write tier satisfies lower-tier + read, read
 * does NOT satisfy any write); unknown-scope fail-closed behaviour; and
 * grantedFromScopes normalisation (trim / dedupe / drop-empty).
 */
import { describe, it, expect } from 'vitest';
import { WRITE_SCOPES, SCOPE_RISK } from '../../src/write/types.js';
import {
  OAUTH_SCOPES,
  requiredScopeForRead,
  requiredScopeForWrite,
  requiredScopeForWriteScope,
  hasRequiredScope,
  grantedFromScopes,
} from '../../src/auth/scopes.js';

describe('OAUTH_SCOPES vocabulary', () => {
  it('is exactly the four coarse scopes, least → most privileged', () => {
    expect(OAUTH_SCOPES).toEqual([
      'whmcs:read',
      'whmcs:write:low',
      'whmcs:write:medium',
      'whmcs:write:high',
    ]);
  });
});

describe('requiredScopeForRead', () => {
  it('always returns the read scope', () => {
    expect(requiredScopeForRead()).toBe('whmcs:read');
  });
});

describe('requiredScopeForWrite', () => {
  it('maps each risk tier to its OAuth scope', () => {
    expect(requiredScopeForWrite('low')).toBe('whmcs:write:low');
    expect(requiredScopeForWrite('medium')).toBe('whmcs:write:medium');
    expect(requiredScopeForWrite('high')).toBe('whmcs:write:high');
  });
});

describe('requiredScopeForWriteScope — every WRITE_SCOPE', () => {
  it.each(WRITE_SCOPES)('maps %s to its risk-tier OAuth scope', (writeScope) => {
    const risk = SCOPE_RISK[writeScope];
    expect(requiredScopeForWriteScope(writeScope)).toBe(`whmcs:write:${risk}`);
  });

  it('covers all three tiers across the vocabulary (sanity: no tier missing)', () => {
    const mapped = new Set(
      WRITE_SCOPES.map((s) => requiredScopeForWriteScope(s)),
    );
    expect(mapped).toEqual(
      new Set(['whmcs:write:low', 'whmcs:write:medium', 'whmcs:write:high']),
    );
  });

  it('fails closed to whmcs:write:high for an unknown write-scope', () => {
    expect(requiredScopeForWriteScope('does:not:exist')).toBe('whmcs:write:high');
    expect(requiredScopeForWriteScope('')).toBe('whmcs:write:high');
    // Not confusable with an OAuth scope passed by mistake.
    expect(requiredScopeForWriteScope('whmcs:read')).toBe('whmcs:write:high');
  });
});

describe('hasRequiredScope — hierarchy implications', () => {
  it('whmcs:write:high satisfies high, medium, low and read', () => {
    const g = ['whmcs:write:high'];
    expect(hasRequiredScope(g, 'whmcs:write:high')).toBe(true);
    expect(hasRequiredScope(g, 'whmcs:write:medium')).toBe(true);
    expect(hasRequiredScope(g, 'whmcs:write:low')).toBe(true);
    expect(hasRequiredScope(g, 'whmcs:read')).toBe(true);
  });

  it('whmcs:write:medium satisfies medium, low and read but NOT high', () => {
    const g = ['whmcs:write:medium'];
    expect(hasRequiredScope(g, 'whmcs:write:high')).toBe(false);
    expect(hasRequiredScope(g, 'whmcs:write:medium')).toBe(true);
    expect(hasRequiredScope(g, 'whmcs:write:low')).toBe(true);
    expect(hasRequiredScope(g, 'whmcs:read')).toBe(true);
  });

  it('whmcs:write:low satisfies low and read but NOT medium or high', () => {
    const g = ['whmcs:write:low'];
    expect(hasRequiredScope(g, 'whmcs:write:high')).toBe(false);
    expect(hasRequiredScope(g, 'whmcs:write:medium')).toBe(false);
    expect(hasRequiredScope(g, 'whmcs:write:low')).toBe(true);
    expect(hasRequiredScope(g, 'whmcs:read')).toBe(true);
  });

  it('whmcs:read satisfies ONLY read — never any write tier', () => {
    const g = ['whmcs:read'];
    expect(hasRequiredScope(g, 'whmcs:read')).toBe(true);
    expect(hasRequiredScope(g, 'whmcs:write:low')).toBe(false);
    expect(hasRequiredScope(g, 'whmcs:write:medium')).toBe(false);
    expect(hasRequiredScope(g, 'whmcs:write:high')).toBe(false);
  });

  it('honours the strongest scope when multiple are granted', () => {
    const g = ['whmcs:read', 'whmcs:write:medium'];
    expect(hasRequiredScope(g, 'whmcs:write:medium')).toBe(true);
    expect(hasRequiredScope(g, 'whmcs:write:high')).toBe(false);
  });
});

describe('hasRequiredScope — fail-closed edge cases', () => {
  it('empty grant satisfies nothing', () => {
    expect(hasRequiredScope([], 'whmcs:read')).toBe(false);
    expect(hasRequiredScope([], 'whmcs:write:high')).toBe(false);
  });

  it('unknown granted scopes grant nothing', () => {
    expect(hasRequiredScope(['admin', 'root', 'whmcs:write:ultra'], 'whmcs:read')).toBe(
      false,
    );
  });

  it('an unrecognised required scope can never be satisfied', () => {
    expect(hasRequiredScope(['whmcs:write:high'], 'whmcs:write:ultra')).toBe(false);
    expect(hasRequiredScope(['whmcs:write:high'], '')).toBe(false);
  });

  it('a write-scope check end-to-end: high-risk write needs whmcs:write:high', () => {
    const required = requiredScopeForWriteScope('billing:refund:record');
    expect(required).toBe('whmcs:write:high');
    expect(hasRequiredScope(['whmcs:write:medium'], required)).toBe(false);
    expect(hasRequiredScope(['whmcs:write:high'], required)).toBe(true);
  });
});

describe('grantedFromScopes — normalisation', () => {
  it('trims, drops empties, and dedupes preserving first-seen order', () => {
    expect(
      grantedFromScopes(['  whmcs:read ', 'whmcs:write:low', '', '  ', 'whmcs:read']),
    ).toEqual(['whmcs:read', 'whmcs:write:low']);
  });

  it('passes unknown scopes through unchanged (no vocabulary filter)', () => {
    expect(grantedFromScopes(['custom:scope', 'whmcs:read'])).toEqual([
      'custom:scope',
      'whmcs:read',
    ]);
  });

  it('returns an empty array for an all-blank input', () => {
    expect(grantedFromScopes(['', '   ', '\t'])).toEqual([]);
  });

  it('normalised output feeds straight into hasRequiredScope', () => {
    const granted = grantedFromScopes([' whmcs:write:high ', 'whmcs:write:high']);
    expect(granted).toEqual(['whmcs:write:high']);
    expect(hasRequiredScope(granted, 'whmcs:write:low')).toBe(true);
  });
});
