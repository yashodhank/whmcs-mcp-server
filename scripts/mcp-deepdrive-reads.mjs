// READ-tool deep-drive harness for the WHMCS MCP server (dev/test only).
//
// Drives the built server over stdio (MCP_ENV=local) as an MCP client and
// calls EVERY read + aggregator + capability-shell tool it exposes, filling
// required params from a fixed seeded inventory. STRICTLY READ-ONLY: it never
// calls any write/draft/execute tool (those are filtered out by name).
//
// Usage (per leg — override WHMCS_API_URL):
//   set -a; . ./.env.local; set +a
//   WHMCS_API_URL=http://localhost:8890 node scripts/mcp-deepdrive-reads.mjs
//   WHMCS_API_URL=http://localhost:8813 node scripts/mcp-deepdrive-reads.mjs
//
// With no WHMCS_API_URL override (or BOTH_LEGS=1) it loops both legs itself.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const text = (r) => (r?.content?.[0]?.text ?? '');
const j = (r) => {
  try {
    return JSON.parse(text(r));
  } catch {
    return text(r);
  }
};

// ---------------------------------------------------------------------------
// Seeded inventory (identical on both legs).
// ---------------------------------------------------------------------------
const INV = {
  clientid: 1,
  serviceid: 78,
  serviceid_alt: 98,
  domainid: 46,
  ticketid: 19407,
  invoiceid: 300003083,
  pid: 403,
  orderid: 987,
  deptid: 12,
};

// Param-name → seeded value resolver. Covers the many naming variants the
// server's schemas use across tools (clientid/client_id/id, serviceid/id, ...).
function valueForParam(toolName, paramName, schema, learned) {
  const p = paramName.toLowerCase();
  // search/term-style params: use a broad term learned from client 1.
  if (/(^|_)(q|query|term|search|keyword|searchterm)$/.test(p)) {
    return learned.searchTerm ?? 'a';
  }
  if (p === 'email') return learned.email ?? undefined;
  if (p === 'domain') return learned.domain ?? 'example.com';

  // id-ish params, in priority order.
  if (/clientid|client_id/.test(p)) return INV.clientid;
  if (/(service|hosting).*id|^id$.*service/.test(p)) return INV.serviceid;
  if (/serviceid|service_id/.test(p)) return INV.serviceid;
  if (/domainid|domain_id/.test(p)) return INV.domainid;
  if (/ticketid|ticket_id/.test(p)) return INV.ticketid;
  if (/invoiceid|invoice_id/.test(p)) return INV.invoiceid;
  if (/(^pid$|productid|product_id)/.test(p)) return INV.pid;
  if (/orderid|order_id/.test(p)) return INV.orderid;
  if (/(deptid|departmentid|department_id|dept_id)/.test(p)) return INV.deptid;

  // bare "id" — resolve by the tool it belongs to.
  if (p === 'id') {
    if (/service/.test(toolName)) return INV.serviceid;
    if (/domain/.test(toolName)) return INV.domainid;
    if (/ticket/.test(toolName)) return INV.ticketid;
    if (/invoice/.test(toolName)) return INV.invoiceid;
    if (/order/.test(toolName)) return INV.orderid;
    if (/product/.test(toolName)) return INV.pid;
    if (/client|account|customer/.test(toolName)) return INV.clientid;
    return INV.clientid;
  }

  // limit/paging — keep tiny.
  if (/limit|limitnum|pagesize|page_size/.test(p)) return 2;
  if (/^(start|offset|page)$/.test(p)) return 0;

  // type defaults from JSON schema.
  const t = schema?.type;
  if (t === 'integer' || t === 'number') return 1;
  if (t === 'boolean') return false;
  if (t === 'string') {
    if (Array.isArray(schema?.enum) && schema.enum.length) return schema.enum[0];
    return 'a';
  }
  if (t === 'array') return [];
  return undefined;
}

// Param names that are pure transport plumbing — never fill these.
const PLUMBING = new Set(['auth_token', 'contract']);

// A property is a "primary id / lookup" param we should fill even when the
// schema marks nothing as required (many single-entity read tools declare
// their id as optional because they accept either id or ids[]).
function isPrimaryLookupParam(name) {
  const p = name.toLowerCase();
  return (
    /clientid$|client_id$|serviceid$|service_id$|domainid$|domain_id$|ticketid$|ticket_id$|invoiceid$|invoice_id$|orderid$|order_id$|^pid$|productid$|product_id$|deptid$|departmentid$|department_id$|^id$/.test(
      p
    ) || /(^|_)(q|query|term|search|keyword|searchterm)$/.test(p)
  );
}

