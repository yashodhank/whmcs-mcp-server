/**
 * Track B — honest client-side status filtering for `list_client_domains`.
 *
 * WHMCS `GetClientsDomains` has NO native status filter, so the tool MUST
 * scan pages and post-filter. These tests pin the bounded-scan contract:
 *  - status=Active ⇒ ONLY Active rows + correct filter metadata
 *  - no status ⇒ unchanged behaviour, no filter metadata
 *  - scan_complete=true when WHMCS total is exhausted within the cap
 *  - scan_complete=false + warning when the maxScan/maxPages cap is reached
 *  - honest pagination over the FILTERED set (offset/limit on matches)
 *  - governance ON + OFF both yield the correct shape; row projection still
 *    applies (no leakage) while envelope metadata is visible to an
 *    authorized contract
 *  - numeric-keyed / single-object / empty WHMCS page shapes handled
 *
 * Synthetic fixtures only; `whmcs.read` is mocked.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { hashToken } from '../../src/governance/consumers.js';

vi.mock('../../src/config.js', () => ({
  config: { MCP_MAX_PAGE_SIZE: 100 },
  isToolAllowed: () => true,
}));
vi.mock('../../src/security.js', () => ({
  AUTH_SHAPE: {},
  ensureToolAuth: () => null,
  isClientMode: () => false,
  ensureClientAllowed: () => null,
}));

import { registerListTool } from '../../src/tools/listTools.js';
import { mapToCanonicalDomain } from '../../src/canonical/index.js';

const DOMAIN_CFG = {
  name: 'list_client_domains',
  description: 'd',
  action: 'GetClientsDomains',
  clientParam: 'clientid' as const,
  normalizerPath: 'domains',
  extraSchema: {},
  mapItem: (d: any) => ({
    domainid: d.id,
    domain: d.domainname,
    status: d.status,
  }),
  canonicalMap: mapToCanonicalDomain,
};

function harness() {
  const handlers: Record<string, any> = {};
  const server = {
    registerTool: (n: string, _cfg: unknown, cb: any) => {
      handlers[n] = cb;
    },
  };
  const childLogger: any = {
    logToolCall: vi.fn(),
    logToolResult: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- self-referential test logger stub (mirrors existing test harness convention)
    child: () => childLogger,
  };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- self-referential test logger stub (mirrors existing test harness convention)
  const logger: any = { child: () => childLogger };
  const rateLimiter: any = { tryConsume: () => true };
  return { server, handlers, logger, rateLimiter };
}

/**
 * Build a paged `GetClientsDomains` reader over a flat list of synthetic
 * domain rows. Honours WHMCS `limitstart`/`limitnum`; reports a stable
 * `totalresults`. Each page nests rows under `domains.domain` (the common
 * WHMCS wrapper). `shape` controls the per-page container encoding so the
 * repo normalizers are exercised.
 */
function pagedReader(
  all: any[],
  shape: 'array' | 'numeric' | 'single' | 'empty' = 'array'
) {
  return vi.fn(async (_action: string, params: any) => {
    const start = Number(params.limitstart ?? 0);
    const num = Number(params.limitnum ?? 10);
    const slice = all.slice(start, start + num);
    let domainContainer: unknown;
    if (slice.length === 0) {
      domainContainer = shape === 'empty' ? {} : [];
    } else if (shape === 'numeric') {
      const o: Record<string, unknown> = {};
      slice.forEach((r, i) => {
        o[String(i)] = r;
      });
      domainContainer = o;
    } else if (shape === 'single' && slice.length === 1) {
      domainContainer = slice[0];
    } else {
      domainContainer = slice;
    }
    return {
      result: 'success',
      totalresults: all.length,
      numreturned: slice.length,
      startnumber: start,
      domains: { domain: domainContainer },
    };
  });
}

const STATUSES = ['Active', 'Cancelled', 'Expired', 'Transferred Away'];
function makeDomains(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    domainname: `d${String(i + 1)}.test`,
    status: STATUSES[i % STATUSES.length],
  }));
}

afterEach(() => {
  vi.resetModules();
});

