// PHASE H.1 — Track D: scenario-based pilot client sampling (discovery).
//
// WHAT THIS IS
//   The prior pilot used a naive first-N auto-pick and missed real risk
//   exposure paths (no overdue / ticket-heavy / inactive account ever made
//   it into the authoritative audit window). This thin script replaces that
//   with DETERMINISTIC, SCENARIO-BASED selection:
//
//     1. Boot the BUILT server (dist/index.js) as an MCP client with
//        GOVERNANCE ON (never disabled) and MCP_MODE=read_only.
//     2. Discover a BOUNDED candidate window via the governed `search_clients`
//        tool (≤ PILOT_SCAN_MAX, default 40, to limit production load).
//     3. For each candidate, make GOVERNED read-only calls
//        (`get_account_360`, `list_client_transactions`) and extract COUNTS
//        + status ONLY — never names/emails/addresses/raw values.
//     4. Feed the non-PII signal records to the PURE selector
//        (scripts/lib/scenarioSelect.mjs) which fills the scenario buckets.
//     5. Print a signals-only JSON to stdout. NO PII ever reaches stdout or
//        any committed file.
//
// WHY GOVERNANCE STAYS ON
//   numeric `clientid` is FieldClass `business.identifier` and `status` /
//   the `counts` block are `public.safe` — they SURVIVE projection under
//   every contract. We use a SYNTHETIC `admin_full_trusted` consumer so the
//   account-360 `client.status` (a non-PII status string) is emitted while
//   STILL going through the real projection pipeline. Governance is NEVER
//   disabled against any WHMCS — `admin_full_trusted` is a governed contract,
//   not a bypass. We deliberately read ONLY status + numeric counts and
//   discard every PII-classed field the moment the response arrives.
//
// PII / RAW-ARTIFACT DISCIPLINE
//   * stdout + any committed artifact: clientid + numeric signals + status
//     ONLY. Never a name / email / address / phone / raw value.
//   * Optional RAW per-candidate responses are written ONLY under the
//     gitignored .audit-local/ dir (verified ignored by .gitignore) and ONLY
//     when PILOT_RAW_LOCAL=1. The script PURGES every raw artifact it wrote
//     before exit, leaving only derived non-PII signals in memory/stdout.
//   * --out <file> writes the SAME signals-only JSON (no PII) for the audit.
//
// SAFETY
//   * Read-only: MCP_MODE=read_only, governance ON, no writes, no mutation.
//   * Bounded scan (≤ PILOT_SCAN_MAX) to limit production load.
//   * Exit 0 always (discovery tool, not a gate); blockers reported on stderr.
//
// USAGE
//   Build first:  npm run build
//   Dev (synthetic WHMCS):
//     MCP_ENV=local node scripts/pilot-sample.mjs
//   Production discovery (governed, read-only, signals-only stdout):
//     MCP_ENV=production MCP_MODE=read_only node scripts/pilot-sample.mjs
//   Persist signals-only JSON for the audit:
//     MCP_ENV=production node scripts/pilot-sample.mjs --out .audit-local/pilot.json
//   Keep + then purge raw discovery (synthetic/local only):
//     MCP_ENV=local PILOT_RAW_LOCAL=1 node scripts/pilot-sample.mjs

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { selectScenarios } from './lib/scenarioSelect.mjs';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const RAW = (id) => `EXAMPLE-${id}-SYNTHETIC-DO-NOT-USE-IN-PROD`;

// Synthetic consumer registry — same shape as scripts/mcp-governed-smoke.mjs
// and scripts/mcp-exposure-audit.mjs. The token is the sha256 of the
// SYNTHETIC example token; this is NOT a production credential.
const PILOT_CONSUMER = 'pilot_sampler';
const PILOT_CONTRACT = 'admin_full_trusted';
const REGISTRY = JSON.stringify([
  {
    id: PILOT_CONSUMER,
    token_sha256: sha(RAW(PILOT_CONSUMER)),
    allowedScopes: ['read'],
    defaultContract: PILOT_CONTRACT,
    allowedContracts: [PILOT_CONTRACT],
    allowedActions: [],
    writeCapability: 'false',
    envRestrictions: [],
    anonymous: false,
  },
]);

