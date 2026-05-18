import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { hashToken } from '../../src/governance/consumers.js';
vi.mock('../../src/config.js', () => ({ config: { MCP_MAX_PAGE_SIZE: 100 }, isToolAllowed: () => true }));
vi.mock('../../src/security.js', () => ({ AUTH_SHAPE: {}, ensureToolAuth: () => null, isClientMode: () => false, ensureClientAllowed: () => null }));
import { registerAggregatorTools } from '../../src/tools/aggregators.js';

function harness(readImpl: (action: string, params: any) => any) {
  const handlers: Record<string, any> = {};
  const configs: Record<string, any> = {};
  const server = { registerTool: (n: string, c: any, cb: any) => { configs[n] = c; handlers[n] = cb; } };
  const childLogger: any = { logToolCall: vi.fn(), logToolResult: vi.fn(), info: vi.fn(), error: vi.fn(), child: () => childLogger };
  const logger: any = { child: () => childLogger };
  const rateLimiter: any = { tryConsume: () => true };
  const whmcs: any = { read: vi.fn(readImpl) };
  registerAggregatorTools(server as any, whmcs, logger, rateLimiter);
  return { handlers, configs, whmcs };
}

describe('get_account_360', () => {
  it('assembles client + counts + recent slices; tickets carry C2 best-effort', async () => {
    const { handlers } = harness((action) => {
      if (action === 'GetClientsDetails') return { id: 30, firstname: 'Test', lastname: 'User', email: 'c@example.test', status: 'Active', credit: '29.51', currency_code: 'INR',
        stats: { creditbalance: '29.51', numunpaidinvoices: 0, numoverdueinvoices: 0, productsnumactive: 1, productsnumtotal: 4, numactivedomains: 4, numdomains: 24, numactivetickets: 0 } };
      if (action === 'GetClientsProducts') return { products: { product: [{ id: 545, name: 'Web Hosting', domain: 'example.org', status: 'Active', nextduedate: '2030-04-14' }] } };
      if (action === 'GetClientsDomains') return { domains: { domain: [{ id: 314, domainname: 'example.net', status: 'Active', expirydate: '2027-01-01' }] } };
      if (action === 'GetInvoices') return { invoices: { invoice: [{ id: 9001, status: 'Paid', total: '100.00', date: '2026-05-18' }] } };
      if (action === 'GetOrders') return { orders: { order: [{ id: 7, date: '2026-05-18', status: 'Active', amount: '0.00' }] } };
      if (action === 'GetTickets') return { tickets: { ticket: [] } };
      return {};
    });
    const res = await handlers['get_account_360']({ clientid: 30 });
    const p = JSON.parse(res.content[0].text);
    expect(p.client).toMatchObject({ clientid: 30, name: 'Test User', status: 'Active', credit_balance: '29.51', currency: 'INR' });
    expect(p.counts).toMatchObject({ services_active: 1, services_total: 4, domains_active: 4, domains_total: 24, unpaid_invoices: 0, overdue_invoices: 0 });
    expect(p.recent.services[0]).toMatchObject({ serviceid: 545, domain: 'example.org' });
    expect(p.recent.invoices[0]).toMatchObject({ invoiceid: 9001 });
    expect(p.recent.tickets.discovery).toBe('best-effort');
    expect(p.recent.tickets.note).toMatch(/may miss operator/i);
    expect(p.partial_errors).toEqual([]);
  });

  it('a failing sub-read becomes a partial_errors entry, not a thrown aggregator', async () => {
    const { handlers } = harness((action) => {
      if (action === 'GetClientsDetails') return { id: 30, firstname: 'T', lastname: 'U', email: 'e', status: 'Active', credit: '0', currency_code: 'INR', stats: { productsnumactive: 0, productsnumtotal: 0, numactivedomains: 0, numdomains: 0, numunpaidinvoices: 0, numoverdueinvoices: 0 } };
      if (action === 'GetClientsProducts') throw new Error('boom-products');
      return { invoices: { invoice: [] }, domains: { domain: [] }, orders: { order: [] }, tickets: { ticket: [] } };
    });
    const res = await handlers['get_account_360']({ clientid: 30 });
    const p = JSON.parse(res.content[0].text);
    expect(p.client.clientid).toBe(30);
    expect(p.recent.services).toEqual([]);
    expect(p.partial_errors.some((e: any) => e.section === 'services' && /boom-products/.test(e.error))).toBe(true);
  });
});

