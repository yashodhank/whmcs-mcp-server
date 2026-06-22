import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { createDraftIntent } from '../../src/write/intents.js';
import type { DbTx } from '../../src/whmcs/WhmcsDb.js';
import { createHash } from 'node:crypto';

// ── billing:invoice:reassign execute guard ────────────────────────────────────
// Verify that a billing:invoice:reassign intent reaching execute_write_intent
// returns blocked_reason 'unsupported_capability' and NEVER calls whmcs.mutate.
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const TOKEN_RAW = 'EXAMPLE-transfer-exec-SYNTHETIC';
const APPROVER_RAW = 'EXAMPLE-transfer-approver-SYNTHETIC';

beforeAll(() => {
  process.env.MCP_CONSUMER_REGISTRY = JSON.stringify([
    {
      id: 'transfer_exec',
      token_sha256: sha(TOKEN_RAW),
      allowedScopes: ['read'],
      defaultContract: 'ops_operator',
      allowedContracts: ['ops_operator'],
      allowedActions: [],
      writeCapability: 'execution_allowed',
      envRestrictions: [],
      anonymous: false,
      allowedWriteScopes: ['billing:invoice:reassign', 'service:transfer_owner'],
    },
    {
      id: 'transfer_approver',
      token_sha256: sha(APPROVER_RAW),
      allowedScopes: ['read'],
      defaultContract: 'ops_operator',
      allowedContracts: ['ops_operator'],
      allowedActions: [],
      writeCapability: 'approval_required',
      envRestrictions: [],
      anonymous: false,
      allowedWriteScopes: ['billing:invoice:reassign', 'service:transfer_owner'],
    },
  ]);
  process.env.MCP_WRITE_EXECUTION_AUTHORIZED = 'UpdateClientProduct,__db_direct__';
});

vi.mock('../../src/config.js', () => ({
  config: {
    MCP_MODE: 'full',
    MCP_ENV: 'local',
    MCP_MAX_PAGE_SIZE: 100,
    MCP_WRITE_REQUIRE_DISTINCT_APPROVER: true,
    MCP_TRANSFER_MAX_BATCH: 50,
    MCP_WRITE_KILL_SWITCH: false,
    MCP_PROD_WRITE_AUTHORIZED: [],
    // Empty DB config so isDbConfigured() returns false in the test environment
    // (host/user/name all empty strings → the capability gate blocks before any
    // real MySQL connection is attempted).
    MCP_WHMCS_DB_HOST: '',
    MCP_WHMCS_DB_PORT: 3306,
    MCP_WHMCS_DB_USER: '',
    MCP_WHMCS_DB_PASSWORD: '',
    MCP_WHMCS_DB_NAME: '',
    MCP_WHMCS_DB_SSL: false,
  },
  isToolAllowed: () => true,
}));
vi.mock('../../src/security.js', () => ({ AUTH_SHAPE: {} }));

import { executeServiceTransferBatch, registerWriteFlowTools } from '../../src/tools/writeFlow.js';
import { __resetRegistryCacheForTests } from '../../src/governance/pipeline.js';

function audit() { const events: any[] = []; return { events, append: (e: any) => events.push(e), appendDurable: (e: any) => events.push(e) } as any; }
function intent(params: Record<string, unknown>) {
  return createDraftIntent({ consumer_id: 'c1', scope: 'service:transfer_owner', params, naturalKey: 'k', preconditions: {}, projected_effect: 't' });
}
// Fake DB: rows keyed by SELECT; UPDATEs report affectedRows from a map.
function fakeDb(opts: { owner?: number; status?: string; destStatus?: string; srcCur?: string; destCur?: string; serviceGuard?: number } = {}) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const tx: DbTx = {
    async query(sql, params) {
      calls.push({ sql, params });
      const s = sql.replace(/\s+/g, ' ').toLowerCase();
      if (s.startsWith('select') && s.includes('tblhosting'))
        return { affectedRows: 0, rows: [{ id: params[0], userid: opts.owner ?? 1, domainstatus: opts.status ?? 'Active' }] };
      if (s.startsWith('select') && s.includes('tblclients'))
        return { affectedRows: 0, rows: [{ id: params[0], status: 'Active', currency_code: (params[0] === 1 ? (opts.srcCur ?? 'USD') : (opts.destCur ?? 'USD')) }] };
      if (s.startsWith('select') && s.includes('tblinvoice'))
        return { affectedRows: 0, rows: [] };
      if (s.startsWith('update') && s.includes('tblhosting '))
        return { affectedRows: opts.serviceGuard ?? 1, rows: [] };
      return { affectedRows: 1, rows: [] };
    },
  };
  const db = { withTransaction: async <T>(fn: (t: DbTx) => Promise<T>) => fn(tx) };
  return { db, calls };
}
const dbConfigured = () => true;

