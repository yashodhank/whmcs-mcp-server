// Governed read-only smoke harness (dev/test only, MCP_ENV=local).
// Spawns the built server with governance ON + the synthetic example
// consumer registry, drives it as an MCP client with per-consumer bearer
// tokens, and asserts contract projection / denial / capability behavior
// against the local dev WHMCS. READ-ONLY. No writes. No prod.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createHash } from 'node:crypto';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const RAW = (id) => `EXAMPLE-${id}-SYNTHETIC-DO-NOT-USE-IN-PROD`;
const entry = (id, dc) => ({
  id, token_sha256: sha(RAW(id)), allowedScopes: ['read'],
  defaultContract: dc, allowedContracts: [dc], allowedActions: [],
  writeCapability: 'false', envRestrictions: [], anonymous: false,
});
const REGISTRY = JSON.stringify([
  entry('llm_chat', 'llm_safe_summary'),
  entry('ops_operator', 'ops_operator'),
  entry('billing_dashboard', 'billing_reconciliation'),
  entry('renewal_worker', 'renewal_automation'),
  entry('support_console', 'support_triage'),
]);

const text = (r) => (r?.content?.[0]?.text ?? '');
const j = (r) => { try { return JSON.parse(text(r)); } catch { return text(r); } };
let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log(`  [${c ? 'PASS' : 'FAIL'}] ${m}`); };

const transport = new StdioClientTransport({
  command: 'node', args: ['dist/index.js'],
  env: {
    ...process.env, MCP_ENV: 'local', MCP_MODE: 'read_only',
    MCP_GOVERNANCE_ENABLED: 'true', MCP_ALLOW_ANON_LLM: 'false',
    MCP_CONSUMER_REGISTRY: REGISTRY,
  },
  stderr: 'ignore',
});
const client = new Client({ name: 'gov-smoke', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);
console.log('connected (stdio, MCP_ENV=local, GOVERNANCE=on)');
const call = (name, args = {}) => client.callTool({ name, arguments: args });
const tok = (id) => ({ auth_token: RAW(id) });

// 1. unknown token in (local) governed mode, anon disabled → denied, no data
let r = await call('get_client_details', { clientid: 1, auth_token: 'totally-unknown' });
let p = j(r);
ok(r.isError === true && /consumer_denied|denied/i.test(JSON.stringify(p)) && !p.data,
  `unknown token denied, no data → ${JSON.stringify(p).slice(0, 100)}`);

// 2. llm_chat → llm_safe_summary projection (contract tagged, secrets gone)
r = await call('get_client_details', { clientid: 1, ...tok('llm_chat') });
p = j(r);
ok(!r.isError && p.contract === 'llm_safe_summary' && p.consumer === 'llm_chat' && !!p.data,
  `llm_chat → contract=${p.contract} consumer=${p.consumer}`);
ok(!/password|secret|credential"\s*:/i.test(JSON.stringify(p.data ?? {})),
  'llm_chat: no secret.credential field in projected data');

// 3. ops_operator → ops_operator contract
r = await call('get_client_details', { clientid: 1, ...tok('ops_operator') });
p = j(r);
ok(!r.isError && p.contract === 'ops_operator' && p.consumer === 'ops_operator',
  `ops_operator → contract=${p.contract}`);

// 4. billing_dashboard → billing_reconciliation; invoices carry refs
r = await call('list_client_invoices', { clientid: 1, limit: 3, ...tok('billing_dashboard') });
p = j(r);
ok(!r.isError && p.contract === 'billing_reconciliation',
  `billing_dashboard list_client_invoices → contract=${p.contract} items=${(p.items ?? []).length}`);

// 5. renewal_worker → renewal_automation
r = await call('list_client_domains', { clientid: 1, limit: 3, ...tok('renewal_worker') });
p = j(r);
ok(!r.isError && p.contract === 'renewal_automation',
  `renewal_worker list_client_domains → contract=${p.contract}`);

// 6. support_console → support_triage, ticket thread (free-text preserved for authorized)
r = await call('get_ticket_thread', { ticketid: 1, ...tok('support_console') });
p = j(r);
ok(!r.isError && p.contract === 'support_triage',
  `support_console get_ticket_thread → contract=${p.contract}`);

// 7. caller cannot escalate: llm_chat requests admin_full_trusted → NOT honored
r = await call('get_client_details', { clientid: 1, contract: 'admin_full_trusted', ...tok('llm_chat') });
p = j(r);
ok(!r.isError && p.contract === 'llm_safe_summary',
  `escalation blocked: llm_chat asked admin_full_trusted, got ${p.contract}`);

// 8. capability-shell honesty (unverified action → structured unavailable, no WHMCS call)
r = await call('list_client_transactions', { clientid: 1, ...tok('ops_operator') });
p = j(r);
ok(r.isError === true && p.capability_unavailable === true && p.action === 'GetTransactions' && p.status === 'unverified',
  `list_client_transactions → capability_unavailable status=${p.status}`);

// 9. get_capability_matrix (pure, no WHMCS) — supported + unverified present
r = await call('get_capability_matrix', tok('ops_operator'));
p = j(r);
const caps = Object.fromEntries((p?.data?.capabilities ?? p?.capabilities ?? []).map((c) => [c.action, c.status]));
ok(caps.GetActivityLog === 'supported' && caps.GetTransactions === 'unverified',
  `capability_matrix: GetActivityLog=${caps.GetActivityLog} GetTransactions=${caps.GetTransactions}`);

// 10. small-limit governed reads + aggregators don't error for an authed consumer
for (const [name, args] of [
  ['search_clients', { search: '', limit: 1 }],
  ['list_client_services', { clientid: 1, limit: 3 }],
  ['list_client_orders', { clientid: 1, limit: 3 }],
  ['get_activity_log', { clientid: 1, limit: 3 }],
  ['get_account_360', { clientid: 1, recent: 3 }],
  ['get_billing_snapshot', { clientid: 1 }],
  ['get_support_snapshot', { clientid: 1 }],
  ['get_renewal_snapshot', { clientid: 1 }],
  ['get_activity_timeline', { clientid: 1, limit: 5 }],
  ['get_reconciliation_snapshot', { clientid: 1 }],
  ['get_provisioning_snapshot', { clientid: 1 }],
  ['get_risk_snapshot', { clientid: 1 }],
]) {
  const rr = await call(name, { ...args, ...tok('ops_operator') });
  ok(!rr.isError, `governed ${name} (small limits) → isError=${!!rr.isError}`);
}

// 11. write still blocked under governance ON
r = await call('mark_invoice_paid', { invoiceid: 1, ...tok('ops_operator') });
ok(r.isError && /read_only|not available/i.test(text(r)),
  `read_only blocks write even governed → ${text(r).slice(0, 80)}`);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
await client.close();
process.exit(fail ? 1 : 0);