describe('list_client_domains — honest client-side status filter', () => {
  it('status=Active ⇒ only Active rows + correct filter metadata', async () => {
    const { server, handlers, logger, rateLimiter } = harness();
    // 40 domains, 10 Active (every 4th starting at index 0).
    const read = pagedReader(makeDomains(40));
    registerListTool(server as any, { read } as any, logger, rateLimiter, {
      ...DOMAIN_CFG,
      extraSchema: {},
    } as any);
    const res = await handlers.list_client_domains({
      clientid: 30,
      status: 'Active',
      limit: 5,
      offset: 0,
    });
    const p = JSON.parse(res.content[0].text);
    expect(p.items.every((d: any) => d.status === 'Active')).toBe(true);
    expect(p.items).toHaveLength(5);
    expect(p.filter_mode).toBe('client_side');
    expect(p.filter_applied).toBe(true);
    expect(p.requested_status).toBe('Active');
    expect(p.matched_count).toBe(10);
    expect(p.returned_count).toBe(5);
    expect(p.scanned_count).toBe(40);
    expect(p.scan_complete).toBe(true);
    expect(p.warning).toBeUndefined();
  });

  it('status is case-insensitive', async () => {
    const { server, handlers, logger, rateLimiter } = harness();
    const read = pagedReader(makeDomains(20));
    registerListTool(server as any, { read } as any, logger, rateLimiter, {
      ...DOMAIN_CFG,
    } as any);
    const res = await handlers.list_client_domains({
      clientid: 30,
      status: 'aCtIvE',
      limit: 10,
      offset: 0,
    });
    const p = JSON.parse(res.content[0].text);
    expect(p.items.every((d: any) => d.status === 'Active')).toBe(true);
    expect(p.matched_count).toBe(5);
    expect(p.requested_status).toBe('aCtIvE');
  });

  it('no status ⇒ unchanged behaviour, NO filter metadata, single page', async () => {
    const { server, handlers, logger, rateLimiter } = harness();
    const read = pagedReader(makeDomains(40));
    registerListTool(server as any, { read } as any, logger, rateLimiter, {
      ...DOMAIN_CFG,
    } as any);
    const res = await handlers.list_client_domains({
      clientid: 30,
      limit: 8,
      offset: 0,
    });
    const p = JSON.parse(res.content[0].text);
    expect(read).toHaveBeenCalledTimes(1);
    expect(p.items).toHaveLength(8);
    expect(p.total).toBe(40);
    expect(p.count).toBe(8);
    expect(p.filter_mode).toBeUndefined();
    expect(p.filter_applied).toBeUndefined();
    expect(p.requested_status).toBeUndefined();
    expect(p.scan_complete).toBeUndefined();
    // mixed statuses retained
    const statuses = (p.items as { status: string }[]).map((d) => d.status);
    expect(new Set(statuses).size).toBeGreaterThan(1);
  });

  it('scan_complete=true when WHMCS total exhausted within cap', async () => {
    const { server, handlers, logger, rateLimiter } = harness();
    const read = pagedReader(makeDomains(12));
    registerListTool(server as any, { read } as any, logger, rateLimiter, {
      ...DOMAIN_CFG,
    } as any);
    const res = await handlers.list_client_domains({
      clientid: 30,
      status: 'Active',
      limit: 50,
      offset: 0,
    });
    const p = JSON.parse(res.content[0].text);
    expect(p.scan_complete).toBe(true);
    expect(p.matched_count).toBe(3); // 12/4
    expect(p.scanned_count).toBe(12);
    expect(p.warning).toBeUndefined();
  });

  it('scan_complete=false + warning when scan cap reached before exhaustion', async () => {
    const { server, handlers, logger, rateLimiter } = harness();
    // Huge dataset where matches are sparse so the cap is hit first.
    // Only id 1 is Active; the rest never match → scan must cap out.
    const big = Array.from({ length: 100000 }, (_, i) => ({
      id: i + 1,
      domainname: `d${String(i + 1)}.test`,
      status: i === 0 ? 'Active' : 'Cancelled',
    }));
    const read = pagedReader(big);
    registerListTool(server as any, { read } as any, logger, rateLimiter, {
      ...DOMAIN_CFG,
    } as any);
    const res = await handlers.list_client_domains({
      clientid: 30,
      status: 'Active',
      limit: 10,
      offset: 0,
    });
    const p = JSON.parse(res.content[0].text);
    expect(p.scan_complete).toBe(false);
    expect(typeof p.warning).toBe('string');
    expect(p.warning.length).toBeGreaterThan(0);
    // It still returns the matches it DID find within the cap.
    expect(p.items.every((d: any) => d.status === 'Active')).toBe(true);
    // Bounded: never scanned the whole 100k.
    expect(p.scanned_count).toBeLessThan(big.length);
  });

  it('pages through MULTIPLE WHMCS reads until matches/exhaustion', async () => {
    const { server, handlers, logger, rateLimiter } = harness();
    // 250 domains > page size (100) → forces ≥3 read pages.
    // 250/4 → 63 Active rows total.
    const read = pagedReader(makeDomains(250));
    registerListTool(server as any, { read } as any, logger, rateLimiter, {
      ...DOMAIN_CFG,
    } as any);
    const res = await handlers.list_client_domains({
      clientid: 30,
      status: 'Active',
      limit: 100,
      offset: 0,
    });
    const p = JSON.parse(res.content[0].text);
    // Multiple WHMCS reads occurred (pagination, not a single page).
    expect(read.mock.calls.length).toBeGreaterThanOrEqual(3);
    // Every read used the configured page size, ascending limitstart.
    expect(read.mock.calls[0][1]).toMatchObject({
      limitnum: 100,
      limitstart: 0,
    });
    expect(read.mock.calls[1][1]).toMatchObject({
      limitnum: 100,
      limitstart: 100,
    });
    expect(p.items.every((d: any) => d.status === 'Active')).toBe(true);
    expect(p.matched_count).toBe(63);
    expect(p.scan_complete).toBe(true);
    expect(p.scanned_count).toBe(250);
  });

  it('early-stop: stops scanning once the window is satisfiable', async () => {
    const { server, handlers, logger, rateLimiter } = harness();
    // 500 all-Active domains. limit=5 offset=0 ⇒ need=5; one 100-row page
    // already yields 100 matches, so the scan stops early (does NOT read
    // all 5 pages) and reports a conservative scan_complete=false.
    const allActive = Array.from({ length: 500 }, (_, i) => ({
      id: i + 1,
      domainname: `d${String(i + 1)}.test`,
      status: 'Active',
    }));
    const read = pagedReader(allActive);
    registerListTool(server as any, { read } as any, logger, rateLimiter, {
      ...DOMAIN_CFG,
    } as any);
    const res = await handlers.list_client_domains({
      clientid: 30,
      status: 'Active',
      limit: 5,
      offset: 0,
    });
    const p = JSON.parse(res.content[0].text);
    expect(read.mock.calls.length).toBe(1); // stopped after 1 page
    expect(p.items).toHaveLength(5);
    expect(p.items.every((d: any) => d.status === 'Active')).toBe(true);
    expect(p.scan_complete).toBe(false); // conservative: not exhausted
    expect(p.warning).toBeUndefined(); // early-stop is NOT a cap
  });

  it('honest pagination over the FILTERED set (offset/limit on matches)', async () => {
    const { server, handlers, logger, rateLimiter } = harness();
    // 40 domains → 10 Active: d1,d5,d9,d13,d17,d21,d25,d29,d33,d37
    const read = pagedReader(makeDomains(40));
    registerListTool(server as any, { read } as any, logger, rateLimiter, {
      ...DOMAIN_CFG,
    } as any);
    const res = await handlers.list_client_domains({
      clientid: 30,
      status: 'Active',
      limit: 3,
      offset: 4,
    });
    const p = JSON.parse(res.content[0].text);
    // matches[4..6] = d17, d21, d25
    expect((p.items as { domain: string }[]).map((d) => d.domain)).toEqual([
      'd17.test',
      'd21.test',
      'd25.test',
    ]);
    expect(p.returned_count).toBe(3);
    expect(p.matched_count).toBe(10);
    expect(p.offset).toBe(4);
    expect(p.limit).toBe(3);
    expect(p.count).toBe(3);
  });

  it('numeric-keyed and single-object and empty WHMCS page shapes handled', async () => {
    for (const shape of ['numeric', 'single', 'empty'] as const) {
      const { server, handlers, logger, rateLimiter } = harness();
      const data = shape === 'empty' ? [] : makeDomains(8);
      const read = pagedReader(data, shape);
      registerListTool(server as any, { read } as any, logger, rateLimiter, {
        ...DOMAIN_CFG,
      } as any);
      const res = await handlers.list_client_domains({
        clientid: 30,
        status: 'Active',
        limit: 10,
        offset: 0,
      });
      const p = JSON.parse(res.content[0].text);
      expect(p.filter_mode).toBe('client_side');
      expect(p.items.every((d: any) => d.status === 'Active')).toBe(true);
      if (shape === 'empty') {
        expect(p.items).toHaveLength(0);
        expect(p.matched_count).toBe(0);
      } else {
        expect(p.matched_count).toBe(2); // 8/4
      }
      expect(p.scan_complete).toBe(true);
    }
  });
});

