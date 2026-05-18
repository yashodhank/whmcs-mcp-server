// ops-account360-cli.mjs — an "ops account360" command-line dashboard.
//
// READ-ONLY · SYNTHETIC consumer. A tiny operator CLI: it reads a SYNTHETIC
// clientid from argv (default 1), connects as `ops_operator`
// (contract: ops_operator), and renders a concise operator dashboard from
// get_account_360. It then additionally consumes the FOUR Phase-H promoted
// governed read tools the way an ops tool would:
//
//   list_client_transactions  (tool: list_client_transactions) — list env
//   get_system_stats          (tool: get_stats)                 — single env
//   list_todo_items           (tool: get_todo_items)            — list env
//   list_automation_log       (tool: get_automation_log)        — list env
//
// and explicitly demonstrates the capability_unavailable degrade via
// `list_users` (GetUsers is NOT promoted — it returns a structured
// `{ capability_unavailable:true, action:'GetUsers', status:'unverified',
// retriable:true, guidance }` payload that an app must handle gracefully,
// never treat as data, never crash on).
//
// Every value consumed is `result.structuredContent` (the governed envelope
// an app renders) — NOT scraped human text. Input is SYNTHETIC only: a
// synthetic clientid and the synthetic sha256'd bearer token from _lib.mjs.
// No real credentials or PII. READ-ONLY: no write/mutate action is ever
// called.
//
// Usage:
//   npm run build
//   node examples/ops-account360-cli.mjs [clientid]    # default clientid=1
//
// Verify contract behavior for this example (a clean exposure-audit report
// proves every field this CLI consumes is safe under ops_operator). The
// audit script imports src/**.ts so it runs under the repo's TS runner (tsx):
//   MCP_ENV=local npx tsx scripts/mcp-exposure-audit.mjs ops_operator \
//     get_account_360
//   MCP_ENV=local npx tsx scripts/mcp-exposure-audit.mjs ops_operator \
//     list_client_transactions '{"clientid":1,"limit":5}'
//   MCP_ENV=local npx tsx scripts/mcp-exposure-audit.mjs ops_operator get_stats
//   # Or sweep this consumer across every known tool in one run:
//   MCP_ENV=local npx tsx scripts/mcp-exposure-audit-all.mjs ops_operator

import {
  connectAs,
  structured,
  readCapability,
  printUnavailable,
  preview,
  banner,
} from './_lib.mjs';

// SYNTHETIC clientid only. Parse argv defensively; never accept anything but
// a positive integer, default to the synthetic example client 1.
const argv = process.argv[2];
const parsed = Number.parseInt(argv ?? '', 10);
const CLIENT_ID =
  Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
if (argv !== undefined && CLIENT_ID === 1 && argv !== '1') {
  console.log(
    `(ignoring non-numeric arg "${argv}"; using synthetic clientid 1)`
  );
}

