// Phase F write-flow simulation (dev/test only, MCP_ENV=local, read-only
// posture). Drives the built server as an MCP client with governance ON +
// a synthetic writer consumer through draft → validate → approve →
// execute(GATED) and asserts: NO whmcs.mutate, deny-by-default execution,
// approval/idempotency/audit fields present, app-useful structured result.
// NEVER executes a production write.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createHash } from 'node:crypto';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const RAW = 'EXAMPLE-writer-SYNTHETIC-DO-NOT-USE-IN-PROD';
const REGISTRY = JSON.stringify([{
  id: 'writer', token_sha256: sha(RAW), allowedScopes: ['read'],
  defaultContract: 'ops_operator', allowedContracts: ['ops_operator'],
  allowedActions: [], writeCapability: 'approval_required',
  envRestrictions: [], anonymous: false,
  allowedWriteScopes: ['ticket:reply', 'billing:credit:add'],
}]);
const text = (r) => r?.content?.[0]?.text ?? '';
const j = (r) => { try { return JSON.parse(text(r)); } catch { return text(r); } };
let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log(`  [${c ? 'PASS' : 'FAIL'}] ${m}`); };

const transport = new StdioClientTransport({
  command: 'node', args: ['dist/index.js'],
  env: { ...process.env, MCP_ENV: 'local', MCP_MODE: 'read_only',
    MCP_GOVERNANCE_ENABLED: 'true', MCP_ALLOW_ANON_LLM: 'false',
    // Dev smoke fires many calls back-to-back; rate limiting is not under
    // test here, so lift the per-second cap for deterministic runs.
    MCP_RATE_LIMIT: '1000',
    MCP_CONSUMER_REGISTRY: REGISTRY },
  stderr: 'ignore',
});
const client = new Client({ name: 'writeflow-smoke', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);
console.log('connected (MCP_ENV=local, GOVERNANCE=on, MODE=read_only)');
const call = (n, a = {}) => client.callTool({ name: n, arguments: { ...a, auth_token: RAW } });

for (const [scope, params, nat] of [
  ['ticket:reply', { ticketid: 1, message: 'Sim reply (not executed)' }, 'sim-ticket-reply-1'],
  ['billing:credit:add', { clientid: 1, amount: '5.00', description: 'Sim credit (not executed)' }, 'sim-credit-1'],
]) {
  const d = j(await call('draft_write_intent', { scope, params, naturalKey: nat, projected_effect: `would ${scope}` }));
  const id = d.intent?.intent_id;
  ok(!!id && d.executed === false && d.idempotency_key && d.would_call?.action,
    `draft ${scope} → intent ${String(id).slice(0,8)} action=${d.would_call?.action} idem=${!!d.idempotency_key} risk_flags=${JSON.stringify(d.risk_flags)}`);

  const v = j(await call('validate_write_intent', { intent_id: id }));
  ok(v.validation && typeof v.validation.ok === 'boolean',
    `validate ${scope} → ok=${v.validation?.ok} compat_warnings=${JSON.stringify(v.validation?.compat_warnings ?? [])}`);

  const a = j(await call('approve_write_intent', { intent_id: id, approver: 'sim-operator', decision: 'approved' }));
  ok(a.intent?.state === 'approved' || a.isError, `approve ${scope} → state=${a.intent?.state ?? a.error}`);

  const e = j(await call('execute_write_intent', { intent_id: id }));
  ok(e.executed === false && e.execution?.attempted === false && (e.execution?.blocked_reason === 'read_only_mode' || e.execution?.blocked_reason === 'intent_not_approved'),
    `execute ${scope} → DENIED executed=${e.executed} reason=${e.execution?.blocked_reason} (no mutation)`);

  const g = j(await call('get_write_intent', { intent_id: id }));
  const trail = (g.audit ?? []).map((x) => x.event);
  ok(trail.includes('intent.drafted') && trail.includes('intent.execution_blocked'),
    `audit ${scope} → ${JSON.stringify(trail)}`);
}

// negative: unknown consumer cannot draft
const u = await client.callTool({ name: 'draft_write_intent', arguments: { scope: 'ticket:reply', params: { ticketid: 1, message: 'x' }, naturalKey: 'u', projected_effect: 'x', auth_token: 'bogus' } });
ok(u.isError === true && /consumer denied/i.test(text(u)), `unknown consumer draft denied → ${text(u).slice(0,70)}`);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
await client.close();
process.exit(fail ? 1 : 0);