describe('executeServiceTransferBatch', () => {
  it('returns unsupported_capability when DB not configured', async () => {
    const res = await executeServiceTransferBatch({
      intent: intent({ source_clientid: 1, dest_clientid: 2, service_ids: [10], invoice_mode: 'none' }),
      audit: audit(), isDbConfigured: () => false, getDb: () => { throw new Error('should not be called'); },
    } as any);
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('unsupported_capability');
  });

  it('aborts when service not owned by source', async () => {
    const { db } = fakeDb({ owner: 99 });
    const res = await executeServiceTransferBatch({
      intent: intent({ source_clientid: 1, dest_clientid: 2, service_ids: [10], invoice_mode: 'none' }),
      audit: audit(), isDbConfigured: dbConfigured, getDb: () => db as any,
    } as any);
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('precondition_mismatch');
  });

  it('aborts on currency mismatch', async () => {
    const { db } = fakeDb({ destCur: 'EUR' });
    const res = await executeServiceTransferBatch({
      intent: intent({ source_clientid: 1, dest_clientid: 2, service_ids: [10], invoice_mode: 'none' }),
      audit: audit(), isDbConfigured: dbConfigured, getDb: () => db as any,
    } as any);
    expect(res.reason).toBe('precondition_mismatch');
  });

  it('dry_run previews, no UPDATE issued', async () => {
    const { db, calls } = fakeDb();
    const res = await executeServiceTransferBatch({
      intent: intent({ source_clientid: 1, dest_clientid: 2, service_ids: [10], invoice_mode: 'none', dry_run: true }),
      audit: audit(), isDbConfigured: dbConfigured, getDb: () => db as any,
    } as any);
    expect(res.dry_run).toBe(true);
    expect(calls.some((c) => c.sql.toLowerCase().startsWith('update'))).toBe(false);
  });

  it('commits + verifies on happy path', async () => {
    const { db } = fakeDb();
    const res = await executeServiceTransferBatch({
      intent: intent({ source_clientid: 1, dest_clientid: 2, service_ids: [10, 11], invoice_mode: 'none' }),
      audit: audit(), isDbConfigured: dbConfigured, getDb: () => db as any,
    } as any);
    expect(res.allowed).toBe(true);
    expect(res.phase_2?.committed).toBe(true);
  });

  it('rolls back when a service guard affects 0 rows', async () => {
    const { db } = fakeDb({ serviceGuard: 0 });
    const res = await executeServiceTransferBatch({
      intent: intent({ source_clientid: 1, dest_clientid: 2, service_ids: [10], invoice_mode: 'none' }),
      audit: audit(), isDbConfigured: dbConfigured, getDb: () => db as any,
    } as any);
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('transfer_rolled_back');
  });

  it('BATCH_TOO_LARGE: service_ids > MCP_TRANSFER_MAX_BATCH → batch_too_large, no DB transaction opened', async () => {
    // MCP_TRANSFER_MAX_BATCH is 50 in the mock; 51 ids must be blocked.
    // The batch-size check fires AFTER isDbConfigured() (which passes here via
    // injection), so we verify batch_too_large and confirm no DB call occurred.
    const bigBatch = Array.from({ length: 51 }, (_, i) => i + 1);
    const getDbCalled = { value: false };
    const res = await executeServiceTransferBatch({
      intent: intent({ source_clientid: 1, dest_clientid: 2, service_ids: bigBatch, invoice_mode: 'none' }),
      audit: audit(),
      isDbConfigured: () => true,
      getDb: () => { getDbCalled.value = true; throw new Error('should not open DB'); },
    } as any);
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('batch_too_large');
    // batch_too_large fires before withTransaction — no DB connection opened.
    expect(getDbCalled.value).toBe(false);
  });
});

// ── billing:invoice:reassign execute guard ────────────────────────────────────

interface Res { content: { text: string }[]; isError?: boolean }
const J2 = (r: Res) => JSON.parse(r.content[0].text) as Record<string, unknown>;
const rec2 = (v: unknown) => v as Record<string, unknown>;