const { call, close } = await connectAs('ops_operator', 'ops_operator');
try {
  banner(`ops account360 CLI — synthetic client ${CLIENT_ID}`);

  // ── 1. Operator dashboard from get_account_360 ─────────────────────────
  const a360Res = await call('get_account_360', {
    clientid: CLIENT_ID,
    recent: 5,
  });
  const a360 = structured(a360Res, 'get_account_360');
  const d = a360.data ?? {};

  console.log('consumer :', a360.consumer);
  console.log('contract :', a360.contract);

  const c = d.client ?? {};
  console.log('\n┌─ Client');
  console.log(`│  #${c.clientid ?? '?'}  ${c.name ?? '(projected)'}`);
  console.log(`│  status=${c.status ?? '?'}  ` +
    `credit=${c.credit_balance ?? '?'} ${c.currency ?? ''}`);

  const k = d.counts ?? {};
  console.log('├─ Stat tiles');
  console.log(`│  services  active=${k.services_active ?? 0}/` +
    `${k.services_total ?? 0}`);
  console.log(`│  domains   active=${k.domains_active ?? 0}/` +
    `${k.domains_total ?? 0}`);
  console.log(`│  invoices  unpaid=${k.unpaid_invoices ?? 0} ` +
    `overdue=${k.overdue_invoices ?? 0}`);
  console.log(`│  tickets   active=${k.active_tickets ?? 0}`);

  const rec = d.recent ?? {};
  console.log('└─ Recent (linked IDs an operator drills into)');
  console.log('   services :', preview(rec.services));
  console.log('   domains  :', preview(rec.domains));
  console.log('   invoices :', preview(rec.invoices));
  console.log('   orders   :', preview(rec.orders));
  console.log('   tickets  :', preview(rec.tickets?.items ?? rec.tickets));

  if (Array.isArray(d.partial_errors) && d.partial_errors.length) {
    console.log('\npartial_errors (operator should badge these):',
      d.partial_errors);
  }

  // ── 2. The FOUR Phase-H promoted governed reads ────────────────────────
  // These are now REAL governed read tools (they call WHMCS and return
  // governed structuredContent). An ops tool consumes the governed
  // envelope, never the text mirror.

  // list_client_transactions → governed LIST envelope
  //   { consumer, contract, items:[...], count, limit, offset }
  console.log('\n[promoted] list_client_transactions');
  const txRes = await call('list_client_transactions', {
    clientid: CLIENT_ID,
    limit: 5,
  });
  const txR = readCapability(txRes);
  if (txR.kind === 'data') {
    const e = txR.env;
    const items = e.items ?? e.data?.items ?? [];
    console.log(`  contract=${e.contract} count=${e.count ?? items.length} ` +
      `limit=${e.limit} offset=${e.offset}`);
    console.log('  items :', preview(items));
  } else if (txR.kind === 'unavailable') {
    printUnavailable('  list_client_transactions', txR.cap);
    console.log('  → ops behavior: omit the transactions panel; not data.');
  } else {
    console.log('  governed error:', txR.status ?? '', txR.error ?? '');
  }

  // get_stats → governed SINGLE/aggregator envelope { entity, data:{metrics} }
  console.log('\n[promoted] get_stats (system/income statistics)');
  const statsRes = await call('get_stats', {});
  const statsR = readCapability(statsRes);
  if (statsR.kind === 'data') {
    const mx = statsR.env.data?.metrics ?? statsR.env.data ?? {};
    console.log(`  contract=${statsR.env.contract}`);
    console.log('  income_thismonth :', mx.income_thismonth ?? '(n/a)');
    console.log('  income_thisyear  :', mx.income_thisyear ?? '(n/a)');
    console.log('  orders_pending   :', mx.orders_pending ?? '(n/a)');
    console.log('  tickets_open     :', mx.tickets_open ?? '(n/a)');
    console.log('  todoitems_due    :', mx.todoitems_due ?? '(n/a)');
  } else if (statsR.kind === 'unavailable') {
    printUnavailable('  get_stats', statsR.cap);
  } else {
    console.log('  governed error:', statsR.status ?? '', statsR.error ?? '');
  }

  // get_todo_items → governed LIST envelope
  console.log('\n[promoted] get_todo_items (admin to-do)');
  const todoRes = await call('get_todo_items', { limit: 5 });
  const todoR = readCapability(todoRes);
  if (todoR.kind === 'data') {
    const e = todoR.env;
    const items = e.items ?? e.data?.items ?? [];
    console.log(`  contract=${e.contract} count=${e.count ?? items.length}`);
    console.log('  items :', preview(items));
  } else if (todoR.kind === 'unavailable') {
    printUnavailable('  get_todo_items', todoR.cap);
  } else {
    console.log('  governed error:', todoR.status ?? '', todoR.error ?? '');
  }

  // get_automation_log → governed LIST envelope
  console.log('\n[promoted] get_automation_log (cron/automation)');
  const autoRes = await call('get_automation_log', { limit: 5 });
  const autoR = readCapability(autoRes);
  if (autoR.kind === 'data') {
    const e = autoR.env;
    const items = e.items ?? e.data?.items ?? [];
    console.log(`  contract=${e.contract} count=${e.count ?? items.length}`);
    console.log('  items :', preview(items));
  } else if (autoR.kind === 'unavailable') {
    printUnavailable('  get_automation_log', autoR.cap);
  } else {
    console.log('  governed error:', autoR.status ?? '', autoR.error ?? '');
  }

  // ── 3. capability_unavailable degrade demo: list_users ─────────────────
  // GetUsers is NOT promoted. The tool returns a structured
  // capability_unavailable payload (SDK marks it isError:true). An ops tool
  // must branch on capability_unavailable===true and degrade — never crash,
  // never render the payload as if it were user records.
  console.log('\n[unpromoted] list_users — capability_unavailable degrade');
  const usersRes = await call('list_users', { limit: 5 });
  const u = readCapability(usersRes);
  if (u.kind === 'unavailable' && u.cap.capability_unavailable === true) {
    printUnavailable('  list_users', u.cap);
    console.log(
      '  → ops behavior: hide the Users tab and show "unverified on this ' +
        `build${u.cap.retriable ? ' (retriable after operator probe)' : ''}". ` +
        'No fabricated rows are ever shown.'
    );
  } else if (u.kind === 'data') {
    console.log('  GetUsers is promoted on this build — rendering user data.');
  } else {
    console.log('  governed error:', u.status ?? '', u.error ?? '');
  }

  console.log('\nCLI complete — every value above came from ' +
    'structuredContent (governed envelope), no text scraping.');
} finally {
  await close();
}
