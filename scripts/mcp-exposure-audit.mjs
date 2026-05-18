// Phase H — deliberate, READ-ONLY exposure audit harness.
//
// WHAT THIS IS
//   The WHMCS MCP projects canonical data per consumer contract at the
//   output boundary (governance/projection.ts). This operator-run tool
//   drives the BUILT server as an MCP client (same pattern as
//   scripts/mcp-governed-smoke.mjs), calls ONE governed read tool for a
//   given consumer, captures the structured result the consumer would
//   actually receive, and feeds it to the PURE auditor
//   (src/audit/exposureAudit.ts) to report WHAT was exposed and whether
//   each emitted field is safe under that contract.
//
//   It does NOT re-project, block, or mutate anything — projection already
//   happened inside the server. This is a reporting tool only.
//
// THREE MODES (by environment)
//   1. dev mode            MCP_ENV=local (default here). Dev WHMCS is
//                          SYNTHETIC, so full value display is permitted
//                          ONLY when the operator also sets
//                          AUDIT_LOCAL_VALUES=1 (see mode 3).
//   2. production-read     MCP_ENV=production. Field-path + classification
//                          report ONLY. Never prints or writes any value;
//                          AUDIT_LOCAL_VALUES is IGNORED in this mode.
//   3. local-only operator AUDIT_LOCAL_VALUES=1 (requires MCP_ENV=local).
//                          May embed raw synthetic values in the report and
//                          write the RAW report to ./.audit-local/<ts>.json
//                          (gitignored). stdout still prints the REDACTED
//                          report only.
//
// CLASSMAP
//   The pure auditor needs the canonical FieldClassMap. The governed tool
//   output does not expose it (by design — the classmap is internal). If a
//   tool result carries a `__classmap` we use it; otherwise we audit by
//   classification-INFERENCE on key names and annotate the report
//   `classmap_source: 'inferred (classmap unavailable from tool output)'`.
//
// SAFETY
//   - Read-only: governance ON, MCP_MODE=read_only, no writes.
//   - stdout is ALWAYS the REDACTED report (no raw values, ever).
//   - Raw values only ever touch ./.audit-local/ and ONLY in mode 3.
//   - Exit code is always 0: reporting tool, not a gate.
//
// HOW TO RUN
//   Dev (synthetic), redacted report to stdout:
//     MCP_ENV=local node scripts/mcp-exposure-audit.mjs llm_chat get_client_details
//   Local operator, raw artifact to ./.audit-local/ (synthetic only):
//     MCP_ENV=local AUDIT_LOCAL_VALUES=1 \
//       node scripts/mcp-exposure-audit.mjs ops_operator get_client_details
//   Production read (paths + classification ONLY, never values):
//     MCP_ENV=production MCP_MODE=read_only \
//       node scripts/mcp-exposure-audit.mjs llm_chat get_client_details
//
//   Server must be BUILT first (npm run build) — this drives dist/index.js.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  auditExposure,
  redactedReport,
} from '../src/audit/exposureAudit.ts';

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
};
const REGISTRY = JSON.stringify(
  Object.entries(CONSUMERS).map(([id, dc]) => entry(id, dc))
);

// Per-FieldClass policies (mirrors governance/contracts.ts, read-only copy
// used only to drive the pure auditor — the server still owns the real one).
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
};

// Best-effort classification inference on a key NAME (only used when the
// tool output carries no `__classmap`). Conservative: unknown stays unknown.
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

const text = (r) => r?.content?.[0]?.text ?? '';
const parse = (r) => {
  try {
    return JSON.parse(text(r));
  } catch {
    return text(r);
  }
};

async function main() {
  const consumerId = process.argv[2] ?? 'llm_chat';
  const tool = process.argv[3] ?? 'get_client_details';
  const restArgs = process.argv.slice(4);

  const env = process.env.MCP_ENV ?? 'production';
  const isLocal = env === 'local';
  // Mode 3 only when explicitly local AND opted in. Production NEVER shows.
  const showValues = isLocal && process.env.AUDIT_LOCAL_VALUES === '1';

  const contract = CONSUMERS[consumerId];
  if (!contract) {
    process.stderr.write(
      `exposure-audit: unknown synthetic consumer '${consumerId}' ` +
        `(known: ${Object.keys(CONSUMERS).join(', ')})\n`
    );
    return;
  }
  const policy = POLICIES[contract];

  // Default tool args by tool name (small, read-only, synthetic ids).
  const defaultArgs = {
    get_client_details: { clientid: 1 },
    list_client_invoices: { clientid: 1, limit: 3 },
    list_client_domains: { clientid: 1, limit: 3 },
    list_client_services: { clientid: 1, limit: 3 },
    get_ticket_thread: { ticketid: 1 },
    get_account_360: { clientid: 1, recent: 3 },
  };
  let toolArgs = defaultArgs[tool] ?? { clientid: 1 };
  if (restArgs.length > 0) {
    try {
      toolArgs = JSON.parse(restArgs.join(' '));
    } catch {
      /* keep defaults */
    }
  }

  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
    env: {
      ...process.env,
      MCP_ENV: env,
      MCP_MODE: 'read_only',
      MCP_GOVERNANCE_ENABLED: 'true',
      MCP_ALLOW_ANON_LLM: 'false',
      MCP_CONSUMER_REGISTRY: REGISTRY,
    },
    stderr: 'ignore',
  });
  const client = new Client(
    { name: 'exposure-audit', version: '1.0.0' },
    { capabilities: {} }
  );
  await client.connect(transport);

  let result;
  try {
    result = await client.callTool({
      name: tool,
      arguments: { ...toolArgs, auth_token: RAW(consumerId) },
    });
  } finally {
    await client.close();
  }

  const payload = parse(result);
  // The governed tool wraps emitted data under `data` / `items` / itself.
  const projected =
    payload && typeof payload === 'object'
      ? (payload.data ??
          (Array.isArray(payload.items)
            ? { items: payload.items }
            : payload))
      : { value: payload };

  // Prefer an explicit classmap if the tool ever surfaces one; else infer.
  let canonicalClasses;
  let classmapSource;
  if (payload && typeof payload === 'object' && payload.__classmap) {
    canonicalClasses = payload.__classmap;
    classmapSource = 'tool-output';
  } else {
    canonicalClasses = buildInferredClassmap(projected);
    classmapSource =
      'inferred (classmap unavailable from tool output)';
  }

  const report = auditExposure({
    consumer_id: consumerId,
    contract,
    tool,
    canonicalClasses,
    projected:
      projected && typeof projected === 'object' ? projected : {},
    contractPolicy: policy,
    localShowValues: showValues,
  });

  const annotated = { ...report, classmap_source: classmapSource, env };

  // Mode 3: write the RAW report to a gitignored artifact dir.
  if (showValues) {
    const dir = resolve(process.cwd(), '.audit-local');
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const file = resolve(dir, `${ts}.json`);
    writeFileSync(file, JSON.stringify(annotated, null, 2) + '\n', {
      mode: 0o600,
    });
    process.stderr.write(
      `exposure-audit: raw report written to ${file} ` +
        `(gitignored, synthetic local data only)\n`
    );
  }

  // stdout is ALWAYS redacted — no raw values, in any mode.
  const safe = {
    ...redactedReport(report),
    classmap_source: classmapSource,
    env,
  };
  process.stdout.write(JSON.stringify(safe, null, 2) + '\n');
}

main()
  .catch((err) => {
    process.stderr.write(
      `exposure-audit: aborted before completion (${
        err && err.name ? err.name : 'Error'
      })\n`
    );
  })
  .finally(() => {
    process.exit(0);
  });
