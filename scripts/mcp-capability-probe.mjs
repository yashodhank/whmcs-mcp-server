// Phase G — deliberate, READ-ONLY capability verification probe.
//
// WHAT THIS IS
//   The WHMCS MCP keeps five reads UNVERIFIED and intentionally OUT of the
//   read allowlist (capabilities.ts UNVERIFIED_READS / actionPolicy.ts
//   READ_ALLOWLIST):
//     GetTransactions   list_client_transactions
//     GetStats          get_system_stats
//     GetUsers          list_users
//     GetToDoItems      list_todo_items
//     GetAutomationLog  list_automation_log
//   `whmcs.read()` calls `assertReadAction`, which BLOCKS these — so they
//   cannot be probed through the normal read path. This operator-run tool
//   issues exactly ONE minimal read-only call per action via the lower-level
//   `WhmcsClient.call(action, { limitnum: 1 }, { isMutating: false })`. That
//   path does NOT consult the read allowlist but DOES still honor read-vs-
//   mutate: isMutating:false is strictly read-only. This is a deliberate,
//   bounded VERIFICATION probe — it does NOT promote anything into the
//   allowlist or capability registry (that is a separate, deliberate step
//   the orchestrator owns). It NEVER calls mutate().
//
// SAFETY
//   - Read-only only: every call is isMutating:false, limitnum:1.
//   - No PII: only {action, capability, status, evidence} is printed, where
//     `evidence` is a short fixed classification string — NEVER the raw
//     WHMCS response body or message text.
//   - Exit code is always 0: this is a reporting tool, not a gate.
//
// HOW TO RUN
//   Local dev WHMCS (dockerized W9):
//     MCP_ENV=local node --import tsx scripts/mcp-capability-probe.mjs
//   Production read-only verification (OPERATOR-RUN ONLY, with prod
//   read-only creds; never wired into automation):
//     MCP_ENV=production MCP_MODE=read_only \
//       node --import tsx scripts/mcp-capability-probe.mjs
//   MCP_ENV defaults to the process env (config.ts default = production).
//   Run from the repo root. `tsx` (a dev dependency) transpiles the TS
//   sources this script imports; nothing needs to be built first.

import {
  classifyProbeOutcome,
  buildProbeReport,
} from '../src/governance/capabilityProbeReport.ts';
import { config } from '../src/config.ts';
import { Logger } from '../src/logging.ts';
import { WhmcsClient } from '../src/whmcs/WhmcsClient.ts';

// The five UNVERIFIED reads. Action names only — capability ids are derived
// inside the pure model (which mirrors capabilities.ts verbatim).
const UNVERIFIED_ACTIONS = [
  'GetTransactions',
  'GetStats',
  'GetUsers',
  'GetToDoItems',
  'GetAutomationLog',
];

async function main() {
  const logger = new Logger('capability-probe');
  const client = new WhmcsClient(config, logger);

  const results = [];
  for (const action of UNVERIFIED_ACTIONS) {
    let outcome;
    try {
      // ONE minimal read-only call. limitnum:1 keeps any returned page tiny;
      // the response body is fed to the PURE classifier and then discarded —
      // it is never logged or printed.
      const response = await client.call(
        action,
        { limitnum: 1 },
        { isMutating: false, normalize: false }
      );
      outcome = { response };
    } catch (error) {
      // WhmcsBusinessError (result:'error') or WhmcsTransportError both land
      // here; the pure classifier separates not_authorized / unsupported /
      // degraded from the message WITHOUT echoing it.
      outcome = { error };
    }
    results.push(classifyProbeOutcome(action, outcome));
  }

  const report = buildProbeReport(results);
  // stdout: PII-free JSON report only.
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

main()
  .catch((err) => {
    // Last-resort: never leak a response body. Emit a generic, non-PII line
    // on stderr and still exit 0 (reporting tool, not a gate).
    process.stderr.write(
      `capability-probe: aborted before completion (${
        err && err.name ? err.name : 'Error'
      })\n`
    );
  })
  .finally(() => {
    process.exit(0);
  });