const SCAN_MAX = Math.max(
  1,
  Math.min(
    200,
    Number.parseInt(process.env.PILOT_SCAN_MAX ?? '40', 10) || 40
  )
);
const PER_CANDIDATE = Math.max(
  1,
  Math.min(
    SCAN_MAX,
    Number.parseInt(process.env.PILOT_CANDIDATES ?? String(SCAN_MAX), 10) ||
      SCAN_MAX
  )
);

const argOut = (() => {
  const i = process.argv.indexOf('--out');
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
})();
const keepRawLocal = process.env.PILOT_RAW_LOCAL === '1';

const text = (r) => r?.content?.[0]?.text ?? '';
const parse = (r) => {
  try {
    return JSON.parse(text(r));
  } catch {
    return text(r);
  }
};
const toInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

// ── RAW-artifact handling (gitignored .audit-local/ only, then purged) ──────
const AUDIT_DIR = resolve(process.cwd(), '.audit-local');
const rawArtifacts = [];
function writeRawLocal(name, obj) {
  if (!keepRawLocal) return;
  mkdirSync(AUDIT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = resolve(AUDIT_DIR, `pilot-raw-${name}-${ts}.audit-raw.json`);
  writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  rawArtifacts.push(file);
}
function purgeRawArtifacts() {
  for (const f of rawArtifacts) {
    try {
      if (existsSync(f)) rmSync(f, { force: true });
    } catch {
      /* best-effort purge */
    }
  }
}

/**
 * Extract a NON-PII signal record from a governed get_account_360 result.
 * Reads ONLY: clientid, status, and the numeric `counts` block. Every
 * PII-classed field (name/email/address) is ignored and never retained.
 */
function signalFrom360(clientid, payload) {
  // Governed aggregator output: { entity, consumer, contract, data }.
  const data =
    payload && typeof payload === 'object'
      ? (payload.data ?? payload)
      : {};
  const counts =
    data && typeof data === 'object' && data.counts ? data.counts : {};
  // status: non-PII; under admin_full_trusted the (otherwise pii.name)
  // client block is allowed, so client.status is emitted. We take ONLY
  // the status string — nothing else from that block.
  const clientBlock =
    data && typeof data === 'object' && data.client ? data.client : {};
  const status =
    typeof clientBlock.status === 'string' && clientBlock.status.length > 0
      ? clientBlock.status
      : 'Unknown';

  const services =
    toInt(counts.services_total) || toInt(counts.services_active);
  const domains =
    toInt(counts.domains_total) || toInt(counts.domains_active);
  const overdue = toInt(counts.overdue_invoices);
  const unpaid = toInt(counts.unpaid_invoices);
  const tickets = toInt(counts.active_tickets);

  return {
    clientid,
    status,
    services,
    domains,
    // invoices: best non-PII proxy = unpaid+overdue count (no amounts/refs).
    invoices: unpaid + overdue,
    overdue,
    tickets,
    txns: 0, // filled by list_client_transactions below (capability-gated)
    renewal_soon: false, // derived from recent services/domains due dates
  };
}

/**
 * Best-effort renewal-soon derivation from the recent services/domains in
 * the governed 360 (next_due_date / expiry_date within ~60 days). COUNTS /
 * BOOLEAN only — no dates or values are retained.
 */
function deriveRenewalSoon(payload) {
  const data =
    payload && typeof payload === 'object'
      ? (payload.data ?? payload)
      : {};
  const recent =
    data && typeof data === 'object' && data.recent ? data.recent : {};
  const horizonMs = 60 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const within = (d) => {
    if (typeof d !== 'string' || d.length < 8) return false;
    const t = Date.parse(d);
    if (!Number.isFinite(t)) return false;
    const delta = t - now;
    return delta >= -2 * 24 * 60 * 60 * 1000 && delta <= horizonMs;
  };
  const arr = (x) => (Array.isArray(x) ? x : []);
  for (const s of arr(recent.services)) {
    if (within(s?.next_due_date)) return true;
  }
  for (const d of arr(recent.domains)) {
    if (within(d?.next_due_date) || within(d?.expiry_date)) return true;
  }
  return false;
}

async function main() {
  const env = process.env.MCP_ENV ?? 'production';
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
    { name: 'pilot-sample', version: '1.0.0' },
    { capabilities: {} }
  );
  await client.connect(transport);

  const tok = { auth_token: RAW(PILOT_CONSUMER) };
  const call = (name, args) =>
    client.callTool({ name, arguments: { ...args, ...tok } });

  let txnCapabilityUnavailable = false;
  const records = [];

  try {
    // 1. Bounded candidate discovery via governed search_clients.
    const search = parse(
      await call('search_clients', { search: '', limit: SCAN_MAX, offset: 0 })
    );
    writeRawLocal('search_clients', search);

    // Governed list output: { consumer, contract, items, total, ... }.
    const items = Array.isArray(search?.items)
      ? search.items
      : Array.isArray(search?.clients)
        ? search.clients
        : [];
    const candidateIds = [];
    for (const it of items) {
      // clientId is business.identifier and survives projection.
      const cid =
        toInt(it?.clientId) || toInt(it?.clientid) || toInt(it?.id);
      if (cid > 0 && !candidateIds.includes(cid)) candidateIds.push(cid);
      if (candidateIds.length >= PER_CANDIDATE) break;
    }

    // 2. Per-candidate governed reads → non-PII signals only.
    for (const cid of candidateIds) {
      let rec;
      try {
        const a360 = parse(await call('get_account_360', { clientid: cid, recent: 5 }));
        writeRawLocal(`account360-${cid}`, a360);
        if (a360 && a360.isError) {
          // Skip a candidate we cannot read (denied / error). Honest skip.
          continue;
        }
        rec = signalFrom360(cid, a360);
        rec.renewal_soon = deriveRenewalSoon(a360);
      } catch {
        continue;
      }

      // Transactions are capability-gated (GetTransactions may be
      // unverified on this build). Degrade honestly: txns stays 0 and we
      // record the capability state — NEVER faked.
      try {
        const tx = parse(
          await call('list_client_transactions', { clientid: cid, limit: 25 })
        );
        writeRawLocal(`txns-${cid}`, tx);
        if (tx && tx.capability_unavailable === true) {
          txnCapabilityUnavailable = true;
        } else {
          const txItems = Array.isArray(tx?.items)
            ? tx.items
            : Array.isArray(tx?.transactions)
              ? tx.transactions
              : [];
          rec.txns = txItems.length;
        }
      } catch {
        /* leave txns = 0 */
      }

      records.push(rec);
    }
  } finally {
    await client.close();
  }

  // 3. PURE deterministic scenario selection.
  const selection = selectScenarios(records);

  // 4. Purge any raw artifacts — leave ONLY derived non-PII signals.
  purgeRawArtifacts();

  // 5. Signals-only output. NO PII anywhere here.
  const out = {
    generated_at: new Date().toISOString(),
    env,
    scan_bound: SCAN_MAX,
    governance: 'on',
    mode: 'read_only',
    consumer: PILOT_CONSUMER,
    contract: PILOT_CONTRACT,
    scenarios: selection.scenarios,
    scanned: selection.scanned,
    unfilled: selection.unfilled,
    notes: {
      transactions_capability_unavailable: txnCapabilityUnavailable,
      pii: 'signals-only: clientid + numeric counts + status; raw purged',
    },
  };

  const json = JSON.stringify(out, null, 2);
  if (argOut) {
    const dest = resolve(process.cwd(), argOut);
    mkdirSync(resolve(dest, '..'), { recursive: true });
    writeFileSync(dest, json + '\n', { mode: 0o600 });
    process.stderr.write(`pilot-sample: signals-only JSON written to ${dest}\n`);
  }
  process.stdout.write(json + '\n');
}

main()
  .catch((err) => {
    process.stderr.write(
      `pilot-sample: aborted before completion (${
        err && err.name ? err.name : 'Error'
      }: ${err && err.message ? String(err.message).slice(0, 160) : ''})\n`
    );
  })
  .finally(() => {
    purgeRawArtifacts();
    process.exit(0);
  });
