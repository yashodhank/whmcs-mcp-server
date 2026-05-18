import { describe, it, expect, vi, afterEach } from 'vitest';
vi.mock('../../src/config.js', () => ({ config: { MCP_MAX_PAGE_SIZE: 100 }, isToolAllowed: () => true }));
vi.mock('../../src/security.js', () => ({ AUTH_SHAPE: {}, ensureToolAuth: () => null, isClientMode: () => false, ensureClientAllowed: () => null }));
import { registerCapabilityShellTools } from '../../src/tools/capabilityShellTools.js';

function harness() {
  const handlers: Record<string, (a: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }>> = {};
  const configs: Record<string, Record<string, unknown>> = {};
  const server = { registerTool: (n: string, c: unknown, cb: unknown) => { configs[n] = c as Record<string, unknown>; handlers[n] = cb as never; } };
  const childLogger = { logToolCall: vi.fn(), logToolResult: vi.fn(), info: vi.fn(), error: vi.fn(), child: () => childLogger };
  const logger = { child: () => childLogger };
  const rateLimiter = { tryConsume: () => true };
  const read = vi.fn();
  const whmcs = { read };
  registerCapabilityShellTools(server as never, whmcs as never, logger as never, rateLimiter as never);
  return { handlers, configs, read };
}

const SHELLS: [tool: string, action: string][] = [
  ['list_client_transactions', 'GetTransactions'],
  ['get_stats', 'GetStats'],
  ['list_users', 'GetUsers'],
  ['get_todo_items', 'GetToDoItems'],
  ['get_automation_log', 'GetAutomationLog'],
];

describe('registerCapabilityShellTools', () => {
  it('registers the 5 capability-shell tools + get_capability_matrix', () => {
    const { handlers } = harness();
    expect(Object.keys(handlers).sort()).toEqual(
      [...SHELLS.map(([t]) => t), 'get_capability_matrix'].sort()
    );
  });

  // GetUsers stays UNVERIFIED (degraded everywhere) — still a shell.
  it('list_users (unverified) returns structured capability_unavailable and NEVER calls WHMCS', async () => {
    const { handlers, read } = harness();
    const res = await handlers.list_users({ clientid: 1 });
    expect(read).not.toHaveBeenCalled();
    const p = JSON.parse(res.content[0].text) as Record<string, unknown>;
    expect(p).toMatchObject({ capability_unavailable: true, action: 'GetUsers' });
    expect(['unverified', 'degraded']).toContain(p.status);
    expect(res.isError).toBe(true);
  });

  // Phase H: the 4 production-verified actions are PROMOTED — real
  // governed reads (call WHMCS, return data, NOT capability_unavailable).
  const PROMOTED: [tool: string, action: string, resp: Record<string, unknown>][] = [
    ['list_client_transactions', 'GetTransactions', { transactions: { transaction: [{ id: 1, userid: 7, amountin: '10.00' }] } }],
    ['get_stats', 'GetStats', { income_today: '100.00', num_clients: 5 }],
    ['get_todo_items', 'GetToDoItems', { todoitems: { todoitem: [{ id: 1, title: 'x', status: 'New' }] } }],
    ['get_automation_log', 'GetAutomationLog', { automationlog: { entry: [{ id: 1, name: 'cron', status: 'Success' }] } }],
  ];
  for (const [tool, action, resp] of PROMOTED) {
    it(`${tool} is PROMOTED: calls WHMCS ${action}, returns governed data (not capability_unavailable)`, async () => {
      const { handlers, read } = harness();
      read.mockResolvedValue(resp);
      const res = await handlers[tool]({ clientid: 7 });
      expect(read).toHaveBeenCalledWith(action, expect.any(Object));
      const p = JSON.parse(res.content[0].text) as Record<string, unknown>;
      expect(p.capability_unavailable).toBeUndefined();
      expect(res.isError).toBeUndefined();
      // legacy path (no governance): items[] for list, data object for single
      expect(p.items !== undefined || Object.keys(p).length > 0).toBe(true);
    });
  }

  it('get_capability_matrix reports the structured capability registry + unverified WHMCS version, no WHMCS call', async () => {
    const { handlers, read } = harness();
    const res = await handlers.get_capability_matrix({});
    expect(read).not.toHaveBeenCalled();
    const p = JSON.parse(res.content[0].text) as {
      whmcs_version: { status: string };
      capabilities: { action: string; status: string }[];
      compat_9x: Record<string, unknown>;
    };
    expect(p.whmcs_version.status).toBe('unverified');
    const byAction = Object.fromEntries(p.capabilities.map((c) => [c.action, c.status]));
    expect(byAction.GetActivityLog).toBe('supported');
    // Phase H: GetTransactions promoted to supported; GetUsers stays unverified.
    expect(byAction.GetTransactions).toBe('supported');
    expect(byAction.GetUsers).toBe('unverified');
    expect(p.compat_9x).toMatchObject({ immutable_non_draft_invoices: true, credit_debit_notes: true });
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toBeDefined();
  });

  it('shells register an outputSchema for the structured capability_unavailable object', () => {
    const { configs } = harness();
    const cfg = configs.list_users;
    expect(cfg.outputSchema).toBeDefined();
    const shape = cfg.outputSchema as Record<string, { _def?: unknown }>;
    for (const k of ['capability_unavailable', 'action', 'status', 'note']) {
      expect(shape[k]).toBeDefined();
      expect(shape[k]._def).toBeDefined();
    }
    // Same stable shape reused across all shells.
    expect(configs.get_stats.outputSchema).toBe(cfg.outputSchema);
  });

  it('get_capability_matrix registers an outputSchema validating governed + ungoverned shapes', () => {
    const { configs } = harness();
    const cfg = configs.get_capability_matrix;
    expect(cfg.outputSchema).toBeDefined();
    const shape = cfg.outputSchema as Record<string, { _def?: unknown }>;
    for (const k of ['whmcs_version', 'capabilities', 'compat_9x', 'consumer', 'contract', 'data']) {
      expect(shape[k]).toBeDefined();
      expect(shape[k]._def).toBeDefined();
    }
  });

  it('does not fake data and is identical with governance OFF vs ON (no data to govern)', async () => {
    const { handlers } = harness();
    const a = await handlers.list_users({});
    const b = await handlers.list_users({ auth_token: 'whatever', contract: 'admin_full_trusted' });
    expect(a.content[0].text).toBe(b.content[0].text);
    const p = JSON.parse(a.content[0].text) as Record<string, unknown>;
    expect(p).not.toHaveProperty('users');
    expect(p).not.toHaveProperty('data');
  });
});

