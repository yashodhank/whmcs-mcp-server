/**
 * OAuth → ConsumerProfile bridge tests (OAUTH_DESIGN.md component 5).
 *
 * Proves the deny-by-default mapping from verified OAuth claims to a registry
 * ConsumerProfile, plus granted-scope extraction. Synthetic data only; pure,
 * no I/O.
 */

import { describe, it, expect } from 'vitest';
import {
  consumerFromClaims,
  consumerScopes,
  type OAuthClaims,
} from '../../src/auth/consumerBridge.js';
import type { ConsumerProfile } from '../../src/governance/types.js';

/** A privileged registry profile — the bridge must only ever hand THIS back on an exact id match. */
const opsProfile: ConsumerProfile = {
  id: 'ops-client',
  allowedScopes: ['whmcs:read', 'whmcs:write:low'],
  defaultContract: 'ops_operator',
  allowedContracts: ['ops_operator', 'llm_safe_summary'],
  allowedActions: ['get_client_details'],
  writeCapability: 'execution_allowed',
  envRestrictions: [],
  anonymous: false,
};

const safeProfile: ConsumerProfile = {
  id: 'llm-client',
  allowedScopes: ['whmcs:read'],
  defaultContract: 'llm_safe_summary',
  allowedContracts: ['llm_safe_summary'],
  allowedActions: [],
  writeCapability: 'false',
  envRestrictions: [],
  anonymous: false,
};

const registry: ConsumerProfile[] = [opsProfile, safeProfile];

describe('consumerFromClaims', () => {
  it('matches client_id to a registry profile id and returns that exact profile', () => {
    const claims: OAuthClaims = { client_id: 'ops-client', sub: 'user-42' };
    const result = consumerFromClaims(claims, registry);
    expect(result).toBe(opsProfile);
    // The resolved profile carries its governance fields unchanged.
    expect(result?.writeCapability).toBe('execution_allowed');
    expect(result?.defaultContract).toBe('ops_operator');
  });

  it('falls back to sub when client_id is absent', () => {
    const claims: OAuthClaims = { sub: 'llm-client' };
    expect(consumerFromClaims(claims, registry)).toBe(safeProfile);
  });

  it('prefers client_id over sub when both are present', () => {
    const claims: OAuthClaims = { client_id: 'llm-client', sub: 'ops-client' };
    expect(consumerFromClaims(claims, registry)).toBe(safeProfile);
  });

  it('falls back to sub when client_id is an empty string', () => {
    const claims: OAuthClaims = { client_id: '', sub: 'ops-client' };
    expect(consumerFromClaims(claims, registry)).toBe(opsProfile);
  });

  it('returns null for an unmatched client (deny by default — no synthesized profile)', () => {
    const claims: OAuthClaims = { client_id: 'unknown-client', sub: 'stranger' };
    expect(consumerFromClaims(claims, registry)).toBeNull();
  });

  it('returns null for empty claims', () => {
    expect(consumerFromClaims({}, registry)).toBeNull();
  });

  it('returns null for garbage / non-string identity claims', () => {
    const garbage = {
      client_id: 12345,
      sub: { nested: true },
    } as unknown as OAuthClaims;
    expect(consumerFromClaims(garbage, registry)).toBeNull();
  });

  it('returns null for a null/undefined claims object', () => {
    expect(consumerFromClaims(null as unknown as OAuthClaims, registry)).toBeNull();
    expect(
      consumerFromClaims(undefined as unknown as OAuthClaims, registry)
    ).toBeNull();
  });

  it('never grants a privileged profile against an empty registry', () => {
    const claims: OAuthClaims = { client_id: 'ops-client' };
    expect(consumerFromClaims(claims, [])).toBeNull();
  });

  it('matching is exact and case-sensitive', () => {
    const claims: OAuthClaims = { client_id: 'OPS-CLIENT' };
    expect(consumerFromClaims(claims, registry)).toBeNull();
  });
});

describe('consumerScopes', () => {
  it('extracts a scopes array', () => {
    const claims: OAuthClaims = {
      client_id: 'ops-client',
      scopes: ['whmcs:read', 'whmcs:write:low'],
    };
    expect(consumerScopes(claims)).toEqual(['whmcs:read', 'whmcs:write:low']);
  });

  it('splits a single space-delimited scope string', () => {
    const claims = {
      scopes: 'whmcs:read   whmcs:write:high',
    } as unknown as OAuthClaims;
    expect(consumerScopes(claims)).toEqual(['whmcs:read', 'whmcs:write:high']);
  });

  it('drops non-string array entries', () => {
    const claims = {
      scopes: ['whmcs:read', 42, null, '', 'pii:read'],
    } as unknown as OAuthClaims;
    expect(consumerScopes(claims)).toEqual(['whmcs:read', 'pii:read']);
  });

  it('returns [] when scopes are missing', () => {
    expect(consumerScopes({ client_id: 'ops-client' })).toEqual([]);
  });

  it('returns [] for a null/undefined claims object', () => {
    expect(consumerScopes(null as unknown as OAuthClaims)).toEqual([]);
    expect(consumerScopes(undefined as unknown as OAuthClaims)).toEqual([]);
  });

  it('is independent of the profile allowedWriteScopes (granted vs authorized)', () => {
    // The token grants only read; the matched profile is authorized for more.
    // The bridge reports ONLY what the token granted.
    const claims: OAuthClaims = { client_id: 'ops-client', scopes: ['whmcs:read'] };
    expect(consumerScopes(claims)).toEqual(['whmcs:read']);
    expect(consumerFromClaims(claims, registry)?.allowedScopes).toContain(
      'whmcs:write:low'
    );
  });
});
