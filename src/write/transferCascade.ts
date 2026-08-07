/**
 * Pure SQL cascade for moving a WHMCS service (and its addons, SSL orders, and
 * in-scope invoices) to a new owning client. Owner column is `userid`
 * (verified WHMCS 9 schema). Every UPDATE is guarded by `AND userid = <source>`
 * so a wrong precondition or concurrent change affects 0 rows rather than
 * clobbering another tenant. tblhostingconfigoptions has no owner column (keyed
 * by relid) so it follows the service with no update.
 */
import type { DbTx } from '../whmcs/WhmcsDb.js';

export interface SqlStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

export class TransferRollback extends Error {
  readonly serviceid: number;
  constructor(serviceid: number) {
    super(`transfer_rolled_back: service ${serviceid} ownership guard affected 0 rows`);
    this.name = 'TransferRollback';
    this.serviceid = serviceid;
  }
}

export function buildServiceMoveStatements(
  serviceid: number,
  source: number,
  dest: number,
  invoiceIds: readonly number[]
): SqlStatement[] {
  const out: SqlStatement[] = [
    {
      sql: 'UPDATE tblhosting SET userid = ? WHERE id = ? AND userid = ?',
      params: [dest, serviceid, source],
    },
    {
      sql: 'UPDATE tblhostingaddons SET userid = ? WHERE hostingid = ? AND userid = ?',
      params: [dest, serviceid, source],
    },
    {
      sql: 'UPDATE tblsslorders SET userid = ? WHERE serviceid = ? AND userid = ?',
      params: [dest, serviceid, source],
    },
  ];
  for (const invoiceid of invoiceIds) {
    out.push({
      sql: 'UPDATE tblinvoices SET userid = ? WHERE id = ? AND userid = ?',
      params: [dest, invoiceid, source],
    });
    out.push({
      sql: 'UPDATE tblinvoiceitems SET userid = ? WHERE invoiceid = ? AND userid = ?',
      params: [dest, invoiceid, source],
    });
  }
  return out;
}

/**
 * Run the cascade for every service inside an open transaction. The FIRST
 * statement per service is the tblhosting guard; if it affects 0 rows the
 * service is not owned by source (or was moved concurrently) → throw
 * TransferRollback so the caller's transaction rolls the whole batch back.
 */
export async function runServiceMoves(
  tx: DbTx,
  plans: readonly { serviceid: number; invoiceIds: number[] }[],
  source: number,
  dest: number
): Promise<void> {
  for (const plan of plans) {
    const stmts = buildServiceMoveStatements(plan.serviceid, source, dest, plan.invoiceIds);
    for (let i = 0; i < stmts.length; i++) {
      const res = await tx.query(stmts[i].sql, stmts[i].params as unknown[]);
      if (i === 0 && res.affectedRows === 0) throw new TransferRollback(plan.serviceid);
    }
  }
}
