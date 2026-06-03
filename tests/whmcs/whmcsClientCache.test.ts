import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config so importing WhmcsClient (-> config.js -> dotenv) is side-effect free.
vi.mock('../../src/config.js', () => ({
  config: {
    WHMCS_API_URL: 'https://test.whmcs.com',
    WHMCS_IDENTIFIER: 'test-id',
    WHMCS_SECRET: 'test-secret',
    MCP_MODE: 'read_only',
  },
  getWhmcsApiEndpoint: () => 'https://test.whmcs.com/includes/api.php',
}));

// Mock axios: create() returns an instance whose post() is a controllable spy.
const post = vi.fn();
vi.mock('axios', () => {
  const create = vi.fn(() => ({ post }));
  return {
    default: { create, isAxiosError: () => false },
    create,
    isAxiosError: () => false,
  };
});

import { WhmcsClient } from '../../src/whmcs/WhmcsClient.js';
import type { AppConfig } from '../../src/config.js';

function makeLogger(): any {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    logWhmcsCall: vi.fn(),
    child: function (): unknown {
      return this;
    },
  };
}

function makeConfig(over: Partial<AppConfig>): AppConfig {
  return {
    WHMCS_API_URL: 'https://test.whmcs.com',
    WHMCS_IDENTIFIER: 'test-id',
    WHMCS_SECRET: 'test-secret',
    MCP_MODE: 'read_only',
    MCP_READ_CACHE_TTL_MS: 0,
    MCP_READ_CACHE_ACTIONS: ['GetProducts', 'GetTLDPricing'],
    ...over,
  } as unknown as AppConfig;
}

beforeEach(() => {
  post.mockReset();
  post.mockResolvedValue({ status: 200, data: { result: 'success', products: { product: [] } } });
});

describe('WhmcsClient read cache (default OFF)', () => {
  it('does NOT cache when TTL is 0 — every read hits the API', async () => {
    const client = new WhmcsClient(makeConfig({ MCP_READ_CACHE_TTL_MS: 0 }), makeLogger());
    await client.read('GetProducts', { pid: 1 });
    await client.read('GetProducts', { pid: 1 });
    expect(post).toHaveBeenCalledTimes(2);
  });
});

describe('WhmcsClient read cache (enabled)', () => {
  it('serves repeated allowlisted reads from cache (one API call)', async () => {
    const client = new WhmcsClient(makeConfig({ MCP_READ_CACHE_TTL_MS: 5000 }), makeLogger());
    const r1 = await client.read('GetProducts', { pid: 1 });
    const r2 = await client.read('GetProducts', { pid: 1 });
    expect(post).toHaveBeenCalledTimes(1);
    expect(r2).toEqual(r1);
  });

  it('does not cache non-allowlisted actions', async () => {
    const client = new WhmcsClient(
      makeConfig({ MCP_READ_CACHE_TTL_MS: 5000, MCP_READ_CACHE_ACTIONS: ['GetTLDPricing'] }),
      makeLogger()
    );
    // GetProducts is a valid read action but not in this cache allowlist.
    await client.read('GetProducts', {});
    await client.read('GetProducts', {});
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('keys by params — different params re-fetch', async () => {
    const client = new WhmcsClient(makeConfig({ MCP_READ_CACHE_TTL_MS: 5000 }), makeLogger());
    await client.read('GetProducts', { pid: 1 });
    await client.read('GetProducts', { pid: 2 });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('clearReadCache() forces a refetch', async () => {
    const client = new WhmcsClient(makeConfig({ MCP_READ_CACHE_TTL_MS: 5000 }), makeLogger());
    await client.read('GetProducts', { pid: 1 });
    client.clearReadCache();
    await client.read('GetProducts', { pid: 1 });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('never caches denied (write/unknown) actions — guard runs first', async () => {
    const client = new WhmcsClient(makeConfig({ MCP_READ_CACHE_TTL_MS: 5000 }), makeLogger());
    await expect(client.read('AddClient', {})).rejects.toThrow();
    expect(post).not.toHaveBeenCalled();
  });

  // ── M1 regression: key on transformed params (drop undefined, normalize bool) ──
  it('treats {x: undefined} and {} as the SAME cache entry (one API call)', async () => {
    const client = new WhmcsClient(makeConfig({ MCP_READ_CACHE_TTL_MS: 5000 }), makeLogger());
    await client.read('GetProducts', { pid: 1, extra: undefined });
    await client.read('GetProducts', { pid: 1 });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('mutating a cached read result does not poison the next cache hit', async () => {
    post.mockResolvedValue({
      status: 200,
      data: { result: 'success', products: { product: [{ id: 1 }] } },
    });
    const client = new WhmcsClient(makeConfig({ MCP_READ_CACHE_TTL_MS: 5000 }), makeLogger());
    const r1 = await client.read<{ injected?: boolean }>('GetProducts', { pid: 1 });
    r1.injected = true;
    const r2 = await client.read<{ injected?: boolean }>('GetProducts', { pid: 1 });
    expect(post).toHaveBeenCalledTimes(1);
    expect(r2.injected).toBeUndefined();
  });
});