describe('get_billing_snapshot', () => {
  it('summarises billing from stats + recent unpaid/overdue', async () => {
    const { handlers } = harness((action, params) => {
      if (action === 'GetClientsDetails') return { currency_code: 'INR', credit: '1.00', stats: { creditbalance: '29.51', numunpaidinvoices: 2, unpaidinvoicesamount: '500.00', numoverdueinvoices: 1, overdueinvoicesbalance: '300.00', numpaidinvoices: 63, paidinvoicesamount: '9000.00', numcancelledinvoices: 5, numrefundedinvoices: 1, numDraftInvoices: 0 } };
      if (action === 'GetInvoices' && params.status === 'Unpaid') return { invoices: { invoice: [{ id: 11, total: '250.00', duedate: '2026-06-01', status: 'Unpaid', date: '2026-05-10' }] } };
      if (action === 'GetInvoices' && params.status === 'Overdue') return { invoices: { invoice: [{ id: 12, total: '300.00', duedate: '2026-04-01', status: 'Overdue', date: '2026-03-01' }] } };
      return {};
    });
    const res = await handlers['get_billing_snapshot']({ clientid: 30 });
    const p = JSON.parse(res.content[0].text);
    expect(p).toMatchObject({ currency: 'INR', credit_balance: '29.51',
      unpaid: { count: 2, amount: '500.00' }, overdue: { count: 1, amount: '300.00' },
      paid: { count: 63, amount: '9000.00' }, cancelled: { count: 5 }, refunded: { count: 1 }, draft: { count: 0 } });
    expect(p.recent_unpaid[0]).toMatchObject({ invoiceid: 11 });
    expect(p.recent_overdue[0]).toMatchObject({ invoiceid: 12 });
    expect(p.partial_errors).toEqual([]);
  });
});

describe('get_support_snapshot', () => {
  it('returns global departments + best-effort client tickets (C2)', async () => {
    const { handlers } = harness((action) => {
      if (action === 'GetSupportDepartments') return { departments: { department: [{ id: 1, name: 'Help Desk', awaitingreply: 7, opentickets: 7 }, { id: 12, name: 'Billing', awaitingreply: 0, opentickets: 0 }] } };
      if (action === 'GetTickets') return { tickets: { ticket: [{ id: 1001, tid: 'TST01', subject: 's', status: 'Answered', lastreply: '2026-05-18 07:31:27' }] } };
      return {};
    });
    const res = await handlers['get_support_snapshot']({ clientid: 30 });
    const p = JSON.parse(res.content[0].text);
    expect(p.departments).toEqual([
      { id: 1, name: 'Help Desk', open_tickets: 7, awaiting_reply: 7 },
      { id: 12, name: 'Billing', open_tickets: 0, awaiting_reply: 0 },
    ]);
    expect(p.departments_scope).toMatch(/global/i);
    expect(p.client_tickets.items[0]).toMatchObject({ ticketid: 1001, tid: 'TST01' });
    expect(p.client_tickets.discovery).toBe('best-effort');
    expect(p.client_tickets.note).toMatch(/may miss operator/i);
    expect(p.partial_errors).toEqual([]);
  });
});

