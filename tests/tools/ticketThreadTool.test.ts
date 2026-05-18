import { describe, it, expect, vi, afterEach } from 'vitest';
import { hashToken } from '../../src/governance/consumers.js';
vi.mock('../../src/config.js', () => ({ config: {}, isToolAllowed: () => true }));
vi.mock('../../src/security.js', () => ({
  AUTH_SHAPE: {},
  ensureToolAuth: () => null,
  isClientMode: () => false,
  ensureClientAllowed: () => null,
  ensureClientOwnership: () => null,
}));
import { registerTicketThreadTool } from '../../src/tools/ticketThreadTool.js';

function harness() {
  const handlers: Record<string, any> = {};
  const configs: Record<string, any> = {};
  const server = {
    registerTool: (n: string, cfg: any, cb: any) => {
      handlers[n] = cb;
      configs[n] = cfg;
    },
  };
  const childLogger: any = { logToolCall: vi.fn(), logToolResult: vi.fn(), info: vi.fn(), error: vi.fn(), child: () => childLogger };
  const logger: any = { child: () => childLogger };
  const rateLimiter: any = { tryConsume: () => true };
  return { server, handlers, configs, logger, rateLimiter };
}

describe('registerTicketThreadTool', () => {
  it('registers get_ticket_thread, calls GetTicket, formats thread, read-only annotations', async () => {
    const { server, handlers, configs, logger, rateLimiter } = harness();
    const read = vi.fn().mockResolvedValue({
      ticketid: 1001, tid: 'TST01', deptname: 'Help Desk', subject: 's', status: 'Answered', date: 'd', userid: 30,
      replies: { reply: [{ replyid: '0', message: 'open' }, { replyid: '1', message: 'r2', admin: 'A' }] },
      notes: [],
    });
    registerTicketThreadTool(server as any, { read } as any, logger, rateLimiter);

    expect(handlers.get_ticket_thread).toBeTypeOf('function');

    const res = await handlers.get_ticket_thread({ ticketid: 1001 });
    expect(read).toHaveBeenCalledWith('GetTicket', { ticketid: 1001 });

    const p = JSON.parse(res.content[0].text);
    expect(p.initial_message).toBe('open');
    expect(p.replies).toHaveLength(1);
    expect(p.replies[0].message).toBe('r2');

    expect(configs.get_ticket_thread.annotations.readOnlyHint).toBe(true);
    expect(configs.get_ticket_thread.annotations.destructiveHint).toBe(false);
  });
});

describe('registerTicketThreadTool — governed path', () => {
  const TOKEN_SUPPORT = 'tok-support-aaaaaaaa';
  const TOKEN_LLM = 'tok-llm-bbbbbbbb';

  const rawTicket = {
    ticketid: 2002,
    id: 2002,
    tid: 'SUP02',
    deptid: 3,
    deptname: 'Help Desk',
    userid: 30,
    subject: 'Cannot log in',
    status: 'Open',
    priority: 'High',
    date: '2026-05-18 09:00:00',
    replies: {
      reply: [
        { replyid: '0', name: 'Jane Client', email: 'jane@example.test', message: 'Reset my password sk_live_TOPSECRET please', date: '2026-05-18 09:00:00' },
        { replyid: '1', admin: 'OpAlice', message: 'Looking into your account now', date: '2026-05-18 09:30:00' },
      ],
    },
    notes: { note: [{ noteid: '5', admin: 'OpAlice', message: 'internal: escalate to L2', date: '2026-05-18 09:31:00' }] },
  };

  const registryJson = JSON.stringify([
    {
      id: 'support_desk',
      token_sha256: hashToken(TOKEN_SUPPORT),
      defaultContract: 'support_triage',
      allowedContracts: ['support_triage'],
      writeCapability: 'false',
    },
    {
      id: 'llm_chat',
      token_sha256: hashToken(TOKEN_LLM),
      defaultContract: 'llm_safe_summary',
      allowedContracts: ['llm_safe_summary'],
      writeCapability: 'false',
    },
  ]);

  afterEach(() => {
    vi.resetModules();
    delete process.env.MCP_CONSUMER_REGISTRY;
  });

  async function governedHarness() {
    vi.resetModules();
    process.env.MCP_CONSUMER_REGISTRY = registryJson;
    vi.doMock('../../src/config.js', () => ({
      config: {
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
      ensureClientOwnership: () => null,
    }));
    const { registerTicketThreadTool: register } = await import(
      '../../src/tools/ticketThreadTool.js'
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
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- test harness double mirrors existing harness() convention
    const childLogger: any = { logToolCall: vi.fn(), logToolResult: vi.fn(), info: vi.fn(), error: vi.fn(), child: () => childLogger };
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return -- test harness double mirrors existing harness() convention
    const logger: any = { child: () => childLogger };
    const rateLimiter: any = { tryConsume: () => true };
    const read = vi.fn().mockResolvedValue(rawTicket);
    register(server as any, { read } as any, logger, rateLimiter);
    return { handlers, read };
  }

  it('support_triage consumer: ticket message text preserved in structuredContent', async () => {
    const { handlers } = await governedHarness();
    const res = await handlers.get_ticket_thread({ ticketid: 2002, auth_token: TOKEN_SUPPORT });

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toBeDefined();
    expect(res.structuredContent.consumer).toBe('support_desk');
    expect(res.structuredContent.contract).toBe('support_triage');

    const blob = JSON.stringify(res.structuredContent);
    expect(blob).toContain('Reset my password sk_live_TOPSECRET please');
    expect(blob).toContain('Looking into your account now');
    // support_triage may see internal notes
    expect(blob).toContain('internal: escalate to L2');
  });

  it('llm_safe_summary consumer: untrusted text wrapped/summarized, internal notes dropped', async () => {
    const { handlers } = await governedHarness();
    const res = await handlers.get_ticket_thread({ ticketid: 2002, auth_token: TOKEN_LLM });

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent.consumer).toBe('llm_chat');
    expect(res.structuredContent.contract).toBe('llm_safe_summary');

    const data = res.structuredContent.data as Record<string, unknown>;
    const blob = JSON.stringify(res.structuredContent);

    // subject is untrusted.free_text → summarized, not raw passthrough as a top-level string
    expect(data.subject).not.toBe('Cannot log in');
    expect(data.subject).toMatchObject({ summary: expect.any(String) });
    // replies array is untrusted.free_text (non-string) → dropped, raw bodies never leak
    expect(blob).not.toContain('Reset my password sk_live_TOPSECRET please');
    expect(blob).not.toContain('Looking into your account now');
    // internal.private_note dropped for llm
    expect(blob).not.toContain('internal: escalate to L2');
    expect(data).not.toHaveProperty('notes');
  });

  it('unknown token in production leaks no thread', async () => {
    const { handlers } = await governedHarness();
    const res = await handlers.get_ticket_thread({ ticketid: 2002, auth_token: 'totally-unknown' });

    expect(res.isError).toBe(true);
    expect(res.structuredContent.status).toBe('consumer_denied');
    const blob = JSON.stringify(res);
    expect(blob).not.toContain('Reset my password sk_live_TOPSECRET please');
    expect(blob).not.toContain('Cannot log in');
    expect(blob).not.toContain('internal: escalate to L2');
  });
});
