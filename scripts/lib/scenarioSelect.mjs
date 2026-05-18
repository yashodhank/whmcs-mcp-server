// PHASE H.1 — Track D: scenario-based pilot client sampling.
//
// PURE selection logic. NO I/O, NO WHMCS, NO governance, NO PII. Given an
// array of per-client NON-PII signal records (counts + status only), it
// returns a deterministic scenario-bucket → clientid mapping so the
// authoritative audit covers REAL exposure paths instead of a naive
// first-N auto-pick.
//
// Why pure: the discovery side (scripts/pilot-sample.mjs) does the governed
// read-only MCP calls and extracts counts; this module just decides. That
// keeps selection unit-testable with synthetic fixtures and zero live WHMCS.
//
// Signal record (every field non-PII; missing fields are defensively
// coerced to 0 / false / 'Unknown'):
//   { clientid:number, status:string, services:number, domains:number,
//     invoices:number, overdue:number, tickets:number, txns:number,
//     renewal_soon:boolean }
//
// Output:
//   { scenarios: { <bucket>: { clientid:number|null,
//                               signals:{...counts+status} | null,
//                               status:'selected'|'unfilled' } },
//     scanned:number, unfilled:string[] }
//
// Determinism contract:
//   * Each bucket has an independent predicate. The SAME clientid may fill
//     multiple buckets (representative coverage, not a partition).
//   * Tie-break is ALWAYS the lowest clientid among matching records. For
//     service_domain_heavy the primary key is the highest (services+domains)
//     footprint, then lowest clientid.
//   * A bucket with zero matching records is reported `unfilled` with a
//     null clientid — NEVER faked.
//   * Output is a pure function of input (order-independent).

/** Canonical, ordered scenario bucket list (audit + report ordering). */
export const SCENARIO_BUCKETS = [
  'active_normal',
  'overdue_invoice',
  'renewal_upcoming',
  'ticket_heavy',
  'service_domain_heavy',
  'transaction_reconciliation_candidate',
  'inactive_edge',
];

/** Combined services+domains footprint at/above which a client is "heavy". */
const SERVICE_DOMAIN_HEAVY_THRESHOLD = 3;

/** Coerce a possibly-missing numeric signal to a safe non-negative int. */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Coerce a possibly-missing status string; default 'Unknown'. */
function statusOf(v) {
  return typeof v === 'string' && v.length > 0 ? v : 'Unknown';
}

/**
 * Normalize an arbitrary input record into a strict NON-PII signal record.
 * Any unexpected/PII-shaped keys on the input are DROPPED here — only the
 * whitelisted numeric/status fields survive into selection or output.
 */
function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const cid = Number(r.clientid);
  return {
    clientid: Number.isInteger(cid) ? cid : null,
    status: statusOf(r.status),
    services: num(r.services),
    domains: num(r.domains),
    invoices: num(r.invoices),
    overdue: num(r.overdue),
    tickets: num(r.tickets),
    txns: num(r.txns),
    renewal_soon: r.renewal_soon === true,
  };
}

/** Strip a normalized record down to the emitted signals view (no clientid). */
function signalsView(r) {
  return {
    status: r.status,
    services: r.services,
    domains: r.domains,
    invoices: r.invoices,
    overdue: r.overdue,
    tickets: r.tickets,
    txns: r.txns,
    renewal_soon: r.renewal_soon,
  };
}

function isActive(r) {
  return r.status.toLowerCase() === 'active';
}

// Bucket predicates. active_normal additionally requires NO risk flags so it
// is a genuine "modest, healthy" representative (not a client that also
// happens to be overdue / ticket-heavy).
const PREDICATES = {
  active_normal: (r) =>
    isActive(r) && r.overdue === 0 && r.tickets === 0,
  overdue_invoice: (r) => r.overdue > 0,
  renewal_upcoming: (r) => r.renewal_soon === true,
  ticket_heavy: (r) => r.tickets > 0,
  service_domain_heavy: (r) =>
    r.services + r.domains >= SERVICE_DOMAIN_HEAVY_THRESHOLD,
  transaction_reconciliation_candidate: (r) => r.txns > 0,
  inactive_edge: (r) => !isActive(r) && r.status !== 'Unknown',
};

/**
 * Pick the representative record for a bucket from the matching set.
 * Default tie-break: lowest clientid. service_domain_heavy first maximises
 * the (services+domains) footprint, then lowest clientid.
 */
function pick(bucket, matches) {
  if (matches.length === 0) return null;
  if (bucket === 'service_domain_heavy') {
    return matches.reduce((best, r) => {
      const fr = r.services + r.domains;
      const fb = best.services + best.domains;
      if (fr > fb) return r;
      if (fr === fb && r.clientid < best.clientid) return r;
      return best;
    });
  }
  return matches.reduce((best, r) =>
    r.clientid < best.clientid ? r : best
  );
}

/**
 * PURE scenario selector.
 *
 * @param {Array<object>} records  per-client NON-PII signal records.
 * @returns {{scenarios:Record<string,{clientid:number|null,signals:object|null,status:string}>,scanned:number,unfilled:string[]}}
 */
export function selectScenarios(records) {
  const list = Array.isArray(records) ? records : [];
  // Normalize first (drops any PII-shaped keys), keep only records with a
  // usable integer clientid.
  const normalized = list
    .map(normalize)
    .filter((r) => r.clientid !== null);

  const scenarios = {};
  const unfilled = [];

  for (const bucket of SCENARIO_BUCKETS) {
    const matches = normalized.filter(PREDICATES[bucket]);
    const chosen = pick(bucket, matches);
    if (chosen === null) {
      scenarios[bucket] = {
        clientid: null,
        signals: null,
        status: 'unfilled',
      };
      unfilled.push(bucket);
    } else {
      scenarios[bucket] = {
        clientid: chosen.clientid,
        signals: signalsView(chosen),
        status: 'selected',
      };
    }
  }

  return { scenarios, scanned: list.length, unfilled };
}