describe('get_renewal_snapshot', () => {
  it('lists services+domains due within window, sorted ascending by due date', async () => {
    const { handlers } = harness((action) => {
      if (action === 'GetClientsProducts') return { products: { product: [
        { id: 545, name: 'Web Hosting', domain: 'example.org', status: 'Active', nextduedate: '2026-06-01', recurringamount: '3.00' },
        { id: 9, name: 'Old', domain: 'x', status: 'Active', nextduedate: '2031-01-01' } ] } };
      if (action === 'GetClientsDomains') return { domains: { domain: [
        { id: 314, domainname: 'example.net', status: 'Active', expirydate: '2026-05-25', nextduedate: '2026-05-25' },
        { id: 99, domainname: 'far.test', status: 'Active', expirydate: '2031-01-01', nextduedate: '2031-01-01' } ] } };
      return {};
    });
    const res = await handlers['get_renewal_snapshot']({ clientid: 30, days: 9999 });
    const p = JSON.parse(res.content[0].text);
    expect(p.upcoming.map((u: any) => `${u.type}:${u.id}`)).toEqual(['domain:314', 'service:545', 'domain:99', 'service:9']);
    expect(p.upcoming[0]).toMatchObject({ type: 'domain', id: 314, name: 'example.net', due_date: '2026-05-25', status: 'Active' });
    expect(p.window_days).toBe(9999);
    expect(p.partial_errors).toEqual([]);
  });
  it('filters out items beyond the window', async () => {
    const { handlers } = harness((action) => {
      if (action === 'GetClientsProducts') return { products: { product: [{ id: 1, name: 'A', domain: 'a', status: 'Active', nextduedate: '2099-01-01' }] } };
      if (action === 'GetClientsDomains') return { domains: { domain: [] } };
      return {};
    });
    const res = await handlers['get_renewal_snapshot']({ clientid: 30, days: 30 });
    const p = JSON.parse(res.content[0].text);
    expect(p.upcoming).toEqual([]);
  });
  it('excludes WHMCS 0000-00-00 sentinel dates (not treated as imminent)', async () => {
    const { handlers } = harness((action) => {
      if (action === 'GetClientsProducts') return { products: { product: [
        { id: 1, name: 'NoDate Svc', domain: 'a', status: 'Active', nextduedate: '0000-00-00' },
        { id: 2, name: 'Real Svc', domain: 'b', status: 'Active', nextduedate: '2026-06-01' } ] } };
      if (action === 'GetClientsDomains') return { domains: { domain: [
        { id: 9, domainname: 'nodate.test', status: 'Active', expirydate: '0000-00-00', nextduedate: '0000-00-00' } ] } };
      return {};
    });
    const res = await handlers['get_renewal_snapshot']({ clientid: 30, days: 9999 });
    const p = JSON.parse(res.content[0].text);
    expect(p.upcoming.map((u: any) => `${u.type}:${u.id}`)).toEqual(['service:2']);
  });

  it('flags truncation when the services list hits the fetch cap (renewals may be missed)', async () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1, name: `S${i}`, domain: 'a', status: 'Active',
      nextduedate: '2026-06-01', recurringamount: '1.00',
    }));
    const { handlers } = harness((action) => {
      if (action === 'GetClientsProducts') return { products: { product: many } };
      if (action === 'GetClientsDomains') return { domains: { domain: [] } };
      return {};
    });
    const res = await handlers.get_renewal_snapshot({ clientid: 30, days: 9999 });
    const p = JSON.parse(res.content[0].text);
    expect(p.truncated).toEqual({ services: true, domains: false });
  });

  it('reports no truncation when both lists are below the fetch cap', async () => {
    const { handlers } = harness((action) => {
      if (action === 'GetClientsProducts') return { products: { product: [
        { id: 1, name: 'A', domain: 'a', status: 'Active', nextduedate: '2026-06-01' } ] } };
      if (action === 'GetClientsDomains') return { domains: { domain: [
        { id: 9, domainname: 'd.test', status: 'Active', expirydate: '2026-06-01', nextduedate: '2026-06-01' } ] } };
      return {};
    });
    const res = await handlers.get_renewal_snapshot({ clientid: 30, days: 9999 });
    const p = JSON.parse(res.content[0].text);
    expect(p.truncated).toEqual({ services: false, domains: false });
  });
});

