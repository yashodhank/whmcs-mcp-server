// Read-only operational workflow simulation runner (dev/test only).
//
// Drives the built server (dist/index.js) as an MCP client with governance
// ON, a synthetic `ops_operator` consumer, and SMALL limits. It exercises
// the operational read aggregators end-to-end against a configured target
// WHMCS, then runs a controlled-write flow (draft → validate → approve →
// execute) and ASSERTS the execute is DENIED — it never expects, attempts,
// or relies on a live mutation.
//
// READ-ONLY. Synthetic consumer tokens only. No PII is printed (workflow
// name + PASS/FAIL + a small list of top-level keys, never raw data).
//
// Targets (env TARGET):
//   devw9   (default) — MCP_ENV=local profile (.env.local → localhost:8890)
//   devw8             — same creds, WHMCS_API_URL overridden to :8813 (http)
//   prodread          — base .env, MCP_MODE=read_only, SMALL limits.
//                        STRICTLY opt-in: only runs when WORKFLOW_ALLOW_PROD=1,
//                        otherwise prints a notice and skips. Never default.
//
// Run after `npm run build`.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createHash } from 'node:crypto';

// --- synthetic consumer (sha256 of an EXAMPLE-* token; never a prod token) --
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const RAW = 'EXAMPLE-ops_operator-SYNTHETIC-DO-NOT-USE-IN-PROD';
const REGISTRY = JSON.stringify([
  {
    id: 'ops_operator',
    token_sha256: sha(RAW),
    allowedScopes: ['read'],
    defaultContract: 'ops_operator',
    allowedContracts: ['ops_operator'],
    allowedActions: [],
    // approval_required lets us walk the full draft→approve→execute(GATED)
    // flow and prove execute is still denied under read_only posture.
    writeCapability: 'approval_required',
    envRestrictions: [],
    anonymous: false,
    allowedWriteScopes: ['ticket:reply'],
  },
]);

// --- target selection ------------------------------------------------------
const TARGET = process.env.TARGET || 'devw9';
const PROD_OK = process.env.WORKFLOW_ALLOW_PROD === '1';

function targetEnv(target) {
  const base = {
    ...process.env,
    MCP_GOVERNANCE_ENABLED: 'true',
    MCP_ALLOW_ANON_LLM: 'false',
    // Smoke fires many calls back-to-back; rate limiting is not under test.
    MCP_RATE_LIMIT: '1000',
    MCP_CONSUMER_REGISTRY: REGISTRY,
  };
  if (target === 'devw9') {
    return { ...base, MCP_ENV: 'local', MCP_MODE: 'read_only' };
  }
  if (target === 'devw8') {
    return {
      ...base,
      MCP_ENV: 'local',
      MCP_MODE: 'read_only',
      // Separate WHMCS 8 install on :8813; same API creds work.
      WHMCS_API_URL: 'http://localhost:8813',
      WHMCS_ALLOW_HTTP: 'true',
    };
  }
  if (target === 'prodread') {
    // base .env only (no MCP_ENV=local layering), forced read_only, small
    // limits. The classifier may still block; that is acceptable and the
    // run will surface it as a FAIL rather than mutating anything.
    return { ...base, MCP_ENV: '', MCP_MODE: 'read_only', MCP_MAX_PAGE_SIZE: '10' };
  }
  throw new Error(`unknown TARGET=${target} (use devw9 | devw8 | prodread)`);
}

if (TARGET === 'prodread' && !PROD_OK) {
  console.log(
    'NOTICE: TARGET=prodread requires explicit opt-in. Re-run with ' +
      'WORKFLOW_ALLOW_PROD=1 to exercise production (read-only, small ' +
      'limits). Skipping — production is never run by default.'
  );
  console.log('\nRESULT: 0 passed, 0 failed (prod skipped)');
  process.exit(0);
}

// --- helpers ---------------------------------------------------------------
const text = (r) => r?.content?.[0]?.text ?? '';
const j = (r) => {
  try {
    return JSON.parse(text(r));
  } catch {
    return text(r);
  }
};
let pass = 0;
let fail = 0;
const ok = (c, m) => {
  c ? pass++ : fail++;
  console.log(`  [${c ? 'PASS' : 'FAIL'}] ${m}`);
};

