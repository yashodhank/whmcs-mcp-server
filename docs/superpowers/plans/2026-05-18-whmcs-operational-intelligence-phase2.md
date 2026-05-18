# WHMCS Operational Intelligence — Phase 2 (Aggregators) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add 4 read-only "snapshot" aggregator tools — `get_account_360`, `get_billing_snapshot`, `get_support_snapshot`, `get_renewal_snapshot` — that compose `GetClientsDetails(stats=true)` + the verified Phase-1 WHMCS read actions into compact, operator-ready summaries from a single `clientid`.

**Architecture:** One new file `src/tools/aggregators.ts` with a shared `safeSection` partial-failure helper and `registerAggregatorTools`. Each tool is read-only (`whmcsClient.read` only — already hard-guarded by `actionPolicy`), uses the proven `registerTool` + `READ_ONLY_ANNOTATIONS` + localized `ToolCallback` cast pattern copied from `src/tools/listTools.ts`, `ensureToolAuth`/`isToolAllowed`/client-mode scoping like existing tools, and is **partial-failure tolerant** (a failing sub-read becomes a `partial_errors[]` entry, never throws the whole aggregator). Aggregators do their own focused field selection (no Phase-1 refactor — minimal risk on freshly shipped code).

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk@1.29` (`registerTool`+`ToolAnnotations`), zod, vitest, existing `WhmcsClient`/`normalizeToArray`/`security`/`rateLimiter`.

**Spec:** `docs/superpowers/specs/2026-05-18-whmcs-operational-intelligence-design.md` §3.3, §3.4. Phase-1 (origin/main @ 18655ef) is live + prod-verified.

**Verified `GetClientsDetails(stats=true)` `stats` fields (live-confirmed this session):** `creditbalance`, `numunpaidinvoices`,`unpaidinvoicesamount`, `numoverdueinvoices`,`overdueinvoicesbalance`, `numpaidinvoices`,`paidinvoicesamount`, `numcancelledinvoices`, `numrefundedinvoices`, `numDraftInvoices`, `productsnumactive`,`productsnumtotal`, `numactivedomains`,`numdomains`, `numtickets`,`numactivetickets`. Root client fields: `id,firstname,lastname,email,status,credit,currency_code`.

**Hard requirement C2:** any aggregator surfacing client tickets MUST include `discovery:'best-effort'` + a note that GetTickets clientid filter may miss operator/admin tickets and `get_ticket_thread` by id is the reliable path. It must NOT present client ticket discovery as complete.

---

## File Structure

- **Create** `src/tools/aggregators.ts` — `safeSection` helper, the 4 tool handlers, `registerAggregatorTools(server, whmcsClient, logger, rateLimiter)`.
- **Modify** `src/index.ts` — import + call `registerAggregatorTools(server, whmcsClient, logger, rateLimiter)` immediately after `registerTicketThreadTool(...)`, before `registerResources(...)`.
- **Test** `tests/tools/aggregators.test.ts`.

## Task 0: Feature worktree (execution-time)

**REQUIRED SUB-SKILL:** `superpowers:using-git-worktrees`.
- [ ] Create worktree via `EnterWorktree` name `whmcs-opsintel-p2` (native; `fresh` base = `origin/main` which has Phase-1 18655ef).
- [ ] Worktree lacks the gitignored `.env`; create a dummy one: `printf 'WHMCS_API_URL=http://localhost:8888\nWHMCS_IDENTIFIER=d\nWHMCS_SECRET=d\nWHMCS_ALLOW_HTTP=true\nMCP_MODE=read_only\n' > .env` (gitignored — verify `git check-ignore -q .env`).
- [ ] `npm install` && `npm run build` && `npx vitest run` → baseline must be **106 passed / 14 skipped**, build green, `npx tsc --noEmit` = **26** (record baseline).

---

## Task 1: `safeSection` helper + `get_account_360`

**Files:** Create `src/tools/aggregators.ts`; Test `tests/tools/aggregators.test.ts`.

- [ ] **Step 1: Failing test** (`tests/tools/aggregators.test.ts`)

```ts
import { describe, it, expect, vi } from 'vitest';
vi.mock('../../src/config.js', () => ({ config: { MCP_MAX_PAGE_SIZE: 100 }, isToolAllowed: () => true }));
vi.mock('../../src/security.js', () => ({ AUTH_SHAPE: {}, ensureToolAuth: () => null, isClientMode: () => false, ensureClientAllowed: () => null }));
import { registerAggregatorTools } from '../../src/tools/aggregators.js';

