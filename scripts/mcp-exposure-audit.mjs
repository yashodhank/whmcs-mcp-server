// Phase H — deliberate, READ-ONLY exposure audit harness.
// PHASE H.1 (Track C) — reliability hardening: EVERY run yields exactly one
// JSON object on stdout — either the redacted audit report OR a structured
// failure — with a correlation_id + dimensions. No silent gaps. A 150-job
// production pilot previously lost 43/150 (29%) runs to silent stdio/timeout
// failures (disproportionately get_account_360 / get_reconciliation_snapshot
// under concurrency); this rewrite removes that class of silent failure.
//
// WHAT THIS IS
//   The WHMCS MCP projects canonical data per consumer contract at the
//   output boundary (governance/projection.ts). This operator-run tool
//   drives the BUILT server as an MCP client, calls ONE governed read tool
//   for a given consumer, captures the structured result the consumer would
//   actually receive, and feeds it to the PURE auditor
//   (src/audit/exposureAudit.ts) to report WHAT was exposed and whether each
//   emitted field is safe under that contract. It does NOT re-project,
//   block, or mutate anything — projection already happened in the server.
//
// AUTHORITATIVE TRACE
//   When the governed server emits `__audit_trace` (env MCP_AUDIT_TRACE=1,
//   set by the runner) AND `auditFromTrace` is available, the audit is
//   AUTHORITATIVE (classmap_source: 'authoritative'). Otherwise it falls
//   back to classification inference and labels classmap_source so the
//   reliability rollup can show authoritative coverage. The fallback is
//   feature-detected at run time so this harness works whether or not the
//   Track-A producer has shipped yet.
//
// THREE MODES (by environment) — UNCHANGED
//   1. dev mode            MCP_ENV=local (default). Dev WHMCS is SYNTHETIC;
//                          full value display permitted ONLY when the
//                          operator also sets AUDIT_LOCAL_VALUES=1 (mode 3).
//   2. production-read     MCP_ENV=production. Field-path + classification
//                          report ONLY. Never prints/writes any value;
//                          AUDIT_LOCAL_VALUES is IGNORED in this mode.
//   3. local-only operator AUDIT_LOCAL_VALUES=1 (requires MCP_ENV=local).
//                          May write the RAW report to ./.audit-local/<ts>.json
//                          (gitignored). stdout still prints REDACTED only.
//
// SAFETY (UNCHANGED)
//   - Read-only: governance ON, MCP_MODE=read_only, no writes.
//   - stdout is ALWAYS the REDACTED report OR a structured failure (never a
//     raw value, in any mode).
//   - Raw values only ever touch ./.audit-local/ and ONLY in mode 3.
//   - Exit code is always 0: reporting tool, not a gate.
//
// HOW TO RUN  (server must be BUILT first: npm run build)
//   MCP_ENV=local npx tsx scripts/mcp-exposure-audit.mjs llm_chat get_account_360
//   MCP_ENV=local AUDIT_LOCAL_VALUES=1 npx tsx scripts/mcp-exposure-audit.mjs \
//     admin_full_trusted get_stats
//   MCP_ENV=production MCP_MODE=read_only npx tsx \
//     scripts/mcp-exposure-audit.mjs llm_chat get_client_details
//   Sweep / pilot: scripts/exposure-audit-pilot.mjs (bounded concurrency,
//   explicit client IDs + env label, metrics rollup).
//
//   Optional override: pass JSON as argv[4+] for tool args. Optional 4th
//   positional convention is overridden by JSON; clientid comes from args.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { auditExposure } from '../src/audit/exposureAudit.ts';
import {
  runAuditJob,
  installSafetyNet,
  writeJsonLineAndExit,
} from './lib/auditRunner.mjs';
import {
  buildEnvelope,
  buildFailureReport,
} from '../src/auditHarness/runnerCore.ts';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const RAW = (id) => `EXAMPLE-${id}-SYNTHETIC-DO-NOT-USE-IN-PROD`;
const entry = (id, dc) => ({
  id,
  token_sha256: sha(RAW(id)),
  allowedScopes: ['read'],
  defaultContract: dc,
  allowedContracts: [dc],
  allowedActions: [],
  writeCapability: 'false',
  envRestrictions: [],
  anonymous: false,
});

// Synthetic example registry — same shape as mcp-governed-smoke.mjs.
const CONSUMERS = {
  llm_chat: 'llm_safe_summary',
  ops_operator: 'ops_operator',
  billing_dashboard: 'billing_reconciliation',
  renewal_worker: 'renewal_automation',
  support_console: 'support_triage',
  admin_full_trusted: 'admin_full_trusted',
};
const REGISTRY = JSON.stringify(
  Object.entries(CONSUMERS).map(([id, dc]) => entry(id, dc))
);

