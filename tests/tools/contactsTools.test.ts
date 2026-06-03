/**
 * Track A/B — get_client_contacts governed read tool.
 *
 * Tests run with governance OFF (legacy passthrough) so the human-readable
 * `content[0].text` payload is asserted directly, mirroring infraTools.test.ts.
 * WHMCS has no live install here — `whmcs.read` is mocked (the tool does NOT
 * depend on the action allowlist; the main thread adds GetContacts to
 * READ_ALLOWLIST separately).
 */
import { it, expect, vi, describe } from 'vitest';

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
vi.mock('../../src/governance/pipeline.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/governance/pipeline.js')>();
  return { ...actual, governanceEnabled: () => false };
});

import { registerContactsTools } from '../../src/tools/contactsTools.js';

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
    child: () => childLogger,
  };
  const logger: any = { child: () => childLogger };
  const rateLimiter: any = { tryConsume: () => true };
  return { server, handlers, logger, rateLimiter };
}

describe('get_client_contacts', () => {
  it('reads GetContacts with clientid and returns a governed list envelope', async () => {
    const { server, handlers, logger, rateLimiter } = harness();
    const read = vi.fn().mockResolvedValue({
      result: 'success',
      totalresults: 2,
      numreturned: 2,
      startnumber: 0,
      contacts: {
        contact: [
          {
            id: '1',
            userid: '42',
            firstname: 'John',
            lastname: 'Doe',
            email: 'john@example.com',
            phonenumber: '+1-000-000-0000',
            companyname: 'Acme Test Ltd',
            subaccount: '1',
            permissions: 'manageproducts',
          },
          { id: '2', userid: '42', firstname: 'Jane', email: 'jane@example.test' },
        ],
      },
    });
    registerContactsTools(server as any, { read } as any, logger, rateLimiter);

    const res = await handlers.get_client_contacts({ clientid: 42 });
    expect(read).toHaveBeenCalledWith('GetContacts', { clientid: 42 });
    const p = JSON.parse(res.content[0].text);
    expect(p.total).toBe(2);
    expect(p.count).toBe(2);
    expect(p.items[0]).toMatchObject({
      contactId: 1,
      clientId: 42,
      firstName: 'John',
      email: 'john@example.com',
      companyName: 'Acme Test Ltd',
      subAccount: true,
    });
    expect(p.items[1].firstName).toBe('Jane');
  });

  it('passes limitnum through when limit is supplied', async () => {
    const { server, handlers, logger, rateLimiter } = harness();
    const read = vi.fn().mockResolvedValue({
      contacts: { contact: { id: 5, firstname: 'solo' } },
    });
    registerContactsTools(server as any, { read } as any, logger, rateLimiter);
    const res = await handlers.get_client_contacts({ clientid: 7, limit: 10 });
    expect(read).toHaveBeenCalledWith('GetContacts', { clientid: 7, limitnum: 10 });
    const p = JSON.parse(res.content[0].text);
    // Single-object contact tolerated (not wrapped in an array).
    expect(p.total).toBe(1);
    expect(p.items[0].firstName).toBe('solo');
  });

  it('errors when clientid is missing', async () => {
    const { server, handlers, logger, rateLimiter } = harness();
    const read = vi.fn();
    registerContactsTools(server as any, { read } as any, logger, rateLimiter);
    const res = await handlers.get_client_contacts({});
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toMatch(/clientid/);
    expect(read).not.toHaveBeenCalled();
  });

  it('returns an empty envelope when the client has no contacts', async () => {
    const { server, handlers, logger, rateLimiter } = harness();
    const read = vi.fn().mockResolvedValue({ result: 'success', contacts: {} });
    registerContactsTools(server as any, { read } as any, logger, rateLimiter);
    const res = await handlers.get_client_contacts({ clientid: 99 });
    const p = JSON.parse(res.content[0].text);
    expect(p.items).toEqual([]);
    expect(p.total).toBe(0);
  });

  it('surfaces a business error as a structured error result', async () => {
    const { WhmcsBusinessError } = await import('../../src/whmcs/WhmcsClient.js');
    const { server, handlers, logger, rateLimiter } = harness();
    const read = vi.fn().mockRejectedValue(new WhmcsBusinessError('boom'));
    registerContactsTools(server as any, { read } as any, logger, rateLimiter);
    const res = await handlers.get_client_contacts({ clientid: 42 });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe('boom');
  });
});
