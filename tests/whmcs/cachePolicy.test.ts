import { describe, expect, it } from 'vitest';
import {
  buildReadCoordinationKey,
  mutationInvalidationTags,
  resolveReadCachePolicy,
} from '../../src/whmcs/cachePolicy.js';

describe('read cache/coalescing policy', () => {
  const configured = new Set(['GetProducts', 'GetActivityLog', 'GetClientsDetails']);

  it('allows configured reference coalescing while completed caching remains off', () => {
    expect(resolveReadCachePolicy('GetProducts', {}, configured, 0)).toMatchObject({
      freshness: 'reference',
      cacheable: false,
      coalescible: true,
    });
  });

  it('never accelerates activity/log/probe actions even if configured', () => {
    expect(resolveReadCachePolicy('GetActivityLog', {}, configured, 5000)).toMatchObject({
      freshness: 'never',
      cacheable: false,
      coalescible: false,
    });
  });

  it('separates coordination by installation, policy version, params, and raw-data scope', () => {
    const base = buildReadCoordinationKey('a', 'GetProducts', { pid: 1 }, 'v1', 'scope-a');
    expect(base).not.toBe(
      buildReadCoordinationKey('b', 'GetProducts', { pid: 1 }, 'v1', 'scope-a')
    );
    expect(base).not.toBe(
      buildReadCoordinationKey('a', 'GetProducts', { pid: 2 }, 'v1', 'scope-a')
    );
    expect(base).not.toBe(
      buildReadCoordinationKey('a', 'GetProducts', { pid: 1 }, 'v1', 'scope-b')
    );
  });

  it('returns narrow tags only for proven mutation mappings', () => {
    expect(mutationInvalidationTags('UpdateClient', { clientid: 7 })).toEqual(['clientid:7']);
    expect(mutationInvalidationTags('CreateInvoice', { userid: 7 })).toBeUndefined();
  });
});
