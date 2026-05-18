// reconciliation.mjs — a finance reconciliation job's data feed.
//
// READ-ONLY · SYNTHETIC consumer. Connects as `ops_operator`
// (contract: ops_operator), calls the Phase-H-upgraded
// get_reconciliation_snapshot, and demonstrates BOTH runtime shapes the
// server can honestly return:
//
//   * COMPOSED (GetTransactions supported): invoices + a transactions
//     summary + `reconciliation_ledger` with matched / unmatched /
//     duplicate-risk / unpaid-with-recent-payment signals and source
//     transaction IDs — exactly what a reconciliation job acts on.
//   * DEGRADED (GetTransactions NOT supported): the structured
//     `transactions: { capability_unavailable: true, ... }` block. The
//     server NEVER fakes or throws for an unverified capability; the job
//     reconciles invoices alone and flags transactions unverified.
//
// In either path it also surfaces the WHMCS 9 immutability caveat and the
// `ledger_adjustments` credit/debit-note capability marker, and explicitly
// demonstrates a capability_unavailable degrade via `list_users` (GetUsers
// is NOT promoted). All input is SYNTHETIC (clientid 1; synthetic token).
//
// Verify contract behavior for this example (a clean exposure-audit report
// proves every emitted field is safe under the ops_operator contract — e.g.
// invoices[].* financial.reference allowed, secrets dropped). The audit
// script imports src/**.ts so it runs under the repo's TS runner (tsx):
//   npm run build
//   MCP_ENV=local npx tsx scripts/mcp-exposure-audit.mjs \
//     ops_operator get_reconciliation_snapshot
//   # Sweep every consumer × tool at once (companion batch runner):
//   MCP_ENV=local npx tsx scripts/mcp-exposure-audit-all.mjs '' \
//     get_reconciliation_snapshot
//
// Run:  npm run build && node examples/reconciliation.mjs

import {
  connectAs,
  structured,
  readCapability,
  printUnavailable,
  preview,
  banner,
} from './_lib.mjs';

const { call, close } = await connectAs('ops_operator', 'ops_operator');
try {
  banner('Reconciliation snapshot');

  const res = await call('get_reconciliation_snapshot', { clientid: 1 });
  // App reads result.structuredContent: { entity, consumer, contract, data }.
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
          `total=${inv.total} balance=${inv.balance ?? '-'} ` +
          `datepaid=${inv.datepaid ?? '-'}`
      );
    }
  }
  console.log('\nsource_invoice_ids:', preview(d.source_invoice_ids, 8));

  // ── The capability-gated transactions section. An app MUST branch on the
  //    shape: it is either a COMPOSED summary or a structured
  //    capability_unavailable block — never an error, never fabricated. ──
  const tx = d.transactions ?? {};
  console.log('\ntransactions section (apps MUST handle this):');

  if (tx.capability_unavailable) {
    // DEGRADED PATH — GetTransactions not supported on this build.
    printUnavailable('  transactions', tx);
    console.log(
      '  → app behavior: reconcile invoices only; flag transactions as ' +
        'unverified rather than failing the run. (No transaction matching ' +
        'is attempted — the server made no GetTransactions call.)'
    );
  } else {
    // COMPOSED PATH — GetTransactions supported (Phase H promoted).
    console.log('  composed summary (no raw gateway/transid in this block):');
    console.log(
      `    action=${tx.action} status=${tx.status} ` +
        `composed=${tx.composed} count=${tx.count} bounded=${tx.bounded}`
    );
    console.log(
      '  source_transaction_ids:',
      preview(d.source_transaction_ids, 8)
    );

    // reconciliation_ledger carries the per-row detail + matching analysis.
    // It is classified system.audit: preserved for ops_operator /
    // billing_reconciliation, dropped for llm_safe_summary. The job acts on
    // these four signals:
    const led = d.reconciliation_ledger ?? {};
    const m = led.matching ?? {};
    console.log('\n  reconciliation_ledger.matching (the job acts on these):');
    console.log(
      '    matched                    :',
      (m.matched ?? []).length,
      preview(m.matched)
    );
    console.log(
      '    unmatched_transaction_ids  :',
      preview(m.unmatched_transaction_ids, 8),
      '(no invoice for these txns ⇒ investigate)'
    );
    const dup = m.duplicate_risk ?? [];
    console.log(
      '    duplicate_risk groups      :',
      dup.length,
      dup.length
        ? preview(dup) + ' (RISK SIGNAL — same invoice+amount near in time)'
        : '(none)'
    );
    const stale = m.unpaid_with_recent_payment ?? [];
    console.log(
      '    unpaid_with_recent_payment :',
      stale.length,
      stale.length
        ? preview(stale) + ' (likely stale invoice status — human review)'
        : '(none)'
    );
    if (led.bounded) {
      console.log('    bounded                    : true');
      console.log('    bounded_note               :', led.bounded_note);
      console.log(
        '    → app behavior: treat matching as over the bounded window ' +
          'ONLY; not a full-ledger guarantee.'
      );
    }
  }

  // WHMCS 9 immutability caveat — ALWAYS present (public.safe), never faked.
  const w9 = d.whmcs9_notice ?? {};
  console.log('\nwhmcs9_notice (reconcile via credit/debit notes, not edits):');
  console.log(
    '  immutable_non_draft_invoices       :',
    w9.immutable_non_draft_invoices
  );
  console.log(
    '  corrections_via_credit_debit_notes :',
    w9.corrections_via_credit_debit_notes
  );
  console.log('  note :', w9.note);

  // ledger_adjustments — a structured capability_unavailable marker. An app
  // must NOT read empty canonical_notes as "no adjustments"; it is
  // unverified, not zero.
  const adj = d.ledger_adjustments ?? {};
  console.log('\nledger_adjustments (capability marker — handle, not assume):');
  console.log('  capability :', adj.capability);
  console.log('  status     :', adj.status);
  console.log(
    '  canonical_notes:',
    Array.isArray(adj.canonical_notes)
      ? `[] (UNVERIFIED — do NOT treat as "no credit/debit notes")`
      : adj.canonical_notes
  );

  if (Array.isArray(d.partial_errors) && d.partial_errors.length) {
    console.log('\npartial_errors:', d.partial_errors);
  }

  // Explicit capability_unavailable degrade: list_users (GetUsers NOT
  // promoted) returns a structured unavailable payload (SDK isError:true),
  // NOT data. A reconciliation job must branch and continue.
  const usersRes = await call('list_users', { limit: 3 });
  const u = readCapability(usersRes);
  if (u.kind === 'unavailable') {
    printUnavailable('list_users (degrade demo)', u.cap);
    console.log('  → app behavior: skip user enrichment; reconcile anyway.');
  } else if (u.kind === 'data') {
    console.log('\nlist_users: returned data (GetUsers promoted on this build).');
  } else {
    console.log('\nlist_users: governed error', u.status ?? '', u.error ?? '');
  }
} finally {
  await close();
}
