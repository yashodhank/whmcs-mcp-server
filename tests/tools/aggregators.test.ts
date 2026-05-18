import { describe, it, expect, vi } from 'vitest';
vi.mock('../../src/config.js', () => ({ config: { MCP_MAX_PAGE_SIZE: 100 }, isToolAllowed: () => true }));
vi.mock('../../src/security.js', () => ({ AUTH_SHAPE: {}, ensureToolAuth: () => null, isClientMode: () => false, ensureClientAllowed: () => null }));
import { registerAggregatorTools } from '../../src/tools/aggregators.js';

function harness(readImpl: (action: string, params: any) => any) {
  const handlers: Record<string, any> = {};
  const server = { registerTool: (n: string, _c: unknown, cb: any) => { handlers[n] = cb; } };
  const childLogger: any = { logToolCall: vi.fn(), logToolResult: vi.fn(), info: vi.fn(), error: vi.fn(), child: () => childLogger };
  const logger: any = { child: () => childLogger };
  const rateLimiter: any = { tryConsume: () => true };
  const whmcs: any = { read: vi.fn(readImpl) };
  registerAggregatorTools(server as any, whmcs, logger, rateLimiter);
  return { handlers, whmcs };
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
});
