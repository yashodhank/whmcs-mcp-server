// PHASE H.1 (Track C) — exposure-audit PILOT runner.
//
// WHAT THIS IS
//   The reliability-hardened batch sweeper. Runs the single-shot
//   scripts/mcp-exposure-audit.mjs once per (consumer × tool × clientId),
//   with a bounded concurrency that does NOT reproduce the 29% silent-loss
//   the original 150-job pilot saw, and aggregates a metrics rollup. Every
//   child emits exactly one structured JSON object (redacted audit report OR
//   structured failure) — there are no silent gaps to aggregate around. If a
//   child somehow emits nothing at all, this runner SYNTHESIZES a structured
//   failure for it so the rollup total is always exact.
//
//   The original sweeper ran consumer×tool serially (no clientId axis, no
//   metrics, "unparseable child output" swallowed failures). This replaces
//   it with: explicit client IDs, an environment label, bounded concurrency
//   with backpressure, serialized server boots when concurrency=1, and a
//   { total, ok, failed, by_kind, by_tool, by_consumer, reliability_pct }
//   rollup to stdout + a redacted rollup written to gitignored .audit-local/.
//
// SAFETY (inherited from the single-shot child + enforced here)
//   - Each child enforces: stdout redacted-or-structured-failure only; raw
//     values only ever to ./.audit-local/ and only in mode 3; exit 0.
//   - This runner NEVER prints/writes a raw value; it only collects the
//     children's already-safe stdout and writes a REDACTED rollup.
//   - Exit code is always 0 (reporting tool, not a gate). The
//     reliability_pct is the number a gate should read.
//
// HOW TO RUN  (server must be BUILT first: npm run build)
//   Dev sweep (default clients 1,2; concurrency 2), metrics to stdout:
//     MCP_ENV=local node scripts/exposure-audit-pilot.mjs
//   Explicit clients + env label + concurrency:
//     MCP_ENV=local AUDIT_CLIENTS=1,2,3 AUDIT_ENV_LABEL=dev-pilot \
//       AUDIT_CONCURRENCY=2 node scripts/exposure-audit-pilot.mjs
//   Filter to one consumer / tool (still all clients):
//     MCP_ENV=local node scripts/exposure-audit-pilot.mjs admin_full_trusted ''
//     MCP_ENV=local node scripts/exposure-audit-pilot.mjs '' get_stats
//   Local-operator raw artifacts (synthetic) → ./.audit-local/ (mode 3):
//     MCP_ENV=local AUDIT_LOCAL_VALUES=1 node scripts/exposure-audit-pilot.mjs
//
// CONCURRENCY NOTE
//   Each child boots its own dist/index.js MCP server over stdio. The
//   original silent failures were stdio/timeout under N concurrent server
//   boots. Default concurrency here is a conservative 2 and is the single
//   tuning knob (AUDIT_CONCURRENCY). Set it to 1 to fully serialize server
//   boots if a constrained host still shows transport_error/connect_timeout
//   in by_kind. Per-job hard timeouts + safe retry (in the child) absorb
//   transient hiccups; the rollup makes any residual failure visible and
//   classified rather than silently dropped.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { aggregateMetrics } from '../src/auditHarness/runnerCore.ts';

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
  'get_activity_timeline',
  'get_risk_snapshot',
  'list_client_transactions',
  'get_stats',
  'get_todo_items',
  'get_automation_log',
];

const onlyConsumer =
  process.argv[2] && process.argv[2].length > 0 ? process.argv[2] : null;
const onlyTool =
  process.argv[3] && process.argv[3].length > 0 ? process.argv[3] : null;

const consumers = onlyConsumer
  ? CONSUMERS.filter((c) => c === onlyConsumer)
  : CONSUMERS;
const tools = onlyTool ? TOOLS.filter((t) => t === onlyTool) : TOOLS;

// Explicit synthetic client IDs (read-only, example data only).
const clients = (process.env.AUDIT_CLIENTS ?? '1,2')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0)
  .map((s) => (Number.isFinite(Number(s)) ? Number(s) : s));

