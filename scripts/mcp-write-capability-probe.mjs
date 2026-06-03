// Track C2 write-scope capability probe (DEV WHMCS ONLY).
//
// PURPOSE: before an operator enables a governed write scope in production,
// verify the underlying WHMCS action EXISTS and ACCEPTS the mapper's param
// shape on the target install. This is the live half of the
// write-capability-probe-runbook; the governed-path SHAPE is verified
// separately by the read_only simulate smoke.
//
// SAFETY — this script performs NO real mutation:
//   - Hard-refuses unless WHMCS_API_URL host is localhost/127.0.0.1 AND
//     MCP_ENV !== 'production' (cannot point at prod my.securiace.com).
//   - Probes every action with a DELIBERATELY NON-EXISTENT entity id
//     (99_999_999). WHMCS looks the entity up first, so the call is rejected
//     at lookup ("not found") WITHOUT creating/charging/changing anything.
//   - Classifies the response: an entity-not-found / missing-param error proves
//     the action is REACHABLE (exists + param shape accepted); an
//     "invalid action" proves it is UNSUPPORTED on this install; anything else
//     is reported verbatim for human review.
//
// It reads WHMCS_API_URL / WHMCS_IDENTIFIER / WHMCS_SECRET from the env
// (source .env.local first). No secrets are printed.

// Run with tsx so the governed mapper/action map are imported straight from
// source (no dist build required): `npx tsx scripts/mcp-write-capability-probe.mjs`.
import { intentToWhmcsParams } from '../src/write/paramMapping.js';
import { SCOPE_ACTION } from '../src/write/types.js';

const URL_RAW = process.env.WHMCS_API_URL ?? '';
const ENV = process.env.MCP_ENV ?? '';

function refuse(msg) {
  console.error(`REFUSED: ${msg}`);
  process.exit(2);
}

// ── Hard prod guards ────────────────────────────────────────────────────────
let host = '';
try {
  host = new URL(URL_RAW).hostname;
} catch {
  refuse(`WHMCS_API_URL is not a valid URL: "${URL_RAW}"`);
}
if (!['localhost', '127.0.0.1'].includes(host)) {
  refuse(`WHMCS_API_URL host "${host}" is not localhost — this probe is DEV-only and never runs against a remote/production WHMCS.`);
}
if (ENV === 'production') {
  refuse('MCP_ENV=production — write-capability probing is forbidden in the production profile.');
}
if (!process.env.WHMCS_IDENTIFIER || !process.env.WHMCS_SECRET) {
  refuse('WHMCS_IDENTIFIER / WHMCS_SECRET not set (source .env.local).');
}

const API = `${URL_RAW.replace(/\/$/, '')}/includes/api.php`;
const NX = 99_999_999; // non-existent entity id

// Representative, well-formed sample params per C2 scope. ids are NON-EXISTENT
// so WHMCS rejects at lookup. These are the INTENT-shape params; the governed
// mapper translates them to the real WHMCS field names below.
// `live: false` ⇒ do NOT issue the live WHMCS call. CreateQuote is the one C2
// action WHMCS does NOT entity-validate — it creates a quote even for a
// non-existent userid, so a non-existent-id probe is NOT side-effect-free for
// it. It is reachable-by-construction (the other quote actions confirm the
// quote subsystem is API-exposed); we skip the live call to keep this probe
// safe to re-run with zero mutations.
const SCOPES = [
  ['service:change_package', { serviceid: NX }, true],
  ['service:upgrade', { serviceid: NX, type: 'product', newproductid: NX }, true],
  ['domain:idprotect:toggle', { domainid: NX, idprotect: true }, true],
  ['domain:lock:toggle', { domainid: NX, lockstatus: true }, true],
  ['client:contact:add', { clientid: NX, firstname: 'Probe', lastname: 'NX', email: 'probe@example.invalid' }, true],
  ['client:contact:update', { contactid: NX, lastname: 'NX' }, true],
  ['billing:billable_item:add', { clientid: NX, description: 'probe (nonexistent client)', amount: 1 }, true],
  ['billing:quote:create', { subject: 'probe', stage: 'Draft', validuntil: '2099-12-31', userid: NX, items: [{ description: 'l', amount: 1 }] }, false],
  ['billing:quote:update', { quoteid: NX, subject: 'probe' }, true],
  ['billing:quote:send', { quoteid: NX }, true],
  ['billing:quote:accept', { quoteid: NX }, true],
  ['ticket:note', { ticketid: NX, message: 'probe note (nonexistent ticket)' }, true],
  ['ticket:merge', { ticketid: NX, mergeticketids: [NX - 1] }, true],
];