function harness(readImpl: (action: string, params: any) => any) {
  const handlers: Record<string, any> = {};
  const server = { registerTool: (n: string, _c: unknown, cb: any) => { handlers[n] = cb; } };
  const childLogger: any = { logToolCall: vi.fn(), logToolResult: vi.fn(), info: vi.fn(), error: vi.fn(), child: () => childLogger };
  const logger: any = { child: () => childLogger };
  const rateLimiter: any = { tryConsume: () => true };
  const whmcs: any = { read: vi.fn(readImpl) };
  registerAggregatorTools(server as any, whmcs, logger, rateLimiter);
  return { handlers, whmcs };
}

describe('get_account_360', () => {
  it('assembles client + counts + recent slices; tickets carry C2 best-effort', async () => {
    const { handlers } = harness((action) => {
      if (action === 'GetClientsDetails') return { id: 30, firstname: 'Test', lastname: 'User', email: 'c@example.test', status: 'Active', credit: '29.51', currency_code: 'INR',
        stats: { creditbalance: '29.51', numunpaidinvoices: 0, numoverdueinvoices: 0, productsnumactive: 1, productsnumtotal: 4, numactivedomains: 4, numdomains: 24, numactivetickets: 0 } };
      if (action === 'GetClientsProducts') return { products: { product: [{ id: 545, name: 'Web Hosting', domain: 'example.org', status: 'Active', nextduedate: '2030-04-14' }] } };
      if (action === 'GetClientsDomains') return { domains: { domain: [{ id: 314, domainname: 'example.net', status: 'Active', expirydate: '2027-01-01' }] } };
      if (action === 'GetInvoices') return { invoices: { invoice: [{ id: 9001, status: 'Paid', total: '100.00', date: '2026-05-18' }] } };
      if (action === 'GetOrders') return { orders: { order: [{ id: 7, date: '2026-05-18', status: 'Active', amount: '0.00' }] } };
      if (action === 'GetTickets') return { tickets: { ticket: [] } };
      return {};
    });
    const res = await handlers['get_account_360']({ clientid: 30 });
    const p = JSON.parse(res.content[0].text);
    expect(p.client).toMatchObject({ clientid: 30, name: 'Test User', status: 'Active', credit_balance: '29.51', currency: 'INR' });
    expect(p.counts).toMatchObject({ services_active: 1, services_total: 4, domains_active: 4, domains_total: 24, unpaid_invoices: 0, overdue_invoices: 0 });
    expect(p.recent.services[0]).toMatchObject({ serviceid: 545, domain: 'example.org' });
    expect(p.recent.invoices[0]).toMatchObject({ invoiceid: 9001 });
    expect(p.recent.tickets.discovery).toBe('best-effort');
    expect(p.recent.tickets.note).toMatch(/may miss operator/i);
    expect(p.partial_errors).toEqual([]);
  });

  it('a failing sub-read becomes a partial_errors entry, not a thrown aggregator', async () => {
    const { handlers } = harness((action) => {
      if (action === 'GetClientsDetails') return { id: 30, firstname: 'T', lastname: 'U', email: 'e', status: 'Active', credit: '0', currency_code: 'INR', stats: { productsnumactive: 0, productsnumtotal: 0, numactivedomains: 0, numdomains: 0, numunpaidinvoices: 0, numoverdueinvoices: 0 } };
      if (action === 'GetClientsProducts') throw new Error('boom-products');
      return { invoices: { invoice: [] }, domains: { domain: [] }, orders: { order: [] }, tickets: { ticket: [] } };
    });
    const res = await handlers['get_account_360']({ clientid: 30 });
    const p = JSON.parse(res.content[0].text);
    expect(p.client.clientid).toBe(30);
    expect(p.recent.services).toEqual([]);
    expect(p.partial_errors.some((e: any) => e.section === 'services' && /boom-products/.test(e.error))).toBe(true);
  });
});
```

- [ ] **Step 2: Run → FAIL** `npx vitest run tests/tools/aggregators.test.ts` (module missing).

- [ ] **Step 3: Implement** `src/tools/aggregators.ts` (this task: helper + imports + get_account_360; later tasks append the other 3 + the registrar — Task 5 wires the registrar, so for Task 1 include a temporary `registerAggregatorTools` that registers ONLY get_account_360; Tasks 2-4 add their tool registration lines into it):

```ts
import { z } from 'zod';
import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WhmcsClient } from '../whmcs/WhmcsClient.js';
import { Logger } from '../logging.js';
import { RateLimiter, RateLimitError } from '../rateLimiter.js';
import { isToolAllowed } from '../config.js';
import { ensureToolAuth, isClientMode, ensureClientAllowed, AUTH_SHAPE } from '../security.js';
import { normalizeToArray } from '../whmcs/normalizers.js';
import { READ_ONLY_ANNOTATIONS } from './listTools.js';

