/**
 * service:domain_rename — frozen-seam additions, strict mapper, and validation.
 *
 * Single-call scope (NOT batch): it flows through the generic
 * intentToWhmcsParams dispatcher + the deny-by-default execution authorizer,
 * exactly like client_note:write. These tests cover the three pure layers
 * (types seam, param mapper, validator). Execution gating is already covered
 * by the shared writeFlow.* suites.
 */
import { describe, it, expect } from 'vitest';
import {
  WRITE_SCOPES,
  SCOPE_ACTION,
  SCOPE_RISK,
  type WriteIntent,
} from '../../src/write/types.js';
import {
  intentToWhmcsParams,
  mapServiceDomainRenameParams,
  normalizeDomain,
} from '../../src/write/paramMapping.js';
import { validateIntent } from '../../src/write/validation.js';
import {
  assertDomainRenameOutput,
  DomainRenameOutputAssertionError,
  precheckDomainRename,
} from '../../src/tools/writeFlow.js';

describe('service:domain_rename frozen-seam additions', () => {
  it('is registered in WRITE_SCOPES', () => {
    expect(WRITE_SCOPES as readonly string[]).toContain('service:domain_rename');
  });

  it('maps to UpdateClientProduct in SCOPE_ACTION', () => {
    expect(SCOPE_ACTION['service:domain_rename']).toBe('UpdateClientProduct');
  });

  it('is medium-risk in SCOPE_RISK', () => {
    expect(SCOPE_RISK['service:domain_rename']).toBe('medium');
  });
});

describe('mapServiceDomainRenameParams (strict 2-key output)', () => {
  it('returns exactly { serviceid, domain }', () => {
    const out = mapServiceDomainRenameParams({ serviceid: 555, domain: 'vps12.example.com' });
    expect(Object.keys(out).sort()).toEqual(['domain', 'serviceid']);
    expect(out.serviceid).toBe(555);
    expect(out.domain).toBe('vps12.example.com');
  });

  it('drops every other UpdateClientProduct field (defense in depth)', () => {
    const out = mapServiceDomainRenameParams({
      serviceid: 555,
      domain: 'new.example.com',
      recurringamount: 0.01,
      status: 'Active',
      billingcycle: 'Annually',
      paymentmethod: 'evil',
    } as never);
    expect(Object.keys(out).sort()).toEqual(['domain', 'serviceid']);
  });

  it('emits the NORMALIZED domain (lowercase, trimmed, trailing-dot stripped)', () => {
    const out = mapServiceDomainRenameParams({ serviceid: 9, domain: '  VPS.Example.COM.  ' });
    expect(out.domain).toBe('vps.example.com');
  });
});

describe('normalizeDomain', () => {
  it('lowercases, trims, and strips a single trailing dot', () => {
    expect(normalizeDomain('  VPS.Example.COM.  ')).toBe('vps.example.com');
    expect(normalizeDomain('localhost')).toBe('localhost');
  });
  it('returns "" for non-string input', () => {
    expect(normalizeDomain(12345)).toBe('');
    expect(normalizeDomain(undefined)).toBe('');
    expect(normalizeDomain(null)).toBe('');
  });
});

describe('assertDomainRenameOutput (defense-in-depth)', () => {
  it('passes for exactly { serviceid, domain }', () => {
    expect(() => {
      assertDomainRenameOutput({ serviceid: 1, domain: 'a.com' });
    }).not.toThrow();
  });
  it('throws on any extra key (e.g. a leaked recurringamount)', () => {
    expect(() => {
      assertDomainRenameOutput({ serviceid: 1, domain: 'a.com', recurringamount: 0.01 });
    }).toThrow(DomainRenameOutputAssertionError);
  });
  it('throws on missing serviceid or domain', () => {
    expect(() => {
      assertDomainRenameOutput({ serviceid: 1 });
    }).toThrow(DomainRenameOutputAssertionError);
    expect(() => {
      assertDomainRenameOutput({ domain: 'a.com' });
    }).toThrow(DomainRenameOutputAssertionError);
  });

  it('is reachable through the dispatcher (single-call scope)', () => {
    const out = intentToWhmcsParams('service:domain_rename', {
      serviceid: 7,
      domain: 'host.example.org',
      recurringamount: 999,
    });
    expect(out).toEqual({ serviceid: 7, domain: 'host.example.org' });
  });
});

function intent(params: Record<string, unknown>): WriteIntent {
  return {
    intent_id: 'i-1',
    consumer_id: 'c-1',
    scope: 'service:domain_rename',
    action: 'UpdateClientProduct',
    risk: 'medium',
    params,
    idempotency_key: 'k-1',
    preconditions: {},
    projected_effect: 'rename service hostname',
    state: 'draft',
    created_at: '2026-06-03T00:00:00.000Z',
    expires_at: '2026-06-03T01:00:00.000Z',
  };
}