describe('aggregators — governed path', () => {
  const TOKEN_OPS = 'tok-ops-aaaaaaaa';
  const TOKEN_BILL = 'tok-bill-bbbbbbbb';

  const registryJson = JSON.stringify([
    {
      id: 'ops_desk',
      token_sha256: hashToken(TOKEN_OPS),
      defaultContract: 'ops_operator',
      allowedContracts: ['ops_operator'],
      writeCapability: 'false',
    },
    {
      id: 'billing_app',
      token_sha256: hashToken(TOKEN_BILL),
      defaultContract: 'billing_reconciliation',
      allowedContracts: ['billing_reconciliation'],
      writeCapability: 'false',
    },
  ]);

  afterEach(() => {
    vi.resetModules();
    delete process.env.MCP_CONSUMER_REGISTRY;
  });

  async function governedHarness(readImpl: (action: string, params: any) => any) {
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
    const { registerAggregatorTools: register } = await import(
      '../../src/tools/aggregators.js'
    );
    const { __resetRegistryCacheForTests } = await import(
      '../../src/governance/pipeline.js'
    );
    __resetRegistryCacheForTests();

    const handlers: Record<string, any> = {};
    const server = {
      registerTool: (n: string, _cfg: any, cb: any) => {
        handlers[n] = cb;
      },
    };
    const childLogger: Record<string, unknown> = {
      logToolCall: vi.fn(),
      logToolResult: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };
    childLogger.child = (): Record<string, unknown> => childLogger;
    const logger: Record<string, unknown> = {
      child: (): Record<string, unknown> => childLogger,
    };
    const rateLimiter: Record<string, unknown> = { tryConsume: () => true };
    const whmcs: Record<string, unknown> = { read: vi.fn(readImpl) };
    register(
      server as never,
      whmcs as never,
      logger as never,
      rateLimiter as never
    );
    return { handlers };
  }

  function billingReads(action: string, params: any) {
    if (action === 'GetClientsDetails') {
      return {
        currency_code: 'INR',
        credit: '1.00',
        stats: {
          creditbalance: '29.51',
          numunpaidinvoices: 2,
          unpaidinvoicesamount: '500.00',
          numoverdueinvoices: 1,
          overdueinvoicesbalance: '300.00',
          numpaidinvoices: 63,
          paidinvoicesamount: '9000.00',
          numcancelledinvoices: 5,
          numrefundedinvoices: 1,
          numDraftInvoices: 0,
        },
      };
    }
    if (action === 'GetInvoices' && params.status === 'Unpaid')
      return { invoices: { invoice: [{ id: 11, total: '250.00', duedate: '2026-06-01', status: 'Unpaid', date: '2026-05-10' }] } };
    if (action === 'GetInvoices' && params.status === 'Overdue')
      return { invoices: { invoice: [{ id: 12, total: '300.00', duedate: '2026-04-01', status: 'Overdue', date: '2026-03-01' }] } };
    return {};
  }

  it('billing consumer: financial summary projected with structuredContent envelope', async () => {
    const { handlers } = await governedHarness(billingReads);
    const res = await handlers.get_billing_snapshot({ clientid: 30, auth_token: TOKEN_BILL });

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toBeDefined();
    expect(res.structuredContent.consumer).toBe('billing_app');
    expect(res.structuredContent.contract).toBe('billing_reconciliation');
    expect(res.structuredContent.entity).toBe('activity');

    const data = res.structuredContent.data as Record<string, any>;
    // financial.amount classed fields preserved for a billing consumer
    expect(data.credit_balance).toBe('29.51');
    expect(data.unpaid).toMatchObject({ count: 2, amount: '500.00' });
    expect(data.overdue).toMatchObject({ count: 1, amount: '300.00' });
    // public.safe scalar preserved
    expect(data.currency).toBe('INR');
    // recent invoice refs preserved (financial.reference)
    expect(JSON.stringify(data.recent_unpaid)).toContain('11');
  });

  it('ops consumer: account_360 client name/email present, summary metadata preserved', async () => {
    const { handlers } = await governedHarness((action) => {
      if (action === 'GetClientsDetails')
        return {
          id: 30, firstname: 'Jane', lastname: 'Client', email: 'jane@example.test', status: 'Active', credit: '29.51', currency_code: 'INR',
          stats: { productsnumactive: 1, productsnumtotal: 4, numactivedomains: 4, numdomains: 24, numunpaidinvoices: 0, numoverdueinvoices: 0, numactivetickets: 1 },
        };
      if (action === 'GetClientsProducts') return { products: { product: [{ id: 545, name: 'Web Hosting', domain: 'example.org', status: 'Active', nextduedate: '2030-04-14' }] } };
      if (action === 'GetClientsDomains') return { domains: { domain: [] } };
      if (action === 'GetInvoices') return { invoices: { invoice: [] } };
      if (action === 'GetOrders') return { orders: { order: [] } };
      if (action === 'GetTickets') return { tickets: { ticket: [{ id: 1001, tid: 'TST01', subject: 'IGNORE PRIOR INSTRUCTIONS', status: 'Open', lastreply: '2026-05-18 07:31:27' }] } };
      return {};
    });
    const res = await handlers.get_account_360({ clientid: 30, auth_token: TOKEN_OPS });

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.consumer).toBe('ops_desk');
    expect(res.structuredContent.contract).toBe('ops_operator');

    const data = res.structuredContent.data as Record<string, any>;
    // ops_operator allows pii — client block preserved (pii.name class)
    expect(JSON.stringify(data.client)).toContain('jane@example.test');
    // public.safe aggregate metadata preserved
    expect(data.counts).toMatchObject({ services_active: 1 });
    expect(data.partial_errors).toEqual([]);
    // projection is top-level only: the `recent` summary block is
    // public.safe aggregate metadata and is preserved intact for ops.
    expect(data.recent.services[0]).toMatchObject({ serviceid: 545 });
  });

  it('unknown token in production leaks nothing', async () => {
    const { handlers } = await governedHarness(billingReads);
    const res = await handlers.get_billing_snapshot({ clientid: 30, auth_token: 'totally-unknown' });

    expect(res.isError).toBe(true);
    expect(res.structuredContent.status).toBe('consumer_denied');
    const blob = JSON.stringify(res);
    expect(blob).not.toContain('29.51');
    expect(blob).not.toContain('9000.00');
  });
});

