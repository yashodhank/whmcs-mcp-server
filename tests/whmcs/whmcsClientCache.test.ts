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
import { mapToCanonicalClient } from '../../src/canonical/client.js';
import type { AppConfig } from '../../src/config.js';
import { hashToken, loadConsumerRegistry } from '../../src/governance/consumers.js';
import { governProjection } from '../../src/governance/pipeline.js';
import type { ConsumerProfile } from '../../src/governance/types.js';

const TOKEN_LLM = 'synthetic-llm-consumer-token';
const TOKEN_OPS = 'synthetic-ops-consumer-token';

function projectionRegistry(): ConsumerProfile[] {
  return loadConsumerRegistry({
    MCP_CONSUMER_REGISTRY: JSON.stringify([
      {
        id: 'llm_consumer',
        token_sha256: hashToken(TOKEN_LLM),
        defaultContract: 'llm_safe_summary',
        allowedContracts: ['llm_safe_summary'],
        writeCapability: 'false',
      },
      {
        id: 'ops_consumer',
        token_sha256: hashToken(TOKEN_OPS),
        defaultContract: 'ops_operator',
        allowedContracts: ['ops_operator'],
        writeCapability: 'false',
      },
    ]),
  } as NodeJS.ProcessEnv);
}

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

  it('forwards cancellation to axios and starts no request when already aborted', async () => {
    const client = new WhmcsClient(makeConfig({ MCP_READ_CACHE_TTL_MS: 0 }), makeLogger());
    const active = new AbortController();
    await client.read('GetProducts', { pid: 1 }, { signal: active.signal });
    expect(post).toHaveBeenCalledWith(
      '',
      expect.any(URLSearchParams),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );

    post.mockClear();
    const cancelled = new AbortController();
    cancelled.abort(new Error('cancelled'));
    await expect(
      client.read('GetProducts', { pid: 1 }, { signal: cancelled.signal })
    ).rejects.toThrow('cancelled');
    expect(post).not.toHaveBeenCalled();
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

  it('coalesces 100 concurrent identical allowlisted reads when the canary is enabled', async () => {
    let release: (() => void) | undefined;
    post.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              status: 200,
              data: { result: 'success', products: { product: [{ id: 1 }] } },
            });
        })
    );
    const client = new WhmcsClient(
      makeConfig({ MCP_READ_CACHE_TTL_MS: 0, MCP_READ_COALESCE_ENABLED: true }),
      makeLogger()
    );
    const pending = Array.from({ length: 100 }, () => client.read('GetProducts', { pid: 1 }));
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    release?.();
    const results = await Promise.all(pending);
    expect(results).toHaveLength(100);
    expect(post).toHaveBeenCalledTimes(1);
    expect(client.getDiagnostics().coordinator.inflight).toBe(0);
  });

  it('logs once at the actual pipeline boundary, not for cache hits or coalesced joiners', async () => {
    let release: (() => void) | undefined;
    post.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ status: 200, data: { result: 'success', products: { product: [] } } });
        })
    );
    const log = makeLogger();
    const client = new WhmcsClient(
      makeConfig({ MCP_READ_CACHE_TTL_MS: 5000, MCP_READ_COALESCE_ENABLED: true }),
      log
    );
    const pending = Array.from({ length: 10 }, () => client.read('GetProducts', { pid: 1 }));
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    release?.();
    await Promise.all(pending);
    await client.read('GetProducts', { pid: 1 });
    expect(log.logWhmcsCall).toHaveBeenCalledTimes(1);
    expect(log.logWhmcsCall).toHaveBeenCalledWith('GetProducts', { pid: 1 }, false);
  });

  it('does not coalesce identical params across different raw-data scopes', async () => {
    const client = new WhmcsClient(
      makeConfig({ MCP_READ_CACHE_TTL_MS: 5000, MCP_READ_COALESCE_ENABLED: true }),
      makeLogger()
    );
    await Promise.all([
      client.read('GetProducts', { pid: 1 }, { rawDataScope: 'consumer-a', bypassCache: true }),
      client.read('GetProducts', { pid: 1 }, { rawDataScope: 'consumer-b', bypassCache: true }),
    ]);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('projects one coalesced raw response through two real consumer contracts', async () => {
    let release: (() => void) | undefined;
    post.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              status: 200,
              data: {
                result: 'success',
                client: {
                  id: 42,
                  firstname: 'Jane',
                  lastname: 'Operator',
                  fullname: 'Jane Operator',
                  email: 'jane.operator@example.test',
                  phonenumber: '+1-555-0100',
                  status: 'Active',
                  credit: '25.50',
                  currency_code: 'USD',
                },
              },
            });
        })
    );
    const client = new WhmcsClient(
      makeConfig({
        MCP_READ_CACHE_TTL_MS: 0,
        MCP_READ_CACHE_ACTIONS: ['GetClientsDetails'],
        MCP_READ_COALESCE_ENABLED: true,
      }),
      makeLogger()
    );
    const commonOptions = {
      rawDataScope: 'shared-installation-raw-v1',
      bypassCache: true,
    } as const;
    const llmPending = client.read(
      'GetClientsDetails',
      { clientid: 42 },
      {
        ...commonOptions,
        consumerKey: 'llm_consumer',
      }
    );
    const opsPending = client.read(
      'GetClientsDetails',
      { clientid: 42 },
      {
        ...commonOptions,
        consumerKey: 'ops_consumer',
      }
    );
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    release?.();
    const [llmRaw, opsRaw] = await Promise.all([llmPending, opsPending]);

    const registry = projectionRegistry();
    const llm = governProjection({
      canonical: mapToCanonicalClient(llmRaw),
      authToken: TOKEN_LLM,
      env: 'production',
      registry,
      allowAnon: false,
    });
    const ops = governProjection({
      canonical: mapToCanonicalClient(opsRaw),
      authToken: TOKEN_OPS,
      env: 'production',
      registry,
      allowAnon: false,
    });

    expect(post).toHaveBeenCalledTimes(1);
    expect(llmRaw).toEqual(opsRaw);
    expect(llmRaw).not.toBe(opsRaw);
    expect(llm).toMatchObject({ ok: true, contract: 'llm_safe_summary' });
    expect(ops).toMatchObject({ ok: true, contract: 'ops_operator' });
    expect(llm.data?.email).toBe('j***@e***');
    expect(ops.data?.email).toBe('jane.operator@example.test');
    expect(llm.data).not.toEqual(ops.data);
  });

  it('invalidates proven client-tagged reads after a successful mutation', async () => {
    post
      .mockResolvedValueOnce({ status: 200, data: { result: 'success', id: 1 } })
      .mockResolvedValueOnce({ status: 200, data: { result: 'success' } })
      .mockResolvedValueOnce({ status: 200, data: { result: 'success', id: 1 } });
    const client = new WhmcsClient(
      makeConfig({
        MCP_MODE: 'full',
        MCP_READ_CACHE_TTL_MS: 5000,
        MCP_READ_CACHE_ACTIONS: ['GetClientsDetails'],
      }),
      makeLogger()
    );
    await client.read('GetClientsDetails', { clientid: 1 });
    await client.mutate('UpdateClient', { clientid: 1, notes: 'changed' });
    await client.read('GetClientsDetails', { clientid: 1 });
    expect(post).toHaveBeenCalledTimes(3);
    expect(client.getDiagnostics().cache.invalidations).toBe(1);
  });

  it('does not repopulate the cache from a read that began before a mutation', async () => {
    let releaseRead: (() => void) | undefined;
    post
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseRead = () =>
              resolve({ status: 200, data: { result: 'success', products: { product: [] } } });
          })
      )
      .mockResolvedValueOnce({ status: 200, data: { result: 'success' } })
      .mockResolvedValueOnce({
        status: 200,
        data: { result: 'success', products: { product: [] } },
      });
    const client = new WhmcsClient(
      makeConfig({ MCP_MODE: 'full', MCP_READ_CACHE_TTL_MS: 5000 }),
      makeLogger()
    );
    const staleRead = client.read('GetProducts', { pid: 1 });
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    await client.mutate('UpdateClient', { clientid: 1 });
    releaseRead?.();
    await staleRead;
    await client.read('GetProducts', { pid: 1 });
    expect(post).toHaveBeenCalledTimes(3);
  });
});