describe('validateIntent: service:domain_rename', () => {
  it('accepts a positive serviceid + valid FQDN', () => {
    const r = validateIntent(intent({ serviceid: 12, domain: 'vps12.example.com' }), {});
    expect(r.ok).toBe(true);
  });

  it('accepts a single-label hostname', () => {
    const r = validateIntent(intent({ serviceid: 12, domain: 'localhost' }), {});
    expect(r.ok).toBe(true);
  });

  it('errors on missing serviceid', () => {
    const r = validateIntent(intent({ domain: 'a.example.com' }), {});
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'missing_required_param')).toBe(true);
  });

  it('errors on missing domain', () => {
    const r = validateIntent(intent({ serviceid: 12 }), {});
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'missing_required_param')).toBe(true);
  });

  it('errors on non-integer / non-positive serviceid', () => {
    for (const sid of [0, -3, 1.5, '12']) {
      const r = validateIntent(intent({ serviceid: sid, domain: 'a.example.com' }), {});
      expect(r.ok).toBe(false);
      expect(r.issues.some((i) => i.code === 'invalid_serviceid')).toBe(true);
    }
  });

  it('errors on malformed domains (spaces, scheme, path, metachars)', () => {
    for (const bad of [
      'has space.com',
      'http://example.com',
      'example.com/path',
      'a..b.com',
      '-leadinghyphen.com',
      'foo;rm -rf',
    ]) {
      const r = validateIntent(intent({ serviceid: 12, domain: bad }), {});
      expect(r.ok, `should reject "${bad}"`).toBe(false);
      expect(r.issues.some((i) => i.code === 'invalid_domain')).toBe(true);
    }
  });

  it('errors on a non-string domain value', () => {
    const r = validateIntent(intent({ serviceid: 12, domain: 12345 }), {});
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'invalid_domain')).toBe(true);
  });

  it('accepts forms that only differ by normalization (case, trailing dot, surrounding space)', () => {
    for (const d of ['A.EXAMPLE.COM', 'a.example.com.', '  a.example.com  ']) {
      const r = validateIntent(intent({ serviceid: 12, domain: d }), {});
      expect(r.ok, `should accept "${d}"`).toBe(true);
    }
  });

  it('accepts a valid expected_old_domain', () => {
    const r = validateIntent(
      intent({ serviceid: 12, domain: 'new.example.com', expected_old_domain: 'OLD.example.com.' }),
      {}
    );
    expect(r.ok).toBe(true);
  });

  it('errors on a malformed expected_old_domain', () => {
    const r = validateIntent(
      intent({ serviceid: 12, domain: 'new.example.com', expected_old_domain: 'http://old' }),
      {}
    );
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'invalid_expected_old_domain')).toBe(true);
  });
});

describe('precheckDomainRename (read-only precondition)', () => {
  const intentFor = (params: Record<string, unknown>): WriteIntent =>
    intent(params);
  const readReturning = (product: Record<string, unknown> | undefined) =>
    () => Promise.resolve({ products: { product: product ? [product] : [] } });

  it('ok when the service exists and is Active', async () => {
    const whmcs = {
      read: readReturning({ id: 7, domain: 'old.example.com', domainstatus: 'Active' }),
    };
    const r = await precheckDomainRename(whmcs as never, intentFor({ serviceid: 7, domain: 'new.example.com' }));
    expect(r.ok).toBe(true);
  });

  it('precondition_mismatch when the service is not found', async () => {
    const whmcs = { read: readReturning(undefined) };
    const r = await precheckDomainRename(whmcs as never, intentFor({ serviceid: 7, domain: 'new.example.com' }));
    expect(r).toEqual({ ok: false, reason: 'precondition_mismatch' });
  });

  it('precondition_mismatch when the service is Terminated', async () => {
    const whmcs = {
      read: readReturning({ id: 7, domain: 'old.example.com', domainstatus: 'Terminated' }),
    };
    const r = await precheckDomainRename(whmcs as never, intentFor({ serviceid: 7, domain: 'new.example.com' }));
    expect(r).toEqual({ ok: false, reason: 'precondition_mismatch' });
  });

  it('precondition_mismatch when expected_old_domain does not match (normalized compare)', async () => {
    const whmcs = {
      read: readReturning({ id: 7, domain: 'actual.example.com', domainstatus: 'Active' }),
    };
    const r = await precheckDomainRename(
      whmcs as never,
      intentFor({ serviceid: 7, domain: 'new.example.com', expected_old_domain: 'WRONG.example.com' })
    );
    expect(r).toEqual({ ok: false, reason: 'precondition_mismatch' });
  });

  it('ok when expected_old_domain matches case-insensitively / trailing dot', async () => {
    const whmcs = {
      read: readReturning({ id: 7, domain: 'old.example.com', domainstatus: 'Active' }),
    };
    const r = await precheckDomainRename(
      whmcs as never,
      intentFor({ serviceid: 7, domain: 'new.example.com', expected_old_domain: 'OLD.Example.COM.' })
    );
    expect(r.ok).toBe(true);
  });

  it('precondition_mismatch when the read throws', async () => {
    const whmcs = { read: () => Promise.reject(new Error('boom')) };
    const r = await precheckDomainRename(whmcs as never, intentFor({ serviceid: 7, domain: 'new.example.com' }));
    expect(r).toEqual({ ok: false, reason: 'precondition_mismatch' });
  });
});