// Per-FieldClass policies (mirrors governance/contracts.ts, read-only copy
// used only to drive the pure auditor on the INFERENCE fallback path — the
// authoritative path uses the trace and never needs these).
const POLICIES = {
  llm_safe_summary: {
    'business.identifier': 'allow', 'financial.amount': 'allow',
    'financial.reference': 'allow', 'pii.name': 'mask', 'pii.email': 'mask',
    'pii.phone': 'mask', 'pii.address': 'mask', 'pii.tax': 'mask',
    'pii.custom_field': 'mask', 'secret.credential': 'drop',
    'untrusted.free_text': 'summarize', 'internal.private_note': 'drop',
    'system.audit': 'drop', 'public.safe': 'allow',
  },
  ops_operator: {
    'business.identifier': 'allow', 'financial.amount': 'allow',
    'financial.reference': 'allow', 'pii.name': 'allow', 'pii.email': 'allow',
    'pii.phone': 'allow', 'pii.address': 'allow', 'pii.tax': 'allow',
    'pii.custom_field': 'allow', 'secret.credential': 'drop',
    'untrusted.free_text': 'wrap_untrusted', 'internal.private_note': 'allow',
    'system.audit': 'allow', 'public.safe': 'allow',
  },
  billing_reconciliation: {
    'business.identifier': 'allow', 'financial.amount': 'allow',
    'financial.reference': 'allow', 'pii.name': 'allow', 'pii.email': 'allow',
    'pii.phone': 'mask', 'pii.address': 'mask', 'pii.tax': 'mask',
    'pii.custom_field': 'drop', 'secret.credential': 'drop',
    'untrusted.free_text': 'drop', 'internal.private_note': 'drop',
    'system.audit': 'allow', 'public.safe': 'allow',
  },
  renewal_automation: {
    'business.identifier': 'allow', 'financial.amount': 'allow',
    'financial.reference': 'allow', 'pii.name': 'mask', 'pii.email': 'allow',
    'pii.phone': 'mask', 'pii.address': 'mask', 'pii.tax': 'mask',
    'pii.custom_field': 'mask', 'secret.credential': 'drop',
    'untrusted.free_text': 'drop', 'internal.private_note': 'drop',
    'system.audit': 'allow', 'public.safe': 'allow',
  },
  support_triage: {
    'business.identifier': 'allow', 'financial.amount': 'allow',
    'financial.reference': 'allow', 'pii.name': 'allow', 'pii.email': 'allow',
    'pii.phone': 'allow', 'pii.address': 'allow', 'pii.tax': 'allow',
    'pii.custom_field': 'allow', 'secret.credential': 'drop',
    'untrusted.free_text': 'allow', 'internal.private_note': 'allow',
    'system.audit': 'allow', 'public.safe': 'allow',
  },
  admin_full_trusted: {
    'business.identifier': 'allow', 'financial.amount': 'allow',
    'financial.reference': 'allow', 'pii.name': 'allow', 'pii.email': 'allow',
    'pii.phone': 'allow', 'pii.address': 'allow', 'pii.tax': 'allow',
    'pii.custom_field': 'allow', 'secret.credential': 'drop',
    'untrusted.free_text': 'allow', 'internal.private_note': 'allow',
    'system.audit': 'allow', 'public.safe': 'allow',
  },
};

