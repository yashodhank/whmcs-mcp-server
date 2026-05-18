// Phase H — batch exposure-audit sweep (companion runner).
//
// PHASE H.1 (Track C): SUPERSEDED by scripts/exposure-audit-pilot.mjs, which
// adds explicit client IDs, an environment label, bounded concurrency with
// backpressure, a per-job hard-timeout + safe retry (in the child), and a
// { total, ok, failed, by_kind, by_tool, by_consumer, reliability_pct }
// metrics rollup that eliminates the 29% silent-loss the original 150-job
// pilot saw. This file is kept as a back-compat alias and now DELEGATES to
// the pilot (single client `1`, concurrency 1) so existing invocations keep
// working while getting the reliability contract. Prefer the pilot directly.
//
// LEGACY DESCRIPTION (delegated):
//   A thin operator convenience that runs scripts/mcp-exposure-audit.mjs
//   once per (synthetic consumer × known tool) pair and aggregates the
//   per-pair REDACTED reports. It does NOT re-implement the auditor, the
//   MCP client, or any of the 3 modes — it delegates to the single-shot
//   script, which already enforces:
//     - stdout is ALWAYS the redacted report OR a structured failure,
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
// COVERAGE  (consumers × tools — same set as the pilot)
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
//   Dev sweep, redacted metrics rollup to stdout:
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
//   For explicit client IDs / concurrency / env label, use the pilot:
//     scripts/exposure-audit-pilot.mjs (see its header).

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PILOT = resolve(HERE, 'exposure-audit-pilot.mjs');

// Back-compat: same positional filters (consumer, tool), single synthetic
// client `1`, fully serialized server boots (concurrency 1). This preserves
// the original deterministic, one-server-at-a-time behaviour while routing
// through the reliability-hardened pilot (timeouts, retry, no silent gaps,
// metrics rollup). Env (MCP_ENV / AUDIT_LOCAL_VALUES) passes through.
const passThroughArgs = [
  process.argv[2] ?? '',
  process.argv[3] ?? '',
].filter((_, i, a) => !(i === 1 && a[1] === '' && a[0] === ''));

const child = spawn(
  process.execPath,
  ['--import', 'tsx', PILOT, ...passThroughArgs],
  {
    env: {
      ...process.env,
      AUDIT_CLIENTS: process.env.AUDIT_CLIENTS ?? '1',
      AUDIT_CONCURRENCY: process.env.AUDIT_CONCURRENCY ?? '1',
    },
    stdio: 'inherit',
  }
);

child.on('error', (err) => {
  process.stderr.write(
    `exposure-audit-all: could not start pilot (${
      err && err.name ? err.name : 'Error'
    })\n`
  );
  process.exit(0);
});
child.on('close', () => {
  // Reporting tool, not a gate — always exit 0.
  process.exit(0);
});
