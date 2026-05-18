/**
 * PHASE H.1 — Track D: scenario-based pilot client sampling.
 *
 * TDD unit tests for the PURE scenario selector
 * (`scripts/lib/scenarioSelect.mjs`).
 *
 * The selector is intentionally pure: it takes an array of per-client
 * NON-PII signal records (counts + status only — never names/emails/etc.)
 * and returns a deterministic scenario-bucket → clientid mapping. No I/O,
 * no WHMCS, no governance — those live in the thin discovery script
 * (`scripts/pilot-sample.mjs`). These tests therefore need NO live WHMCS.
 *
 * Signal record shape (all non-PII):
 *   {
 *     clientid: number,
 *     status:   'Active' | 'Inactive' | 'Closed' | string,
 *     services: number,   // total services (count only)
 *     domains:  number,   // total domains  (count only)
 *     invoices: number,   // total invoices (count only)
 *     overdue:  number,   // unpaid+overdue invoice count
 *     tickets:  number,   // active/recent ticket count
 *     txns:     number,   // transaction count
 *     renewal_soon: boolean, // a service/domain due within ~60d
 *   }
 *
 * Deterministic selection rule per bucket: among all records that match a
 * bucket's predicate, pick the one with the LOWEST clientid (stable
 * tie-break). Buckets are filled independently; the SAME clientid may fill
 * more than one bucket (representative, not partition). A bucket with zero
 * matching records is reported as `unfilled` (never faked).
 */

import { describe, it, expect } from 'vitest';

// ── Local types for the pure JS selector ───────────────────────────────────
// `scripts/lib/scenarioSelect.mjs` is intentionally a plain-JS .mjs module:
//   * `npm run typecheck` (tsc) includes only `src/**`, so it is untyped there;
//   * `npm run lint` globs `src/ tests/`, so the .mjs itself is never linted;
//   * this test file IS linted, so we give the import an explicit local type
//     (no `any` leaks → no `no-unsafe-*` lint errors).
interface SignalRecord {
  clientid: number;
  status?: string;
  services?: number;
  domains?: number;
  invoices?: number;
  overdue?: number;
  tickets?: number;
  txns?: number;
  renewal_soon?: boolean;
}
interface ScenarioCell {
  clientid: number | null;
  signals: Record<string, number | string | boolean> | null;
  status: 'selected' | 'unfilled';
}
interface SelectionResult {
  scenarios: Record<string, ScenarioCell>;
  scanned: number;
  unfilled: string[];
}
const selectorModule = (await import(
  '../scripts/lib/scenarioSelect.mjs'
)) as {
  selectScenarios: (records: unknown[]) => SelectionResult;
  SCENARIO_BUCKETS: string[];
};
const { selectScenarios, SCENARIO_BUCKETS } = selectorModule;

function rec(over: Partial<SignalRecord>): SignalRecord {
  return {
    clientid: 1,
    status: 'Active',
    services: 0,
    domains: 0,
    invoices: 0,
    overdue: 0,
    tickets: 0,
    txns: 0,
    renewal_soon: false,
    ...over,
  };
}