// Classification inference on a key NAME (only used on the fallback path
// when neither an authoritative trace nor a tool __classmap is present).
const KEY_RULES = [
  [/(^|[._[])password|secret|api[_-]?key|token|credential/i, 'secret.credential'],
  [/(^|[._[])email\b|email$/i, 'pii.email'],
  [/phone|mobile|tel(ephone)?/i, 'pii.phone'],
  [/(^|[._[])(firstname|lastname|fullname|contactname|name)$/i, 'pii.name'],
  [/address|address1|address2|city|state|postcode|zip|country/i, 'pii.address'],
  [/tax(id)?|vat|gst|ssn|pan\b/i, 'pii.tax'],
  [/customfield|custom_field/i, 'pii.custom_field'],
  [/(txn|transaction)[_-]?(id|ref)|invoice(num|id)|paymentid|gatewayid/i,
    'financial.reference'],
  [/amount|balance|total|credit|tax\b|subtotal/i, 'financial.amount'],
  [/clientid|^id$|companyname|userid|domainid|serviceid|ticketid/i,
    'business.identifier'],
  [/note|adminnote|internalnote/i, 'internal.private_note'],
  [/message|subject|body|description|notes/i, 'untrusted.free_text'],
];
function inferClass(path) {
  const leaf = path.split(/[.[]/).filter(Boolean).pop() ?? path;
  for (const [re, cls] of KEY_RULES) {
    if (re.test(leaf) || re.test(path)) return cls;
  }
  return undefined;
}
function leafPaths(value, prefix, out) {
  if (Array.isArray(value)) {
    if (value.length === 0) return;
    for (const el of value) leafPaths(el, `${prefix}[]`, out);
    return;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return;
    for (const k of keys) {
      leafPaths(value[k], prefix.length === 0 ? k : `${prefix}.${k}`, out);
    }
    return;
  }
  out.add(prefix);
}
function buildInferredClassmap(projected) {
  const paths = new Set();
  leafPaths(projected, '', paths);
  const map = {};
  for (const p of paths) {
    const c = inferClass(p);
    if (c) map[p] = c;
  }
  return map;
}

const DEFAULT_ARGS = {
  get_client_details: { clientid: 1 },
  list_client_invoices: { clientid: 1, limit: 3 },
  list_client_domains: { clientid: 1, limit: 3 },
  list_client_services: { clientid: 1, limit: 3 },
  get_ticket_thread: { ticketid: 1 },
  get_account_360: { clientid: 1, recent: 3 },
  get_billing_snapshot: { clientid: 1 },
  get_reconciliation_snapshot: { clientid: 1 },
  get_support_snapshot: { clientid: 1 },
  get_renewal_snapshot: { clientid: 1 },
  list_client_transactions: { clientid: 1, limit: 3 },
  get_stats: {},
  get_todo_items: { clientid: 1, limit: 3 },
  get_automation_log: { clientid: 1, limit: 3 },
};

const consumerId = process.argv[2] ?? 'llm_chat';
const tool = process.argv[3] ?? 'get_client_details';
const restArgs = process.argv.slice(4);

const env = process.env.MCP_ENV ?? 'production';
const isLocal = env === 'local';
const showValues = isLocal && process.env.AUDIT_LOCAL_VALUES === '1';

const contract = CONSUMERS[consumerId];

let toolArgs = DEFAULT_ARGS[tool] ?? { clientid: 1 };
if (restArgs.length > 0) {
  try {
    toolArgs = JSON.parse(restArgs.join(' '));
  } catch {
    /* keep defaults */
  }
}
const clientid =
  toolArgs && (toolArgs.clientid ?? toolArgs.ticketid ?? 'n/a');

// Arm the process-level safety net BEFORE any async work so even a hang or
// crash before the runner resolves still yields exactly one structured
// failure JSON line. This is the core of "no silent gaps".
const net = installSafetyNet({
  consumerId,
  tool,
  clientid,
  environment: env,
  startedAt: Date.now(),
});

async function main() {
  // Unknown synthetic consumer is itself a structured failure (not silent).
  if (!contract) {
    net.disarm();
    const envelope = buildEnvelope({
      consumer: consumerId,
      tool,
      clientid,
      environment: env,
      startedAt: Date.now(),
    });
    const failure = buildFailureReport(envelope, {
      kind: 'tool_error',
      message:
        `unknown synthetic consumer '${consumerId}' ` +
        `(known: ${Object.keys(CONSUMERS).join(', ')})`,
      attempts: 1,
    });
    return failure;
  }

  const policy = POLICIES[contract];

  const job = await runAuditJob({
    consumerId,
    tool,
    toolArgs,
    clientid,
    rawToken: RAW(consumerId),
    registry: REGISTRY,
    environment: env,
    contract,
    contractPolicy: policy,
    classmapInference: buildInferredClassmap,
    showValues,
  });

  net.disarm();

  // Mode 3: write the RAW report to a gitignored artifact dir (synthetic
  // local data only). Only on a successful audit; failures carry no values.
  if (job.ok && showValues && job.rawReport) {
    try {
      const dir = resolve(process.cwd(), '.audit-local');
      mkdirSync(dir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const file = resolve(dir, `${ts}-${consumerId}-${tool}.json`);
      const rawAnnotated = {
        ...job.rawReport,
        classmap_source: job.classmapSource,
        env,
        consumer: consumerId,
        tool,
        clientid,
      };
      writeFileSync(file, JSON.stringify(rawAnnotated, null, 2) + '\n', {
        mode: 0o600,
      });
      process.stderr.write(
        `exposure-audit: raw report written to ${file} ` +
          `(gitignored, synthetic local data only)\n`
      );
    } catch (e) {
      process.stderr.write(
        `exposure-audit: could not write raw artifact (${
          e && e.name ? e.name : 'Error'
        }) — stdout report is unaffected\n`
      );
    }
  }

  // stdout is ALWAYS exactly one JSON object: redacted report OR structured
  // failure. Both carry correlation_id + dimensions. Never a raw value.
  return job.stdout;
}

// Reference auditExposure so a future refactor that drops the inference
// fallback fails loudly instead of silently — keeps the import meaningful.
void auditExposure;

main()
  .then((payload) => {
    net.disarm();
    // Single exit path: flush the one JSON object fully before exiting so a
    // large (~50KB) report is never truncated at the 8192-byte pipe boundary
    // (`process.exit()` does not drain a pending pipe write). This closes the
    // dominant silent/parse-failure class.
    writeJsonLineAndExit(payload);
  })
  .catch((err) => {
    // Last-resort: the safety net normally fires first, but if main() itself
    // rejects we still emit exactly one structured failure, never silent.
    net.disarm();
    writeJsonLineAndExit({
      ok: false,
      failure: {
        kind: 'audit_error',
        message: err && err.message ? err.message : 'aborted',
      },
      correlation_id: '00000000-0000-0000-0000-000000000000',
      consumer: consumerId,
      tool,
      clientid,
      environment: env,
    });
  });
