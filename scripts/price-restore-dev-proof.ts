/* eslint-disable no-console -- one-off CLI proof script: stdout IS the output */
/**
 * Live dev proof of service:price_restore on a benign throwaway service.
 *
 * Pre-reqs:
 *   - dev WHMCS9 up at localhost:8890 (post-install-fixup.sh ran).
 *   - A throwaway service exists on dev (NOT client 50). Set TPR_SERVICEID + TPR_NEW_AMOUNT env vars.
 *
 * Run:
 *   set -a; . ./.env.local; set +a
 *   MCP_ENV=local MCP_MODE=full WHMCS_ALLOW_HTTP=true \
 *   MCP_WRITE_EXECUTION_AUTHORIZED=UpdateClientProduct \
 *   TPR_SERVICEID=<dev-service-id> TPR_NEW_AMOUNT=1.00 \
 *   npx tsx scripts/price-restore-dev-proof.ts
 */
import { createHash } from 'node:crypto';

const RAW = 'PRICE-RESTORE-DEV-PROOF-SYNTHETIC';
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

process.env.MCP_CONSUMER_REGISTRY = JSON.stringify([
  {
    id: 'pr-dev',
    token_sha256: sha(RAW),
    allowedScopes: ['read'],
    defaultContract: 'ops_operator',
    allowedContracts: ['ops_operator'],
    allowedActions: [],
    writeCapability: 'execution_allowed',
    allowedWriteScopes: ['service:price_restore'],
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
const J = (r: Res): Record<string, unknown> =>
  JSON.parse(r.content[0].text) as Record<string, unknown>;
const rec = (v: unknown): Record<string, unknown> => v as Record<string, unknown>;

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
const SID = Number(process.env.TPR_SERVICEID ?? 0);
const NEW = Number(process.env.TPR_NEW_AMOUNT ?? 1);
if (!Number.isInteger(SID) || SID <= 0) {
  console.error('Set TPR_SERVICEID to a positive integer (dev service id, NOT client 50).');
  process.exit(2);
}

console.log('env:', config.MCP_ENV, '| mode:', config.MCP_MODE, '| api:', config.WHMCS_API_URL);

// 1. dry_run preview
const dDry = await handlers.draft_write_intent({
  scope: 'service:price_restore',
  params: { targets: [{ serviceid: SID, new_amount: NEW }], dry_run: true },
  naturalKey: `dev-proof-dry-${String(Date.now())}`,
  projected_effect: 'dev proof dry-run',
  ...tok,
});
const dId = rec(J(dDry).intent).intent_id as string;
await handlers.validate_write_intent({ intent_id: dId, ...tok });
await handlers.approve_write_intent({
  intent_id: dId,
  approver: 'pr-dev',
  decision: 'approved',
  ...tok,
});
const eDry = await handlers.execute_write_intent({ intent_id: dId, ...tok });
console.log('dry_run result:', JSON.stringify(J(eDry).execution));

// 2. real execute
const dReal = await handlers.draft_write_intent({
  scope: 'service:price_restore',
  params: { targets: [{ serviceid: SID, new_amount: NEW }] },
  naturalKey: `dev-proof-real-${String(Date.now())}`,
  projected_effect: 'dev proof real',
  ...tok,
});
const rId = rec(J(dReal).intent).intent_id as string;
await handlers.validate_write_intent({ intent_id: rId, ...tok });
await handlers.approve_write_intent({
  intent_id: rId,
  approver: 'pr-dev',
  decision: 'approved',
  ...tok,
});
const eReal = await handlers.execute_write_intent({ intent_id: rId, ...tok });
const realBody = J(eReal);
const exec = rec(realBody.execution);
console.log('real result   :', JSON.stringify(exec));

const phase2 = rec(exec.phase_2);
const outcomes = phase2.outcomes as { status: string; serviceid: number }[];
const ok = realBody.executed === true && outcomes.every((o) => o.status === 'verified');
console.log('\nRESULT:', ok ? 'PASS — live restore succeeded + verified' : 'INVESTIGATE');
