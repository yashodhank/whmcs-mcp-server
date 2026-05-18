import { describe, it, expect, vi } from 'vitest';
vi.mock('../../src/config.js', () => ({ config: { MCP_MAX_PAGE_SIZE: 100 }, isToolAllowed: () => true }));
vi.mock('../../src/security.js', () => ({ AUTH_SHAPE: {}, ensureToolAuth: () => null, isClientMode: () => false, ensureClientAllowed: () => null }));
import { registerListTools } from '../../src/tools/listTools.js';

function harness() {
  const handlers: Record<string, any> = {};
  const configs: Record<string, any> = {};
  const server = { registerTool: (n: string, cfg: unknown, cb: any) => { configs[n] = cfg; handlers[n] = cb; } };
  const childLogger: any = { logToolCall: vi.fn(), logToolResult: vi.fn(), info: vi.fn(), error: vi.fn(), child: () => childLogger };
  const logger: any = { child: () => childLogger };
  const rateLimiter: any = { tryConsume: () => true };
  const read = vi.fn();
  const whmcs: any = { read };
  return { server, handlers, configs, logger, rateLimiter, read, whmcs };
}

describe('registerListTools', () => {
  it('registers exactly the 6 expected list tools', () => {
    const { server, handlers, logger, rateLimiter, whmcs } = harness();
    registerListTools(server as any, whmcs, logger, rateLimiter);
    expect(Object.keys(handlers).sort()).toEqual(
      ['get_activity_log', 'list_client_domains', 'list_client_invoices', 'list_client_orders', 'list_client_services', 'list_client_tickets'].sort()
    );
    expect(Object.keys(handlers)).toHaveLength(6);
  });

  it('get_activity_log maps WHMCS GetActivityLog entries (newest first)', async () => {
    const { server, handlers, logger, rateLimiter, read, whmcs } = harness();
    read.mockResolvedValue({
      totalresults: 2, numreturned: 2, startnumber: 0,
      activity: { entry: [
        { id: 10, date: '2026-05-17 08:00:00', user: 'admin', description: 'Older', ipaddr: '203.0.113.1' },
        { id: 11, date: '2026-05-18 09:00:00', user: 'admin', description: 'Newer', ipaddr: '203.0.113.2' },
      ] },
    });
    registerListTools(server as any, whmcs, logger, rateLimiter);
    const res = await handlers.get_activity_log({ clientid: 9001, limit: 10, offset: 0 });
    expect(read).toHaveBeenCalledWith('GetActivityLog', { clientid: 9001, limitnum: 10, limitstart: 0 });
    const p = JSON.parse(res.content[0].text);
    expect(p.items.map((e: { id: number }) => e.id)).toEqual([11, 10]);
    expect(p.items[0]).toEqual({ id: 11, date: '2026-05-18 09:00:00', user: 'admin', description: 'Newer', ipaddr: '203.0.113.2' });
  });

  it('list_client_services maps WHMCS GetClientsProducts rows', async () => {
    const { server, handlers, logger, rateLimiter, read, whmcs } = harness();
    read.mockResolvedValue({
      totalresults: 3, numreturned: 2, startnumber: 0,
      products: { product: [{ id: 545, pid: 413, name: 'Web Hosting', domain: 'example.org', status: 'Active', billingcycle: 'Triennially', nextduedate: '2030-04-14', recurringamount: '3.00', paymentmethod: 'card' }] },
    });
    registerListTools(server as any, whmcs, logger, rateLimiter);
    const res = await handlers['list_client_services']({ clientid: 9001, limit: 2, offset: 0 });
    expect(read).toHaveBeenCalledWith('GetClientsProducts', { clientid: 9001, limitnum: 2, limitstart: 0 });
    const p = JSON.parse(res.content[0].text);
    expect(p.items[0]).toEqual({ serviceid: 545, pid: 413, product: 'Web Hosting', domain: 'example.org', status: 'Active', billing_cycle: 'Triennially', next_due_date: '2030-04-14', recurring_amount: '3.00', payment_method: 'card' });
  });

  it('list_client_domains maps WHMCS GetClientsDomains rows', async () => {
    const { server, handlers, logger, rateLimiter, read, whmcs } = harness();
    read.mockResolvedValue({
      totalresults: 1, numreturned: 1, startnumber: 0,
      domains: { domain: [{ id: 615, domainname: 'example.net', registrar: 'r', status: 'Active', regdate: '2025-05-30', expirydate: '2026-07-09', nextduedate: '2026-07-09', donotrenew: '0' }] },
    });
    registerListTools(server as any, whmcs, logger, rateLimiter);
    const res = await handlers['list_client_domains']({ clientid: 9001 });
    expect(read).toHaveBeenCalledWith('GetClientsDomains', { clientid: 9001, limitnum: 10, limitstart: 0 });
    const p = JSON.parse(res.content[0].text);
    expect(p.items[0]).toEqual({ domainid: 615, domain: 'example.net', registrar: 'r', status: 'Active', regdate: '2025-05-30', expiry_date: '2026-07-09', next_due_date: '2026-07-09', donotrenew: '0' });
  });

  it('list_client_invoices maps WHMCS GetInvoices rows with userid + fixed ordering + status', async () => {
    const { server, handlers, logger, rateLimiter, read, whmcs } = harness();
    read.mockResolvedValue({
      totalresults: 62, numreturned: 1, startnumber: 0,
      invoices: { invoice: [{ id: 30001, invoicenum: 'X1', date: '2026-03-19', duedate: '2026-04-03', datepaid: '2026-03-19', status: 'Paid', total: '100.00', balance: '0.00' }] },
    });
    registerListTools(server as any, whmcs, logger, rateLimiter);
    const res = await handlers['list_client_invoices']({ clientid: 9001, status: 'Paid' });
    expect(read).toHaveBeenCalledWith('GetInvoices', { userid: 9001, limitnum: 10, limitstart: 0, orderby: 'date', order: 'desc', status: 'Paid' });
    const p = JSON.parse(res.content[0].text);
    expect(p.items[0]).toEqual({ invoiceid: 30001, invoicenum: 'X1', date: '2026-03-19', duedate: '2026-04-03', datepaid: '2026-03-19', status: 'Paid', total: '100.00', balance: '0.00' });
  });

  it('list_client_tickets maps GetTickets rows, sorts by lastreply DESC, and carries discovery caveat', async () => {
    const { server, handlers, logger, rateLimiter, read, whmcs } = harness();
    read.mockResolvedValue({
      totalresults: 2, numreturned: 2, startnumber: 0,
      tickets: { ticket: [
        { id: 1001, tid: 'TST01', subject: 's', status: 'Answered', deptname: 'Help Desk', date: '2026-05-18 07:21:49', lastreply: '2026-05-18 07:31:27' },
        { id: 2, tid: 'T2', subject: 'y', status: 'Open', deptname: 'Billing', date: '2026-01-01 00:00:00', lastreply: '2026-02-01 00:00:00' },
      ] },
    });
    registerListTools(server as any, whmcs, logger, rateLimiter);
    const res = await handlers['list_client_tickets']({ clientid: 9001 });
    expect(read).toHaveBeenCalledWith('GetTickets', { clientid: 9001, limitnum: 10, limitstart: 0 });
    const p = JSON.parse(res.content[0].text);
    expect(p.items[0].ticketid).toBe(1001);
    expect(Object.keys(p.items[0]).sort()).toEqual(['date', 'deptname', 'lastreply', 'status', 'subject', 'ticketid', 'tid'].sort());
    expect(p.discovery).toBe('best-effort');
    expect(typeof p.note).toBe('string');
    expect(p.note).toContain('may miss operator');
    expect(p.note).toContain('get_ticket_thread');
  });

  it('registers a stable outputSchema describing legacy + governed envelopes', () => {
    const { server, configs, logger, rateLimiter, whmcs } = harness();
    registerListTools(server as any, whmcs, logger, rateLimiter);
    const cfg = configs.list_client_services;
    expect(cfg.outputSchema).toBeDefined();
    // Passthrough ZodObject (so strict MCP runtimes accept the
    // client-side status-filter envelope metadata) — inspect its .shape.
    const shape = (cfg.outputSchema as { shape: Record<string, unknown> })
      .shape;
    for (const k of ['items', 'total', 'count', 'offset', 'limit', 'consumer', 'contract']) {
      expect(shape[k]).toBeDefined();
      expect((shape[k] as { _def?: unknown })._def).toBeDefined();
    }
    // Single shared schema instance reused across every factory tool.
    expect(configs.get_activity_log.outputSchema).toBe(cfg.outputSchema);
  });

  it('list_client_orders maps GetOrders rows with userid and sorts by date DESC', async () => {
    const { server, handlers, logger, rateLimiter, read, whmcs } = harness();
    read.mockResolvedValue({
      totalresults: 49, numreturned: 2, startnumber: 0,
      orders: { order: [
        { id: 5, ordernum: 'O5', date: '2020-01-01', amount: '1.00', status: 'Active', invoiceid: 1, name: 'a' },
        { id: 967, ordernum: 'O967', date: '2025-08-25', amount: '699.00', status: 'Cancelled', invoiceid: 30002, name: 'b' },
      ] },
    });
    registerListTools(server as any, whmcs, logger, rateLimiter);
    const res = await handlers['list_client_orders']({ clientid: 9001 });
    expect(read).toHaveBeenCalledWith('GetOrders', { userid: 9001, limitnum: 10, limitstart: 0 });
    const p = JSON.parse(res.content[0].text);
    expect(p.items[0].orderid).toBe(967);
    expect(Object.keys(p.items[0]).sort()).toEqual(['amount', 'date', 'invoiceid', 'name', 'orderid', 'ordernum', 'status'].sort());
  });
});
