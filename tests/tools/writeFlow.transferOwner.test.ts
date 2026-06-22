import { describe, it, expect, vi, beforeAll } from 'vitest';
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
