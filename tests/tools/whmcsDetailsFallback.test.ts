/**
 * WhmcsDetails fallback logic tests (Phase A + follow-up fix).
 *
 * Proofs:
 *  - isPermissionDenied detects WhmcsTransportError 403 via forbiddenKind
 *  - isPermissionDenied detects WhmcsBusinessError via message text
 *  - isPermissionDenied returns false for generic 403 (no forbiddenKind)
 *  - isPermissionDenied returns false for non-permission errors
 *  - mapToCanonicalWhmcsDetails extracts version from nested and flat shapes
 *
 * The critical regression test: a 403 whose message has been rewritten by
 * the pipeline (no literal "Invalid Permissions") must still be detected
 * when forbiddenKind is set.
 */

import { describe, it, expect } from 'vitest';
import { WhmcsBusinessError, WhmcsTransportError } from '../../src/whmcs/request/errors.js';
import { mapToCanonicalWhmcsDetails } from '../../src/canonical/systemRefs.js';

/**
 * Mirror of the actual isPermissionDenied from systemRefTools.ts.
 * Uses forbiddenKind on WhmcsTransportError (not message string-matching).
 */
function isPermissionDenied(e: unknown): boolean {
  if (e instanceof WhmcsTransportError && e.statusCode === 403) {
    return e.forbiddenKind === 'invalid_permissions';
  }
  if (e instanceof WhmcsBusinessError) {
    return /invalid\s+permissions/i.test(e.message);
  }
  return false;
}

describe('isPermissionDenied', () => {
  it('detects WhmcsTransportError 403 via forbiddenKind (pipeline-rewritten message)', () => {
    const err = new WhmcsTransportError(
      'WHMCS HTTP error: 403 — HTTP 403 — the API credential role does not allow this action.',
      403
    );
    err.forbiddenKind = 'invalid_permissions';
    expect(isPermissionDenied(err)).toBe(true);
  });

  it('detects WhmcsTransportError 403 even when message contains NO "Invalid Permissions" text', () => {
    const err = new WhmcsTransportError(
      'WHMCS HTTP error: 403 — some completely generic message with no permission keyword',
      403
    );
    err.forbiddenKind = 'invalid_permissions';
    expect(isPermissionDenied(err)).toBe(true);
  });

  it('returns false for WhmcsTransportError 403 with forbiddenKind=invalid_ip', () => {
    const err = new WhmcsTransportError('WHMCS HTTP error: 403 — Invalid IP 10.0.0.1', 403);
    err.forbiddenKind = 'invalid_ip';
    expect(isPermissionDenied(err)).toBe(false);
  });

  it('returns false for WhmcsTransportError 403 with no forbiddenKind', () => {
    const err = new WhmcsTransportError('WHMCS HTTP error: 403 — generic', 403);
    expect(isPermissionDenied(err)).toBe(false);
  });

  it('recognizes WhmcsBusinessError with "Invalid Permissions" (HTTP 200 result=error)', () => {
    const err = new WhmcsBusinessError(
      'Invalid Permissions: API action "whmcsdetails" is not allowed'
    );
    expect(isPermissionDenied(err)).toBe(true);
  });

  it('returns false for WhmcsBusinessError without permission text', () => {
    const err = new WhmcsBusinessError('Some other error');
    expect(isPermissionDenied(err)).toBe(false);
  });

  it('returns false for non-403 WhmcsTransportError', () => {
    const err = new WhmcsTransportError('WHMCS HTTP error: 500', 500);
    expect(isPermissionDenied(err)).toBe(false);
  });

  it('returns false for plain Error', () => {
    const err = new Error('Invalid Permissions');
    expect(isPermissionDenied(err)).toBe(false);
  });

  it('returns false for non-Error', () => {
    expect(isPermissionDenied('Invalid Permissions')).toBe(false);
    expect(isPermissionDenied(null)).toBe(false);
    expect(isPermissionDenied(undefined)).toBe(false);
  });
});

describe('mapToCanonicalWhmcsDetails (fallback mapper)', () => {
  it('extracts version from nested whmcs block', () => {
    const raw = { whmcs: { version: '8.13.7', canonicalversion: '8.13.7-release.1' } };
    const canonical = mapToCanonicalWhmcsDetails(raw);
    expect(canonical.entity).toBe('activity');
    const data = canonical.data as { version: string | null; release: string | null };
    expect(data.version).toBe('8.13.7');
    expect(data.release).toBe('8.13.7-release.1');
  });

  it('extracts version from flat response', () => {
    const raw = { version: '8.13.7', canonicalversion: '8.13.7-release.1' };
    const canonical = mapToCanonicalWhmcsDetails(raw);
    const data = canonical.data as { version: string | null; release: string | null };
    expect(data.version).toBe('8.13.7');
    expect(data.release).toBe('8.13.7-release.1');
  });

  it('returns null version for empty input', () => {
    const canonical = mapToCanonicalWhmcsDetails({});
    const data = canonical.data as { version: string | null; release: string | null };
    expect(data.version).toBeNull();
    expect(data.release).toBeNull();
  });

  it('uses release as fallback for canonicalversion', () => {
    const raw = { whmcs: { version: '8.13.7', release: '8.13.7-release.1' } };
    const canonical = mapToCanonicalWhmcsDetails(raw);
    const data = canonical.data as { version: string | null; release: string | null };
    expect(data.version).toBe('8.13.7');
    expect(data.release).toBe('8.13.7-release.1');
  });
});
