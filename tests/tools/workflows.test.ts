/**
 * Composite workflow tools — DRAFT-ONLY invariant suite.
 *
 * For each of the four `workflow_*` tools we assert:
 *  - happy path: it DRAFTS the expected governed intent(s) (non-empty
 *    drafted_intent_ids), the drafts are retrievable via the SHARED store
 *    (get_write_intent), `whmcs.mutate` is NEVER called, and `executed===false`;
 *  - governance: a consumer WITHOUT the needed scope ⇒ the candidate is NOT
 *    drafted but recorded in `skipped[]` with the deny reason (no throw);
 *  - fault isolation: a failing `whmcs.read` for one section ⇒ `partial_errors[]`
 *    records it and the tool still returns a result;
 *  - month_end_close drives the exported pure `reconcile()` (duplicate-risk
 *    fixture surfaces a discrepancy → a drafted annotation).
 *
 * The whole suite is mocked: no live WHMCS calls. config + security are mocked
 * exactly as the existing writeFlow tests do.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
// SYNTHETIC tokens — not secrets.
const FULL_RAW = 'EXAMPLE-workflow-full-SYNTHETIC';
const NONOTE_RAW = 'EXAMPLE-workflow-nonote-SYNTHETIC';

beforeAll(() => {
  process.env.MCP_CONSUMER_REGISTRY = JSON.stringify([
    {
      id: 'wf_full',
      token_sha256: sha(FULL_RAW),
      allowedScopes: ['read'],
      defaultContract: 'ops_operator',
      allowedContracts: ['ops_operator'],
      allowedActions: [],
      // draft_only is enough to DRAFT (the helper only needs not-`false`).
      writeCapability: 'draft_only',
      envRestrictions: [],
      anonymous: false,
      allowedWriteScopes: [
        'client_note:write',
        'billing:credit:add',
        'ticket:create',
        'ticket:note',
        'ticket:status',
      ],
    },
    {
      // Same scopes EXCEPT client_note:write — exercises the scope-gated skip.
      id: 'wf_nonote',
      token_sha256: sha(NONOTE_RAW),
      allowedScopes: ['read'],
      defaultContract: 'ops_operator',
      allowedContracts: ['ops_operator'],
      allowedActions: [],
      writeCapability: 'draft_only',
      envRestrictions: [],
      anonymous: false,
      allowedWriteScopes: ['ticket:create', 'ticket:note', 'ticket:status'],
    },
  ]);
});

vi.mock('../../src/config.js', () => ({
  config: {
    MCP_MODE: 'full',
    MCP_ENV: 'local',
    MCP_MAX_PAGE_SIZE: 100,
  },
  isToolAllowed: () => true,
}));
vi.mock('../../src/security.js', () => ({ AUTH_SHAPE: {} }));

import { registerWorkflowTools } from '../../src/tools/workflows.js';
import { registerWriteFlowTools, __resetWriteFlowForTests } from '../../src/tools/writeFlow.js';
import { __resetRegistryCacheForTests } from '../../src/governance/pipeline.js';

interface Res {
  content: { text: string }[];
  isError?: boolean;
}
const J = (r: Res) => JSON.parse(r.content[0].text) as Record<string, unknown>;

type ReadFn = (action: string, params: Record<string, unknown>) => Promise<unknown>;

/**
 * Build a test harness: both workflow + writeFlow tools share the SAME module
 * singletons, so `get_write_intent` can fetch drafts created by the workflows.
 * `read` is a configurable async fn; `mutate` is a spy that must stay at 0.
 */
function harness(read: ReadFn) {
  const h: Record<string, (a: Record<string, unknown>) => Promise<Res>> = {};
  const server = {
    registerTool: (n: string, _c: unknown, cb: unknown) => {
      h[n] = cb as never;
    },
  };
  const cl = {
    logToolCall: vi.fn(),
    logToolResult: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    child: () => cl,
  };
  const mutate = vi.fn().mockResolvedValue({ result: 'success' });
  const readSpy = vi.fn(read);
  const whmcs = { read: readSpy, mutate } as never;
  const logger = { child: () => cl } as never;
  const rl = { tryConsume: () => true } as never;
  registerWriteFlowTools(server, whmcs, logger, rl);
  registerWorkflowTools(server, whmcs, logger, rl);
  return { h, mutate, read: readSpy };
}

const full = { auth_token: FULL_RAW };
const nonote = { auth_token: NONOTE_RAW };