async function callWhmcs(action, params) {
  const body = new URLSearchParams({
    action,
    identifier: process.env.WHMCS_IDENTIFIER,
    secret: process.env.WHMCS_SECRET,
    responsetype: 'json',
  });
  for (const [k, v] of Object.entries(params)) {
    body.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { result: 'non-json', message: text.slice(0, 200) };
  }
  return json;
}

// Classify the WHMCS response into a reachability verdict.
function classify(json) {
  const msg = String(json.message ?? json.result ?? '').toLowerCase();
  if (/invalid action|action not found|unknown action|function not/.test(msg)) {
    return { verdict: 'UNSUPPORTED', detail: json.message };
  }
  if (json.result === 'success') {
    // Unexpected on a non-existent id — surface for review (should be rare).
    return { verdict: 'REACHABLE(success?!)', detail: 'succeeded on NX id — review' };
  }
  if (/not found|does not exist|invalid (id|serviceid|domainid|quoteid|ticketid|client|contact)|no such|unable to locate/.test(msg)) {
    return { verdict: 'REACHABLE', detail: json.message };
  }
  if (/missing|required|empty/.test(msg)) {
    // Action exists and is parsing params (rejected a required field) ⇒ reachable.
    return { verdict: 'REACHABLE(param)', detail: json.message };
  }
  return { verdict: 'REVIEW', detail: json.message ?? JSON.stringify(json).slice(0, 160) };
}

console.log(`Write-capability probe → ${API} (env=${ENV || 'unset'}, host=${host})`);
console.log('NO real mutation: every action is called with a non-existent id.\n');

const evidence = [];
for (const [scope, params, live] of SCOPES) {
  let mapped, verdict, detail;
  try {
    mapped = intentToWhmcsParams(scope, params, { idempotency_key: `probe|${scope}` });
  } catch (e) {
    console.log(`  [MAP-ERR] ${scope}: ${e.message}`);
    evidence.push({ scope, error: e.message });
    continue;
  }
  // Derive the action the same way the write-flow does — via the frozen map.
  const action = SCOPE_ACTION?.[scope] ?? '(unknown)';
  if (!live) {
    verdict = 'REACHABLE(skipped-live)';
    detail = 'mutating on bogus id (not entity-validated); reachable by construction';
  } else {
    try {
      const json = await callWhmcs(action, mapped);
      ({ verdict, detail } = classify(json));
    } catch (e) {
      verdict = 'TRANSPORT-ERR';
      detail = e.message;
    }
  }
  const flag =
    verdict.startsWith('REACHABLE') ? '✓' : verdict === 'UNSUPPORTED' ? '✗' : '?';
  console.log(`  [${flag}] ${scope.padEnd(28)} ${action.padEnd(24)} ${verdict} — ${String(detail ?? '').slice(0, 80)}`);
  evidence.push({ scope, action, mapped, verdict, detail });
}

const reachable = evidence.filter((e) => String(e.verdict).startsWith('REACHABLE')).length;
const unsupported = evidence.filter((e) => e.verdict === 'UNSUPPORTED').length;
const review = evidence.filter((e) => e.verdict === 'REVIEW' || e.verdict === 'TRANSPORT-ERR').length;
console.log(`\nSummary: ${reachable} reachable · ${unsupported} unsupported · ${review} needs-review (of ${evidence.length})`);
console.log('\nEvidence JSON:');
console.log(JSON.stringify(evidence, null, 2));
