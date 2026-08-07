import { describe, it, expect } from 'vitest';
import {
  buildServiceMoveStatements,
  runServiceMoves,
  TransferRollback,
} from '../../src/write/transferCascade.js';
import type { DbTx } from '../../src/whmcs/WhmcsDb.js';

describe('buildServiceMoveStatements', () => {
  it('emits source-guarded updates for service + addons + ssl + each invoice', () => {
    const s = buildServiceMoveStatements(10, 1, 2, [100]);
    const sqls = s.map((x) => x.sql.replace(/\s+/g, ' ').trim());
    expect(sqls).toContain('UPDATE tblhosting SET userid = ? WHERE id = ? AND userid = ?');
    expect(sqls).toContain(
      'UPDATE tblhostingaddons SET userid = ? WHERE hostingid = ? AND userid = ?'
    );
    expect(sqls).toContain('UPDATE tblsslorders SET userid = ? WHERE serviceid = ? AND userid = ?');
    expect(sqls).toContain('UPDATE tblinvoices SET userid = ? WHERE id = ? AND userid = ?');
    expect(sqls).toContain(
      'UPDATE tblinvoiceitems SET userid = ? WHERE invoiceid = ? AND userid = ?'
    );
    // every statement carries dest, key, source — and source guard is present
    expect(s[0].params).toEqual([2, 10, 1]);
  });
  it('omits invoice statements when no invoiceIds', () => {
    const s = buildServiceMoveStatements(10, 1, 2, []);
    expect(s.some((x) => x.sql.includes('tblinvoices'))).toBe(false);
  });
});

describe('runServiceMoves', () => {
  function fakeTx(affectedFor: (sql: string) => number) {
    const calls: { sql: string; params: unknown[] }[] = [];
    const tx: DbTx = {
      async query(sql, params) {
        calls.push({ sql, params });
        return { affectedRows: affectedFor(sql), rows: [] };
      },
    };
    return { tx, calls };
  }
  it('runs all statements when service guard affects a row', async () => {
    const { tx, calls } = fakeTx(() => 1);
    await runServiceMoves(tx, [{ serviceid: 10, invoiceIds: [100] }], 1, 2);
    expect(calls.length).toBe(5);
  });
  it('throws TransferRollback when the service-row guard affects 0 rows', async () => {
    const { tx } = fakeTx((sql) => (sql.includes('tblhosting ') ? 0 : 1));
    await expect(
      runServiceMoves(tx, [{ serviceid: 10, invoiceIds: [] }], 1, 2)
    ).rejects.toBeInstanceOf(TransferRollback);
  });
});