// ── Fixtures ─────────────────────────────────────────────────────────────
const overdueInvoices = {
  invoices: {
    invoice: [
      { id: 1001, userid: 7, status: 'Overdue', total: '120.00', balance: '120.00', duedate: '2026-04-01' },
      { id: 1002, userid: 7, status: 'Overdue', total: '50.00', balance: '50.00', duedate: '2026-03-15' },
      { id: 1003, userid: 9, status: 'Unpaid', total: '30.00', balance: '30.00', duedate: '2026-05-01' },
    ],
  },
};
const upcomingProducts = {
  products: {
    product: [
      { id: 201, clientid: 7, name: 'Hosting Pro', nextduedate: futureDate(10), donotrenew: '1' },
      { id: 202, clientid: 8, name: 'Hosting Lite', nextduedate: futureDate(20), donotrenew: '0' },
    ],
  },
};
const upcomingDomains = {
  domains: {
    domain: [
      { id: 301, clientid: 9, domainname: 'risk.example', expirydate: futureDate(5), donotrenew: '1' },
    ],
  },
};
const openTickets = {
  tickets: {
    ticket: [
      { id: 401, userid: 7, subject: 'Cannot log in', status: 'Open' },
      { id: 402, userid: 8, subject: 'Billing question', status: 'Customer-Reply' },
    ],
  },
};
const ticketThread = { id: 401, replies: { reply: [{ message: 'help' }] } };

// duplicate-risk: two same-amount txns for the same invoice within 3 days.
const dupTxns = {
  transactions: {
    transaction: [
      { id: 9001, invoiceid: 5001, amountin: '100.00', date: '2026-06-01' },
      { id: 9002, invoiceid: 5001, amountin: '100.00', date: '2026-06-02' },
    ],
  },
};
const closeInvoices = {
  invoices: { invoice: [{ id: 5001, userid: 7, status: 'Paid', total: '100.00', date: '2026-06-01' }] },
};

