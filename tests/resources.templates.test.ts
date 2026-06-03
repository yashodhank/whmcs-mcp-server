/**
 * Resource templates + argument completions (MCP spec 2025-11-25, SDK 1.29).
 *
 * Covers the new singular-URI templated resources and the `complete` callbacks
 * wired onto their URI variables:
 *   - whmcs://client/{clientid}/services   (clientid + status completions)
 *   - whmcs://client/{clientid}/domains    (clientid + status completions)
 *   - whmcs://client/{clientid}/summary    (clientid completion)
 *   - whmcs://invoice/{invoiceid}/history
 *   - whmcs://ticket/{ticketid}/thread
 *
 * Completion contract pinned here:
 *   - clientid: bounded (<= COMPLETION_LIMIT), empty input => [], admin mode
 *     uses ALLOWLISTED GetClients and returns BARE IDS (no PII), client mode
 *     returns only in-scope allowlisted ids and never queries WHMCS.
 *   - status: closed enum set, prefix-filtered, no WHMCS call.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

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
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { COMPLETION_LIMIT } from '../src/resources/completions.js';

interface Registered {
  template: ResourceTemplate;
  handler: (uri: URL, params?: any) => Promise<any>;
}

function makeServer() {
  const reg: Record<string, Registered> = {};
  const server = {
    resource: (name: string, template: ResourceTemplate, cb: any) => {
      reg[name] = { template, handler: cb };
    },
  };
  return { server, reg };
}

const childLogger: any = { info: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => childLogger };
const logger: any = { child: () => childLogger, info: vi.fn(), debug: vi.fn() };
const rateLimiter: any = { tryConsume: () => true };

afterEach(() => {
  cfg.config.MCP_ACCESS_MODE = 'admin';
  cfg.config.MCP_ALLOWED_CLIENT_IDS = [];
  cfg.config.MCP_GOVERNANCE_ENABLED = false;
});

describe('new templated resource registration', () => {
  it('registers the five singular-URI templates with correct patterns', () => {
    const { server, reg } = makeServer();
    registerResources(server as any, { read: vi.fn() } as any, logger, rateLimiter);

    expect(reg['client-summary-v2'].template.uriTemplate.toString()).toBe('whmcs://client/{clientid}/summary');
    expect(reg['client-services'].template.uriTemplate.toString()).toBe('whmcs://client/{clientid}/services');
    expect(reg['client-domains'].template.uriTemplate.toString()).toBe('whmcs://client/{clientid}/domains');
    expect(reg['invoice-history-v2'].template.uriTemplate.toString()).toBe('whmcs://invoice/{invoiceid}/history');
    expect(reg['ticket-thread-v2'].template.uriTemplate.toString()).toBe('whmcs://ticket/{ticketid}/thread');
  });

  it('keeps the existing plural URIs (backward compatible)', () => {
    const { server, reg } = makeServer();
    registerResources(server as any, { read: vi.fn() } as any, logger, rateLimiter);
    expect(reg['client-summary'].template.uriTemplate.toString()).toBe('whmcs://clients/{clientid}/summary');
    expect(reg['invoice-history'].template.uriTemplate.toString()).toBe('whmcs://invoices/{invoiceid}/history');
    expect(reg['ticket-thread'].template.uriTemplate.toString()).toBe('whmcs://tickets/{ticketid}/thread');
  });
});

describe('client/{clientid}/services resource', () => {
  it('reads services via allowlisted GetClientsProducts and SEC-003 coerces id', async () => {
    const { server, reg } = makeServer();
    const whmcs: any = {
      read: vi.fn(async (action: string, params: any) => {
        expect(action).toBe('GetClientsProducts');
        expect(params.clientid).toBe(42);
        return {
          products: { product: [
            { id: 1, pid: 5, name: 'Hosting', domain: 'a.test', status: 'Active', billingcycle: 'Monthly', nextduedate: '2026-07-01', recurringamount: '9.00', paymentmethod: 'paypal' },
            { id: 2, pid: 6, name: 'VPS', domain: 'b.test', status: 'Suspended' },
          ] },
          totalresults: 2,
        };
      }),
    };
    registerResources(server as any, whmcs, logger, rateLimiter);

    const res = await reg['client-services'].handler(new URL('whmcs://client/42/services'), { clientid: '42' });
    const payload = JSON.parse(res.contents[0].text);
    expect(payload.error).toBeUndefined();
    expect(payload.clientid).toBe(42);
    expect(payload.services).toHaveLength(2);
    expect(payload.services[0]).toMatchObject({ serviceid: 1, product: 'Hosting', status: 'Active' });
  });

  it('filters by status when the status var is supplied', async () => {
    const { server, reg } = makeServer();
    const whmcs: any = {
      read: vi.fn().mockResolvedValue({
        products: { product: [
          { id: 1, name: 'A', status: 'Active' },
          { id: 2, name: 'B', status: 'Suspended' },
        ] },
        totalresults: 2,
      }),
    };
    registerResources(server as any, whmcs, logger, rateLimiter);

    const res = await reg['client-services'].handler(new URL('whmcs://client/42/services'), { clientid: '42', status: 'Suspended' });
    const payload = JSON.parse(res.contents[0].text);
    expect(payload.services).toHaveLength(1);
    expect(payload.services[0].serviceid).toBe(2);
  });

  it('rejects a non-positive-int clientid (SEC-003) without calling WHMCS', async () => {
    const { server, reg } = makeServer();
    const whmcs: any = { read: vi.fn() };
    registerResources(server as any, whmcs, logger, rateLimiter);

    const res = await reg['client-services'].handler(new URL('whmcs://client/0/services'), { clientid: '0' });
    expect(JSON.parse(res.contents[0].text).error).toMatch(/positive integer/i);
    expect(whmcs.read).not.toHaveBeenCalled();
  });

  it('denies an out-of-scope client id in client access mode', async () => {
    cfg.config.MCP_ACCESS_MODE = 'client';
    cfg.config.MCP_ALLOWED_CLIENT_IDS = [7];
    const { server, reg } = makeServer();
    const whmcs: any = { read: vi.fn() };
    registerResources(server as any, whmcs, logger, rateLimiter);

    const res = await reg['client-services'].handler(new URL('whmcs://client/9/services'), { clientid: '9' });
    expect(JSON.parse(res.contents[0].text).error).toMatch(/scope mismatch/i);
    expect(whmcs.read).not.toHaveBeenCalled();
  });
});

describe('client/{clientid}/domains resource', () => {
  it('reads domains via allowlisted GetClientsDomains', async () => {
    const { server, reg } = makeServer();
    const whmcs: any = {
      read: vi.fn(async (action: string) => {
        expect(action).toBe('GetClientsDomains');
        return {
          domains: { domain: [
            { id: 11, domainname: 'x.test', registrar: 'enom', status: 'Active', regdate: '2025-01-01', expirydate: '2027-01-01', nextduedate: '2027-01-01', donotrenew: '0' },
          ] },
          totalresults: 1,
        };
      }),
    };
    registerResources(server as any, whmcs, logger, rateLimiter);

    const res = await reg['client-domains'].handler(new URL('whmcs://client/42/domains'), { clientid: '42' });
    const payload = JSON.parse(res.contents[0].text);
    expect(payload.domains).toHaveLength(1);
    expect(payload.domains[0]).toMatchObject({ domainid: 11, domain: 'x.test', status: 'Active' });
  });
});

describe('completions — {clientid}', () => {
  it('empty input returns [] (never an unbounded dump) and does not query WHMCS', async () => {
    const { server, reg } = makeServer();
    const whmcs: any = { read: vi.fn() };
    registerResources(server as any, whmcs, logger, rateLimiter);

    const complete = reg['client-services'].template.completeCallback('clientid')!;
    expect(complete).toBeTypeOf('function');
    const out = await complete('', undefined);
    expect(out).toEqual([]);
    expect(whmcs.read).not.toHaveBeenCalled();
  });

  it('admin mode: bounded GetClients search returning BARE ids (no PII)', async () => {
    const { server, reg } = makeServer();
    const many = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, firstname: 'Ada', email: 'ada@x.test' }));
    const whmcs: any = {
      read: vi.fn(async (action: string, params: any) => {
        expect(action).toBe('GetClients');
        expect(params.limitnum).toBe(COMPLETION_LIMIT);
        expect(params.search).toBe('1');
        return { clients: { client: many } };
      }),
    };
    registerResources(server as any, whmcs, logger, rateLimiter);

    const complete = reg['client-summary-v2'].template.completeCallback('clientid')!;
    const out = await complete('1', undefined);
    expect(out.length).toBeLessThanOrEqual(COMPLETION_LIMIT);
    // bare numeric-string ids only — no names / emails leaked
    out.forEach((v: string) => expect(v).toMatch(/^\d+$/));
    expect(out.join(',')).not.toContain('Ada');
    expect(out.join(',')).not.toContain('@');
  });

  it('client mode: returns only in-scope allowlisted ids, never queries WHMCS', async () => {
    cfg.config.MCP_ACCESS_MODE = 'client';
    cfg.config.MCP_ALLOWED_CLIENT_IDS = [7, 12, 70];
    const { server, reg } = makeServer();
    const whmcs: any = { read: vi.fn() };
    registerResources(server as any, whmcs, logger, rateLimiter);

    const complete = reg['client-summary-v2'].template.completeCallback('clientid')!;
    const out = await complete('7', undefined);
    expect(out).toEqual(['7', '70']);
    expect(whmcs.read).not.toHaveBeenCalled();
  });

  it('degrades to [] if the allowlisted read throws', async () => {
    const { server, reg } = makeServer();
    const whmcs: any = { read: vi.fn().mockRejectedValue(new Error('boom')) };
    registerResources(server as any, whmcs, logger, rateLimiter);

    const complete = reg['client-domains'].template.completeCallback('clientid')!;
    expect(await complete('5', undefined)).toEqual([]);
  });
});

describe('completions — {status} enum', () => {
  it('services status enum is prefix-filtered, bounded, and makes no WHMCS call', async () => {
    const { server, reg } = makeServer();
    const whmcs: any = { read: vi.fn() };
    registerResources(server as any, whmcs, logger, rateLimiter);

    const complete = reg['client-services'].template.completeCallback('status')!;
    const all = await complete('', undefined);
    expect(all).toContain('Active');
    expect(all).toContain('Suspended');
    expect(all.length).toBeLessThanOrEqual(COMPLETION_LIMIT);

    const filtered = await complete('su', undefined);
    expect(filtered).toEqual(['Suspended']);
    expect(whmcs.read).not.toHaveBeenCalled();
  });

  it('domains status enum includes domain-specific states', async () => {
    const { server, reg } = makeServer();
    registerResources(server as any, { read: vi.fn() } as any, logger, rateLimiter);
    const complete = reg['client-domains'].template.completeCallback('status')!;
    const out = await complete('Pending', undefined);
    expect(out).toContain('Pending Registration');
    expect(out).toContain('Pending Transfer');
  });
});

describe('new singular invoice/ticket templates reuse the existing read path', () => {
  it('invoice-history-v2 returns the same shape as the plural resource', async () => {
    const { server, reg } = makeServer();
    const whmcs: any = {
      read: vi.fn().mockResolvedValue({
        invoiceid: 555, userid: 7, date: '2026-01-02', duedate: '2026-01-09', datepaid: '',
        status: 'Unpaid', total: '99.00', balance: '99.00',
        items: { item: [{ id: 1, description: 'Hosting', amount: '99.00' }] }, transactions: { transaction: [] },
      }),
    };
    registerResources(server as any, whmcs, logger, rateLimiter);
    const res = await reg['invoice-history-v2'].handler(new URL('whmcs://invoice/555/history'), { invoiceid: '555' });
    expect(JSON.parse(res.contents[0].text)).toMatchObject({ invoiceid: 555, clientid: 7, status: 'Unpaid' });
  });

  it('ticket-thread-v2 returns the formatted thread', async () => {
    const { server, reg } = makeServer();
    const whmcs: any = {
      read: vi.fn().mockResolvedValue({
        ticketid: 1001, tid: 'TST01', deptname: 'Help Desk', subject: 's', status: 'Open', date: '2026-05-18 07:21:49',
        replies: { reply: [{ replyid: '0', name: 'X', date: '2026-05-18 07:21:49', message: 'Body', admin: '' }] }, notes: [],
      }),
    };
    registerResources(server as any, whmcs, logger, rateLimiter);
    const res = await reg['ticket-thread-v2'].handler(new URL('whmcs://ticket/1001/thread'), { ticketid: '1001' });
    const payload = JSON.parse(res.contents[0].text);
    expect(payload.ticket_number).toBe('TST01');
    expect(payload.initial_message).toBe('Body');
  });
});