// A workflow PASSes when: not an MCP error, and the structured result carries
// either the governed envelope ({ consumer, contract, data }) or the legacy
// aggregator shape ({ items | partial_errors | <known section> }).
function shapeOk(p) {
  if (p == null || typeof p !== 'object') return { ok: false, keys: [] };
  if (p.isError) return { ok: false, keys: Object.keys(p) };
  const keys = Object.keys(p);
  const governed = typeof p.consumer === 'string' && typeof p.contract === 'string';
  const legacy =
    'partial_errors' in p ||
    'items' in p ||
    'client' in p ||
    'timeline' in p ||
    'data' in p;
  return { ok: governed || legacy, keys };
}

// --- connect ---------------------------------------------------------------
const env = targetEnv(TARGET);
const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
  env,
  stderr: 'ignore',
});
const client = new Client(
  { name: 'workflow-harness', version: '1.0.0' },
  { capabilities: {} }
);
await client.connect(transport);
console.log(
  `connected (TARGET=${TARGET}, GOVERNANCE=on, MODE=read_only, ` +
    `consumer=ops_operator [synthetic])`
);

const call = (name, args = {}) =>
  client.callTool({ name, arguments: { ...args, auth_token: RAW } });

// --- 1. operational read workflows (SMALL limits) --------------------------
const READ_WORKFLOWS = [
  ['get_account_360', { clientid: 1, recent: 3 }],
  ['get_billing_snapshot', { clientid: 1 }],
  ['get_reconciliation_snapshot', { clientid: 1 }],
  ['get_support_snapshot', { clientid: 1 }],
  ['get_renewal_snapshot', { clientid: 1 }],
  ['get_provisioning_snapshot', { clientid: 1 }],
  ['get_activity_timeline', { clientid: 1, limit: 5 }],
  ['get_risk_snapshot', { clientid: 1 }],
];

for (const [name, args] of READ_WORKFLOWS) {
  try {
    const r = await call(name, args);
    const p = j(r);
    const s = shapeOk(p);
    const errOut = r.isError || (p && p.isError);
    ok(
      !errOut && s.ok,
      `workflow ${name} → ${!errOut && s.ok ? 'structured ok' : 'BAD'} ` +
        `keys=[${s.keys.slice(0, 8).join(',')}]`
    );
  } catch (e) {
    ok(false, `workflow ${name} → THREW ${String(e).slice(0, 90)}`);
  }
}

// --- 2. controlled write flow: execute MUST be DENIED ----------------------
try {
  const d = j(
    await call('draft_write_intent', {
      scope: 'ticket:reply',
      params: { ticketid: 1, message: 'Workflow sim reply (NOT executed)' },
      naturalKey: 'workflow-harness-ticket-reply',
      projected_effect: 'would reply to ticket (simulation only)',
    })
  );
  const id = d.intent?.intent_id;
  ok(
    !!id && d.executed === false && !!d.idempotency_key,
    `write/draft ticket:reply → intent=${String(id).slice(0, 8)} ` +
      `executed=${d.executed}`
  );

  const v = j(await call('validate_write_intent', { intent_id: id }));
  ok(
    v.validation && typeof v.validation.ok === 'boolean',
    `write/validate → ok=${v.validation?.ok}`
  );

  const a = j(
    await call('approve_write_intent', {
      intent_id: id,
      approver: 'workflow-harness',
      decision: 'approved',
    })
  );
  ok(
    a.intent?.state === 'approved' || a.isError,
    `write/approve → state=${a.intent?.state ?? a.error}`
  );

  const e = j(await call('execute_write_intent', { intent_id: id }));
  ok(
    e.executed === false &&
      e.execution?.attempted === false &&
      typeof e.execution?.blocked_reason === 'string' &&
      e.execution.blocked_reason.length > 0,
    `write/execute → DENIED executed=${e.executed} ` +
      `blocked_reason=${e.execution?.blocked_reason} (no mutation)`
  );
} catch (e) {
  ok(false, `write flow → THREW ${String(e).slice(0, 110)}`);
}

// --- result ----------------------------------------------------------------
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
await client.close();
process.exit(fail ? 1 : 0);