function futureDate(days: number): string {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

/** Default read router used by the happy-path tests. */
const router = (overrides?: Record<string, unknown>): ReadFn => {
  return async (action: string, params: Record<string, unknown>) => {
    if (overrides && action in overrides) {
      const v = overrides[action];
      if (v instanceof Error) throw v;
      return v;
    }
    switch (action) {
      case 'GetInvoices': {
        // close uses a single GetInvoices (no status); dunning uses status.
        if (params.status === undefined) return closeInvoices;
        return overdueInvoices;
      }
      case 'GetClientsProducts':
        return upcomingProducts;
      case 'GetClientsDomains':
        return upcomingDomains;
      case 'GetTickets':
        return openTickets;
      case 'GetTicket':
        return ticketThread;
      case 'GetTransactions':
        return dupTxns;
      default:
        return { result: 'success' };
    }
  };
};

beforeEach(() => {
  __resetWriteFlowForTests();
  __resetRegistryCacheForTests();
});

describe('workflow tools — DRAFT-ONLY invariant', () => {
  it('whmcs.mutate is NEVER called by any workflow tool (happy path, all four)', async () => {
    const { h, mutate } = harness(router());
    await h.workflow_dunning_sweep({ ...full });
    await h.workflow_renewal_risk_triage({ ...full });
    await h.workflow_ticket_triage_to_resolution({ ...full });
    await h.workflow_month_end_close({ ...full });
    expect(mutate).toHaveBeenCalledTimes(0);
  });

  it('every workflow result has executed === false', async () => {
    const { h } = harness(router());
    for (const name of [
      'workflow_dunning_sweep',
      'workflow_renewal_risk_triage',
      'workflow_ticket_triage_to_resolution',
      'workflow_month_end_close',
    ] as const) {
      const r = J(await h[name]({ ...full }));
      expect(r.executed).toBe(false);
    }
  });

  it('dunning_sweep drafts a client_note per overdue client; drafts are retrievable via get_write_intent', async () => {
    const { h, mutate } = harness(router());
    const r = J(await h.workflow_dunning_sweep({ ...full, overdue_min_days: 1 }));
    const ids = r.drafted_intent_ids as string[];
    expect(ids.length).toBeGreaterThan(0);
    expect(mutate).toHaveBeenCalledTimes(0);
    // Retrievable via the SHARED store / get_write_intent.
    const view = J(await h.get_write_intent({ intent_id: ids[0], ...full }));
    const intent = view.intent as Record<string, unknown>;
    expect(intent.intent_id).toBe(ids[0]);
    expect(intent.scope).toBe('client_note:write');
    expect(intent.state).toBe('draft'); // never advanced past draft
  });

  it('dunning_sweep with goodwill_credit drafts an OPTIONAL billing:credit:add (HIGH) — still no mutate', async () => {
    const { h, mutate } = harness(router());
    const r = J(await h.workflow_dunning_sweep({ ...full, overdue_min_days: 1, goodwill_credit: true }));
    const ids = r.drafted_intent_ids as string[];
    // Find the high-risk credit draft among the drafts.
    let sawCredit = false;
    for (const id of ids) {
      const v = J(await h.get_write_intent({ intent_id: id, ...full }));
      if ((v.intent as Record<string, unknown>).scope === 'billing:credit:add') {
        sawCredit = true;
        expect((v.intent as Record<string, unknown>).risk).toBe('high');
        expect((v.intent as Record<string, unknown>).state).toBe('draft');
      }
    }
    expect(sawCredit).toBe(true);
    expect(mutate).toHaveBeenCalledTimes(0);
  });

  it('SCOPE-GATED: a consumer without client_note:write does NOT draft it — recorded in skipped[], no throw', async () => {
    const { h, mutate } = harness(router());
    const r = J(await h.workflow_dunning_sweep({ ...nonote, overdue_min_days: 1 }));
    expect(r.drafted_intent_ids).toEqual([]); // nothing drafted
    const skipped = r.skipped as { reason: string }[];
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.some((s) => /scope_not_allowed|write scope denied/.test(s.reason))).toBe(true);
    expect(mutate).toHaveBeenCalledTimes(0);
  });

  it('renewal_risk_triage drafts a ticket:create for at-risk (auto-renew off) renewals only', async () => {
    const { h, mutate } = harness(router());
    const r = J(await h.workflow_renewal_risk_triage({ ...full, horizon_days: 60 }));
    const ids = r.drafted_intent_ids as string[];
    expect(ids.length).toBeGreaterThan(0);
    // The drafted intents are ticket:create (never a renew/charge scope).
    for (const id of ids) {
      const v = J(await h.get_write_intent({ intent_id: id, ...full }));
      expect((v.intent as Record<string, unknown>).scope).toBe('ticket:create');
    }
    // The auto-renew-ON service (id 202) is a candidate but NOT drafted.
    const cands = r.candidates as Record<string, unknown>[];
    const safe = cands.find((c) => c.item_id === 202);
    expect(safe?.drafted_intent_id).toBeNull();
    expect(mutate).toHaveBeenCalledTimes(0);
  });

  it('ticket_triage drafts an internal ticket:note (+ medium status) and flags customer replies for human review', async () => {
    const { h, mutate } = harness(router());
    const r = J(await h.workflow_ticket_triage_to_resolution({ ...full }));
    const ids = r.drafted_intent_ids as string[];
    expect(ids.length).toBeGreaterThan(0);
    const cands = r.candidates as Record<string, unknown>[];
    // Every candidate is flagged for human review (customer replies are gated).
    expect(cands.every((c) => c.needs_human_review === true)).toBe(true);
    // At least one ticket:note was drafted.
    let sawNote = false;
    for (const id of ids) {
      const v = J(await h.get_write_intent({ intent_id: id, ...full }));
      if ((v.intent as Record<string, unknown>).scope === 'ticket:note') sawNote = true;
    }
    expect(sawNote).toBe(true);
    expect(mutate).toHaveBeenCalledTimes(0);
  });

  it('month_end_close drives the exported reconcile() — duplicate-risk fixture yields a drafted annotation', async () => {
    const { h, mutate } = harness(router());
    const r = J(await h.workflow_month_end_close({ ...full }));
    const summary = r.close_summary as Record<string, unknown>;
    // reconcile() found the duplicate-risk group from the fixture.
    expect(summary.duplicate_risk_groups).toBe(1);
    const ids = r.drafted_intent_ids as string[];
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const v = J(await h.get_write_intent({ intent_id: id, ...full }));
      expect((v.intent as Record<string, unknown>).scope).toBe('client_note:write');
    }
    expect(mutate).toHaveBeenCalledTimes(0);
  });

  it('FAULT ISOLATION: a failing read for one section records partial_errors[] and still returns a result', async () => {
    // Make the renewal services read throw; domains still succeed.
    const { h, mutate } = harness(
      router({ GetClientsProducts: new Error('boom: GetClientsProducts unavailable') })
    );
    const r = J(await h.workflow_renewal_risk_triage({ ...full, horizon_days: 60 }));
    const errs = r.partial_errors as { section: string; error: string }[];
    expect(errs.some((e) => e.section === 'services' && e.error.includes('boom'))).toBe(true);
    // Still returns a structured result (executed false) and processes domains.
    expect(r.executed).toBe(false);
    expect(Array.isArray(r.candidates)).toBe(true);
    expect(mutate).toHaveBeenCalledTimes(0);
  });

  it('a consumer-denied (bad token) run drafts nothing and never mutates', async () => {
    const { h, mutate } = harness(router());
    const r = J(await h.workflow_dunning_sweep({ auth_token: 'EXAMPLE-unknown-SYNTHETIC', overdue_min_days: 1 }));
    expect(r.drafted_intent_ids).toEqual([]);
    expect((r.skipped as unknown[]).length).toBeGreaterThan(0);
    expect(mutate).toHaveBeenCalledTimes(0);
  });
});