describe('scenarioSelect — pure selector', () => {
  it('exposes the canonical, ordered bucket list', () => {
    expect(SCENARIO_BUCKETS).toEqual([
      'active_normal',
      'overdue_invoice',
      'renewal_upcoming',
      'ticket_heavy',
      'service_domain_heavy',
      'transaction_reconciliation_candidate',
      'inactive_edge',
    ]);
  });

  it('returns a result with every bucket present and an unfilled list', () => {
    const out = selectScenarios([]);
    expect(out.scanned).toBe(0);
    expect(Object.keys(out.scenarios).sort()).toEqual(
      [...SCENARIO_BUCKETS].sort()
    );
    // Empty input → every bucket unfilled, clientid null, never faked.
    for (const b of SCENARIO_BUCKETS) {
      expect(out.scenarios[b].clientid).toBeNull();
      expect(out.scenarios[b].status).toBe('unfilled');
    }
    expect(out.unfilled.sort()).toEqual([...SCENARIO_BUCKETS].sort());
  });

  it('selects active_normal: Active, modest activity, no risk flags', () => {
    const recs = [
      rec({ clientid: 10, status: 'Active', services: 2, domains: 1, invoices: 3 }),
      rec({ clientid: 5, status: 'Active', services: 1, domains: 1, invoices: 2 }),
      // overdue → excluded from active_normal even though Active
      rec({ clientid: 3, status: 'Active', overdue: 4 }),
    ];
    const out = selectScenarios(recs);
    // lowest clientid among matching (5, not 3 which is overdue)
    expect(out.scenarios.active_normal.clientid).toBe(5);
    expect(out.scenarios.active_normal.status).toBe('selected');
    expect(out.scenarios.active_normal.signals).toEqual({
      status: 'Active',
      services: 1,
      domains: 1,
      invoices: 2,
      overdue: 0,
      tickets: 0,
      txns: 0,
      renewal_soon: false,
    });
  });

  it('selects overdue_invoice by overdue>0, lowest clientid tie-break', () => {
    const out = selectScenarios([
      rec({ clientid: 22, overdue: 1 }),
      rec({ clientid: 9, overdue: 5 }),
      rec({ clientid: 40, overdue: 2 }),
    ]);
    expect(out.scenarios.overdue_invoice.clientid).toBe(9);
    expect(out.scenarios.overdue_invoice.signals.overdue).toBe(5);
  });

  it('selects renewal_upcoming only when renewal_soon is true', () => {
    const out = selectScenarios([
      rec({ clientid: 7, renewal_soon: false }),
      rec({ clientid: 12, renewal_soon: true, services: 3 }),
      rec({ clientid: 30, renewal_soon: true }),
    ]);
    expect(out.scenarios.renewal_upcoming.clientid).toBe(12);
  });

  it('selects ticket_heavy by tickets>0', () => {
    const out = selectScenarios([
      rec({ clientid: 50, tickets: 0 }),
      rec({ clientid: 18, tickets: 4 }),
      rec({ clientid: 60, tickets: 1 }),
    ]);
    expect(out.scenarios.ticket_heavy.clientid).toBe(18);
    expect(out.scenarios.ticket_heavy.signals.tickets).toBe(4);
  });

  it('selects service_domain_heavy by the highest combined services+domains, then lowest clientid', () => {
    const out = selectScenarios([
      rec({ clientid: 2, services: 1, domains: 1 }),
      rec({ clientid: 80, services: 6, domains: 4 }), // 10 — heaviest
      rec({ clientid: 81, services: 7, domains: 3 }), // 10 — tie → lower id 80
      rec({ clientid: 4, services: 2, domains: 2 }),
    ]);
    expect(out.scenarios.service_domain_heavy.clientid).toBe(80);
  });

  it('does not pick service_domain_heavy when no client has a meaningful footprint', () => {
    const out = selectScenarios([
      rec({ clientid: 1, services: 0, domains: 0 }),
      rec({ clientid: 2, services: 1, domains: 0 }),
    ]);
    // threshold: combined >= 3 to count as "heavy"
    expect(out.scenarios.service_domain_heavy.clientid).toBeNull();
    expect(out.scenarios.service_domain_heavy.status).toBe('unfilled');
    expect(out.unfilled).toContain('service_domain_heavy');
  });

  it('selects transaction_reconciliation_candidate by txns>0', () => {
    const out = selectScenarios([
      rec({ clientid: 33, txns: 0 }),
      rec({ clientid: 21, txns: 9 }),
      rec({ clientid: 70, txns: 2 }),
    ]);
    expect(out.scenarios.transaction_reconciliation_candidate.clientid).toBe(
      21
    );
  });

  it('selects inactive_edge only for non-Active status (Inactive/Closed/Suspended)', () => {
    const out = selectScenarios([
      rec({ clientid: 100, status: 'Active' }),
      rec({ clientid: 55, status: 'Closed' }),
      rec({ clientid: 44, status: 'Inactive' }),
      rec({ clientid: 88, status: 'Suspended' }),
    ]);
    // lowest clientid among non-Active = 44
    expect(out.scenarios.inactive_edge.clientid).toBe(44);
    expect(out.scenarios.inactive_edge.signals.status).toBe('Inactive');
  });

  it('inactive_edge is unfilled when every scanned client is Active', () => {
    const out = selectScenarios([
      rec({ clientid: 1, status: 'Active' }),
      rec({ clientid: 2, status: 'Active' }),
    ]);
    expect(out.scenarios.inactive_edge.clientid).toBeNull();
    expect(out.unfilled).toContain('inactive_edge');
  });

  it('one representative client may fill multiple buckets (not a partition)', () => {
    const out = selectScenarios([
      rec({
        clientid: 7,
        status: 'Active',
        services: 5,
        domains: 5,
        invoices: 4,
        overdue: 3,
        tickets: 2,
        txns: 6,
        renewal_soon: true,
      }),
    ]);
    expect(out.scenarios.overdue_invoice.clientid).toBe(7);
    expect(out.scenarios.renewal_upcoming.clientid).toBe(7);
    expect(out.scenarios.ticket_heavy.clientid).toBe(7);
    expect(out.scenarios.service_domain_heavy.clientid).toBe(7);
    expect(out.scenarios.transaction_reconciliation_candidate.clientid).toBe(
      7
    );
    // Active but has overdue/tickets → NOT active_normal.
    expect(out.scenarios.active_normal.clientid).toBeNull();
    // Active → NOT inactive_edge.
    expect(out.scenarios.inactive_edge.clientid).toBeNull();
  });

  it('is deterministic: same input always yields the same mapping', () => {
    const recs = [
      rec({ clientid: 9, status: 'Active', services: 4, domains: 2 }),
      rec({ clientid: 3, status: 'Closed', txns: 5 }),
      rec({ clientid: 14, overdue: 2, tickets: 3, renewal_soon: true }),
    ];
    const a = selectScenarios(recs);
    const b = selectScenarios(recs.slice().reverse());
    expect(a).toEqual(b);
    expect(a.scanned).toBe(3);
  });

  it('emits ONLY numeric signals + status — never any PII-shaped field', () => {
    const out = selectScenarios([
      rec({ clientid: 2, status: 'Active', services: 1, domains: 1, invoices: 1 }),
    ]);
    const sig = out.scenarios.active_normal.signals;
    expect(Object.keys(sig).sort()).toEqual(
      [
        'domains',
        'invoices',
        'overdue',
        'renewal_soon',
        'services',
        'status',
        'tickets',
        'txns',
      ].sort()
    );
    // No name/email/address-shaped keys anywhere in the serialized output.
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/name|email|address|phone|firstname|lastname/i);
  });

  it('ignores malformed records defensively (missing fields treated as 0/false)', () => {
    const out = selectScenarios([
      { clientid: 8, status: 'Active' }, // no count fields at all
      { clientid: 6 }, // no status
    ]);
    // clientid 8 is Active w/ all-zero activity → active_normal candidate.
    expect(out.scenarios.active_normal.clientid).toBe(8);
    expect(out.scanned).toBe(2);
  });
});
