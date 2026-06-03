/**
 * Regression for #10: get_client_details reported product_count/domain_count
 * as 0 because it read non-existent root keys (numproducts/numdomains).
 * WHMCS GetClientsDetails only returns counts in a `stats` object when
 * stats=true is passed. These tests pin: stats:true is sent, and counts come
 * from result.stats (active + total).
 */
import { describe, it, expect, vi } from 'vitest';

const { cfg } = vi.hoisted(() => ({
  cfg: {
    WHMCS_API_URL: 'https://test.whmcs.com',
    WHMCS_IDENTIFIER: 'id',
    WHMCS_SECRET: 'secret',
    MCP_MODE: 'read_only',
    MCP_RATE_LIMIT: 10,
    MCP_DEBUG: false,
    MCP_MAX_PAGE_SIZE: 100,
    MCP_TOOL_ALLOWLIST: [],
    MCP_CLIENT_CUSTOM_FIELD_LABELS: {},
    MCP_LARGE_REFUND_THRESHOLD: 1000,
    MCP_GOVERNANCE_ENABLED: false,
    MCP_ALLOW_ANON_LLM: false,
    MCP_ENV: 'production',
  } as Record<string, unknown>,
}));

vi.mock('../../src/config.js', () => ({
  get config() {
    return cfg;
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
import { hashToken } from '../../src/governance/consumers.js';
import { __resetRegistryCacheForTests } from '../../src/governance/pipeline.js';

describe('get_client_details (#10 stats counts)', () => {
  it('passes stats:true and maps product/domain counts from result.stats', async () => {
    const handlers: Record<string, (p: any) => Promise<any>> = {};
    const server = { registerTool: (n: string, _cfg: unknown, cb: any) => { handlers[n] = cb; } };

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

  it('applies MCP_CLIENT_CUSTOM_FIELD_LABELS over WHMCS field names in custom_fields', async () => {
    cfg.MCP_CLIENT_CUSTOM_FIELD_LABELS = { '7': 'Configured Label' };
    const handlers: Record<string, (p: any) => Promise<any>> = {};
    const server = { registerTool: (n: string, _cfg: unknown, cb: any) => { handlers[n] = cb; } };

    const read = vi.fn().mockResolvedValue({
      id: 30,
      firstname: 'Test',
      lastname: 'User',
      fullname: 'Test User',
      email: 'client@example.test',
      status: 'Active',
      credit: '0',
      currency_code: 'USD',
      customfields: [{ id: 7, fieldname: 'WHMCS Name', value: 'cf-value' }],
      stats: { productsnumactive: 0, productsnumtotal: 0, numactivedomains: 0, numdomains: 0 },
    });
    const whmcsClient: any = { read };
    const childLogger: any = { logToolCall: vi.fn(), logToolResult: vi.fn(), info: vi.fn(), error: vi.fn(), child: () => childLogger };
    const logger: any = { child: () => childLogger };
    const rateLimiter: any = { tryConsume: () => true };

    registerClientTools(server as any, whmcsClient, logger, rateLimiter);
    const res = await handlers.get_client_details({ clientid: 30 });
    const payload = JSON.parse(res.content[0].text);

    expect(payload.custom_fields).toEqual([
      { id: 7, label: 'Configured Label', name: 'Configured Label', value: 'cf-value' },
    ]);
    cfg.MCP_CLIENT_CUSTOM_FIELD_LABELS = {};
  });
});

describe('get_client_details (governed path)', () => {
  const TOKEN_BILL = 'tok-bill-clientdetails';

  function harness() {
    const handlers: Record<string, (p: any) => Promise<any>> = {};
    const server = { registerTool: (n: string, _cfg: unknown, cb: any) => { handlers[n] = cb; } };
    const read = vi.fn().mockResolvedValue({
      id: 30,
      firstname: 'Test',
      lastname: 'User',
      fullname: 'Test User',
      email: 'client@example.test',
      phonenumber: '+1.5125550100',
      status: 'Active',
      credit: '29.51',
      currency_code: 'INR',
      defaultgateway: 'razorpay',
      customfields: [],
      stats: { productsnumactive: 1, productsnumtotal: 3, numactivedomains: 4, numdomains: 23 },
    });
    const whmcsClient: any = { read };
    const childLogger: any = { logToolCall: vi.fn(), logToolResult: vi.fn(), info: vi.fn(), error: vi.fn() };
    childLogger.child = () => childLogger as unknown;
    const logger: any = { child: () => childLogger as unknown };
    const rateLimiter: any = { tryConsume: () => true };
    return { server, handlers, whmcsClient, logger, rateLimiter };
  }

  function enableGovernance(): void {
    cfg.MCP_GOVERNANCE_ENABLED = true;
    cfg.MCP_ALLOW_ANON_LLM = true;
    cfg.MCP_ENV = 'production';
    process.env.MCP_CONSUMER_REGISTRY = JSON.stringify([
      {
        id: 'billing_app',
        token_sha256: hashToken(TOKEN_BILL),
        defaultContract: 'billing_reconciliation',
        allowedContracts: ['billing_reconciliation'],
        writeCapability: 'false',
      },
    ]);
    __resetRegistryCacheForTests();
  }

  function disableGovernance(): void {
    cfg.MCP_GOVERNANCE_ENABLED = false;
    cfg.MCP_ALLOW_ANON_LLM = false;
    delete process.env.MCP_CONSUMER_REGISTRY;
    __resetRegistryCacheForTests();
  }

  it('authed billing consumer gets projected structuredContent; denied token leaks no data', async () => {
    enableGovernance();
    try {
      const { server, handlers, whmcsClient, logger, rateLimiter } = harness();
      registerClientTools(server as any, whmcsClient, logger, rateLimiter);

      const ok = await handlers.get_client_details({ clientid: 30, auth_token: TOKEN_BILL });
      expect(ok.structuredContent).toBeDefined();
      expect(ok.structuredContent.contract).toBe('billing_reconciliation');
      expect(ok.structuredContent.data).toMatchObject({ clientId: 30, email: 'client@example.test' });
      // phone is masked under billing_reconciliation
      expect(JSON.stringify(ok.structuredContent.data)).not.toContain('+1.5125550100');

      const denied = await handlers.get_client_details({ clientid: 30, auth_token: 'unknown-token' });
      expect(denied.isError).toBe(true);
      expect(denied.structuredContent?.data).toBeUndefined();
      expect(JSON.stringify(denied)).not.toContain('client@example.test');
    } finally {
      disableGovernance();
    }
  });
});
