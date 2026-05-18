// Phase H — batch exposure-audit sweep (companion runner).
//
// WHAT THIS IS
//   A thin operator convenience that runs scripts/mcp-exposure-audit.mjs
//   once per (synthetic consumer × known tool) pair and aggregates the
//   per-pair REDACTED reports into a single redacted JSON document on
//   stdout. It does NOT re-implement the auditor, the MCP client, or any
//   of the 3 modes — it delegates entirely to the single-shot script,
//   which already enforces:
//     - stdout is ALWAYS the redacted report (no raw values, ever),
//     - raw artifacts only ever touch ./.audit-local/ and ONLY in mode 3
//       (MCP_ENV=local AND AUDIT_LOCAL_VALUES=1),
//     - production-read (MCP_ENV=production) never prints/writes values
//       and ignores AUDIT_LOCAL_VALUES,
//     - exit code is always 0 (reporting tool, not a gate).
//   Because each child enforces those invariants, this sweeper inherits
//   them. It NEVER prints or writes a raw value itself; it only collects
//   the children's already-redacted stdout. The env (MCP_ENV /
//   AUDIT_LOCAL_VALUES) is passed through unchanged to each child.
//
// COVERAGE
//   Consumers: llm_chat, ops_operator, billing_dashboard, renewal_worker,
//              support_console, admin_full_trusted
//   Tools:     get_client_details, list_client_invoices,
//              list_client_domains, list_client_services,
//              get_ticket_thread, get_account_360, get_billing_snapshot,
//              get_reconciliation_snapshot, get_support_snapshot,
//              get_renewal_snapshot, list_client_transactions, get_stats,
//              get_todo_items, get_automation_log
//
// HOW TO RUN (server must be BUILT first: npm run build)
//   Dev sweep, redacted aggregate to stdout:
//     MCP_ENV=local node scripts/mcp-exposure-audit-all.mjs
//   Local operator sweep (raw per-pair artifacts → ./.audit-local/ only):
//     MCP_ENV=local AUDIT_LOCAL_VALUES=1 \
//       node scripts/mcp-exposure-audit-all.mjs
//   Production sweep (paths + classification only, never values):
//     MCP_ENV=production MCP_MODE=read_only \
//       node scripts/mcp-exposure-audit-all.mjs
//   Filter to one consumer and/or one tool:
//     MCP_ENV=local node scripts/mcp-exposure-audit-all.mjs admin_full_trusted
//     MCP_ENV=local node scripts/mcp-exposure-audit-all.mjs '' get_stats

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SINGLE = resolve(HERE, 'mcp-exposure-audit.mjs');

const CONSUMERS = [
  'llm_chat',
  'ops_operator',
  'billing_dashboard',
  'renewal_worker',
  'support_console',
  'admin_full_trusted',
];

const TOOLS = [
  'get_client_details',
  'list_client_invoices',
  'list_client_domains',
  'list_client_services',
  'get_ticket_thread',
  'get_account_360',
  'get_billing_snapshot',
  'get_reconciliation_snapshot',
  'get_support_snapshot',
  'get_renewal_snapshot',
  'list_client_transactions',
  'get_stats',
  'get_todo_items',
  'get_automation_log',
];

// Optional filters: argv[2] = consumer (or '' for all), argv[3] = tool.
const onlyConsumer = process.argv[2] && process.argv[2].length > 0
  ? process.argv[2]
  : null;
const onlyTool = process.argv[3] && process.argv[3].length > 0
  ? process.argv[3]
  : null;

const consumers = onlyConsumer
  ? CONSUMERS.filter((c) => c === onlyConsumer)
  : CONSUMERS;
const tools = onlyTool ? TOOLS.filter((t) => t === onlyTool) : TOOLS;

// Run one single-shot child; capture only its REDACTED stdout. The child
// is responsible for all mode/redaction enforcement. Never resolves with a
// raw value — the child's stdout is redacted by construction.
function runOne(consumer, tool) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [SINGLE, consumer, tool], {
      // Pass env through unchanged so mode (MCP_ENV / AUDIT_LOCAL_VALUES)
      // is identical to a direct single-shot invocation.
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.on('close', () => {
      let parsed;
      try {
        parsed = JSON.parse(out);
      } catch {
        parsed = { error: 'unparseable redacted child output', consumer, tool };
      }
      resolveRun({ consumer, tool, report: parsed });
    });
    child.on('error', () => {
      resolveRun({
        consumer,
        tool,
        report: { error: 'child failed to spawn', consumer, tool },
      });
    });
  });
}

async function main() {
  const env = process.env.MCP_ENV ?? 'production';
  const results = [];
  // Sequential: each child boots its own MCP server; serial keeps it
  // deterministic and avoids N concurrent dist/index.js processes.
  for (const consumer of consumers) {
    for (const tool of tools) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await runOne(consumer, tool));
    }
  }

  const aggregate = {
    kind: 'exposure-audit-sweep',
    env,
    generated_at: new Date().toISOString(),
    pair_count: results.length,
    note:
      'Every per-pair report below is the REDACTED report from ' +
      'mcp-exposure-audit.mjs (no raw values). Raw artifacts, if any, ' +
      'were written by the child only to ./.audit-local/ and only in ' +
      'mode 3 (MCP_ENV=local AND AUDIT_LOCAL_VALUES=1).',
    results,
  };

  // stdout is ALWAYS the aggregated REDACTED document — never a raw value.
  process.stdout.write(JSON.stringify(aggregate, null, 2) + '\n');
}

main()
  .catch((err) => {
    process.stderr.write(
      `exposure-audit-all: aborted before completion (${
        err && err.name ? err.name : 'Error'
      })\n`
    );
  })
  .finally(() => {
    // Reporting tool, not a gate — always exit 0.
    process.exit(0);
  });