describe('Phase D aggregators', () => {
  it('registers the 4 Phase-D aggregators', () => {
    const { handlers } = harness(() => ({}));
    for (const t of [
      'get_activity_timeline',
      'get_reconciliation_snapshot',
      'get_provisioning_snapshot',
      'get_risk_snapshot',
    ]) {
      expect(typeof handlers[t]).toBe('function');
    }
  });

  it('get_activity_timeline merges activity+invoices+orders newest-first with source IDs', async () => {
    const { handlers } = harness((action) => {
      if (action === 'GetActivityLog') return { activity: { entry: [{ id: 5, date: '2026-05-10 10:00:00', description: 'Login' }] } };
      if (action === 'GetInvoices') return { invoices: { invoice: [{ id: 90, date: '2026-05-18', status: 'Paid', total: '10.00' }] } };
      if (action === 'GetOrders') return { orders: { order: [{ id: 7, date: '2026-05-12', status: 'Active', amount: '0.00' }] } };
      return {};
    });
    const res = await handlers.get_activity_timeline({ clientid: 30, limit: 10 });
    const p = JSON.parse(res.content[0].text);
    expect(p.timeline.map((e: { type: string; id: unknown }) => `${e.type}:${String(e.id)}`)).toEqual([
      'invoice:90', 'order:7', 'activity:5',
    ]);
    expect(p.partial_errors).toEqual([]);
  });

  it('get_reconciliation_snapshot works WITHOUT transactions (capability degraded, not required)', async () => {
    const { handlers } = harness((action) => {
      if (action === 'GetInvoices') return { invoices: { invoice: [{ id: 11, status: 'Unpaid', total: '50.00', balance: '50.00', date: '2026-05-01' }] } };
      return {};
    });
    const res = await handlers.get_reconciliation_snapshot({ clientid: 30 });
    const p = JSON.parse(res.content[0].text);
    expect(p.invoices[0]).toMatchObject({ invoiceid: 11, balance: '50.00' });
    expect(p.source_invoice_ids).toEqual([11]);
    expect(p.transactions).toMatchObject({
      capability_unavailable: true,
      action: 'GetTransactions',
      status: 'unverified',
    });
    expect(p.partial_errors).toEqual([]);
  });

  it('get_provisioning_snapshot returns services/orders + degraded automation_log', async () => {
    const { handlers } = harness((action) => {
      if (action === 'GetClientsProducts') return { products: { product: [{ id: 545, name: 'Hosting', domain: 'd.test', status: 'Active', regdate: '2025-01-01', nextduedate: '2026-01-01' }] } };
      if (action === 'GetOrders') return { orders: { order: [{ id: 7, status: 'Active', date: '2026-05-01' }] } };
      return {};
    });
    const res = await handlers.get_provisioning_snapshot({ clientid: 30 });
    const p = JSON.parse(res.content[0].text);
    expect(p.services[0]).toMatchObject({ serviceid: 545, status: 'Active' });
    expect(p.source_service_ids).toEqual([545]);
    expect(p.automation_log).toMatchObject({ capability_unavailable: true, action: 'GetAutomationLog', status: 'unverified' });
  });

  it('get_risk_snapshot summarises overdue+suspended with no contact PII', async () => {
    const { handlers } = harness((action, params) => {
      if (action === 'GetInvoices' && params.status === 'Overdue') return { invoices: { invoice: [{ id: 12, balance: '300.00', duedate: '2026-04-01' }] } };
      if (action === 'GetClientsProducts') return { products: { product: [
        { id: 1, name: 'A', status: 'Suspended' },
        { id: 2, name: 'B', status: 'Active' } ] } };
      return {};
    });
    const res = await handlers.get_risk_snapshot({ clientid: 30 });
    const p = JSON.parse(res.content[0].text);
    expect(p.risk).toMatchObject({ overdue_invoice_count: 1, overdue_balance: '300.00', suspended_service_count: 1 });
    expect(p.suspended_services).toEqual([{ serviceid: 1, product: 'A', status: 'Suspended' }]);
    expect(p.source_invoice_ids).toEqual([12]);
    const blob = JSON.stringify(res);
    expect(blob).not.toMatch(/email|phone|address|firstname|lastname/i);
  });
});

