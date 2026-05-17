// Real MCP client↔server e2e harness (dev/test only).
// Spawns the built server over stdio (MCP_ENV=local) and drives it as an
// MCP client: initialize → tools/list → resources/list → representative
// read tool calls + resource reads against the local WHMCS, with
// SEC-002 (no auth token in returned URIs) and read_only assertions.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const text = (r) => (r?.content?.[0]?.text ?? '');
const j = (r) => { try { return JSON.parse(text(r)); } catch { return text(r); } };
let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log(`  [${c ? 'PASS' : 'FAIL'}] ${m}`); };

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
  env: { ...process.env, MCP_ENV: 'local' },
  stderr: 'ignore',
});
const client = new Client({ name: 'e2e-harness', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);
console.log('connected to MCP server (stdio, MCP_ENV=local)');

const tools = await client.listTools();
ok(tools.tools.length >= 24, `tools/list → ${tools.tools.length} tools`);
const res = await client.listResources().catch(() => ({ resources: [] }));
const resTpl = await client.listResourceTemplates?.().catch(() => ({ resourceTemplates: [] }));
console.log(`  resources=${res.resources?.length ?? 0} templates=${resTpl?.resourceTemplates?.length ?? 0}`);

const call = (name, args = {}) => client.callTool({ name, arguments: args });

// --- read tools vs local WHMCS ---
let r = await call('list_products', { limit: 2 });
ok(j(r)?.products || j(r)?.total >= 0 || /product/i.test(text(r)), `list_products → ${text(r).slice(0, 80)}`);

r = await call('get_ticket_departments', {});
ok(!r.isError, `get_ticket_departments → isError=${!!r.isError}`);

r = await call('get_client_details', { clientid: 1 });
const gcd = j(r);
ok(!r.isError && (gcd.clientid || gcd.email), `get_client_details(1) → ${JSON.stringify(gcd).slice(0, 90)}`);
ok(!/(@(?!example\.test))[^"]*\.[a-z]/i.test(JSON.stringify(gcd)), 'PII: client email is scrubbed (no real domain)');

r = await call('check_domain_availability', { domain: 'example.com' });
const dw = j(r);
ok(!r.isError && (dw.status || /available|unavailable/i.test(text(r))), `check_domain_availability(example.com) → ${text(r).slice(0, 90)} (the prod-500 tool)`);

// --- resource read + SEC-002 (no token leaked in returned uri) ---
try {
  const pb = await client.readResource({ uri: 'whmcs://docs/ops-playbook' });
  const u = pb.contents?.[0]?.uri ?? '';
  ok(!/[?&](token|auth_token)=/.test(u), `SEC-002: ops-playbook uri has no token (${u})`);
} catch (e) { ok(false, `readResource ops-playbook threw: ${String(e).slice(0,80)}`); }
try {
  const cs = await client.readResource({ uri: 'whmcs://clients/1/summary' });
  const u = cs.contents?.[0]?.uri ?? '';
  ok(!/[?&](token|auth_token)=/.test(u), `SEC-002: client-summary uri has no token (${u})`);
  ok(!/(@(?!example\.test))[^"]*\.[a-z]/i.test(cs.contents?.[0]?.text ?? ''), 'PII: client-summary email scrubbed');
} catch (e) { ok(false, `readResource client/1/summary threw: ${String(e).slice(0,80)}`); }

// --- read_only must block writes ---
r = await call('mark_invoice_paid', { invoiceid: 1 });
ok(r.isError && /read_only|not available/i.test(text(r)), `read_only blocks mark_invoice_paid → ${text(r).slice(0, 90)}`);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
await client.close();
process.exit(fail ? 1 : 0);