function transferHarness() {
  const h: Record<string, (a: Record<string, unknown>) => Promise<Res>> = {};
  const server = {
    registerTool: (n: string, _c: unknown, cb: unknown) => { h[n] = cb as never; },
  };
  const cl = { logToolCall: vi.fn(), logToolResult: vi.fn(), info: vi.fn(), error: vi.fn(), child: () => cl };
  const mutate = vi.fn().mockResolvedValue({ result: 'success' });
  const read = vi.fn().mockResolvedValue({ result: 'success' });
  registerWriteFlowTools(server as never, { mutate, read } as never, { child: () => cl } as never, { tryConsume: () => true } as never);
  return { h, mutate };
}

async function approvedIntent(
  h: Record<string, (a: Record<string, unknown>) => Promise<Res>>,
  scope: string,
  params: Record<string, unknown>,
  nk: string,
) {
  const execTok = { auth_token: TOKEN_RAW };
  const approveTok = { auth_token: APPROVER_RAW };
  const d = await h.draft_write_intent({ scope, params, naturalKey: nk, projected_effect: scope, ...execTok });
  const id = rec2(J2(d).intent).intent_id as string;
  await h.validate_write_intent({ intent_id: id, ...execTok });
  await h.approve_write_intent({ intent_id: id, approver: 'op', decision: 'approved', ...approveTok });
  return { id, execTok };
}

describe('billing:invoice:reassign execute guard (composed-only, v1)', () => {
  it('returns blocked_reason unsupported_capability and never calls whmcs.mutate', async () => {
    __resetRegistryCacheForTests?.();
    const { h, mutate } = transferHarness();
    const { id, execTok } = await approvedIntent(
      h,
      'billing:invoice:reassign',
      { invoice_id: 100, dest_clientid: 2 },
      'reassign-guard-1',
    );
    const e = await h.execute_write_intent({ intent_id: id, ...execTok });
    const ep = J2(e);
    expect(rec2(ep.execution).blocked_reason).toBe('unsupported_capability');
    expect(ep.executed).toBeFalsy();
    expect(mutate).not.toHaveBeenCalled();
  });
});

// ── Full-flow gate tests (via registered handlers) ───────────────────────────

import { config } from '../../src/config.js';

const TRANSFER_PARAMS = { source_clientid: 1, dest_clientid: 2, service_ids: [10], invoice_mode: 'none' as const };