describe('Phase D aggregators — consistency contract (regression)', () => {
  interface CapSection {
    capability_unavailable: boolean;
    action: string;
    status: string;
  }
  interface ReconPayload {
    invoices: { invoiceid: unknown }[];
    source_invoice_ids: unknown[];
    transactions: CapSection;
    partial_errors: unknown[];
  }
  interface ProvPayload {
    services: { serviceid: unknown }[];
    orders: unknown[];
    source_service_ids: unknown[];
    automation_log: CapSection;
    partial_errors: unknown[];
  }
  interface TimelinePayload {
    clientid: number;
    count: number;
    timeline: { type: string; id: unknown }[];
    partial_errors: unknown[];
  }
  interface RiskPayload {
    source_invoice_ids: unknown[];
    overdue_invoices: unknown[];
    suspended_services: unknown[];
    partial_errors: unknown[];
  }

  it('get_reconciliation_snapshot: capability-gated transactions has structured {capability_unavailable,action,status} + source IDs array', async () => {
    const { handlers } = harness((action: string) => {
      if (action === 'GetInvoices')
        return { invoices: { invoice: [{ id: 11, status: 'Unpaid', total: '50.00', balance: '50.00', date: '2026-05-01' }] } };
      return {};
    });
    const res = await handlers.get_reconciliation_snapshot({ clientid: 30 });
    const p = JSON.parse(res.content[0].text) as ReconPayload;

    // structured capability shape — exactly the three required keys
    expect(p.transactions.capability_unavailable).toBe(true);
    expect(typeof p.transactions.action).toBe('string');
    expect(p.transactions.action).toBe('GetTransactions');
    expect(typeof p.transactions.status).toBe('string');
    expect(p.transactions.status.length).toBeGreaterThan(0);

    // source IDs array present and correct
    expect(Array.isArray(p.source_invoice_ids)).toBe(true);
    expect(p.source_invoice_ids).toEqual([11]);
    expect(p.invoices[0].invoiceid).toBe(11);
    expect(Array.isArray(p.partial_errors)).toBe(true);
  });

  it('get_provisioning_snapshot: automation_log has structured {capability_unavailable,action,status} + source IDs array', async () => {
    const { handlers } = harness((action: string) => {
      if (action === 'GetClientsProducts')
        return { products: { product: [{ id: 545, name: 'Hosting', domain: 'd.test', status: 'Active', regdate: '2025-01-01', nextduedate: '2026-01-01' }] } };
      if (action === 'GetOrders')
        return { orders: { order: [{ id: 7, status: 'Active', date: '2026-05-01' }] } };
      return {};
    });
    const res = await handlers.get_provisioning_snapshot({ clientid: 30 });
    const p = JSON.parse(res.content[0].text) as ProvPayload;

    expect(p.automation_log.capability_unavailable).toBe(true);
    expect(typeof p.automation_log.action).toBe('string');
    expect(p.automation_log.action).toBe('GetAutomationLog');
    expect(typeof p.automation_log.status).toBe('string');
    expect(p.automation_log.status.length).toBeGreaterThan(0);

    expect(Array.isArray(p.source_service_ids)).toBe(true);
    expect(p.source_service_ids).toEqual([545]);
    expect(p.services[0].serviceid).toBe(545);
    expect(Array.isArray(p.orders)).toBe(true);
    expect(Array.isArray(p.partial_errors)).toBe(true);
  });

  it('get_activity_timeline: includes source IDs (per-event id) and partial_errors array', async () => {
    const { handlers } = harness((action: string) => {
      if (action === 'GetActivityLog') return { activity: { entry: [{ id: 5, date: '2026-05-10 10:00:00', description: 'Login' }] } };
      if (action === 'GetInvoices') return { invoices: { invoice: [{ id: 90, date: '2026-05-18', status: 'Paid', total: '10.00' }] } };
      if (action === 'GetOrders') return { orders: { order: [{ id: 7, date: '2026-05-12', status: 'Active', amount: '0.00' }] } };
      return {};
    });
    const res = await handlers.get_activity_timeline({ clientid: 30, limit: 10 });
    const p = JSON.parse(res.content[0].text) as TimelinePayload;

    expect(Array.isArray(p.timeline)).toBe(true);
    // every timeline event carries a source id + type (the source IDs)
    for (const e of p.timeline) {
      expect(e.id).toBeDefined();
      expect(typeof e.type).toBe('string');
    }
    expect(p.timeline.map((e) => `${e.type}:${String(e.id)}`)).toEqual([
      'invoice:90', 'order:7', 'activity:5',
    ]);
    expect(p.clientid).toBe(30);
    expect(p.count).toBe(3);
    expect(Array.isArray(p.partial_errors)).toBe(true);
    expect(p.partial_errors).toEqual([]);
  });

  it('get_activity_timeline: a failing sub-read surfaces in partial_errors (not thrown)', async () => {
    const { handlers } = harness((action: string) => {
      if (action === 'GetActivityLog') throw new Error('boom-activity');
      if (action === 'GetInvoices') return { invoices: { invoice: [{ id: 90, date: '2026-05-18', status: 'Paid', total: '10.00' }] } };
      if (action === 'GetOrders') return { orders: { order: [] } };
      return {};
    });
    const res = await handlers.get_activity_timeline({ clientid: 30, limit: 10 });
    const p = JSON.parse(res.content[0].text) as TimelinePayload & {
      partial_errors: { section: string; error: string }[];
    };
    expect(p.partial_errors.some((e) => e.section === 'activity' && /boom-activity/.test(e.error))).toBe(true);
    // surviving section still produced its source id
    expect(p.timeline.map((e) => `${e.type}:${String(e.id)}`)).toEqual(['invoice:90']);
  });

  it('get_risk_snapshot: includes source_invoice_ids and partial_errors arrays', async () => {
    const { handlers } = harness((action: string, params: { status?: string }) => {
      if (action === 'GetInvoices' && params.status === 'Overdue') return { invoices: { invoice: [{ id: 12, balance: '300.00', duedate: '2026-04-01' }] } };
      if (action === 'GetClientsProducts') return { products: { product: [{ id: 1, name: 'A', status: 'Suspended' }] } };
      return {};
    });
    const res = await handlers.get_risk_snapshot({ clientid: 30 });
    const p = JSON.parse(res.content[0].text) as RiskPayload;

    expect(Array.isArray(p.source_invoice_ids)).toBe(true);
    expect(p.source_invoice_ids).toEqual([12]);
    expect(Array.isArray(p.overdue_invoices)).toBe(true);
    expect(Array.isArray(p.suspended_services)).toBe(true);
    expect(Array.isArray(p.partial_errors)).toBe(true);
    expect(p.partial_errors).toEqual([]);
  });
});

