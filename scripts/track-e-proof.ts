/**
 * Track E — LIVE dev execution proof (one-off; not wired into the test suite).
 *
 * Drives the REAL registered write-flow tool handlers against dev WHMCS9
 * (localhost:8890) with MCP_MODE=full + a synthetic execution_allowed
 * consumer + AddClientNote runtime-authorized, env=local (non-prod path).
 *
 *   draft -> validate -> approve -> execute(LIVE whmcs.mutate)
 *   then re-execute the same intent  -> must be denied (replay / not-approved)
 *
 * Proves: the deny-by-default authorizer ALLOWS only when every gate passes,
 * the gated path performs a real WHMCS mutation, and a second attempt is
 * refused without a second mutation. Pure dev; benign client-note only.
 *
 * Run:
 *   set -a; . ./.env.local; set +a
 *   MCP_ENV=local MCP_MODE=full WHMCS_ALLOW_HTTP=true \
 *   MCP_WRITE_EXECUTION_AUTHORIZED=AddClientNote MCP_GOVERNANCE_ENABLED=true \
 *   npx tsx scripts/track-e-proof.ts
 */
/* eslint-disable no-console -- one-off CLI proof script: stdout IS the output */
import { createHash } from 'node:crypto';

const RAW = 'TRACKE-DEV-PROOF-SYNTHETIC';
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

// Synthetic execution_allowed consumer (dev only).
process.env.MCP_CONSUMER_REGISTRY = JSON.stringify([
  {
    id: 'tracke',
    token_sha256: sha(RAW),
    allowedScopes: ['read'],
    defaultContract: 'ops_operator',
    allowedContracts: ['ops_operator'],
    allowedActions: [],
    writeCapability: 'execution_allowed',
    allowedWriteScopes: ['client_note:write'],
    envRestrictions: [],
    anonymous: false,
  },
]);

const { config } = await import('../src/config.js');
const { WhmcsClient } = await import('../src/whmcs/WhmcsClient.js');
const { registerWriteFlowTools } = await import('../src/tools/writeFlow.js');

interface Res {
  content: { text: string }[];
  isError?: boolean;
}
const J = (r: Res) => JSON.parse(r.content[0].text) as Record<string, unknown>;
const rec = (v: unknown) => v as Record<string, unknown>;

const noop = (): void => undefined;
const log: Record<string, unknown> = {
  child: () => log,
  logToolCall: noop,
  logToolResult: noop,
  logWhmcsCall: noop,
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
};

const handlers: Record<string, (a: Record<string, unknown>) => Promise<Res>> = {};
const server = {
  registerTool: (n: string, _c: unknown, cb: unknown) => {
    handlers[n] = cb as never;
  },
};

const whmcs = new WhmcsClient(config, log as never);
registerWriteFlowTools(server as never, whmcs, log as never, { tryConsume: () => true } as never);

const tok = { auth_token: RAW };
const CLIENTID = Number(process.env.TRACKE_CLIENTID ?? 30);
const stamp = new Date().toISOString();
// Pass only intent-contract names (clientid, note). The param mapper
// (src/write/paramMapping.ts) now performs the WHMCS field-name translation
// (clientid→userid, note→notes) at execute time — no double-naming needed.
const params = {
  clientid: CLIENTID,
  note: `TRACK-E live proof ${stamp} (automated dev test)`,
};

console.log('env:', config.MCP_ENV, '| mode:', config.MCP_MODE, '| api:', config.WHMCS_API_URL);

const d = await handlers.draft_write_intent({
  scope: 'client_note:write',
  params,
  naturalKey: `tracke-${stamp}`,
  projected_effect: 'add client note (Track E dev proof)',
  ...tok,
});
const id = rec(J(d).intent).intent_id as string;
console.log('draft     :', rec(J(d).intent).state, id);

const v = await handlers.validate_write_intent({ intent_id: id, ...tok });
console.log('validate  :', rec(J(v).intent).state, '| ok=', rec(J(v).validation).ok);

const a = await handlers.approve_write_intent({
  intent_id: id,
  approver: 'track-e',
  decision: 'approved',
  ...tok,
});
console.log('approve   :', rec(J(a).intent).state);

const e = await handlers.execute_write_intent({ intent_id: id, ...tok });
const ep = J(e);
console.log(
  'execute   :',
  'executed=',
  ep.executed,
  '| state=',
  rec(ep.intent).state,
  '| exec=',
  JSON.stringify(ep.execution)
);

const e2 = await handlers.execute_write_intent({ intent_id: id, ...tok });
const ep2 = J(e2);
console.log(
  're-execute:',
  'executed=',
  ep2.executed,
  '| blocked_reason=',
  rec(ep2.execution).blocked_reason
);

console.log(
  '\nRESULT:',
  ep.executed === true && ep2.executed === false
    ? 'PASS — live mutation succeeded once; replay refused (no 2nd mutation)'
    : 'INVESTIGATE — see execution payloads above'
);
