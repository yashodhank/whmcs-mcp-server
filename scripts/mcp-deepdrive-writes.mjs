// Deep-drive WRITE harness (DEV WHMCS ONLY, both legs). Run via tsx.
//
// Drives the BUILT MCP server end-to-end with governance ON and write
// execution FULLY ARMED (MCP_MODE=full, all actions runtime-authorized, high
// caps, a consumer cleared for execution + granted every write scope), then
// runs EVERY governed write scope through draft -> validate -> approve ->
// execute against the local dev WHMCS, with read-back + cleanup.
//
// SAFETY: hard-refuses any non-localhost target. Operates on the existing
// seeded client 1 (phone captured + restored), self-created invoice/ticket/
// quote, and reversible domain toggles (captured + restored). Destructive /
// charging scopes are driven through the FULL gate but are EXPECTED to
// hard-block (PROD_NEVER_EXECUTABLE) or cap-deny (high-risk w/o a bounding
// amount); those denials are the system working.
//
// Outcome classes:
//   EXECUTED    — gate authorized AND WHMCS performed the write (read-back ok).
//   GATE-OK     — gate authorized; WHMCS rejected downstream (dev env: e.g.
//                 "Module Not Found" — no real provisioning server; or the
//                 welcome-email storage bug on AddClient). Governed path proven.
//   DESIGN-DENY — gate correctly STOPPED a destructive/uncapped high-risk op.
//   FAIL        — draft/validate/approve broke, or an UNEXPECTED gate block, or
//                 an expected-deny that slipped through.
//
// Source .env.local first; select leg via WHMCS_API_URL.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createHash } from 'node:crypto';
import { SCOPE_ACTION } from '../src/write/types.js';

const LEG = process.env.WHMCS_API_URL ?? 'http://localhost:8890';
const host = (() => { try { return new URL(LEG).hostname; } catch { return ''; } })();
if (!['localhost', '127.0.0.1'].includes(host)) {
  console.error(`REFUSED: WHMCS_API_URL host "${host}" is not localhost — dev-only harness.`);
  process.exit(2);
}
const ID = process.env.WHMCS_IDENTIFIER, SEC = process.env.WHMCS_SECRET;
if (!ID || !SEC) { console.error('REFUSED: source .env.local.'); process.exit(2); }
const API = `${LEG.replace(/\/$/, '')}/includes/api.php`;
const PORT = new URL(LEG).port;

async function raw(action, params = {}) {
  const body = new URLSearchParams({ action, identifier: ID, secret: SEC, responsetype: 'json' });
  for (const [k, v] of Object.entries(params)) body.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  const r = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  try { return JSON.parse(await r.text()); } catch { return { result: 'non-json' }; }
}

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const RAW_TOKEN = 'DEEPDRIVE-writer-SYNTHETIC-DEV-ONLY';
const ALL_ACTIONS = [...new Set(Object.values(SCOPE_ACTION))];
const REGISTRY = JSON.stringify([{
  id: 'deepdrive', token_sha256: sha(RAW_TOKEN), allowedScopes: ['read', 'write'],
  defaultContract: 'ops_operator', allowedContracts: ['ops_operator'],
  allowedActions: [], writeCapability: 'execution_allowed', envRestrictions: [], anonymous: false,
  allowedWriteScopes: Object.keys(SCOPE_ACTION),
}]);