const TICKET_BEST_EFFORT = {
  discovery: 'best-effort' as const,
  note: 'GetTickets clientid discovery may miss operator/admin-created tickets; use get_ticket_thread by known ticketid/tid for reliable retrieval.',
};

interface PartialError { section: string; error: string; }

/** Run a sub-section; on throw, record into errs and return the fallback. */
async function safeSection<T>(section: string, errs: PartialError[], fallback: T, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) { errs.push({ section, error: e instanceof Error ? e.message : String(e) }); return fallback; }
}

function norm<T>(container: any, singular: string): T[] {
  return normalizeToArray<T>(
    container && typeof container === 'object' ? (container[singular] ?? container) : container
  );
}

type Handler = (params: any) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>;

function register(server: McpServer, name: string, description: string, extra: z.ZodRawShape, logger: Logger, rl: RateLimiter, run: (params: any) => Promise<unknown>): void {
  if (!isToolAllowed(name)) return;
  const schema = z.object({ clientid: z.number().int().positive(), ...extra });
  const handler: ToolCallback<z.ZodRawShape> = (async (params: any) => {
    const log = logger.child(); const t0 = Date.now();
    try {
      const authErr = ensureToolAuth(params as Record<string, unknown>); if (authErr) return authErr;
      if (isClientMode()) { const s = ensureClientAllowed(params.clientid); if (s) return s; }
      log.logToolCall(name, params, false);
      if (!rl.tryConsume()) throw new RateLimitError();
      const payload = await run(params);
      log.logToolResult(name, true, Date.now() - t0);
      return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
    } catch (e) {
      log.logToolResult(name, false, Date.now() - t0, e instanceof Error ? e.message : String(e));
      if (e instanceof RateLimitError) return { content: [{ type: 'text' as const, text: JSON.stringify({ isError: true, error: e.message }) }], isError: true };
      throw e;
    }
  }) as unknown as ToolCallback<z.ZodRawShape>;
  server.registerTool(name, { description, inputSchema: { ...schema.shape, ...AUTH_SHAPE }, annotations: READ_ONLY_ANNOTATIONS }, handler);
}