describe('service:transfer_owner — full-flow gate tests', () => {
  beforeEach(() => { __resetRegistryCacheForTests?.(); });

  it('SEALED: production env with empty prod allowlist blocks execute with action_not_prod_authorized', async () => {
    // Temporarily switch to production environment — gate checks MCP_PROD_WRITE_AUTHORIZED
    // (which is [] in the mock) for high-risk intents when env === 'production'.
    const savedEnv = (config as Record<string, unknown>).MCP_ENV;
    (config as Record<string, unknown>).MCP_ENV = 'production';
    try {
      const { h, mutate } = transferHarness();
      // Draft + validate + approve (distinct approver) — all succeed pre-execute.
      const execTok = { auth_token: TOKEN_RAW };
      const approveTok = { auth_token: APPROVER_RAW };
      const d = await h.draft_write_intent({ scope: 'service:transfer_owner', params: TRANSFER_PARAMS, naturalKey: 'sealed-1', projected_effect: 'transfer', ...execTok });
      const id = rec2(J2(d).intent).intent_id as string;
      await h.validate_write_intent({ intent_id: id, ...execTok });
      await h.approve_write_intent({ intent_id: id, approver: 'op', decision: 'approved', ...approveTok });
      const e = await h.execute_write_intent({ intent_id: id, ...execTok });
      const ep = J2(e);
      // Gate must block — the prod allowlist is empty so __db_direct__ is not authorized.
      expect(ep.executed).toBeFalsy();
      expect(rec2(ep.execution).attempted).toBe(false);
      expect(rec2(ep.execution).blocked_reason).toBe('action_not_prod_authorized');
      // KEYSTONE: no WHMCS mutate ever called.
      expect(mutate).not.toHaveBeenCalled();
    } finally {
      (config as Record<string, unknown>).MCP_ENV = savedEnv;
    }
  });

  it('NO_APPROVAL: execute without approve step → blocked (intent_not_approved), no mutation', async () => {
    // The state machine enforces that only an intent in `approved` state may be
    // executed. Attempting execute before approve_write_intent is called yields
    // `intent_not_approved` (the outer guard at executeRun). The inner
    // `human_approval_required` check is an unreachable defense-in-depth path
    // via the public API (approve_write_intent atomically sets both state and
    // the approvals record), so we assert the actual observable gate behavior.
    const { h, mutate } = transferHarness();
    const execTok = { auth_token: TOKEN_RAW };
    const d = await h.draft_write_intent({ scope: 'service:transfer_owner', params: TRANSFER_PARAMS, naturalKey: 'no-approval-1', projected_effect: 'transfer', ...execTok });
    const id = rec2(J2(d).intent).intent_id as string;
    await h.validate_write_intent({ intent_id: id, ...execTok });
    // Execute WITHOUT calling approve_write_intent — intent remains in 'validated' state.
    const e = await h.execute_write_intent({ intent_id: id, ...execTok });
    const ep = J2(e);
    expect(ep.executed).toBeFalsy();
    // intent_not_approved is the enforced gate when the approval step is skipped.
    expect(rec2(ep.execution).blocked_reason).toBe('intent_not_approved');
    expect(mutate).not.toHaveBeenCalled();
  });

  it('SELF_APPROVAL: approval recorded by the same consumer that drafted → blocked_reason self_approval_forbidden', async () => {
    const { h, mutate } = transferHarness();
    const execTok = { auth_token: TOKEN_RAW };
    const d = await h.draft_write_intent({ scope: 'service:transfer_owner', params: TRANSFER_PARAMS, naturalKey: 'self-approve-1', projected_effect: 'transfer', ...execTok });
    const id = rec2(J2(d).intent).intent_id as string;
    await h.validate_write_intent({ intent_id: id, ...execTok });
    // Approve using the SAME token as the drafter (self-approval).
    await h.approve_write_intent({ intent_id: id, approver: 'op', decision: 'approved', ...execTok });
    const e = await h.execute_write_intent({ intent_id: id, ...execTok });
    const ep = J2(e);
    expect(ep.executed).toBeFalsy();
    expect(rec2(ep.execution).blocked_reason).toBe('self_approval_forbidden');
    expect(mutate).not.toHaveBeenCalled();
  });

  it('CAPABILITY_OFF: gate passes but DB not configured → blocked_reason unsupported_capability, no DB call', async () => {
    // In the test environment no DB DSN is set, so isDbConfigured() returns false
    // inside executeServiceTransferBatch (called from the handler without injection).
    // The intent gets past the gate (local env, runtime-authorized __db_direct__,
    // distinct approver) but then hits the DB capability guard.
    const { h, mutate } = transferHarness();
    const { id, execTok } = await approvedIntent(h, 'service:transfer_owner', TRANSFER_PARAMS, 'cap-off-1');
    const e = await h.execute_write_intent({ intent_id: id, ...execTok });
    const ep = J2(e);
    expect(ep.executed).toBeFalsy();
    expect(rec2(ep.execution).blocked_reason).toBe('unsupported_capability');
    // Mutate (WHMCS API) is never called — DB executor gates before any DB op.
    expect(mutate).not.toHaveBeenCalled();
  });

  it('BATCH_TOO_LARGE (full-flow): service_ids exceeding MCP_TRANSFER_MAX_BATCH → blocked, no mutation', async () => {
    // Via full flow the batch check inside executeServiceTransferBatch is reached
    // only after DB capability check. In the test environment DB is unconfigured
    // (empty host/user/name), so the blocked_reason from the full-flow path is
    // unsupported_capability (the capability guard fires first). The separate
    // unit-level BATCH_TOO_LARGE test below verifies batch_too_large directly.
    const bigBatch = Array.from({ length: 51 }, (_, i) => i + 1);
    const { h, mutate } = transferHarness();
    const { id, execTok } = await approvedIntent(
      h,
      'service:transfer_owner',
      { source_clientid: 1, dest_clientid: 2, service_ids: bigBatch, invoice_mode: 'none' },
      'batch-too-large-ff-1',
    );
    const e = await h.execute_write_intent({ intent_id: id, ...execTok });
    const ep = J2(e);
    expect(ep.executed).toBeFalsy();
    // Capability gate fires before batch-size check in the handler path.
    expect(['unsupported_capability', 'batch_too_large']).toContain(rec2(ep.execution).blocked_reason);
    expect(mutate).not.toHaveBeenCalled();
  });
});

