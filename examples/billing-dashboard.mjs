// billing-dashboard.mjs — a billing dashboard's data feed.
//
// READ-ONLY · SYNTHETIC consumer. Connects as `billing_dashboard`
// (contract: billing_reconciliation), calls get_billing_snapshot,
// list_client_invoices (limit 3), and the Phase-H-upgraded
// get_reconciliation_snapshot. Shows that financial.reference /
// financial.identifier fields (invoice IDs, balances, totals) are PRESERVED
// for this authorized contract, that the reconciler can read the detailed
// `reconciliation_ledger` matching analysis (system.audit ⇒ allowed for
// billing_reconciliation), and that the dashboard surfaces the WHMCS 9
// invoice-immutability caveat + the structured (never faked) credit/debit-note
// `ledger_adjustments` capability_unavailable block.
//
// All input is SYNTHETIC (clientid 1; synthetic bearer token via _lib.mjs).
//
// Verify contract behavior for this example (clean report ⇒ every emitted
// field is safe under billing_reconciliation; financial refs preserved,
// pii.* masked/dropped, secrets dropped). The audit script imports src/**.ts
// so it runs under the repo's TS runner (tsx):
//   npm run build
//   MCP_ENV=local npx tsx scripts/mcp-exposure-audit.mjs \
//     billing_dashboard get_reconciliation_snapshot
//   MCP_ENV=local npx tsx scripts/mcp-exposure-audit.mjs \
//     billing_dashboard list_client_invoices '{"clientid":1,"limit":3}'
//
// Run:  npm run build && node examples/billing-dashboard.mjs

import {
  connectAs,
  structured,
  readCapability,
  printUnavailable,
  preview,
  banner,
} from './_lib.mjs';

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

  // ── Phase H: upgraded get_reconciliation_snapshot ──────────────────────
  // When GetTransactions is supported the server composes transactions and
  // matches them to invoices; billing_reconciliation may read the detailed
  // ledger (system.audit ⇒ allowed). A reconciliation UI consumes the
  // matching signals AND must surface the WHMCS 9 immutability caveat plus
  // the structured credit/debit-note capability marker.
  const recRes = await call('get_reconciliation_snapshot', { clientid: 1 });
  const rec = structured(recRes, 'get_reconciliation_snapshot');
  const r = rec.data ?? {};

  console.log('\nget_reconciliation_snapshot:');
  console.log('  consumer :', rec.consumer);
  console.log('  contract :', rec.contract);

  const tx = r.transactions ?? {};
  if (tx.capability_unavailable) {
    // Degraded path: GetTransactions NOT supported on this build. The
    // dashboard reconciles invoices alone and badges transactions unverified.
    printUnavailable('  transactions section', tx);
    console.log(
      '  → dashboard behavior: reconcile invoices only; mark transaction ' +
        'matching as unverified rather than failing the panel.'
    );
  } else {
    console.log('  transactions (composed summary, no raw gateway/transid):');
    console.log(`    action=${tx.action} status=${tx.status} ` +
      `composed=${tx.composed} count=${tx.count} bounded=${tx.bounded}`);
    console.log('  source_transaction_ids:', preview(r.source_transaction_ids, 8));

    // reconciliation_ledger is system.audit → PRESERVED for this contract
    // (an LLM consumer would have it dropped). Matching signals a finance
    // reviewer acts on:
    const led = r.reconciliation_ledger ?? {};
    const m = led.matching ?? {};
    console.log('  reconciliation_ledger.matching:');
    console.log('    matched                    :', (m.matched ?? []).length);
    console.log('    unmatched_transaction_ids  :', preview(m.unmatched_transaction_ids, 8));
    console.log('    duplicate_risk groups      :', (m.duplicate_risk ?? []).length,
      (m.duplicate_risk ?? []).length ? preview(m.duplicate_risk) : '');
    console.log('    unpaid_with_recent_payment :', (m.unpaid_with_recent_payment ?? []).length,
      (m.unpaid_with_recent_payment ?? []).length ? preview(m.unpaid_with_recent_payment) : '');
    if (led.bounded) console.log('    bounded_note               :', led.bounded_note);
  }

  // WHMCS 9 immutability caveat — ALWAYS emitted (public.safe), never faked.
  // A billing UI must show this so a user does not assume invoice edits.
  const w9 = r.whmcs9_notice ?? {};
  console.log('\n  whmcs9_notice (caveat the UI must show):');
  console.log('    immutable_non_draft_invoices    :', w9.immutable_non_draft_invoices);
  console.log('    corrections_via_credit_debit_notes:', w9.corrections_via_credit_debit_notes);
  console.log('    note :', w9.note);

  // ledger_adjustments: a structured capability_unavailable marker (no
  // verified WHMCS read for credit/debit notes). The app must NOT treat the
  // empty canonical_notes as "no adjustments" — it is unverified, not zero.
  const adj = r.ledger_adjustments ?? {};
  console.log('\n  ledger_adjustments (capability marker — handle, not assume):');
  console.log('    capability     :', adj.capability);
  console.log('    status         :', adj.status, '(capability_unavailable)');
  console.log('    canonical_notes:', Array.isArray(adj.canonical_notes)
    ? `[] (length ${adj.canonical_notes.length}) — UNVERIFIED, not "no notes"`
    : adj.canonical_notes);
  console.log('    → dashboard behavior: show "credit/debit notes unavailable ' +
    'on this build"; do NOT render 0 adjustments as a reconciled fact.');

  if (Array.isArray(r.partial_errors) && r.partial_errors.length) {
    console.log('\n  partial_errors:', r.partial_errors);
  }

  // Demonstrate the capability_unavailable degrade explicitly: list_users
  // (GetUsers is NOT promoted) returns a structured unavailable payload, NOT
  // data — a billing app must branch on it gracefully.
  const usersRes = await call('list_users', { limit: 3 });
  const u = readCapability(usersRes);
  if (u.kind === 'unavailable') {
    printUnavailable('list_users', u.cap);
    console.log('  → app behavior: skip the users panel; do not treat as data.');
  } else if (u.kind === 'data') {
    console.log('\nlist_users: returned data (GetUsers promoted on this build).');
  } else {
    console.log('\nlist_users: governed error', u.status ?? '', u.error ?? '');
  }
} finally {
  await close();
}