/* ════════════════════════════════════════════════════════════════════════════
 * Phase H — FULL test matrix for the 4 PROMOTED governed read tools.
 *
 * Each promoted shell (list_client_transactions / get_stats / get_todo_items /
 * get_automation_log) is a REAL governed read: it calls WHMCS, maps via its
 * canonical mapper, and runs through the governance pipeline. Per tool, where
 * applicable, the matrix below covers:
 *   - happy path (governed data, NOT capability_unavailable)
 *   - empty WHMCS response
 *   - malformed / partial response (no throw, degrades safely)
 *   - numeric-keyed / nested-wrapper / single-object shapes
 *   - governance DISABLED legacy compat (byte-stable legacy payload)
 *   - governance ENABLED contract projection (synthetic registry)
 *   - scope/consumer denial (unknown token ⇒ structured error, no data)
 *   - outputSchema validation (registered SHELL_OUTPUT_SHAPE)
 *   - NO PII/secret leakage in the projected llm contract
 *
 * Synthetic fixtures only. The governance-ON sub-suite re-imports the module
 * graph with a mocked config + synthetic MCP_CONSUMER_REGISTRY (mirrors the
 * pattern in tests/tools/aggregators.test.ts).
 * ════════════════════════════════════════════════════════════════════════════ */

import { z } from 'zod';
import { hashToken } from '../../src/governance/consumers.js';

