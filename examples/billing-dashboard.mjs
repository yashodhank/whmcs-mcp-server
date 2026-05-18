// billing-dashboard.mjs — a billing dashboard's data feed.
//
// READ-ONLY · SYNTHETIC consumer. Connects as `billing_dashboard`
// (contract: billing_reconciliation), calls get_billing_snapshot and
// list_client_invoices (limit 3), and shows that financial.reference /
// financial.identifier fields (invoice IDs, balances, totals) are PRESERVED
// for this authorized contract — the dashboard can reconcile against them.
//
// Run:  npm run build && node examples/billing-dashboard.mjs

import { connectAs, structured, preview, banner } from './_lib.mjs';

const { call, close } = await connectAs(
  'billing_dashboard',
  'billing_reconciliation'
);
try {
  banner('Billing dashboard');

  const snapRes = await call('get_billing_snapshot', { clientid: 1 });
  const snap = structured(snapRes, 'get_billing_snapshot');
  const s = snap.data ?? {};

  console.log('consumer :', snap.consumer);
  console.log('contract :', snap.contract, '(financial refs preserved)');

  // Financial summary tiles — amounts/counts retained under this contract.
  console.log('\nBilling snapshot:');
  console.log('  currency       :', s.currency);
  console.log('  credit_balance :', s.credit_balance);
  console.log('  unpaid         :', s.unpaid);
  console.log('  overdue        :', s.overdue);
  console.log('  paid           :', s.paid);
  console.log('  recent_unpaid  :', preview(s.recent_unpaid));
  console.log('  recent_overdue :', preview(s.recent_overdue));

  // List tool: governed list envelope has consumer/contract + projected items.
  const listRes = await call('list_client_invoices', {
    clientid: 1,
    limit: 3,
  });
  const list = structured(listRes, 'list_client_invoices');
  console.log('\nlist_client_invoices (limit 3):');
  console.log('  consumer :', list.consumer);
  console.log('  contract :', list.contract);
  const items = list.items ?? list.data?.items ?? [];
  console.log('  count    :', list.count ?? items.length);
  // financial.reference + financial.amount are kept under this contract. The
  // exact key the projection preserves the invoice reference under can vary,
  // so an app discovers it rather than assuming a fixed name — print the whole
  // projected row so the preserved fields are visible.
  for (const inv of preview(items)) {
    if (typeof inv === 'string') {
      console.log('   ', inv);
    } else {
      const ref =
        inv.invoiceId ??
        inv.invoiceid ??
        inv.id ??
        inv.invoiceNumber ??
        inv.reference ??
        '?';
      console.log(
        `    invoice#${ref} status=${inv.status} ` +
          `total=${inv.total} balance=${inv.balance ?? '-'}`
      );
      console.log('      (projected row:', JSON.stringify(inv) + ')');
    }
  }
} finally {
  await close();
}