// Build an arguments object: fill every REQUIRED param, every primary
// id/lookup param (even if optional), and clientid for list_*/aggregator
// tools — so each tool exercises a real read path. Plumbing params and
// "...ids[]" plural variants are left out.
function buildArgs(tool, learned) {
  const schema = tool.inputSchema ?? {};
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const args = {};

  for (const [name, sub] of Object.entries(props)) {
    if (PLUMBING.has(name)) continue;
    // Skip plural id arrays (clientids/invoiceids/...) — we use the singular.
    if (/ids$/.test(name.toLowerCase())) continue;
    const isRequired = required.has(name);
    const isLookup = isPrimaryLookupParam(name);
    if (!isRequired && !isLookup) continue;
    const v = valueForParam(tool.name, name, sub, learned);
    if (v !== undefined) args[name] = v;
  }
  return args;
}

// A tool is a WRITE tool (never call) if its name matches mutating verbs.
const WRITE_RE =
  /^(write$|create|update|delete|mark_|add_|apply_|capture_|record_|register_|renew_|transfer_|sync_|suspend|unsuspend|terminate|accept_|reply_|draft_|execute_|approve_|validate_write|get_write_intent)/;

// Read/aggregator/capability tools we positively expect to find.
const EXPECTED = [
  'get_client_details',
  'get_service_details',
  'search_clients',
  'get_invoice',
  'get_ticket_thread',
  'get_ticket_departments',
  'list_client_services',
  'list_client_domains',
  'list_client_invoices',
  'list_client_orders',
  'list_client_tickets',
  'list_client_transactions',
  'get_activity_log',
  'list_products',
  'list_invoices',
  'list_services',
  'list_users',
  'get_stats',
  'get_todo_items',
  'get_automation_log',
  'get_capability_matrix',
  'get_account_360',
  'get_billing_snapshot',
  'get_support_snapshot',
  'get_renewal_snapshot',
  'get_activity_timeline',
  'get_reconciliation_snapshot',
  'get_provisioning_snapshot',
  'get_risk_snapshot',
];

// Detect a structured "capability gated by design" payload → PASS-WITH-NOTE.
function isGated(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.capability_unavailable === true) return true;
  if (payload.status === 'capability_unavailable') return true;
  // Some shells nest it under data/sections — shallow scan one level.
  for (const v of Object.values(payload)) {
    if (v && typeof v === 'object') {
      if (v.capability_unavailable === true) return true;
      if (v.status === 'capability_unavailable') return true;
    }
  }
  return false;
}

// Short shape summary for logging (no PII bodies — keys + small counts only).
function shapeSummary(payload) {
  if (payload == null) return 'null';
  if (typeof payload === 'string') return `text(${payload.length}b)`;
  if (Array.isArray(payload)) return `array[${payload.length}]`;
  if (typeof payload === 'object') {
    const keys = Object.keys(payload);
    const counts = [];
    for (const k of keys.slice(0, 8)) {
      const v = payload[k];
      if (Array.isArray(v)) counts.push(`${k}[${v.length}]`);
      else if (v && typeof v === 'object') counts.push(`${k}{}`);
      else counts.push(k);
    }
    return `{${counts.join(',')}${keys.length > 8 ? ',…' : ''}}`;
  }
  return String(payload);
}