const mcpEnv = process.env.MCP_ENV ?? 'production';
// Human label for the rollup (e.g. dev-pilot, staging). Distinct from the
// MCP_ENV mode that drives child redaction.
const envLabel = process.env.AUDIT_ENV_LABEL ?? mcpEnv;

// The single tuning knob for the stdio-failure class. Default conservative.
const concurrency = Math.max(
  1,
  Number(process.env.AUDIT_CONCURRENCY ?? 2) || 2
);

// Tools the pilot args inject a clientid for. get_stats takes none;
// get_ticket_thread takes ticketid. We map the client axis onto the right
// key so the same client list is meaningful across tools.
function argsFor(tool, client) {
  if (tool === 'get_stats') return null; // no per-client arg
  if (tool === 'get_ticket_thread') return { ticketid: client };
  if (tool === 'get_account_360') return { clientid: client, recent: 3 };
  if (
    tool === 'list_client_invoices' ||
    tool === 'list_client_domains' ||
    tool === 'list_client_services' ||
    tool === 'list_client_transactions' ||
    tool === 'get_todo_items' ||
    tool === 'get_automation_log'
  ) {
    return { clientid: client, limit: 3 };
  }
  return { clientid: client };
}

// Run one single-shot child. ALWAYS resolves to a structured object: the
// child's redacted report / structured failure, or — if the child somehow
// produced no parseable line — a SYNTHESIZED structured failure so the
// rollup total is exact and no gap is silent.
function runOne(consumer, tool, client) {
  const childArgs = [SINGLE, consumer, tool];
  const a = argsFor(tool, client);
  if (a) childArgs.push(JSON.stringify(a));

  return new Promise((resolveRun) => {
    let child;
    try {
      child = spawn(process.execPath, ['--import', 'tsx', ...childArgs], {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'inherit'],
      });
    } catch (e) {
      resolveRun(
        synthFailure(consumer, tool, client, 'transport_error', String(e))
      );
      return;
    }

    // Collect stdout as Buffers and resolve ONLY after the stdout stream has
    // fully ended AND the process exited. A child that writes a large (~50KB)
    // report then exits quickly can otherwise emit `close` before all `data`
    // chunks are drained — a Node stdio race that truncates the captured
    // JSON mid-string and was the dominant residual parse_error here.
    const chunks = [];
    let stdoutEnded = false;
    let exited = false;
    let settled = false;

    const finish = () => {
      if (settled) return;
      if (!stdoutEnded || !exited) return;
      settled = true;
      const out = Buffer.concat(chunks).toString('utf8');
      const obj = lastJsonObject(out);
      if (obj && typeof obj === 'object') {
        resolveRun(normalize(obj, consumer, tool, client));
        return;
      }
      // No parseable JSON at all — the exact failure mode this Track fixes.
      // Never silently drop it: synthesize a structured failure.
      resolveRun(
        synthFailure(
          consumer,
          tool,
          client,
          'parse_error',
          'child produced no parseable structured output'
        )
      );
    };

    child.stdout.on('data', (d) => {
      chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d));
    });
    child.stdout.on('end', () => {
      stdoutEnded = true;
      finish();
    });
    child.stdout.on('error', () => {
      stdoutEnded = true;
      finish();
    });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      resolveRun(
        synthFailure(
          consumer,
          tool,
          client,
          'transport_error',
          e && e.message ? e.message : 'child failed to spawn'
        )
      );
    });
    child.on('exit', () => {
      exited = true;
      finish();
    });
  });
}

// Children pretty-print JSON (2-space). Grab the LAST top-level {...} block
// so trailing/leading noise can never break aggregation.
function lastJsonObject(s) {
  const trimmed = s.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to bracket scan */
  }
  let depth = 0;
  let start = -1;
  let last = null;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          last = JSON.parse(trimmed.slice(start, i + 1));
        } catch {
          /* keep previous */
        }
      }
    }
  }
  return last;
}

