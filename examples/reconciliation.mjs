// reconciliation.mjs — a finance reconciliation job's data feed.
//
// READ-ONLY · SYNTHETIC consumer. Connects as `ops_operator`
// (contract: ops_operator), calls get_reconciliation_snapshot, and shows:
//   * invoice references/balances an app reconciles against, AND
//   * the structured `transactions: { capability_unavailable: true, ... }`
//     section. The server NEVER fakes or throws for an unverified capability —
//     it returns it as a structured block, and APPS MUST HANDLE IT (degrade,
//     not crash; reconcile invoices regardless).
//
// Run:  npm run build && node examples/reconciliation.mjs

import { connectAs, structured, preview, banner } from './_lib.mjs';

const { call, close } = await connectAs('ops_operator', 'ops_operator');
try {
  banner('Reconciliation snapshot');

  const res = await call('get_reconciliation_snapshot', { clientid: 1 });
  const env = structured(res, 'get_reconciliation_snapshot');
  const d = env.data ?? {};

  console.log('consumer :', env.consumer);
  console.log('contract :', env.contract);

  // Invoice references — financial.reference/identifier preserved so a
  // reconciliation job can match by invoiceid + balance/status.
  const invoices = d.invoices ?? [];
  console.log(`\nInvoices (${invoices.length}, first few):`);
  for (const inv of preview(invoices)) {
    if (typeof inv === 'string') {
      console.log('  ', inv);
    } else {
      console.log(
        `  invoice#${inv.invoiceid} status=${inv.status} ` +
          `total=${inv.total} balance=${inv.balance} datepaid=${inv.datepaid ?? '-'}`
      );
    }
  }
  console.log('\nsource_invoice_ids:', preview(d.source_invoice_ids, 8));

  // The capability-gated section. An app MUST check this shape and degrade
  // gracefully — it is NOT an error and NOT data; transactions simply could
  // not be verified, so the job continues with invoices alone.
  const tx = d.transactions ?? {};
  console.log('\ntransactions section (apps MUST handle this):');
  console.log('  capability_unavailable :', tx.capability_unavailable);
  console.log('  action                 :', tx.action);
  console.log('  status                 :', tx.status);
  if (tx.note) console.log('  note                   :', tx.note);
  if (tx.capability_unavailable) {
    console.log(
      '  → app behavior: reconcile invoices only; flag transactions as ' +
        'unverified rather than failing the run.'
    );
  }

  if (Array.isArray(d.partial_errors) && d.partial_errors.length) {
    console.log('\npartial_errors:', d.partial_errors);
  }
} finally {
  await close();
}