async function runLeg(apiUrl) {
  console.log(`\n${'='.repeat(72)}`);
  console.log(`LEG: ${apiUrl}`);
  console.log('='.repeat(72));

  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
    env: {
      ...process.env,
      MCP_ENV: 'local',
      WHMCS_API_URL: apiUrl,
      WHMCS_ALLOW_HTTP: 'true',
      MCP_MODE: 'read_only',
    },
    stderr: 'ignore',
  });
  const client = new Client(
    { name: 'deepdrive-reads', version: '1.0.0' },
    { capabilities: {} }
  );
  await client.connect(transport);

  const { tools } = await client.listTools();
  const byName = new Map(tools.map((t) => [t.name, t]));
  console.log(`tools/list → ${tools.length} tools`);

  // Assert expected read/aggregator tools are present.
  const missing = EXPECTED.filter((n) => !byName.has(n));
  if (missing.length) {
    console.log(`  [WARN] expected-but-missing: ${missing.join(', ')}`);
  } else {
    console.log(`  [OK] all ${EXPECTED.length} expected read tools present`);
  }

  // Discover the full read set = everything that is NOT a write tool.
  const readTools = tools
    .filter((t) => !WRITE_RE.test(t.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  console.log(
    `  read/aggregator/capability tools to exercise: ${readTools.length}` +
      ` (write tools skipped: ${tools.length - readTools.length})`
  );

  const call = (name, args = {}) => client.callTool({ name, arguments: args });

  // Learn a search term + email + domain from client 1 first.
  const learned = { searchTerm: 'a' };
  if (byName.has('get_client_details')) {
    try {
      const gcd = j(await call('get_client_details', { clientid: INV.clientid }));
      if (gcd && typeof gcd === 'object') {
        const c = gcd.client ?? gcd.data ?? gcd;
        const email = c.email ?? gcd.email;
        const last = c.lastname ?? gcd.lastname;
        const first = c.firstname ?? gcd.firstname;
        if (typeof email === 'string' && email.includes('@')) {
          learned.email = email;
          learned.searchTerm = email;
        } else if (typeof last === 'string' && last) {
          learned.searchTerm = last;
        } else if (typeof first === 'string' && first) {
          learned.searchTerm = first;
        }
      }
    } catch {
      /* fall back to defaults */
    }
  }

  let pass = 0,
    fail = 0,
    gated = 0;
  const failures = [];

  for (const tool of readTools) {
    const args = buildArgs(tool, learned);
    let line;
    try {
      const r = await call(tool.name, args);
      const payload = j(r);
      // A structured capability_unavailable marker is GATED-by-design — it is
      // PASS-WITH-NOTE even when the server flags the envelope isError.
      if (isGated(payload)) {
        gated++;
        pass++;
        line = `[GATED] ${tool.name} -> capability_unavailable (gated by design)`;
      } else if (r?.isError) {
        fail++;
        const msg = (text(r) || '').slice(0, 160);
        line = `[FAIL] ${tool.name} -> isError: ${msg}`;
        failures.push({ tool: tool.name, args, error: msg });
      } else if (payload == null || (typeof payload === 'string' && payload === '')) {
        // No structured content at all → treat as failure.
        fail++;
        line = `[FAIL] ${tool.name} -> empty/no structured content`;
        failures.push({ tool: tool.name, args, error: 'empty/no structured content' });
      } else {
        pass++;
        line = `[PASS] ${tool.name} -> ${shapeSummary(payload)}`;
      }
    } catch (e) {
      fail++;
      const msg = String(e?.message ?? e).slice(0, 160);
      line = `[FAIL] ${tool.name} -> threw: ${msg}`;
      failures.push({ tool: tool.name, args, error: `threw: ${msg}` });
    }
    console.log('  ' + line);
  }

  const total = pass + fail;
  console.log(
    `\nSUMMARY [${apiUrl}]: ${pass}/${total} passed (gated: ${gated}), ${fail} failed`
  );
  if (failures.length) {
    console.log('  GENUINE FAILURES:');
    for (const f of failures) {
      console.log(
        `    - ${f.tool} args=${JSON.stringify(f.args)} :: ${f.error}`
      );
    }
  }

  await client.close();
  return { apiUrl, pass, fail, gated, total, failures, toolCount: tools.length, missing };
}

async function main() {
  const explicit = process.env.WHMCS_API_URL;
  const both = process.env.BOTH_LEGS === '1';
  const legs =
    both || !explicit
      ? ['http://localhost:8890', 'http://localhost:8813']
      : [explicit];

  const results = [];
  for (const leg of legs) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await runLeg(leg));
  }

  console.log(`\n${'#'.repeat(72)}`);
  console.log('OVERALL');
  console.log('#'.repeat(72));
  let anyFail = false;
  for (const r of results) {
    console.log(
      `  ${r.apiUrl}: ${r.pass}/${r.total} (gated: ${r.gated}), failed: ${r.fail}` +
        (r.missing.length ? `, missing-tools: ${r.missing.length}` : '')
    );
    if (r.fail) anyFail = true;
  }
  process.exit(anyFail ? 1 : 0);
}

main().catch((e) => {
  console.error('harness aborted:', e);
  process.exit(2);
});
