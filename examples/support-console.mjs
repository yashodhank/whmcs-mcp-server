// support-console.mjs — a support agent console's data feed.
//
// READ-ONLY · SYNTHETIC consumer. Connects as `support_console`
// (contract: support_triage), calls get_support_snapshot and
// get_ticket_thread, and shows that ticket free-text (subjects/messages) is
// PRESERVED for this authorized contract — a triage console needs to read it.
//
// Run:  npm run build && node examples/support-console.mjs

import { connectAs, structured, preview, banner } from './_lib.mjs';

const { call, close } = await connectAs('support_console', 'support_triage');
try {
  banner('Support console');

  const snapRes = await call('get_support_snapshot', { clientid: 1 });
  const snap = structured(snapRes, 'get_support_snapshot');
  const s = snap.data ?? {};

  console.log('consumer :', snap.consumer);
  console.log('contract :', snap.contract, '(ticket free-text preserved)');

  console.log('\nSupport snapshot:');
  console.log('  departments       :', preview(s.departments));
  console.log('  departments_scope :', s.departments_scope);
  const ct = s.client_tickets ?? {};
  console.log('  client_tickets    :', preview(ct.items ?? ct));
  if (ct.discovery) console.log('  discovery         :', ct.discovery);

  // get_ticket_thread: the actual conversation. Under support_triage the
  // untrusted.free_text (subject/messages) is retained so an agent can read
  // the thread for the authorized contract.
  const threadRes = await call('get_ticket_thread', { ticketid: 1 });
  const thread = structured(threadRes, 'get_ticket_thread');
  const t = thread.data ?? thread;
  console.log('\nget_ticket_thread(1):');
  console.log('  consumer :', thread.consumer);
  console.log('  contract :', thread.contract);
  // Show that content is present (truncated) — not masked away.
  const subject = t.subject ?? t.ticket?.subject;
  const messages = t.messages ?? t.replies ?? t.ticket?.messages;
  console.log('  subject  :', subject ?? '(none / projected)');
  console.log(
    '  messages :',
    Array.isArray(messages)
      ? preview(
          messages.map((m) =>
            typeof m === 'string'
              ? m.slice(0, 80)
              : { author: m.admin ?? m.name ?? m.email, msg: String(m.message ?? '').slice(0, 80) }
          )
        )
      : '(none / projected)'
  );
} finally {
  await close();
}
