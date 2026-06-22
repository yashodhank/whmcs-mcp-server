import { describe, it, expect } from 'vitest';
import { executeServiceTransferBatch } from '../../src/tools/writeFlow.js';
import { createDraftIntent } from '../../src/write/intents.js';
import type { DbTx } from '../../src/whmcs/WhmcsDb.js';

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