// ── Invoice-mode SQL assertions (unit-level via executeServiceTransferBatch) ──

function fakeDbForInvoiceMode() {
  const calls: { sql: string; params: unknown[] }[] = [];
  const tx: DbTx = {
    async query(sql, params) {
      calls.push({ sql, params });
      const s = sql.replace(/\s+/g, ' ').toLowerCase();
      if (s.startsWith('select') && s.includes('tblhosting'))
        return { affectedRows: 0, rows: [{ id: params[0], userid: 1, domainstatus: 'Active' }] };
      if (s.startsWith('select') && s.includes('tblclients'))
        return { affectedRows: 0, rows: [{ id: params[0], status: 'Active', currency_code: 'USD' }] };
      if (s.startsWith('select') && s.includes('tblinvoice'))
        return { affectedRows: 0, rows: [] };
      if (s.startsWith('update') && s.includes('tblhosting '))
        return { affectedRows: 1, rows: [] };
      return { affectedRows: 1, rows: [] };
    },
  };
  const db = { withTransaction: async <T>(fn: (t: DbTx) => Promise<T>) => fn(tx) };
  return { db, calls };
}

function auditForMode() {
  const events: { message?: string; detail?: string; [k: string]: unknown }[] = [];
  return {
    events,
    append: (e: unknown) => events.push(e as typeof events[0]),
    appendDurable: (e: unknown) => events.push(e as typeof events[0]),
  } as any;
}

function intentForMode(invoice_mode: string) {
  return createDraftIntent({
    consumer_id: 'c1',
    scope: 'service:transfer_owner',
    params: { source_clientid: 1, dest_clientid: 2, service_ids: [10], invoice_mode },
    naturalKey: `invoice-mode-${invoice_mode}-${String(Math.random()).slice(2)}`,
    preconditions: {},
    projected_effect: 'transfer',
  });
}

describe('service:transfer_owner — invoice mode SQL (unit-level)', () => {
  it('invoice_mode=none: no invoice SELECT is issued', async () => {
    const { db, calls } = fakeDbForInvoiceMode();
    await executeServiceTransferBatch({
      intent: intentForMode('none'),
      audit: auditForMode(),
      isDbConfigured: () => true,
      getDb: () => db as any,
    } as any);
    const invoiceCalls = calls.filter((c) => c.sql.toLowerCase().includes('tblinvoice'));
    expect(invoiceCalls).toHaveLength(0);
  });

  it('invoice_mode=unpaid_only: invoice SELECT contains AND i.status = \'Unpaid\'', async () => {
    const { db, calls } = fakeDbForInvoiceMode();
    await executeServiceTransferBatch({
      intent: intentForMode('unpaid_only'),
      audit: auditForMode(),
      isDbConfigured: () => true,
      getDb: () => db as any,
    } as any);
    const invoiceCalls = calls.filter((c) => c.sql.toLowerCase().includes('tblinvoice'));
    expect(invoiceCalls.length).toBeGreaterThan(0);
    // Must include the Unpaid status filter.
    expect(invoiceCalls[0].sql).toMatch(/i\.status\s*=\s*'Unpaid'/i);
    // Must NOT be missing the status filter (i.e. no 'all' mode variant).
    expect(invoiceCalls[0].sql).not.toMatch(/AND\s+i\.status\s*=\s*'Unpaid'.*AND\s+i\.status/i);
  });

  it('invoice_mode=all: invoice SELECT has no status filter AND audit emits settled-history WARNING', async () => {
    const { db, calls } = fakeDbForInvoiceMode();
    const auditLog = auditForMode();
    await executeServiceTransferBatch({
      intent: intentForMode('all'),
      audit: auditLog,
      isDbConfigured: () => true,
      getDb: () => db as any,
    } as any);
    const invoiceCalls = calls.filter((c) => c.sql.toLowerCase().includes('tblinvoice'));
    expect(invoiceCalls.length).toBeGreaterThan(0);
    // The 'all' mode must NOT have the Unpaid status filter.
    expect(invoiceCalls[0].sql).not.toMatch(/i\.status\s*=\s*'Unpaid'/i);
    // Audit must contain the settled-history warning.
    const warningEvent = auditLog.events.find(
      (e: Record<string, unknown>) =>
        typeof e === 'object' &&
        JSON.stringify(e).includes('WARNING invoice_mode=all re-owns SETTLED invoices'),
    );
    expect(warningEvent).toBeDefined();
  });
});
