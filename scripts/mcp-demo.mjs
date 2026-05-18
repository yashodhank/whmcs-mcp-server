// On-demand MCP client driver for live demos (dev/test only, not committed
// to product behavior). Spawns the built server over stdio and performs a
// single operation, printing the JSON result.
//
// Usage:
//   node scripts/mcp-demo.mjs <local|prod> list
//   node scripts/mcp-demo.mjs <local|prod> tool <toolName> '<jsonArgs>'
//   node scripts/mcp-demo.mjs <local|prod> resource '<whmcs://uri>'
//
// prod runs are FORCED read_only (defense-in-depth on top of config).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [, , envName, kind, a, b] = process.argv;
if (!envName || !kind) {
  console.error('usage: mcp-demo.mjs <local|prod> <list|tool|resource> [name] [jsonArgs|uri]');
  process.exit(2);
}

const env = { ...process.env };
if (envName === 'local') {
  env.MCP_ENV = 'local';
} else if (envName === 'prod') {
  env.MCP_ENV = 'production';
  env.MCP_MODE = 'read_only'; // hard guardrail for live prod demos
} else {
  console.error(`unknown env "${envName}" (use local|prod)`);
  process.exit(2);
}

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
  env,
  stderr: 'ignore',
});
const client = new Client({ name: 'mcp-demo', version: '1.0.0' }, { capabilities: {} });

const pretty = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const unwrap = (r) => {
  const t = r?.content?.[0]?.text ?? r?.contents?.[0]?.text ?? '';
  try { return JSON.parse(t); } catch { return t || r; }
};

try {
  await client.connect(transport);
  if (kind === 'list') {
    const tools = await client.listTools();
    const res = await client.listResources().catch(() => ({ resources: [] }));
    const tpl = await client.listResourceTemplates?.().catch(() => ({ resourceTemplates: [] }));
    pretty({
      env: envName,
      tools: tools.tools.map((t) => t.name),
      resources: (res.resources || []).map((r) => r.uri),
      resourceTemplates: (tpl?.resourceTemplates || []).map((r) => r.uriTemplate),
    });
  } else if (kind === 'tool') {
    const args = b ? JSON.parse(b) : (a && a.startsWith('{') ? JSON.parse(a) : {});
    const name = b ? a : a; // name is always `a`
    const r = await client.callTool({ name, arguments: args });
    console.log(`[isError=${!!r.isError}]`);
    pretty(unwrap(r));
  } else if (kind === 'resource') {
    const r = await client.readResource({ uri: a });
    pretty(unwrap(r));
  } else {
    console.error(`unknown kind "${kind}"`);
    process.exitCode = 2;
  }
} catch (e) {
  console.error('ERROR:', e?.message || String(e));
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