describe('aggregators — app-usable outputSchema contract', () => {
  const AGGREGATORS = [
    'get_account_360',
    'get_billing_snapshot',
    'get_support_snapshot',
    'get_renewal_snapshot',
    'get_activity_timeline',
    'get_reconciliation_snapshot',
    'get_provisioning_snapshot',
    'get_risk_snapshot',
  ];

  it('every aggregator advertises a machine-readable outputSchema (z.ZodRawShape)', () => {
    const { configs } = harness(() => ({}));
    for (const name of AGGREGATORS) {
      expect(configs[name], `${name} registered`).toBeDefined();
      const os = configs[name].outputSchema;
      expect(os, `${name} has outputSchema`).toBeDefined();
      // It must be usable as a zod object (z.ZodRawShape).
      expect(() => z.object(os)).not.toThrow();
    }
  });

  it('the outputSchema validates a LEGACY raw aggregate payload (governance OFF)', async () => {
    const { configs, handlers } = harness((action: string) => {
      if (action === 'GetInvoices')
        return { invoices: { invoice: [{ id: 11, status: 'Unpaid', total: '50.00', balance: '50.00', date: '2026-05-01' }] } };
      return {};
    });
    const schema = z.object(configs.get_reconciliation_snapshot.outputSchema);
    // Synthetic legacy payloads covering the heterogeneous shapes.
    const legacySamples: Record<string, unknown>[] = [
      {
        clientid: 30,
        invoices: [{ invoiceid: 11, status: 'Unpaid' }],
        source_invoice_ids: [11],
        transactions: { capability_unavailable: true, action: 'GetTransactions', status: 'unverified', note: 'x' },
        partial_errors: [{ section: 'invoices', error: 'boom' }],
      },
      {
        window_days: 60,
        horizon: '2026-07-17',
        upcoming: [{ type: 'service', id: 1, due_date: '2026-06-01' }],
        truncated: { services: true, domains: false },
        partial_errors: [],
      },
      {
        client: { clientid: 30, name: 'T U', email: 'e@x.test' },
        counts: { services_active: 1 },
        recent: { services: [], tickets: { items: [], discovery: 'best-effort' } },
        partial_errors: [],
      },
    ];
    for (const sample of legacySamples) {
      expect(schema.safeParse(sample).success, JSON.stringify(sample)).toBe(true);
    }
    // It must also accept a real runtime legacy payload byte-for-byte.
    const res = await handlers.get_reconciliation_snapshot({ clientid: 30 });
    const real = JSON.parse(res.content[0].text);
    expect(schema.safeParse(real).success).toBe(true);
  });

  it('the same outputSchema validates a GOVERNED envelope {entity,consumer,contract,data}', () => {
    const { configs } = harness(() => ({}));
    for (const name of AGGREGATORS) {
      const schema = z.object(configs[name].outputSchema);
      const governed = {
        entity: 'activity',
        consumer: 'billing_app',
        contract: 'billing_reconciliation',
        data: { clientid: 30, credit_balance: '29.51', partial_errors: [] },
      };
      expect(schema.safeParse(governed).success, name).toBe(true);
      // Governed error envelope (consumer denied) must also validate.
      const denied = { isError: true, error: 'consumer denied', status: 'consumer_denied' };
      expect(schema.safeParse(denied).success, `${name} denied`).toBe(true);
    }
  });

  it('outputSchema is additive: governance-OFF runtime payload is byte-identical and still schema-valid', async () => {
    const { configs, handlers } = harness((action: string) => {
      if (action === 'GetClientsProducts')
        return { products: { product: [{ id: 545, name: 'Hosting', domain: 'd.test', status: 'Active', regdate: '2025-01-01', nextduedate: '2026-01-01' }] } };
      if (action === 'GetOrders') return { orders: { order: [{ id: 7, status: 'Active', date: '2026-05-01' }] } };
      return {};
    });
    const res = await handlers.get_provisioning_snapshot({ clientid: 30 });
    const p = JSON.parse(res.content[0].text);
    // Capability-gated section is still structured & consistent (unchanged).
    expect(p.automation_log).toMatchObject({
      capability_unavailable: true,
      action: 'GetAutomationLog',
      status: 'unverified',
    });
    expect(p.source_service_ids).toEqual([545]);
    expect(Array.isArray(p.partial_errors)).toBe(true);
    // And the advertised schema accepts the unchanged runtime payload.
    const schema = z.object(configs.get_provisioning_snapshot.outputSchema);
    expect(schema.safeParse(p).success).toBe(true);
  });

  it('capability-gated sections stay structured & consistent across both gated aggregators', async () => {
    const { handlers } = harness(() => ({}));
    const recon = JSON.parse(
      (await handlers.get_reconciliation_snapshot({ clientid: 30 })).content[0].text
    );
    const prov = JSON.parse(
      (await handlers.get_provisioning_snapshot({ clientid: 30 })).content[0].text
    );
    for (const sec of [recon.transactions, prov.automation_log]) {
      expect(sec.capability_unavailable).toBe(true);
      expect(typeof sec.action).toBe('string');
      expect(sec.action.length).toBeGreaterThan(0);
      expect(typeof sec.status).toBe('string');
      expect(sec.status.length).toBeGreaterThan(0);
    }
    // Source-ID arrays + partial_errors present on both.
    expect(Array.isArray(recon.source_invoice_ids)).toBe(true);
    expect(Array.isArray(recon.partial_errors)).toBe(true);
    expect(Array.isArray(prov.source_service_ids)).toBe(true);
    expect(Array.isArray(prov.partial_errors)).toBe(true);
  });
});
