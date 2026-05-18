// account360-dashboard.mjs — what an "Account 360" dashboard would render.
//
// READ-ONLY · SYNTHETIC consumer. Connects as `ops_operator`
// (contract: ops_operator), calls get_account_360 for client 1 with a small
// recent window, and prints ONLY the app-usable structured fields a dashboard
// card would show — NOT a raw dump.
//
// Run:  npm run build && node examples/account360-dashboard.mjs

import { connectAs, structured, preview, banner } from './_lib.mjs';

const { call, close } = await connectAs('ops_operator', 'ops_operator');
try {
  banner('Account 360 dashboard');

  const res = await call('get_account_360', { clientid: 1, recent: 3 });
  // App reads result.structuredContent: { entity, consumer, contract, data }.
  const env = structured(res, 'get_account_360');
  const d = env.data ?? {};

  // Provenance an app would surface so users know which governed view this is.
  console.log('consumer :', env.consumer); // who the bearer token resolved to
  console.log('contract :', env.contract); // projection applied to the data
  console.log('entity   :', env.entity);

  // Client identity card (projected per contract — may be masked under
  // stricter contracts; ops_operator keeps it readable).
  console.log('\nClient card:');
  console.log('  client :', d.client ?? '(projected out)');

  // Headline counts a dashboard renders as stat tiles.
  console.log('\nCounts (stat tiles):');
  console.log(' ', d.counts ?? '(projected out)');

  // Recent activity — show the *IDs/shape* an app would link to, not a dump.
  const recent = d.recent ?? {};
  console.log('\nRecent (linked lists, first few):');
  console.log('  services :', preview(recent.services));
  console.log('  domains  :', preview(recent.domains));
  console.log('  invoices :', preview(recent.invoices));
  console.log('  orders   :', preview(recent.orders));
  console.log(
    '  tickets  :',
    preview(recent.tickets?.items ?? recent.tickets),
    recent.tickets?.discovery
      ? `(discovery=${recent.tickets.discovery})`
      : ''
  );

  // Apps MUST surface partial failures rather than silently show zeros.
  if (Array.isArray(d.partial_errors) && d.partial_errors.length) {
    console.log('\npartial_errors (app should badge these):', d.partial_errors);
  }
} finally {
  await close();
}