export function registerAggregatorTools(server: McpServer, whmcs: WhmcsClient, logger: Logger, rl: RateLimiter): void {
  // get_account_360
  register(server, 'get_account_360', 'Read-only 360 snapshot: client identity/status/credit, account counts (from GetClientsDetails stats), and recent services/domains/invoices/orders/tickets. Ticket discovery is best-effort.', { recent: z.number().int().min(1).max(20).default(5) }, logger, rl, async (params) => {
    const errs: PartialError[] = [];
    const cid = params.clientid; const n = params.recent ?? 5;
    const cd: any = await safeSection('client', errs, {}, () => whmcs.read('GetClientsDetails', { clientid: cid, stats: true }));
    const st = cd.stats ?? {};
    const services = await safeSection('services', errs, [], async () => norm<any>((await whmcs.read<any>('GetClientsProducts', { clientid: cid, limitnum: n })).products, 'product').map((p) => ({ serviceid: p.id, product: p.name, domain: p.domain, status: p.status, next_due_date: p.nextduedate })));
    const domains = await safeSection('domains', errs, [], async () => norm<any>((await whmcs.read<any>('GetClientsDomains', { clientid: cid, limitnum: n })).domains, 'domain').map((d) => ({ domainid: d.id, domain: d.domainname, status: d.status, expiry_date: d.expirydate })));
    const invoices = await safeSection('invoices', errs, [], async () => norm<any>((await whmcs.read<any>('GetInvoices', { userid: cid, limitnum: n, orderby: 'date', order: 'desc' })).invoices, 'invoice').map((i) => ({ invoiceid: i.id, status: i.status, total: i.total, date: i.date, duedate: i.duedate })));
    const orders = await safeSection('orders', errs, [], async () => norm<any>((await whmcs.read<any>('GetOrders', { userid: cid, limitnum: 25 })).orders, 'order').map((o) => ({ orderid: o.id, date: o.date, status: o.status, amount: o.amount })).sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, n));
    const tickets = await safeSection('tickets', errs, [], async () => norm<any>((await whmcs.read<any>('GetTickets', { clientid: cid, limitnum: 25 })).tickets, 'ticket').map((t) => ({ ticketid: t.id, tid: t.tid, subject: t.subject, status: t.status, lastreply: t.lastreply })).sort((a, b) => String(b.lastreply || '').localeCompare(String(a.lastreply || ''))).slice(0, n));
    return {
      client: { clientid: cd.id, name: `${cd.firstname ?? ''} ${cd.lastname ?? ''}`.trim(), email: cd.email, status: cd.status, credit_balance: cd.credit, currency: cd.currency_code },
      counts: { services_active: st.productsnumactive ?? 0, services_total: st.productsnumtotal ?? 0, domains_active: st.numactivedomains ?? 0, domains_total: st.numdomains ?? 0, unpaid_invoices: st.numunpaidinvoices ?? 0, overdue_invoices: st.numoverdueinvoices ?? 0, active_tickets: st.numactivetickets ?? 0 },
      recent: { services, domains, invoices, orders, tickets: { items: tickets, ...TICKET_BEST_EFFORT } },
      partial_errors: errs,
    };
  });
  // Tasks 2-4 append register(...) calls for get_billing_snapshot / get_support_snapshot / get_renewal_snapshot here.
}
```

- [ ] **Step 4: Run → PASS** `npx vitest run tests/tools/aggregators.test.ts`; FULL suite `npx vitest run` (106 + new, no regressions, 14 skipped); `npm run build` success; `npx tsc --noEmit` ≤ 26.
- [ ] **Step 5: Commit** `git add src/tools/aggregators.ts tests/tools/aggregators.test.ts && git commit -m "feat(tools): get_account_360 aggregator + safeSection helper"`

---

## Task 2: `get_billing_snapshot`

**Files:** Modify `src/tools/aggregators.ts`; Modify `tests/tools/aggregators.test.ts`.

- [ ] **Step 1: Failing test** — append a describe:

```ts
describe('get_billing_snapshot', () => {
  it('summarises billing from stats + recent unpaid/overdue', async () => {
    const { handlers } = harness((action, params) => {
      if (action === 'GetClientsDetails') return { currency_code: 'INR', stats: { creditbalance: '29.51', numunpaidinvoices: 2, unpaidinvoicesamount: '500.00', numoverdueinvoices: 1, overdueinvoicesbalance: '300.00', numpaidinvoices: 63, paidinvoicesamount: '9000.00', numcancelledinvoices: 5, numrefundedinvoices: 1, numDraftInvoices: 0 } };
      if (action === 'GetInvoices' && params.status === 'Unpaid') return { invoices: { invoice: [{ id: 11, total: '250.00', duedate: '2026-06-01', status: 'Unpaid', date: '2026-05-10' }] } };
      if (action === 'GetInvoices' && params.status === 'Overdue') return { invoices: { invoice: [{ id: 12, total: '300.00', duedate: '2026-04-01', status: 'Overdue', date: '2026-03-01' }] } };
      return {};
    });
    const res = await handlers['get_billing_snapshot']({ clientid: 30 });
    const p = JSON.parse(res.content[0].text);
    expect(p).toMatchObject({ currency: 'INR', credit_balance: '29.51',
      unpaid: { count: 2, amount: '500.00' }, overdue: { count: 1, amount: '300.00' },
      paid: { count: 63, amount: '9000.00' }, cancelled: { count: 5 }, refunded: { count: 1 }, draft: { count: 0 } });
    expect(p.recent_unpaid[0]).toMatchObject({ invoiceid: 11 });
    expect(p.recent_overdue[0]).toMatchObject({ invoiceid: 12 });
    expect(p.partial_errors).toEqual([]);
  });
});
```

- [ ] **Step 2: FAIL** (`get_billing_snapshot` not registered).
- [ ] **Step 3: Implement** — add inside `registerAggregatorTools`:

```ts
register(server, 'get_billing_snapshot', 'Read-only billing snapshot: unpaid/overdue/paid/cancelled/refunded/draft counts+amounts (from GetClientsDetails stats), credit balance, and recent unpaid/overdue invoices.', {}, logger, rl, async (params) => {
  const errs: PartialError[] = []; const cid = params.clientid;
  const cd: any = await safeSection('client', errs, {}, () => whmcs.read('GetClientsDetails', { clientid: cid, stats: true }));
  const st = cd.stats ?? {};
  const mapInv = (arr: any[]) => arr.map((i) => ({ invoiceid: i.id, total: i.total, duedate: i.duedate, date: i.date, status: i.status }));
  const recent_unpaid = await safeSection('unpaid', errs, [], async () => mapInv(norm<any>((await whmcs.read<any>('GetInvoices', { userid: cid, status: 'Unpaid', limitnum: 5, orderby: 'duedate', order: 'desc' })).invoices, 'invoice')));
  const recent_overdue = await safeSection('overdue', errs, [], async () => mapInv(norm<any>((await whmcs.read<any>('GetInvoices', { userid: cid, status: 'Overdue', limitnum: 5, orderby: 'duedate', order: 'desc' })).invoices, 'invoice')));
  return {
    currency: cd.currency_code, credit_balance: st.creditbalance ?? cd.credit,
    unpaid: { count: st.numunpaidinvoices ?? 0, amount: st.unpaidinvoicesamount ?? '0.00' },
    overdue: { count: st.numoverdueinvoices ?? 0, amount: st.overdueinvoicesbalance ?? '0.00' },
    paid: { count: st.numpaidinvoices ?? 0, amount: st.paidinvoicesamount ?? '0.00' },
    cancelled: { count: st.numcancelledinvoices ?? 0 }, refunded: { count: st.numrefundedinvoices ?? 0 }, draft: { count: st.numDraftInvoices ?? 0 },
    recent_unpaid, recent_overdue, partial_errors: errs,
  };
});
```

- [ ] **Step 4: PASS** + full suite + build + tsc ≤26. **Step 5: Commit** `feat(tools): get_billing_snapshot aggregator`.

---

## Task 3: `get_support_snapshot` (C2)

**Files:** Modify `src/tools/aggregators.ts`; Modify `tests/tools/aggregators.test.ts`.

- [ ] **Step 1: Failing test** — append:

```ts
describe('get_support_snapshot', () => {
  it('returns global departments + best-effort client tickets (C2)', async () => {
    const { handlers } = harness((action) => {
      if (action === 'GetSupportDepartments') return { departments: { department: [{ id: 1, name: 'Help Desk', awaitingreply: 7, opentickets: 7 }, { id: 12, name: 'Billing', awaitingreply: 0, opentickets: 0 }] } };
      if (action === 'GetTickets') return { tickets: { ticket: [{ id: 1001, tid: 'TST01', subject: 's', status: 'Answered', lastreply: '2026-05-18 07:31:27' }] } };
      return {};
    });
    const res = await handlers['get_support_snapshot']({ clientid: 30 });
    const p = JSON.parse(res.content[0].text);
    expect(p.departments).toEqual([
      { id: 1, name: 'Help Desk', open_tickets: 7, awaiting_reply: 7 },
      { id: 12, name: 'Billing', open_tickets: 0, awaiting_reply: 0 },
    ]);
    expect(p.departments_scope).toMatch(/global/i);
    expect(p.client_tickets.items[0]).toMatchObject({ ticketid: 1001, tid: 'TST01' });
    expect(p.client_tickets.discovery).toBe('best-effort');
    expect(p.client_tickets.note).toMatch(/may miss operator/i);
    expect(p.partial_errors).toEqual([]);
  });
});
```

- [ ] **Step 2: FAIL**.
- [ ] **Step 3: Implement** — add inside `registerAggregatorTools`:

```ts
register(server, 'get_support_snapshot', 'Read-only support snapshot: global department open/awaiting counts (GetSupportDepartments — NOT client-scoped) + best-effort recent client tickets (GetTickets clientid may miss operator/admin tickets).', {}, logger, rl, async (params) => {
  const errs: PartialError[] = []; const cid = params.clientid;
  const departments = await safeSection('departments', errs, [], async () => norm<any>((await whmcs.read<any>('GetSupportDepartments', {})).departments, 'department').map((d) => ({ id: d.id, name: d.name, open_tickets: d.opentickets ?? 0, awaiting_reply: d.awaitingreply ?? 0 })));
  const items = await safeSection('tickets', errs, [], async () => norm<any>((await whmcs.read<any>('GetTickets', { clientid: cid, limitnum: 25 })).tickets, 'ticket').map((t) => ({ ticketid: t.id, tid: t.tid, subject: t.subject, status: t.status, lastreply: t.lastreply })).sort((a, b) => String(b.lastreply || '').localeCompare(String(a.lastreply || ''))).slice(0, 10));
  return { departments, departments_scope: 'global (not client-scoped)', client_tickets: { items, ...TICKET_BEST_EFFORT }, partial_errors: errs };
});
```

- [ ] **Step 4: PASS** + full suite + build + tsc ≤26. **Step 5: Commit** `feat(tools): get_support_snapshot aggregator (C2 best-effort)`.

---

## Task 4: `get_renewal_snapshot`

**Files:** Modify `src/tools/aggregators.ts`; Modify `tests/tools/aggregators.test.ts`.

- [ ] **Step 1: Failing test** — append (uses a fixed "today" via the `days` window; test data has one in-window + one out-of-window per type):

```ts
describe('get_renewal_snapshot', () => {
  it('lists services+domains due within `days`, sorted ascending by due date', async () => {
    const soon = '2026-06-01'; const far = '2031-01-01';
    const { handlers } = harness((action) => {
      if (action === 'GetClientsProducts') return { products: { product: [
        { id: 545, name: 'Web Hosting', domain: 'example.org', status: 'Active', nextduedate: soon, recurringamount: '3.00' },
        { id: 9, name: 'Old', domain: 'x', status: 'Active', nextduedate: far } ] } };
      if (action === 'GetClientsDomains') return { domains: { domain: [
        { id: 314, domainname: 'example.net', status: 'Active', expirydate: '2026-05-25', nextduedate: '2026-05-25' },
        { id: 99, domainname: 'far.test', status: 'Active', expirydate: far, nextduedate: far } ] } };
      return {};
    });
    const res = await handlers['get_renewal_snapshot']({ clientid: 30, days: 9999 }); // wide window to keep test date-stable
    const p = JSON.parse(res.content[0].text);
    // both in-window items present, sorted ascending by due_date (domain 2026-05-25 before service 2026-06-01)
    expect(p.upcoming.map((u: any) => `${u.type}:${u.id}`)).toEqual(['domain:314', 'service:545', 'domain:99', 'service:9']);
    expect(p.upcoming[0]).toMatchObject({ type: 'domain', id: 314, name: 'example.net', due_date: '2026-05-25', status: 'Active' });
    expect(p.window_days).toBe(9999);
    expect(p.partial_errors).toEqual([]);
  });
  it('filters out items beyond the window', async () => {
    const { handlers } = harness((action) => {
      if (action === 'GetClientsProducts') return { products: { product: [{ id: 1, name: 'A', domain: 'a', status: 'Active', nextduedate: '2099-01-01' }] } };
      if (action === 'GetClientsDomains') return { domains: { domain: [] } };
      return {};
    });
    const res = await handlers['get_renewal_snapshot']({ clientid: 30, days: 30 });
    const p = JSON.parse(res.content[0].text);
    expect(p.upcoming).toEqual([]);
  });
});
```

- [ ] **Step 2: FAIL**.
- [ ] **Step 3: Implement** — add inside `registerAggregatorTools`:

```ts
register(server, 'get_renewal_snapshot', 'Read-only renewal snapshot: services (next_due_date) and domains (expiry/next_due) due within `days` (default 60), sorted soonest-first. Date window filtered client-side.', { days: z.number().int().min(1).max(3650).default(60) }, logger, rl, async (params) => {
  const errs: PartialError[] = []; const cid = params.clientid;
  const horizon = new Date(Date.now() + (params.days ?? 60) * 86400000).toISOString().slice(0, 10);
  const inWindow = (d?: string) => !!d && /^\d{4}-\d{2}-\d{2}/.test(d) && d.slice(0, 10) <= horizon;
  const svc = await safeSection('services', errs, [], async () => norm<any>((await whmcs.read<any>('GetClientsProducts', { clientid: cid, limitnum: 100 })).products, 'product')
    .filter((p) => inWindow(p.nextduedate)).map((p) => ({ type: 'service' as const, id: p.id, name: p.name, due_date: p.nextduedate, status: p.status, recurring_amount: p.recurringamount })));
  const dom = await safeSection('domains', errs, [], async () => norm<any>((await whmcs.read<any>('GetClientsDomains', { clientid: cid, limitnum: 100 })).domains, 'domain')
    .filter((d) => inWindow(d.expirydate ?? d.nextduedate)).map((d) => ({ type: 'domain' as const, id: d.id, name: d.domainname, due_date: (d.expirydate ?? d.nextduedate), status: d.status })));
  const upcoming = [...svc, ...dom].sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)));
  return { window_days: params.days ?? 60, horizon, upcoming, partial_errors: errs };
});
```

(Note: the first test uses `days:9999` so `horizon` is far-future and date-stability is not a problem; ordering asserts the comparator. The second test uses `days:30` with a year-2099 item to assert windowing without depending on the current date being before any near item.)

- [ ] **Step 4: PASS** + full suite + build + tsc ≤26. **Step 5: Commit** `feat(tools): get_renewal_snapshot aggregator`.

---

## Task 5: Register + final verify

**Files:** Modify `src/index.ts`; Test: full suite + E2E smoke.

- [ ] **Step 1:** In `src/index.ts` add `import { registerAggregatorTools } from './tools/aggregators.js';` with the other tool imports, and add `registerAggregatorTools(server, whmcsClient, logger, rateLimiter);` immediately AFTER `registerTicketThreadTool(server, whmcsClient, logger, rateLimiter);` and BEFORE `registerResources(...)`. Match exact existing variable names/order.
- [ ] **Step 2:** `npm run build` (success); `npx vitest run` (106 + all new aggregator tests, no regressions, 14 skipped); `npx tsc --noEmit` (≤ 26; zero in new/changed files via `grep -c "src/tools/aggregators.ts\|src/index.ts"` = 0).
- [ ] **Step 3: E2E tools/list smoke** (no prod): spawn `dist/index.js` over stdio with an MCP client, assert the 4 new tools `get_account_360,get_billing_snapshot,get_support_snapshot,get_renewal_snapshot` are present and each has `annotations.readOnlyHint===true && annotations.destructiveHint===false`. (Reuse the inline smoke pattern used at Phase-1 Task 10.)
- [ ] **Step 4: Commit** `git add src/index.ts && git commit -m "feat: register Phase-2 aggregator tools"`.
- [ ] **Step 5: STOP** for controller final review + finishing-a-development-branch. Do NOT push (user-gated). Prod verification handled by controller post-merge.

---

## Self-Review

- **Spec coverage (§3.3):** get_account_360 (identity/status/credit + stats counts + recent services/domains/invoices/tickets) → Task 1 ✅; get_billing_snapshot (unpaid/overdue/paid totals from stats + recent invoices + balance) → Task 2 ✅; get_support_snapshot (departments open/awaiting + recent ticket list) → Task 3 ✅; get_renewal_snapshot (upcoming service/domain next-due/expiry within window) → Task 4 ✅. Read-only + same annotations → `register()` helper uses `READ_ONLY_ANNOTATIONS` + `whmcs.read` only (actionPolicy already guards) ✅. Composed from stats + Phase-1 actions ✅.
- **C2:** get_account_360 (`recent.tickets.{discovery,note}`) and get_support_snapshot (`client_tickets.{discovery,note}` + `departments_scope:'global (not client-scoped)'`) both explicitly surface best-effort + the operator-ticket caveat; asserted in tests ✅.
- **Placeholders:** none — every step has complete runnable code/tests; the "Tasks 2-4 append here" markers are explicit append-points with full code provided in those tasks (not "similar to").
- **Type consistency:** `safeSection`, `norm`, `register`, `PartialError`, `TICKET_BEST_EFFORT`, `registerAggregatorTools` names + signatures used identically across Tasks 1–5 and `index.ts`. Output keys consistent (`partial_errors`, `recent`, `counts`, `client`).
- **Security/quality:** all read-only (no `mutate`), `ensureToolAuth`/`isToolAllowed`/client-mode scope via shared `register()`, partial-failure tolerant (auth/rate-limit still fail fast), localized `ToolCallback` cast copied from proven listTools pattern (tsc stays 26).
