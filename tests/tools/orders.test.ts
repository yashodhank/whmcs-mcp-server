/**
 * Unit tests for order management tools
 *
 * Tests: list_products, accept_order
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock modules
vi.mock('../src/config.js', () => ({
  config: {
    WHMCS_API_URL: 'https://test.whmcs.com',
    WHMCS_IDENTIFIER: 'test-id',
    WHMCS_SECRET: 'test-secret',
    MCP_MODE: 'full',
    MCP_RATE_LIMIT: 10,
    MCP_DEBUG: false,
    MCP_MAX_PAGE_SIZE: 100,
    MCP_TOOL_ALLOWLIST: [],
  },
  isToolAllowed: () => true,
  legacyWriteToolsEnabled: () => true,
}));

// Correctly-pathed mocks for the integration-style mapper tests below.
vi.mock('../../src/config.js', () => ({
  config: {
    WHMCS_API_URL: 'https://test.whmcs.com',
    WHMCS_IDENTIFIER: 'test-id',
    WHMCS_SECRET: 'test-secret',
    MCP_MODE: 'full',
    MCP_RATE_LIMIT: 10,
    MCP_DEBUG: false,
    MCP_MAX_PAGE_SIZE: 100,
    MCP_TOOL_ALLOWLIST: [],
  },
  isToolAllowed: () => true,
  legacyWriteToolsEnabled: () => true,
}));
vi.mock('../../src/security.js', () => ({
  AUTH_SHAPE: {},
  ensureToolAuth: () => null,
  clientModeDenied: () => ({}),
  isClientMode: () => false,
}));

describe('Order Tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('list_products', () => {
    it('should validate list products parameters', () => {
      const { z } = require('zod');

      const listProductsSchema = z.object({
        group_id: z.number().int().optional(),
        name_contains: z.string().optional(),
        include_hidden: z.boolean().default(false),
        limit: z.number().int().min(1).max(100).default(50),
        include_pricing: z.boolean().default(true),
        currency: z.string().optional(),
      });

      // Valid with defaults
      const defaultResult = listProductsSchema.safeParse({});
      expect(defaultResult.success).toBe(true);
      expect(defaultResult.data?.include_hidden).toBe(false);
      expect(defaultResult.data?.limit).toBe(50);

      // With filters
      expect(
        listProductsSchema.safeParse({
          group_id: 5,
          name_contains: 'hosting',
          include_hidden: true,
          limit: 25,
        }).success
      ).toBe(true);

      // Invalid limit
      expect(
        listProductsSchema.safeParse({
          limit: 200, // Exceeds max
        }).success
      ).toBe(false);
    });

    it('should filter products by name', () => {
      interface Product {
        pid: number;
        name: string;
        hidden: number;
      }

      function filterProducts(
        products: Product[],
        nameContains?: string,
        includeHidden?: boolean
      ): Product[] {
        let filtered = products;

        if (nameContains) {
          const search = nameContains.toLowerCase();
          filtered = filtered.filter((p) => p.name.toLowerCase().includes(search));
        }

        if (!includeHidden) {
          filtered = filtered.filter((p) => p.hidden !== 1);
        }

        return filtered;
      }

      const products: Product[] = [
        { pid: 1, name: 'Basic Hosting', hidden: 0 },
        { pid: 2, name: 'Premium Hosting', hidden: 0 },
        { pid: 3, name: 'Hidden Product', hidden: 1 },
        { pid: 4, name: 'VPS Server', hidden: 0 },
      ];

      // Filter by name
      const hostingProducts = filterProducts(products, 'hosting');
      expect(hostingProducts.length).toBe(2);

      // Include hidden
      const allProducts = filterProducts(products, undefined, true);
      expect(allProducts.length).toBe(4);

      // Exclude hidden (default)
      const visibleProducts = filterProducts(products);
      expect(visibleProducts.length).toBe(3);

      // Combined filters
      const hiddenHosting = filterProducts(products, 'hosting', true);
      expect(hiddenHosting.length).toBe(2);
    });
  });

  describe('accept_order', () => {
    it('should validate accept order parameters', () => {
      const { z } = require('zod');

      const acceptOrderSchema = z.object({
        orderid: z.number().int().positive(),
        autosetup: z.boolean().default(true),
        sendemail: z.boolean().default(true),
        serverid: z.number().int().optional(),
      });

      // Valid with defaults
      const defaultResult = acceptOrderSchema.safeParse({
        orderid: 100,
      });
      expect(defaultResult.success).toBe(true);
      expect(defaultResult.data?.autosetup).toBe(true);
      expect(defaultResult.data?.sendemail).toBe(true);

      // With manual setup
      expect(
        acceptOrderSchema.safeParse({
          orderid: 100,
          autosetup: false,
          sendemail: false,
        }).success
      ).toBe(true);

      // With specific server
      expect(
        acceptOrderSchema.safeParse({
          orderid: 100,
          serverid: 5,
        }).success
      ).toBe(true);

      // Invalid orderid
      expect(
        acceptOrderSchema.safeParse({
          orderid: 0,
        }).success
      ).toBe(false);
    });
  });
});

// =============================================================================
// list_products → output mapping with slug+pricing (#18)
// =============================================================================
//
// These tests exercise the actual registerOrderTools handler against a
// mocked WhmcsClient, asserting that the new additive fields (slug,
// product_url, gid, pricing) are surfaced from the raw GetProducts response
// and that include_pricing / currency knobs project as documented. The
// pricing block is a passthrough of the raw WHMCS response — its inner
// shape is opaque to the tool; we only assert presence + projection.
import { registerOrderTools } from '../../src/tools/orders.js';

describe('list_products → output mapping with slug+pricing', () => {
  type Handler = (p: any) => Promise<any>;

  // 7-product fixture covering acceptance-criteria pids: 480, 481, 482, 483,
  // 470, 484, 500. Each carries name, slug, product_url, gid, type:'server',
  // hidden:0, and a USD pricing block with the six standard billing cycles.
  function makeFixture() {
    const cycle = (m: string, q: string, s: string, a: string, b: string, t: string) => ({
      monthly: m,
      quarterly: q,
      semiannually: s,
      annually: a,
      biennially: b,
      triennially: t,
    });
    return [
      {
        pid: 480,
        gid: 12,
        name: 'VPS XS SSD',
        slug: 'vps-xs-ssd',
        product_url: 'https://example.test/store/vps/vps-xs-ssd',
        description: 'Entry VPS',
        type: 'server',
        hidden: 0,
        groupname: 'VPS',
        pricing: { USD: cycle('5.00', '14.00', '27.00', '52.00', '99.00', '140.00') },
      },
      {
        pid: 481,
        gid: 12,
        name: 'VPS S SSD',
        slug: 'vps-s-ssd',
        product_url: 'https://example.test/store/vps/vps-s-ssd',
        description: 'Small VPS',
        type: 'server',
        hidden: 0,
        groupname: 'VPS',
        pricing: { USD: cycle('10.00', '28.00', '54.00', '104.00', '198.00', '280.00') },
      },
      {
        pid: 482,
        gid: 12,
        name: 'VPS L SSD',
        slug: 'vps-l-ssd',
        product_url: 'https://example.test/store/vps/vps-l-ssd',
        description: 'Large VPS',
        type: 'server',
        hidden: 0,
        groupname: 'VPS',
        pricing: { USD: cycle('20.00', '56.00', '108.00', '208.00', '396.00', '560.00') },
      },
      {
        pid: 483,
        gid: 12,
        name: 'VPS XL SSD',
        slug: 'vps-xl-ssd',
        product_url: 'https://example.test/store/vps/vps-xl-ssd',
        description: 'XL VPS',
        type: 'server',
        hidden: 0,
        groupname: 'VPS',
        pricing: { USD: cycle('40.00', '112.00', '216.00', '416.00', '792.00', '1120.00') },
      },
      {
        pid: 470,
        gid: 12,
        name: 'VPS Starter',
        slug: 'vps-starter',
        product_url: 'https://example.test/store/vps/vps-starter',
        description: 'Starter VPS',
        type: 'server',
        hidden: 0,
        groupname: 'VPS',
        pricing: { USD: cycle('3.00', '8.00', '15.00', '28.00', '54.00', '78.00') },
      },
      {
        pid: 484,
        gid: 12,
        name: 'VPS XXL SSD',
        slug: 'vps-xxl-ssd',
        product_url: 'https://example.test/store/vps/vps-xxl-ssd',
        description: 'XXL VPS',
        type: 'server',
        hidden: 0,
        groupname: 'VPS',
        pricing: { USD: cycle('80.00', '224.00', '432.00', '832.00', '1584.00', '2240.00') },
      },
      {
        pid: 500,
        gid: 12,
        name: 'VPS 3 SSD',
        slug: 'vps-3-ssd',
        product_url: 'https://example.test/store/vps/vps-3-ssd',
        description: 'VPS 3',
        type: 'server',
        hidden: 0,
        groupname: 'VPS',
        pricing: { USD: cycle('15.00', '42.00', '81.00', '156.00', '297.00', '420.00') },
      },
    ];
  }

  function harness(extra: Record<string, unknown> = {}) {
    const handlers: Record<string, Handler> = {};
    const server = {
      registerTool: (n: string, _cfg: unknown, cb: Handler) => {
        handlers[n] = cb;
      },
    };
    const read = vi.fn().mockResolvedValue({
      products: { product: makeFixture() },
      totalresults: 7,
      ...extra,
    });
    const whmcsClient: any = { read, isReadOnly: () => true };
    const childLogger: any = {
      logToolCall: vi.fn(),
      logToolResult: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };
    childLogger.child = (): unknown => childLogger as unknown;
    const logger: any = { child: (): unknown => childLogger as unknown };
    const rateLimiter: any = { tryConsume: () => true };
    return { server, handlers, whmcsClient, logger, rateLimiter, read };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('every mapped row has slug, product_url, gid, and pricing (default include_pricing=true)', async () => {
    const { server, handlers, whmcsClient, logger, rateLimiter } = harness();
    registerOrderTools(server as any, whmcsClient, logger, rateLimiter);
    expect(handlers.list_products).toBeTypeOf('function');

    const res = await handlers.list_products({
      include_hidden: false,
      limit: 50,
      include_pricing: true,
    });
    const payload = JSON.parse(res.content[0].text);
    expect(payload.count).toBe(7);
    for (const row of payload.products) {
      expect(typeof row.slug).toBe('string');
      expect(row.slug.length).toBeGreaterThan(0);
      expect(typeof row.product_url).toBe('string');
      expect(typeof row.gid).toBe('number');
      expect(row.pricing).toBeDefined();
      expect(row.pricing.USD).toBeDefined();
    }
    // Spot-check pid 482 → vps-l-ssd (deterministic join key per #18).
    const vpsL = payload.products.find((p: any) => p.id === 482);
    expect(vpsL.slug).toBe('vps-l-ssd');
  });

  it('include_pricing=false omits the pricing field; other additive fields still present', async () => {
    const { server, handlers, whmcsClient, logger, rateLimiter } = harness();
    registerOrderTools(server as any, whmcsClient, logger, rateLimiter);

    const res = await handlers.list_products({
      include_hidden: false,
      limit: 50,
      include_pricing: false,
    });
    const payload = JSON.parse(res.content[0].text);
    for (const row of payload.products) {
      expect(row.pricing).toBeUndefined();
      expect(row.slug).toBeDefined();
      expect(row.product_url).toBeDefined();
      expect(row.gid).toBeDefined();
    }
  });

  it('currency=USD projects pricing to only the USD key', async () => {
    const { server, handlers, whmcsClient, logger, rateLimiter } = harness();
    registerOrderTools(server as any, whmcsClient, logger, rateLimiter);

    const res = await handlers.list_products({
      include_hidden: false,
      limit: 50,
      include_pricing: true,
      currency: 'USD',
    });
    const payload = JSON.parse(res.content[0].text);
    for (const row of payload.products) {
      expect(Object.keys(row.pricing)).toEqual(['USD']);
    }
  });

  it('backward-compat: existing 6 fields keep their shape and values', async () => {
    const { server, handlers, whmcsClient, logger, rateLimiter } = harness();
    registerOrderTools(server as any, whmcsClient, logger, rateLimiter);

    const res = await handlers.list_products({
      include_hidden: false,
      limit: 50,
      include_pricing: true,
    });
    const payload = JSON.parse(res.content[0].text);
    const vpsL = payload.products.find((p: any) => p.id === 482);
    // Shape pin: the 6 original fields exist and match raw fixture values.
    expect(vpsL.id).toBe(482);
    expect(vpsL.name).toBe('VPS L SSD');
    expect(vpsL.group_name).toBe('VPS');
    expect(vpsL.description).toBe('Large VPS');
    expect(vpsL.type).toBe('server');
    expect(vpsL.isHidden).toBe(false);
  });

  it('include_hidden=false still drops hidden rows in the new shape', async () => {
    const handlers: Record<string, Handler> = {};
    const server = {
      registerTool: (n: string, _cfg: unknown, cb: Handler) => {
        handlers[n] = cb;
      },
    };
    const fixture = makeFixture();
    // Mark pid 470 as hidden.
    fixture[4] = { ...fixture[4], hidden: 1 };
    const read = vi.fn().mockResolvedValue({
      products: { product: fixture },
      totalresults: fixture.length,
    });
    const whmcsClient: any = { read, isReadOnly: () => true };
    const childLogger: any = {
      logToolCall: vi.fn(),
      logToolResult: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };
    childLogger.child = (): unknown => childLogger as unknown;
    const logger: any = { child: (): unknown => childLogger as unknown };
    const rateLimiter: any = { tryConsume: () => true };

    registerOrderTools(server as any, whmcsClient, logger, rateLimiter);
    const res = await handlers.list_products({
      include_hidden: false,
      limit: 50,
      include_pricing: true,
    });
    const payload = JSON.parse(res.content[0].text);
    expect(payload.count).toBe(6);
    expect(payload.products.find((p: any) => p.id === 470)).toBeUndefined();
    // Hidden row excluded but additive fields still present on remaining rows.
    for (const row of payload.products) {
      expect(row.slug).toBeDefined();
      expect(row.gid).toBeDefined();
    }
  });

  it('limit:2 only returns first two rows projected', async () => {
    const { server, handlers, whmcsClient, logger, rateLimiter } = harness();
    registerOrderTools(server as any, whmcsClient, logger, rateLimiter);

    const res = await handlers.list_products({
      include_hidden: false,
      limit: 2,
      include_pricing: true,
    });
    const payload = JSON.parse(res.content[0].text);
    expect(payload.count).toBe(2);
    expect(payload.products).toHaveLength(2);
    expect(payload.products[0].id).toBe(480);
    expect(payload.products[1].id).toBe(481);
    // Additive fields still present on the limited rows.
    for (const row of payload.products) {
      expect(row.slug).toBeDefined();
      expect(row.pricing).toBeDefined();
    }
  });
});