interface ToolResult {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * A long (>200 char) sensitive payload. `llm_safe_summary` summarizes
 * untrusted.free_text into `{summary,length,truncated}` capped at 200 chars,
 * so the raw TAIL of a long string must NOT survive — and the field is never
 * a raw top-level instruction string for the model.
 */
const LONG_TAIL = 'TAILSECRET_must_not_survive_projection';
const LONG_FREE_TEXT = `${'x'.repeat(220)} ${LONG_TAIL}`;

const LIST_TOOLS: {
  tool: string;
  action: string;
  /** A WHMCS response shaped as { wrapper: { singular: [row, ...] } }. */
  wrap: (rows: Record<string, unknown>[]) => Record<string, unknown>;
  /** A row with a sensitive free_text / system.audit field. */
  sensitiveRow: Record<string, unknown>;
  /**
   * `summarize` — the projected canonical field is untrusted.free_text
   * (emitted as a {summary,...} object, raw tail truncated); or
   * `drop` — the projected canonical field is system.audit (omitted).
   */
  sensitiveField: string;
  mode: 'summarize' | 'drop';
}[] = [
  {
    tool: 'list_client_transactions',
    action: 'GetTransactions',
    wrap: (rows) => ({ transactions: { transaction: rows } }),
    sensitiveRow: { id: 1, userid: 7, transid: 'TX-1', amountin: '10.00', description: LONG_FREE_TEXT },
    sensitiveField: 'description',
    mode: 'summarize',
  },
  {
    tool: 'get_todo_items',
    action: 'GetToDoItems',
    wrap: (rows) => ({ todoitems: { todoitem: rows } }),
    sensitiveRow: { id: 1, adminid: 3, status: 'New', title: LONG_FREE_TEXT },
    sensitiveField: 'title',
    mode: 'summarize',
  },
  {
    tool: 'get_automation_log',
    action: 'GetAutomationLog',
    wrap: (rows) => ({ automationlog: { entry: rows } }),
    // `output` is system.audit ⇒ DROPPED entirely under llm_safe_summary.
    sensitiveRow: { id: 1, name: 'cron', status: 'Success', output: `AUDITSECRET admin@corp.test ${LONG_TAIL}` },
    sensitiveField: 'output',
    mode: 'drop',
  },
];

describe('Phase H promoted LIST tools — governance OFF (legacy compat)', () => {
  for (const { tool, action, wrap } of LIST_TOOLS) {
    it(`${tool}: happy path calls WHMCS ${action}, returns legacy {items,count}, NOT capability_unavailable`, async () => {
      const { handlers, read } = harness();
      read.mockResolvedValue(wrap([{ id: 1, userid: 7 }, { id: 2, userid: 7 }]));
      const res = (await handlers[tool]({ clientid: 7 })) as ToolResult;
      expect(read).toHaveBeenCalledWith(action, expect.any(Object));
      const p = JSON.parse(res.content[0].text) as Record<string, unknown>;
      expect(p.capability_unavailable).toBeUndefined();
      expect(res.isError).toBeUndefined();
      expect(Array.isArray(p.items)).toBe(true);
      expect((p.items as unknown[]).length).toBe(2);
      expect(p.count).toBe(2);
      // No governance wrapper keys in legacy mode.
      expect(p.consumer).toBeUndefined();
      expect(p.contract).toBeUndefined();
    });

    it(`${tool}: empty WHMCS response ⇒ items:[] count:0 (no throw)`, async () => {
      const { handlers, read } = harness();
      read.mockResolvedValue({});
      const res = (await handlers[tool]({})) as ToolResult;
      const p = JSON.parse(res.content[0].text) as Record<string, unknown>;
      expect(p.items).toEqual([]);
      expect(p.count).toBe(0);
      expect(p.capability_unavailable).toBeUndefined();
    });

    it(`${tool}: empty wrapper object {wrapper:{}} ⇒ items:[] (no throw)`, async () => {
      const { handlers, read } = harness();
      read.mockResolvedValue(wrap([]));
      const res = (await handlers[tool]({})) as ToolResult;
      const p = JSON.parse(res.content[0].text) as Record<string, unknown>;
      expect(p.items).toEqual([]);
      expect(p.count).toBe(0);
    });

    it(`${tool}: malformed/partial rows (missing keys, wrong types) degrade safely, no throw`, async () => {
      const { handlers, read } = harness();
      read.mockResolvedValue(wrap([{}, { id: 'not-a-number', userid: null }, { unexpected: { nested: true } }]));
      const res = (await handlers[tool]({})) as ToolResult;
      const p = JSON.parse(res.content[0].text) as { items: Record<string, unknown>[]; count: number };
      expect(p.count).toBe(3);
      expect(p.items).toHaveLength(3);
      // Mapper coerces unknowns to null rather than throwing.
      expect(() => JSON.stringify(p)).not.toThrow();
    });

    it(`${tool}: numeric-keyed wrapper {"0":..,"1":..} is unwrapped to rows`, async () => {
      const { handlers, read } = harness();
      const numeric = JSON.parse(
        JSON.stringify(wrap([])).replace(/\[\]/, '{"0":{"id":1},"1":{"id":2},"2":{"id":3}}')
      ) as Record<string, unknown>;
      read.mockResolvedValue(numeric);
      const res = (await handlers[tool]({})) as ToolResult;
      const p = JSON.parse(res.content[0].text) as { items: unknown[]; count: number };
      expect(p.count).toBe(3);
    });

    it(`${tool}: single (non-array) object under the singular key is treated as one row`, async () => {
      const { handlers, read } = harness();
      const single = JSON.parse(
        JSON.stringify(wrap([])).replace(/\[\]/, '{"id":9}')
      ) as Record<string, unknown>;
      read.mockResolvedValue(single);
      const res = (await handlers[tool]({})) as ToolResult;
      const p = JSON.parse(res.content[0].text) as { items: unknown[]; count: number };
      expect(p.count).toBe(1);
    });

    it(`${tool}: governance OFF runtime payload is byte-stable across calls`, async () => {
      const { handlers, read } = harness();
      read.mockResolvedValue(wrap([{ id: 1, userid: 7 }]));
      const a = (await handlers[tool]({ clientid: 7 })) as ToolResult;
      const b = (await handlers[tool]({ clientid: 7 })) as ToolResult;
      expect(a.content[0].text).toBe(b.content[0].text);
    });

    it(`${tool}: result validates against the registered outputSchema`, async () => {
      const { handlers, configs, read } = harness();
      read.mockResolvedValue(wrap([{ id: 1, userid: 7 }]));
      const res = (await handlers[tool]({ clientid: 7 })) as ToolResult;
      const p = JSON.parse(res.content[0].text);
      const schema = z.object(configs[tool].outputSchema as z.ZodRawShape);
      expect(schema.safeParse(p).success).toBe(true);
    });
  }
});

describe('get_stats (single) — governance OFF (legacy compat)', () => {
  it('happy path: calls WHMCS GetStats, returns mapped data object (NOT capability_unavailable)', async () => {
    const { handlers, read } = harness();
    read.mockResolvedValue({ income_today: '100.50', num_clients: 5, total_revenue: 9000 });
    const res = (await handlers.get_stats({})) as ToolResult;
    expect(read).toHaveBeenCalledWith('GetStats', expect.any(Object));
    const p = JSON.parse(res.content[0].text) as { metrics: Record<string, unknown> };
    expect(p.capability_unavailable).toBeUndefined();
    expect(res.isError).toBeUndefined();
    expect(p.metrics.income_today).toBe(100.5);
    expect(p.metrics.num_clients).toBe(5);
  });

  it('empty WHMCS response ⇒ metrics:{} (no throw)', async () => {
    const { handlers, read } = harness();
    read.mockResolvedValue({});
    const res = (await handlers.get_stats({})) as ToolResult;
    const p = JSON.parse(res.content[0].text) as { metrics: Record<string, unknown> };
    expect(p.metrics).toEqual({});
    expect(p.capability_unavailable).toBeUndefined();
  });

  it('malformed response (array / nested objects) degrades safely, no throw', async () => {
    const { handlers, read } = harness();
    read.mockResolvedValue({ orders_today: 4, nested: { a: 1 }, list: [1, 2] });
    const res = (await handlers.get_stats({})) as ToolResult;
    const p = JSON.parse(res.content[0].text) as { metrics: Record<string, unknown> };
    expect(p.metrics.orders_today).toBe(4);
    // nested objects/arrays are not emitted as scalar metrics.
    expect('nested' in p.metrics).toBe(false);
    expect('list' in p.metrics).toBe(false);
  });

  it('governance OFF runtime payload is byte-stable across calls', async () => {
    const { handlers, read } = harness();
    read.mockResolvedValue({ income_today: '1.00' });
    const a = (await handlers.get_stats({})) as ToolResult;
    const b = (await handlers.get_stats({})) as ToolResult;
    expect(a.content[0].text).toBe(b.content[0].text);
  });

  it('result validates against the registered outputSchema', async () => {
    const { handlers, configs, read } = harness();
    read.mockResolvedValue({ income_today: '1.00' });
    const res = (await handlers.get_stats({})) as ToolResult;
    const p = JSON.parse(res.content[0].text);
    const schema = z.object(configs.get_stats.outputSchema as z.ZodRawShape);
    expect(schema.safeParse(p).success).toBe(true);
  });
});

describe('Phase H promoted tools — governance ON (contract projection + denial)', () => {
  const TOKEN_OPS = 'tok-ops-cap-shell-aaaa';
  const TOKEN_LLM = 'tok-llm-cap-shell-bbbb';

  const registryJson = JSON.stringify([
    {
      id: 'ops_desk',
      token_sha256: hashToken(TOKEN_OPS),
      defaultContract: 'ops_operator',
      allowedContracts: ['ops_operator'],
      writeCapability: 'false',
    },
    {
      id: 'llm_app',
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
    const { registerCapabilityShellTools: register } = await import(
      '../../src/tools/capabilityShellTools.js'
    );
    const { __resetRegistryCacheForTests } = await import(
      '../../src/governance/pipeline.js'
    );
    const { __resetCapabilityCacheForTests } = await import(
      '../../src/governance/capabilities.js'
    );
    __resetRegistryCacheForTests();
    __resetCapabilityCacheForTests();

    const handlers: Record<string, (a: Record<string, unknown>) => Promise<ToolResult>> = {};
    const configs: Record<string, Record<string, unknown>> = {};
    const server = {
      registerTool: (n: string, c: unknown, cb: unknown) => {
        configs[n] = c as Record<string, unknown>;
        handlers[n] = cb as never;
      },
    };
    const childLogger = { logToolCall: vi.fn(), logToolResult: vi.fn(), info: vi.fn(), error: vi.fn(), child: () => childLogger };
    const logger = { child: () => childLogger };
    const rateLimiter = { tryConsume: () => true };
    const read = vi.fn();
    const whmcs = { read };
    register(server as never, whmcs as never, logger as never, rateLimiter as never);
    return { handlers, configs, read };
  }

  it('list_client_transactions: authed ops consumer ⇒ projected list envelope {consumer,contract,items}', async () => {
    const { handlers, read } = await governedHarness();
    read.mockResolvedValue({ transactions: { transaction: [{ id: 1, userid: 7, transid: 'TX-1', amountin: '10.00' }] } });
    const res = await handlers.list_client_transactions({ clientid: 7, auth_token: TOKEN_OPS });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toBeDefined();
    const sc: Record<string, unknown> = res.structuredContent ?? {};
    expect(sc.consumer).toBe('ops_desk');
    expect(sc.contract).toBe('ops_operator');
    expect(Array.isArray(sc.items)).toBe(true);
    expect(sc.count).toBe(1);
    const item0 = (sc.items as Record<string, unknown>[])[0];
    // financial.amount + financial.reference preserved for ops_operator.
    expect(item0.amountIn).toBe(10);
    expect(item0.transactionId).toBe('TX-1');
  });

  it('get_stats: authed ops consumer ⇒ projected single envelope {entity,consumer,contract,data}', async () => {
    const { handlers, read } = await governedHarness();
    read.mockResolvedValue({ income_today: '500.00', num_clients: 12 });
    const res = await handlers.get_stats({ auth_token: TOKEN_OPS });
    expect(res.isError).toBeFalsy();
    const sc: Record<string, unknown> = res.structuredContent ?? {};
    expect(sc.consumer).toBe('ops_desk');
    expect(sc.contract).toBe('ops_operator');
    expect(sc.entity).toBe('activity');
    // `metrics` is public.safe ⇒ preserved intact.
    expect((sc.data as { metrics: Record<string, unknown> }).metrics.income_today).toBe(500);
  });

  it('unknown bearer token ⇒ structured consumer_denied, NO data leaked (all promoted tools)', async () => {
    const cases: { tool: string; resp: Record<string, unknown>; needle: string }[] = [
      { tool: 'list_client_transactions', resp: { transactions: { transaction: [{ id: 1, transid: 'SECRET-TX' }] } }, needle: 'SECRET-TX' },
      { tool: 'get_stats', resp: { income_today: '987654.00' }, needle: '987654' },
      { tool: 'get_todo_items', resp: { todoitems: { todoitem: [{ id: 1, title: 'SECRET-TODO' }] } }, needle: 'SECRET-TODO' },
      { tool: 'get_automation_log', resp: { automationlog: { entry: [{ id: 1, output: 'SECRET-AUDIT' }] } }, needle: 'SECRET-AUDIT' },
    ];
    for (const { tool, resp, needle } of cases) {
      const { handlers, read } = await governedHarness();
      read.mockResolvedValue(resp);
      const res = await handlers[tool]({ auth_token: 'totally-unknown-token' });
      expect(res.isError, tool).toBe(true);
      const sc: Record<string, unknown> = res.structuredContent ?? {};
      expect(sc.status, tool).toBe('consumer_denied');
      // The raw WHMCS payload must NOT appear anywhere in the response.
      expect(JSON.stringify(res), `${tool} leaked raw data`).not.toContain(needle);
    }
  });

  // Track 5 — GetUsers defense-in-depth under governance ON. list_users has
  // NO canonicalMap ⇒ it must STAY a structured capability_unavailable shell
  // and NEVER call whmcs.read, even with a fully valid bearer token.
  it('list_users stays capability_unavailable & NEVER calls WHMCS even with a valid token (governance ON)', async () => {
    const { handlers, read } = await governedHarness();
    read.mockResolvedValue({ users: { user: [{ id: 1, email: 'real@person.test' }] } });
    const res = await handlers.list_users({ auth_token: TOKEN_OPS, contract: 'ops_operator' });
    expect(read).not.toHaveBeenCalled();
    const p = JSON.parse(res.content[0].text) as Record<string, unknown>;
    expect(p).toMatchObject({ capability_unavailable: true, action: 'GetUsers' });
    expect(['unverified', 'degraded']).toContain(p.status);
    expect(res.isError).toBe(true);
    // No data, no projected envelope — never faked.
    expect(p).not.toHaveProperty('items');
    expect(p).not.toHaveProperty('data');
    expect(JSON.stringify(res)).not.toContain('real@person.test');
  });

  it('no bearer token under production governance ⇒ consumer_denied, no items/data', async () => {
    const { handlers, read } = await governedHarness();
    read.mockResolvedValue({ transactions: { transaction: [{ id: 1, transid: 'NOAUTH-TX' }] } });
    const res = await handlers.list_client_transactions({ clientid: 7 });
    expect(res.isError).toBe(true);
    const sc: Record<string, unknown> = res.structuredContent ?? {};
    expect(sc.status).toBe('consumer_denied');
    expect(sc.items).toBeUndefined();
    expect(JSON.stringify(res)).not.toContain('NOAUTH-TX');
  });

  for (const { tool, action, wrap, sensitiveRow, sensitiveField, mode } of LIST_TOOLS) {
    it(`${tool}: llm_safe_summary ${mode}s the sensitive field — raw tail never leaks`, async () => {
      const { handlers, read } = await governedHarness();
      read.mockResolvedValue(wrap([sensitiveRow]));
      const res = await handlers[tool]({ clientid: 7, auth_token: TOKEN_LLM });
      expect(res.isError, `${tool} (${action})`).toBeFalsy();
      const sc: Record<string, unknown> = res.structuredContent ?? {};
      expect(sc.consumer).toBe('llm_app');
      expect(sc.contract).toBe('llm_safe_summary');
      const item0 = (sc.items as Record<string, unknown>[])[0];
      // The long raw tail MUST NOT survive the llm contract regardless of mode.
      expect(JSON.stringify(res), `${tool} leaked raw sensitive tail`).not.toContain(LONG_TAIL);
      if (mode === 'drop') {
        // system.audit ⇒ field omitted entirely.
        expect(item0[sensitiveField], `${tool}.${sensitiveField} must be dropped`).toBeUndefined();
      } else {
        // untrusted.free_text ⇒ NOT a raw string; a {summary,length,truncated}
        // object, capped (truncated) so the model never sees raw instructions.
        const v = item0[sensitiveField] as Record<string, unknown>;
        expect(typeof v, `${tool}.${sensitiveField} must be wrapped`).toBe('object');
        expect(v.truncated).toBe(true);
        expect(typeof v.summary).toBe('string');
        expect((v.summary as string).length).toBeLessThanOrEqual(201);
      }
    });

    it(`${tool}: governed envelope validates against the registered outputSchema`, async () => {
      const { handlers, configs, read } = await governedHarness();
      read.mockResolvedValue(wrap([{ id: 1, userid: 7 }]));
      const res = await handlers[tool]({ clientid: 7, auth_token: TOKEN_OPS });
      const schema = z.object(configs[tool].outputSchema as z.ZodRawShape);
      expect(schema.safeParse(JSON.parse(res.content[0].text)).success).toBe(true);
      // The consumer_denied error envelope must validate too.
      const denied = await handlers[tool]({ clientid: 7, auth_token: 'nope' });
      expect(schema.safeParse(JSON.parse(denied.content[0].text)).success).toBe(true);
    });
  }
});