describe('list_client_domains status filter — governance ON', () => {
  const TOKEN_OPS = 'tok-ops-domains-aaaaaaaa';
  const registryJson = JSON.stringify([
    {
      id: 'ops_desk',
      token_sha256: hashToken(TOKEN_OPS),
      defaultContract: 'ops_operator',
      allowedContracts: ['ops_operator'],
      writeCapability: 'false',
    },
  ]);

  afterEach(() => {
    vi.resetModules();
    delete process.env.MCP_CONSUMER_REGISTRY;
  });

  async function governedHarness(readImpl: (a: string, p: any) => any) {
    vi.resetModules();
    process.env.MCP_CONSUMER_REGISTRY = registryJson;
    vi.doMock('../../src/config.js', () => ({
      config: {
        MCP_MAX_PAGE_SIZE: 100,
        MCP_GOVERNANCE_ENABLED: true,
        MCP_ENV: 'production',
        MCP_ALLOW_ANON_LLM: false,
      },
      isToolAllowed: () => true,
    }));
    vi.doMock('../../src/security.js', () => ({
      AUTH_SHAPE: {},
      ensureToolAuth: () => null,
      isClientMode: () => false,
      ensureClientAllowed: () => null,
    }));
    const { registerListTool: rlt } = await import(
      '../../src/tools/listTools.js'
    );
    const { mapToCanonicalDomain: cmap } = await import(
      '../../src/canonical/index.js'
    );
    const { __resetRegistryCacheForTests } = await import(
      '../../src/governance/pipeline.js'
    );
    __resetRegistryCacheForTests();
    const { server, handlers, logger, rateLimiter } = harness();
    rlt(server as any, { read: vi.fn(readImpl) } as any, logger, rateLimiter, {
      ...DOMAIN_CFG,
      canonicalMap: cmap,
    } as any);
    return handlers;
  }

  it('governed: only Active rows, projected items, metadata visible on envelope', async () => {
    const reader = pagedReader(makeDomains(40));
    const handlers = await governedHarness(reader);
    const res = await handlers.list_client_domains({
      clientid: 30,
      status: 'Active',
      limit: 4,
      offset: 0,
      auth_token: TOKEN_OPS,
    });
    const p = JSON.parse(res.content[0].text);
    expect(p.consumer).toBe('ops_desk');
    expect(p.contract).toBe('ops_operator');
    // Envelope metadata flows through alongside total/count/offset/limit.
    expect(p.filter_mode).toBe('client_side');
    expect(p.filter_applied).toBe(true);
    expect(p.requested_status).toBe('Active');
    expect(p.matched_count).toBe(10);
    expect(p.returned_count).toBe(4);
    expect(p.scan_complete).toBe(true);
    expect(p.items).toHaveLength(4);
    // Projected canonical domain rows (status is public.safe → allowed).
    expect(p.items.every((d: any) => d.status === 'Active')).toBe(true);
    expect(p.items[0]).toHaveProperty('domain');
  });

  it('governed: scan cap → scan_complete=false + warning still on envelope', async () => {
    const big = Array.from({ length: 100000 }, (_, i) => ({
      id: i + 1,
      domainname: `d${String(i + 1)}.test`,
      status: i === 0 ? 'Active' : 'Cancelled',
    }));
    const handlers = await governedHarness(pagedReader(big));
    const res = await handlers.list_client_domains({
      clientid: 30,
      status: 'Active',
      limit: 10,
      offset: 0,
      auth_token: TOKEN_OPS,
    });
    const p = JSON.parse(res.content[0].text);
    expect(p.scan_complete).toBe(false);
    expect(typeof p.warning).toBe('string');
    expect(p.consumer).toBe('ops_desk');
  });
});
