/**
 * Phase B governance wiring for read-only MCP resources.
 *
 * Resources carry NO auth_token (stdio resources are not token-authed). The
 * three mappable resources (client-summary, invoice-history, ticket-thread)
 * route their payload through the proven governance projection boundary.
 *
 * Contract pinned here:
 *  - governance OFF (default) ⇒ legacy payload is unchanged (JSON.parse
 *    identical to the pre-governance shape); existing resource tests stay green.
 *  - governance ON + production + NO consumer registry ⇒ the resolved consumer
 *    is the anon/deny path (authToken undefined): a STRUCTURED
 *    `consumer_denied` is returned with NO PII (no email/name) leaked, instead
 *    of raw client/invoice/ticket data.
 *  - client-log / system-activity have no single-entity canonical mapper and
 *    remain legacy even when governance is ON.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const cfg = vi.hoisted(() => ({
  config: {
    MCP_AUTH_TOKEN: '',
    MCP_ACCESS_MODE: 'admin' as 'admin' | 'client',
    MCP_ALLOWED_CLIENT_IDS: [] as number[],
    MCP_MODE: 'read_only',
    MCP_ENV: 'production' as 'local' | 'staging' | 'production',
    MCP_GOVERNANCE_ENABLED: false,
    MCP_ALLOW_ANON_LLM: false,
  },
}));
vi.mock('../src/config.js', () => cfg);

import { registerResources } from '../src/resources/index.js';
import { __resetRegistryCacheForTests } from '../src/governance/pipeline.js';

function makeServer() {
  const handlers: Record<string, (uri: URL, params?: any) => Promise<any>> = {};
  const server = { resource: (n: string, _t: unknown, cb: any) => { handlers[n] = cb; } };
  return { server, handlers };
}
// eslint-disable-next-line @typescript-eslint/no-unsafe-return -- self-referential test logger stub (mirrors existing resources test harness convention)
const childLogger: any = { info: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => childLogger };
// eslint-disable-next-line @typescript-eslint/no-unsafe-return -- self-referential test logger stub (mirrors existing resources test harness convention)
const logger: any = { child: () => childLogger, info: vi.fn(), debug: vi.fn() };
const rateLimiter: any = { tryConsume: () => true };

const CLIENT_RAW = {
  id: 7,
  firstname: 'Grace',
  lastname: 'Hopper',
  email: 'grace@example.test',
  status: 'Active',
  credit: '12.50',
  currency_code: 'USD',
  stats: { productsnumactive: 2, productsnumtotal: 3, numactivedomains: 1, numdomains: 1 },
};
const INVOICE_RAW = {
  invoiceid: 555,
  userid: 7,
  date: '2026-01-02',
  duedate: '2026-01-09',
  datepaid: '',
  status: 'Unpaid',
  total: '99.00',
  balance: '99.00',
  items: { item: [{ id: 1, description: 'Hosting', amount: '99.00' }] },
  transactions: { transaction: [] },
};
const TICKET_RAW = {
  ticketid: 1001,
  tid: 'GOV01',
  deptname: 'Help Desk',
  subject: 'secret subject',
  status: 'Open',
  date: '2026-05-18 07:21:49',
  userid: 7,
  replies: { reply: [{ replyid: '0', name: 'Grace Hopper', date: '2026-05-18 07:21:49', message: 'Body', admin: '' }] },
  notes: [],
};

beforeEach(() => {
  cfg.config.MCP_GOVERNANCE_ENABLED = false;
  cfg.config.MCP_ENV = 'production';
  cfg.config.MCP_ALLOW_ANON_LLM = false;
  delete process.env.MCP_CONSUMER_REGISTRY;
  __resetRegistryCacheForTests();
});

describe('resources governance wiring — backward compat (governance OFF)', () => {
  it('client-summary returns the unchanged legacy payload', async () => {
    const { server, handlers } = makeServer();
    const whmcsClient: any = { read: vi.fn().mockResolvedValue(CLIENT_RAW) };
    registerResources(server as any, whmcsClient, logger, rateLimiter);

    const res = await handlers['client-summary'](new URL('whmcs://clients/7/summary'), { clientid: '7' });
    const payload = JSON.parse(res.contents[0].text);

    expect(payload).toEqual({
      clientid: 7,
      name: 'Grace Hopper',
      email: 'grace@example.test',
      status: 'Active',
      credit_balance: '12.50',
      currency: 'USD',
      product_count: 2,
      product_count_total: 3,
      domain_count: 1,
      domain_count_total: 1,
    });
    expect(res.contents[0].mimeType).toBe('application/json');
  });

  it('invoice-history and ticket-thread return unchanged legacy payloads', async () => {
    const { server, handlers } = makeServer();
    const whmcsClient: any = {
      read: vi.fn(async (action: string) =>
        action === 'GetInvoice' ? INVOICE_RAW : TICKET_RAW
      ),
    };
    registerResources(server as any, whmcsClient, logger, rateLimiter);

    const inv = JSON.parse(
      (await handlers['invoice-history'](new URL('whmcs://invoices/555/history'), { invoiceid: '555' })).contents[0].text
    );
    expect(inv).toMatchObject({ invoiceid: 555, clientid: 7, status: 'Unpaid', total: '99.00' });

    const tkt = JSON.parse(
      (await handlers['ticket-thread'](new URL('whmcs://tickets/1001/thread'), { ticketid: '1001' })).contents[0].text
    );
    expect(tkt.ticket_number).toBe('GOV01');
    expect(tkt.initial_message).toBe('Body');
  });
});

describe('resources governance wiring — governance ON, production, no registry', () => {
  it('client-summary returns structured consumer_denied with NO PII leaked', async () => {
    cfg.config.MCP_GOVERNANCE_ENABLED = true;
    const { server, handlers } = makeServer();
    const whmcsClient: any = { read: vi.fn().mockResolvedValue(CLIENT_RAW) };
    registerResources(server as any, whmcsClient, logger, rateLimiter);

    const res = await handlers['client-summary'](new URL('whmcs://clients/7/summary'), { clientid: '7' });
    const text = res.contents[0].text;
    const payload = JSON.parse(text);

    expect(payload.isError).toBe(true);
    expect(payload.status).toBe('consumer_denied');
    // No PII / raw data leaked.
    expect(text).not.toContain('grace@example.test');
    expect(text).not.toContain('Grace');
    expect(payload).not.toHaveProperty('email');
  });

  it('invoice-history + ticket-thread also return consumer_denied (no raw data)', async () => {
    cfg.config.MCP_GOVERNANCE_ENABLED = true;
    const { server, handlers } = makeServer();
    const whmcsClient: any = {
      read: vi.fn(async (action: string) =>
        action === 'GetInvoice' ? INVOICE_RAW : TICKET_RAW
      ),
    };
    registerResources(server as any, whmcsClient, logger, rateLimiter);

    const invText = (await handlers['invoice-history'](new URL('whmcs://invoices/555/history'), { invoiceid: '555' })).contents[0].text;
    expect(JSON.parse(invText)).toMatchObject({ isError: true, status: 'consumer_denied' });

    const tktText = (await handlers['ticket-thread'](new URL('whmcs://tickets/1001/thread'), { ticketid: '1001' })).contents[0].text;
    expect(JSON.parse(tktText)).toMatchObject({ isError: true, status: 'consumer_denied' });
    expect(tktText).not.toContain('secret subject');
  });

  it('client-log stays legacy even when governance is ON (no single-entity mapper)', async () => {
    cfg.config.MCP_GOVERNANCE_ENABLED = true;
    const { server, handlers } = makeServer();
    const whmcsClient: any = {
      read: vi.fn(async (action: string) => {
        if (action === 'GetOrders') return { orders: { order: [] } };
        if (action === 'GetInvoices') return { invoices: { invoice: [] } };
        if (action === 'GetTickets') return { tickets: { ticket: [] } };
        return {};
      }),
    };
    registerResources(server as any, whmcsClient, logger, rateLimiter);

    const res = await handlers['client-log'](new URL('whmcs://clients/7/log'), { clientid: '7' });
    const payload = JSON.parse(res.contents[0].text);
    expect(payload.isError).toBeUndefined();
    expect(payload.clientid).toBe(7);
    expect(payload).toHaveProperty('tickets_best_effort');
  });
});