// A SYNTHESIZED structured failure for a child that produced no parseable
// output / failed to spawn — returned in the SAME normalized shape as
// normalize() so the rollup total is always exact and no gap is silent.
function synthFailure(consumer, tool, client, kind, message) {
  const report = {
    ok: false,
    failure: { kind, message },
    consumer,
    tool,
    clientid: client,
    environment: envLabel,
    attempts: 0,
    synthesized: true,
  };
  return {
    consumer,
    tool,
    clientid: client,
    ok: false,
    report,
    outcome: {
      ok: false,
      tool,
      consumer,
      clientid: client,
      failure_kind: kind,
    },
  };
}

// Normalize a child object into { outcome, report } where outcome feeds the
// pure aggregator and report is the redacted child stdout for the rollup.
function normalize(obj, consumer, tool, client) {
  const ok = obj.ok === true;
  return {
    consumer,
    tool,
    clientid: client,
    ok,
    report: obj,
    outcome: {
      ok,
      tool,
      consumer,
      clientid: client,
      ...(ok
        ? {}
        : {
            failure_kind:
              (obj.failure && obj.failure.kind) ||
              (obj.synthesized ? 'parse_error' : 'unknown'),
          }),
    },
  };
}

// Bounded-concurrency worker pool with backpressure: at most `concurrency`
// children alive at once. concurrency=1 fully serializes server boots.
async function runPool(jobs, limit) {
  const results = new Array(jobs.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      const { consumer, tool, client } = jobs[i];
      // eslint-disable-next-line no-await-in-loop
      results[i] = await runOne(consumer, tool, client);
    }
  }
  const workers = [];
  for (let w = 0; w < Math.min(limit, jobs.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

async function main() {
  const jobs = [];
  for (const consumer of consumers) {
    for (const tool of tools) {
      if (tool === 'get_stats') {
        jobs.push({ consumer, tool, client: 'n/a' });
        continue;
      }
      for (const client of clients) {
        jobs.push({ consumer, tool, client });
      }
    }
  }

  const startedAt = Date.now();
  const results = await runPool(jobs, concurrency);
  const durationMs = Date.now() - startedAt;

  const outcomes = results.map((r) => r.outcome);
  const metrics = aggregateMetrics(outcomes);

  // Redacted per-job reports for the artifact (children already redacted).
  const perJob = results.map((r) => ({
    consumer: r.consumer,
    tool: r.tool,
    clientid: r.clientid,
    ok: r.ok,
    report: r.report,
  }));

  const rollup = {
    kind: 'exposure-audit-pilot-rollup',
    environment: envLabel,
    mcp_env: mcpEnv,
    generated_at: new Date().toISOString(),
    duration_ms: durationMs,
    concurrency,
    clients,
    consumers,
    tools,
    job_count: jobs.length,
    metrics,
    // The number a gate should read. ≥95% is the dev target; any residual
    // production failures are CLASSIFIED in metrics.by_kind, not masked.
    reliability_pct: metrics.reliability_pct,
  };

  // Always write the redacted rollup (+ redacted per-job) to the gitignored
  // artifact dir for operator review. NEVER a raw value (children redacted).
  try {
    const dir = resolve(process.cwd(), '.audit-local');
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const file = resolve(dir, `pilot-rollup-${ts}.json`);
    writeFileSync(
      file,
      JSON.stringify({ ...rollup, results: perJob }, null, 2) + '\n',
      { mode: 0o600 }
    );
    process.stderr.write(
      `exposure-audit-pilot: redacted rollup written to ${file} ` +
        `(gitignored)\n`
    );
  } catch (e) {
    process.stderr.write(
      `exposure-audit-pilot: could not write rollup artifact (${
        e && e.name ? e.name : 'Error'
      }) — stdout metrics are unaffected\n`
    );
  }

  // stdout is ALWAYS the REDACTED rollup with the metrics shape the spec
  // mandates: { total, ok, failed, by_kind, by_tool, by_consumer,
  // reliability_pct }. No raw values, ever.
  process.stdout.write(JSON.stringify(rollup, null, 2) + '\n');
}

main()
  .catch((err) => {
    process.stderr.write(
      `exposure-audit-pilot: aborted before completion (${
        err && err.name ? err.name : 'Error'
      })\n`
    );
    if (process.env.AUDIT_DEBUG === '1' && err && err.stack) {
      process.stderr.write(err.stack + '\n');
    }
  })
  .finally(() => {
    process.exit(0);
  });
