/**
 * Regression for #10: get_client_details reported product_count/domain_count
 * as 0 because it read non-existent root keys (numproducts/numdomains).
 * WHMCS GetClientsDetails only returns counts in a `stats` object when
 * stats=true is passed. These tests pin: stats:true is sent, and counts come
 * from result.stats (active + total).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: {
    WHMCS_API_URL: 'https://test.whmcs.com',
    WHMCS_IDENTIFIER: 'id',
    WHMCS_SECRET: 'secret',
    MCP_MODE: 'read_only',
    MCP_RATE_LIMIT: 10,
    MCP_DEBUG: false,
    MCP_MAX_PAGE_SIZE: 100,
    MCP_TOOL_ALLOWLIST: [],
    MCP_LARGE_REFUND_THRESHOLD: 1000,
  },
  isToolAllowed: () => true,
}));
vi.mock('../../src/security.js', () => ({
  AUTH_SHAPE: {},
  ensureToolAuth: () => null,
  clientModeDenied: () => ({}),
  isClientMode: () => false,
  ensureClientAllowed: () => null,
  ensureClientOwnership: () => null,
}));

import { registerClientTools } from '../../src/tools/clients.js';

describe('get_client_details (#10 stats counts)', () => {
  it('passes stats:true and maps product/domain counts from result.stats', async () => {
    const handlers: Record<string, (p: any) => Promise<any>> = {};
    const server = { tool: (n: string, _d: string, _s: unknown, cb: any) => { handlers[n] = cb; } };

    const read = vi.fn().mockResolvedValue({
      id: 30,
      firstname: 'Test',
      lastname: 'User',
      fullname: 'Test User',
      email: 'client@example.test',
      status: 'Active',
      credit: '29.51',
      currency_code: 'INR',
      customfields: [],
      stats: {
        productsnumactive: 1,
        productsnumtotal: 3,
        numactivedomains: 4,
        numdomains: 23,
      },
    });
    const whmcsClient: any = { read };
    const childLogger: any = { logToolCall: vi.fn(), logToolResult: vi.fn(), info: vi.fn(), error: vi.fn(), child: () => childLogger };
    const logger: any = { child: () => childLogger };
    const rateLimiter: any = { tryConsume: () => true };

    registerClientTools(server as any, whmcsClient, logger, rateLimiter);
    expect(handlers.get_client_details).toBeTypeOf('function');

    const res = await handlers.get_client_details({ clientid: 30 });
    const payload = JSON.parse(res.content[0].text);

    expect(read).toHaveBeenCalledWith('GetClientsDetails', { clientid: 30, stats: true });
    expect(payload.product_count).toBe(1);
    expect(payload.product_count_total).toBe(3);
    expect(payload.domain_count).toBe(4);
    expect(payload.domain_count_total).toBe(23);
  });
});