const transport = new StdioClientTransport({
  command: 'node', args: ['dist/index.js'],
  env: {
    ...process.env, MCP_ENV: 'local', MCP_MODE: 'full', MCP_GOVERNANCE_ENABLED: 'true',
    MCP_RATE_LIMIT: '100000',
    MCP_WRITE_EXECUTION_AUTHORIZED: [...ALL_ACTIONS, ...Object.keys(SCOPE_ACTION)].join(','),
    MCP_PROD_HIGH_RISK_PER_ACTION_CAP: '1000000000',
    MCP_PROD_HIGH_RISK_DAILY_CAP: '1000000000000',
    MCP_WRITE_STRICT_ALLOWLIST: 'false',
    MCP_CONSUMER_REGISTRY: REGISTRY,
  },
  stderr: 'ignore',
});
const client = new Client({ name: 'deepdrive-writes', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);

const text = (r) => r?.content?.[0]?.text ?? '';
const j = (r) => { try { return JSON.parse(text(r)); } catch { return text(r); } };
const callTool = (n, a = {}) => client.callTool({ name: n, arguments: { ...a, auth_token: RAW_TOKEN } });

const GATE_BLOCKS = new Set(['read_only_mode', 'intent_not_approved', 'consumer_not_execution_allowed',
  'action_not_runtime_authorized', 'action_not_prod_authorized']);
const STOPS = new Set(['action_permanently_blocked', 'amount_cap_exceeded', 'target_amount_cap_exceeded']);

const results = [];
function record(scope, klass, detail) {
  const tag = { EXECUTED: '✓ EXECUTED', 'GATE-OK': '✓ GATE-OK', 'DESIGN-DENY': '◑ DESIGN-DENY', FAIL: '✗ FAIL' }[klass];
  results.push({ scope, klass, detail });
  console.log(`  [${tag}] ${scope.padEnd(28)} ${detail}`);
}

// expect: 'pass' (gate must authorize) | 'deny' (gate must stop)
async function run(scope, params, { expect = 'pass', verify } = {}) {
  const nat = `dd|${scope}|${PORT}`;
  const d = j(await callTool('draft_write_intent', { scope, params, naturalKey: nat, projected_effect: `deepdrive ${scope}` }));
  const id = d.intent?.intent_id;
  if (!id) return record(scope, 'FAIL', `draft failed: ${JSON.stringify(d.error ?? d).slice(0, 120)}`);
  const v = j(await callTool('validate_write_intent', { intent_id: id }));
  if (!v.validation?.ok) return record(scope, 'FAIL', `validate: ${JSON.stringify(v.validation?.issues ?? v.error).slice(0, 130)}`);
  const a = j(await callTool('approve_write_intent', { intent_id: id, approver: 'deepdrive-op', decision: 'approved' }));
  if (a.intent?.state !== 'approved') return record(scope, 'FAIL', `approve: ${a.error ?? a.intent?.state}`);
  const e = j(await callTool('execute_write_intent', { intent_id: id }));
  const blocked = e.execution?.blocked_reason;

  if (expect === 'deny') {
    if (e.executed === false && (STOPS.has(blocked) || blocked === 'action_permanently_blocked'))
      return record(scope, 'DESIGN-DENY', `gate stop = ${blocked} (expected)`);
    return record(scope, 'FAIL', `expected gate deny, got executed=${e.executed} reason=${blocked}`);
  }
  // expect pass: gate must authorize (no gate-level block / stop).
  if (blocked && (GATE_BLOCKS.has(blocked) || STOPS.has(blocked)))
    return record(scope, 'FAIL', `unexpected gate stop: ${blocked}`);
  if (e.executed === true) {
    let vinfo = '';
    if (verify) { try { vinfo = await verify(); } catch (err) { vinfo = `verify-err:${err.message}`; } }
    return record(scope, 'EXECUTED', `verified=${e.execution?.verified ?? 'n/a'} ${vinfo}`);
  }
  // gate authorized but WHMCS rejected downstream (dev env / data).
  return record(scope, 'GATE-OK', `gate authorized; WHMCS rejected: ${e.execution?.note ?? blocked ?? e.error ?? 'whmcs-error'}`);
}

console.log(`\n################ WRITE deep-drive @ ${API} (host=${host}:${PORT}) ################`);

const TCID = 1; // existing seeded client (AddClient blocked by dev email-storage bug → see client:create)
const before1 = await raw('GetClientsDetails', { clientid: TCID });
const ORIG_PHONE = before1.client?.phonenumber ?? '';
const inv = await raw('CreateInvoice', { userid: TCID, status: 'Unpaid', itemdescription1: 'DeepDrive', itemamount1: '10.00', itemtaxed1: 0 });
const INVID = Number(inv.invoiceid);
console.log(`seed: target client ${TCID}, test invoice ${INVID} (${inv.result})`);

// ── client / notes (low/medium) ──────────────────────────────────────────────
await run('client_note:write', { clientid: TCID, note: 'deepdrive note' });
await run('client:update', { clientid: TCID, phonenumber: '+19999999999' },
  { verify: async () => { const g = await raw('GetClientsDetails', { clientid: TCID }); return `phone=${g.client?.phonenumber}`; } });
// NOTE: email/suffix kept SHORT on purpose — a 13–19 digit run (e.g. a raw
// Date.now() timestamp) is in credit-card-number length range and the
// write-path PAN scanner will (correctly) reject the draft.
const sfx = Math.random().toString(36).slice(2, 8);
await run('client:create', // expected GATE-OK on dev: AddClient blocked by email-attachment-storage bug
  { firstname: 'DD', lastname: 'Created', email: `dd-${PORT}-${sfx}@example.invalid`, password2: 'Dd!xY7zz99', address1: '1 St', city: 'T', state: 'TS', postcode: '12345', country: 'IN', phonenumber: '+1-555-0100' });

// ── ticket lifecycle (self-created) ──────────────────────────────────────────
let TKID;
{
  const d = j(await callTool('draft_write_intent', { scope: 'ticket:create', params: { deptid: 12, subject: 'DeepDrive ticket', message: 'body', clientid: TCID }, naturalKey: `dd|tcreate|${PORT}`, projected_effect: 'create ticket' }));
  const id = d.intent?.intent_id;
  await callTool('validate_write_intent', { intent_id: id });
  await callTool('approve_write_intent', { intent_id: id, approver: 'dd', decision: 'approved' });
  const e = j(await callTool('execute_write_intent', { intent_id: id }));
  const gt = await raw('GetTickets', { clientid: TCID, limitnum: 1 });
  TKID = Number(gt.tickets?.ticket?.[0]?.id);
  record('ticket:create', e.executed ? 'EXECUTED' : 'GATE-OK', `executed=${e.executed} ticketid=${TKID || '?'}`);
}
if (TKID) {
  await run('ticket:reply', { ticketid: TKID, message: 'deepdrive reply' });
  await run('ticket:note', { ticketid: TKID, message: 'deepdrive internal note' });
  await run('ticket:status', { ticketid: TKID, status: 'Answered' },
    { verify: async () => { const g = await raw('GetTicket', { ticketid: TKID }); return `status=${g.status}`; } });
}

// ── contacts (self-created on client 1) ──────────────────────────────────────
let CONTACTID;
await run('client:contact:add', { clientid: TCID, firstname: 'DDc', lastname: 'Contact', email: `dd-c-${PORT}@example.invalid` },
  { verify: async () => { const g = await raw('GetContacts', { userid: TCID }); const c = (g.contacts?.contact ?? []).find((x) => x.firstname === 'DDc'); CONTACTID = Number(c?.id); return `contactid=${CONTACTID || '?'}`; } });
if (CONTACTID) await run('client:contact:update', { contactid: CONTACTID, lastname: 'ContactUpdated' });
else record('client:contact:update', 'FAIL', 'no contactid from add step');

await run('billing:billable_item:add', { clientid: TCID, description: 'deepdrive billable', amount: 5 });
await run('billing:invoice:create', { userid: TCID, items: [{ description: 'dd item', amount: 12.5, taxed: false }] });

// ── reversible domain toggles (capture → set → restore) ──────────────────────
const DOMAIN_ID = 46;
{
  const b = (await raw('GetClientsDomains', { domainid: DOMAIN_ID })).domains?.domain?.[0] ?? {};
  const curIdp = String(b.idprotection) === '1' || b.idprotection === true;
  await run('domain:idprotect:toggle', { domainid: DOMAIN_ID, idprotect: !curIdp });
  await raw('DomainToggleIdProtect', { domainid: DOMAIN_ID, idprotect: curIdp }); // restore
  await run('domain:lock:toggle', { domainid: DOMAIN_ID, lockstatus: true });
  await raw('DomainUpdateLockingStatus', { domainid: DOMAIN_ID, lockstatus: false }); // restore baseline
  await run('domain:nameservers:update', { domainid: DOMAIN_ID, nameservers: ['ns1.deepdrive.test', 'ns2.deepdrive.test'] });
}

// ── service ops (active service; module not connected on dev ⇒ GATE-OK) ──────
const SVC_ID = 78;
await run('service:suspend', { serviceid: SVC_ID, suspendreason: 'deepdrive test' });
await run('service:unsuspend', { serviceid: SVC_ID });
await run('service:change_package', { serviceid: SVC_ID });

// ── HIGH-RISK money WITH amount (caps armed → should EXECUTE) ─────────────────
await run('billing:credit:add', { clientid: TCID, amount: 3, description: 'deepdrive credit' },
  { verify: async () => { const g = await raw('GetClientsDetails', { clientid: TCID }); return `credit=${g.client?.credit}`; } });
await run('billing:payment:add', { invoiceid: INVID, amount: 1, gateway: 'system' });
await run('billing:credit:apply', { invoiceid: INVID, amount: 1 });
await run('billing:refund:record', { invoiceid: INVID, amount: 1, refund_type: 'Credit', paymentmethod: 'system' });

// ── HIGH-RISK WITHOUT a bounding amount → EXPECTED cap-deny (design) ─────────
await run('billing:payment:capture', { invoiceid: INVID }, { expect: 'deny' });
await run('domain:register', { domainid: DOMAIN_ID }, { expect: 'deny' });
await run('domain:renew', { domainid: DOMAIN_ID, regperiod: 1 }, { expect: 'deny' });
await run('service:upgrade', { serviceid: SVC_ID, type: 'product', newproductid: 491 }, { expect: 'deny' });
await run('billing:quote:accept', { quoteid: 99999999 }, { expect: 'deny' });

// ── quotes (self-created) ─────────────────────────────────────────────────────
let QID;
{
  const d = j(await callTool('draft_write_intent', { scope: 'billing:quote:create', params: { subject: 'DeepDrive quote', stage: 'Draft', validuntil: '2099-12-31', userid: TCID, items: [{ description: 'q', amount: 9 }] }, naturalKey: `dd|qcreate|${PORT}`, projected_effect: 'create quote' }));
  const id = d.intent?.intent_id;
  await callTool('validate_write_intent', { intent_id: id });
  await callTool('approve_write_intent', { intent_id: id, approver: 'dd', decision: 'approved' });
  const e = j(await callTool('execute_write_intent', { intent_id: id }));
  const gq = await raw('GetQuotes', { userid: TCID, limitnum: 1 });
  QID = Number(gq.quotes?.quote?.[0]?.id);
  record('billing:quote:create', e.executed ? 'EXECUTED' : 'GATE-OK', `executed=${e.executed} quoteid=${QID || '?'}`);
}
if (QID) {
  await run('billing:quote:update', { quoteid: QID, subject: 'DeepDrive quote v2' });
  await run('billing:quote:send', { quoteid: QID }); // may GATE-OK on dev SMTP
}

// ── order:accept — full gate against a NON-EXISTENT order (no provisioning) ───
await run('order:accept', { orderid: 99999999 });

// ── PERMANENTLY BLOCKED (expected action_permanently_blocked, even local) ─────
await run('service:terminate', { serviceid: SVC_ID }, { expect: 'deny' });

// ── service:price_restore — high batch (dry_run; cap/precondition path) ───────
await run('service:price_restore', { targets: [{ serviceid: SVC_ID, new_amount: 0.01 }], dry_run: true });

// NOTE: domain:transfer / domain:release are NOT in WRITE_SCOPES (they exist
// only in PROD_NEVER_EXECUTABLE_SCOPES as defensive block-list strings). They
// are therefore not draftable — z.enum(WRITE_SCOPES) rejects them — which is
// the correct, intended behavior; nothing to execute.

// ── cleanup ───────────────────────────────────────────────────────────────────
console.log('cleanup...');
await raw('UpdateClient', { clientid: TCID, phonenumber: ORIG_PHONE }); // restore phone
if (QID) await raw('DeleteQuote', { quoteid: QID });
if (TKID) await raw('DeleteTicket', { ticketid: TKID });
if (CONTACTID) await raw('DeleteContact', { contactid: CONTACTID });
if (Number.isFinite(INVID)) await raw('UpdateInvoice', { invoiceid: INVID, status: 'Cancelled' }); // can't DeleteInvoice via API
console.log(`cleanup done (phone restored, test ticket/quote/contact deleted, test invoice ${INVID} cancelled)`);

const ex = results.filter((r) => r.klass === 'EXECUTED').length;
const ok = results.filter((r) => r.klass === 'GATE-OK').length;
const dd = results.filter((r) => r.klass === 'DESIGN-DENY').length;
const fl = results.filter((r) => r.klass === 'FAIL').length;
console.log(`\nSummary @ ${host}:${PORT}: ${ex} EXECUTED · ${ok} GATE-OK · ${dd} DESIGN-DENY · ${fl} FAIL (of ${results.length})`);
if (fl) console.log('FAILS: ' + results.filter((r) => r.klass === 'FAIL').map((r) => `${r.scope} (${r.detail})`).join(' | '));

await client.close();
process.exit(fl ? 1 : 0);
