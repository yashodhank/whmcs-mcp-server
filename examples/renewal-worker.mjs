// renewal-worker.mjs — an automated renewal worker's data feed.
//
// READ-ONLY · SYNTHETIC consumer. Connects as `renewal_worker`
// (contract: renewal_automation), calls get_renewal_snapshot, and shows the
// email / domain / expiry fields a renewal job needs to act on (it would
// only *notify*; these examples never write).
//
// Run:  npm run build && node examples/renewal-worker.mjs

import { connectAs, structured, preview, banner } from './_lib.mjs';

const { call, close } = await connectAs(
  'renewal_worker',
  'renewal_automation'
);
try {
  banner('Renewal worker');

  const res = await call('get_renewal_snapshot', { clientid: 1, days: 60 });
  const env = structured(res, 'get_renewal_snapshot');
  const d = env.data ?? {};

  console.log('consumer :', env.consumer);
  console.log('contract :', env.contract);

  console.log('\nRenewal window:');
  console.log('  window_days :', d.window_days);
  console.log('  horizon     :', d.horizon);
  console.log('  truncated   :', d.truncated, '(true ⇒ more may exist)');

  // Each upcoming item carries name (domain/service), due/expiry date and
  // status — exactly what a renewal worker keys its notifications on.
  const upcoming = d.upcoming ?? [];
  console.log(`\nUpcoming renewals (${upcoming.length}, first few):`);
  for (const u of preview(upcoming)) {
    if (typeof u === 'string') {
      console.log('  ', u);
    } else {
      console.log(
        `  [${u.type}] ${u.name}  due=${u.due_date}  status=${u.status}` +
          (u.recurring_amount ? `  amount=${u.recurring_amount}` : '')
      );
    }
  }

  // Client contact (email) for the notification — projected per contract.
  if (d.client) console.log('\nclient (notify target):', d.client);

  if (Array.isArray(d.partial_errors) && d.partial_errors.length) {
    console.log('\npartial_errors:', d.partial_errors);
  }
} finally {
  await close();
}
