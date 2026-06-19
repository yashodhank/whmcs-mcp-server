/**
 * Regression for C3: client-log resource (whmcs://clients/{clientid}/log).
 * Two problems pinned here:
 *  1. The "recent" timeline must be NEWEST-FIRST. GetOrders/GetTickets do not
 *     reliably honor server-side ordering, so the resource must sort
 *     client-side by date DESC. GetInvoices does honor orderby/order, so the
 *     resource must request orderby:'date', order:'desc'.
 *  2. The tickets section must be honestly labelled best-effort: the array key
 *     is `tickets_best_effort` (not `recent_tickets`) and a `tickets_note`
 *     string explains GetTickets clientid filter may miss operator/admin
 *     tickets.
 */
import { describe, it, expect, vi } from 'vitest';

const cfg = vi.hoisted(() => ({
  config: {
    MCP_AUTH_TOKEN: '',
    MCP_ACCESS_MODE: 'admin' as 'admin' | 'client',
    MCP_ALLOWED_CLIENT_IDS: [] as number[],
    MCP_MODE: 'read_only',
  },
}));
vi.mock('../src/config.js', () => cfg);

import { registerResources } from '../src/resources/index.js';

function makeServer() {
  const handlers: Record<string, (uri: URL, params?: any) => Promise<any>> = {};
  const server = {
    resource: (n: string, _t: unknown, cb: any) => {
      handlers[n] = cb;
    },
  };
  return { server, handlers };
}
const childLogger: any = {
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => childLogger,
};
const logger: any = { child: () => childLogger, info: vi.fn(), debug: vi.fn() };
const rateLimiter: any = { tryConsume: () => true };

describe('client-log resource (C3)', () => {
  it('orders newest-first, invoices server-ordered, tickets best-effort labelled', async () => {
    const { server, handlers } = makeServer();
    const calls: { action: string; params: any }[] = [];
    const whmcsClient: any = {
      read: vi.fn(async (action: string, params: any) => {
        calls.push({ action, params });
        if (action === 'GetOrders') {
          return {
            orders: {
              order: [
                { id: 1, date: '2020-01-01 00:00:00', status: 'Active', amount: '1.00' },
                { id: 2, date: '2025-08-25 00:00:00', status: 'Cancelled', amount: '9.00' },
              ],
            },
          };
        }
        if (action === 'GetInvoices') {
          return {
            invoices: {
              invoice: [
                { id: 10, date: '2026-03-19', duedate: 'd', status: 'Paid', total: '100.00' },
              ],
            },
          };
        }
        if (action === 'GetTickets') {
          return {
            tickets: {
              ticket: [
                { id: 1001, date: '2026-01-01 00:00:00', subject: 's', status: 'Open' },
                { id: 1002, date: '2026-05-01 00:00:00', subject: 's2', status: 'Answered' },
              ],
            },
          };
        }
        return {};
      }),
    };
    registerResources(server as any, whmcsClient, logger, rateLimiter);

    const res = await handlers['client-log'](new URL('whmcs://clients/901/log'), {
      clientid: '901',
    });

    // --- assert read call params ---
    const getInvoices = calls.find((c) => c.action === 'GetInvoices');
    const getOrders = calls.find((c) => c.action === 'GetOrders');
    const getTickets = calls.find((c) => c.action === 'GetTickets');

    expect(getInvoices).toBeDefined();
    expect(getInvoices!.params).toMatchObject({
      userid: 901,
      orderby: 'date',
      order: 'desc',
      limitnum: 10,
    });

    expect(getOrders).toBeDefined();
    expect(getOrders!.params).toMatchObject({ userid: 901, limitnum: 25 });

    expect(getTickets).toBeDefined();
    expect(getTickets!.params).toMatchObject({ clientid: 901, limitnum: 25 });

    // --- assert payload ---
    const payload = JSON.parse(res.contents[0].text);
    expect(payload.error).toBeUndefined();

    // recent_orders newest-first: 2025 (id 2) before 2020 (id 1)
    expect(payload.recent_orders).toHaveLength(2);
    expect(payload.recent_orders[0].id).toBe(2);
    expect(payload.recent_orders[1].id).toBe(1);

    // recent_invoices present
    expect(payload.recent_invoices).toHaveLength(1);
    expect(payload.recent_invoices[0].id).toBe(10);

    // tickets key renamed + newest-first + best-effort note
    expect(payload.recent_tickets).toBeUndefined();
    expect(payload.tickets_best_effort).toHaveLength(2);
    expect(payload.tickets_best_effort[0].id).toBe(1002);
    expect(payload.tickets_best_effort[1].id).toBe(1001);
    expect(typeof payload.tickets_note).toBe('string');
    expect(payload.tickets_note).toContain('best-effort');
    expect(payload.tickets_note).toContain('may miss operator');
  });
});
