# WHMCS Operational Intelligence — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 6 read-only WHMCS discovery tools (`list_client_services|domains|invoices|tickets|orders`, `get_ticket_thread`) plus a corrected `clients/{id}/log` resource, so an operator/agent can do Account-360 → Billing → Support-triage from a client ID with no WHMCS admin UI and zero production mutations.

**Architecture:** A single shared `registerListTool` factory (DRY) drives the 5 list tools — each supplies a config (WHMCS action, normalizer path, zod extras, item mapper). `get_ticket_thread` reuses a shared `formatTicketThread` extracted from the existing resource. A WhmcsClient action-policy guard hard-blocks write actions server-side. Pagination `limit/offset` → WHMCS `limitnum/limitstart`. New tools use SDK 1.29 `registerTool` + read-only annotations.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk@1.29` (`registerTool` + `ToolAnnotations`), zod, vitest, existing `WhmcsClient`/`normalizeToArray`/`security` helpers.

**Spec:** `docs/superpowers/specs/2026-05-18-whmcs-operational-intelligence-design.md`

---

## Prerequisites (NOT part of this plan's tasks — must be true before Task 0)

- P1. `e6114cb` (#10/#11) test fixtures sanitized of real owner PII (`Test/User/client@example.test/example.org` → synthetic), commit amended, suite green. **User-gated.**
- P2. #10/#11 (`e6114cb`) + spec (`4e6216c`) pushed to `origin/main` (so the feature worktree's `fresh` base from origin contains the #11 normalizer fix this plan depends on). **User-gated.**

If P2 is not done, Task 0 must use a `head`-based worktree instead of `fresh` (see Task 0).

## The 3 user clarifications (MUST appear in code + docs)

- C1. `list_client_tickets` description + returned payload `note` field must state: *GetTickets clientid discovery may miss operator/admin-created tickets; use `get_ticket_thread` by known ticketid/tid for reliable retrieval.*
- C2. Phase-2 account/support aggregators must not assume clientid ticket discovery is complete (encoded later; noted here so Phase 1 leaves the hook: `list_client_tickets` returns `discovery: 'best-effort'`).
- C3. `clients/{id}/log` must label its tickets section `tickets_best_effort` (not guaranteed full support history).

## File Structure

- **Create** `src/whmcs/actionPolicy.ts` — read-action allowlist + write-action denylist; `assertReadAction(action)`.
- **Modify** `src/whmcs/WhmcsClient.ts` — call `assertReadAction` inside `read()`.
- **Create** `src/whmcs/ticketThread.ts` — `formatTicketThread(ticket)` shared by the resource and the new tool (extracted from `resources/index.ts`).
- **Modify** `src/resources/index.ts` — ticket-thread resource uses `formatTicketThread`; `clients/{id}/log` ordering fix + `tickets_best_effort`.
- **Create** `src/tools/listTools.ts` — `registerListTool` factory + the 5 list tools + `registerListTools(server,...)`.
- **Create** `src/tools/ticketThreadTool.ts` — `get_ticket_thread` tool (uses `formatTicketThread`).
- **Modify** `src/index.ts` — call `registerListTools` and `registerTicketThreadTool`.
- **Tests:** `tests/whmcs/actionPolicy.test.ts`, `tests/whmcs/ticketThread.test.ts`, `tests/tools/listTools.test.ts`, `tests/tools/ticketThreadTool.test.ts`, `tests/resources.log.test.ts`.

---

## Task 0: Feature worktree (execution-time only)

**REQUIRED SUB-SKILL:** `superpowers:using-git-worktrees`.

- [ ] **Step 1:** Confirm prerequisites P1+P2 done (`git log origin/main..HEAD` empty for #10/#11; `git grep -n "<owner-name>|<owner-email>" origin/main -- tests/` empty).
- [ ] **Step 2:** Create worktree `whmcs-opsintel-p1` via `EnterWorktree` (native; `fresh` base = origin/main now includes #11 fix). If P2 not done, the operator must set `worktree.baseRef=head` first.
- [ ] **Step 3:** `npm install` && `npm run build` && `npx vitest run` — baseline must be green (88 passed/14 skipped) before changes.

---

## Task 1: Action-policy guard (server-side write block)

**Files:** Create `src/whmcs/actionPolicy.ts`; Modify `src/whmcs/WhmcsClient.ts`; Test `tests/whmcs/actionPolicy.test.ts`.

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest';
import { assertReadAction, WriteActionError } from '../../src/whmcs/actionPolicy.js';

describe('actionPolicy', () => {
  it('allows known read actions', () => {
    for (const a of ['GetClientsDetails','GetClientsProducts','GetClientsDomains','GetInvoices','GetTickets','GetTicket','GetOrders'])
      expect(() => assertReadAction(a)).not.toThrow();
  });
  it('blocks write actions by denylist prefix/name', () => {
    for (const a of ['AddClient','UpdateClient','DeleteClient','CreateInvoice','CapturePayment','ApplyCredit','AddCredit','AddInvoicePayment','OpenTicket','AddTicketReply','UpdateTicket','ModuleCreate','DomainRegister','DomainRenew','DomainTransfer','SendEmail','SendAdminEmail','TriggerNotificationEvent','SetConfigurationValue'])
      expect(() => assertReadAction(a)).toThrow(WriteActionError);
  });
  it('blocks unknown/non-allowlisted actions (deny by default)', () => {
    expect(() => assertReadAction('SomeUnknownAction')).toThrow(WriteActionError);
  });
});
```

- [ ] **Step 2: Run → FAIL** `npx vitest run tests/whmcs/actionPolicy.test.ts` — Expected: cannot find module.

- [ ] **Step 3: Implement**

```ts
// src/whmcs/actionPolicy.ts
export class WriteActionError extends Error {
  constructor(action: string) { super(`Action '${action}' is not a permitted read-only action`); this.name = 'WriteActionError'; }
}
const READ_ALLOWLIST = new Set<string>([
  'GetClients','GetClientsDetails','GetClientsProducts','GetClientsDomains',
  'GetInvoice','GetInvoices','GetTickets','GetTicket','GetSupportDepartments',
  'GetOrders','GetProducts','GetActivityLog','GetAdminDetails','DomainWhois',
]);
const WRITE_DENY_PREFIX = /^(Add|Update|Delete|Create|Module|Domain(Register|Renew|Transfer)|Send|Set)/i;
const WRITE_DENY_EXACT = new Set<string>([
  'CapturePayment','ApplyCredit','AddCredit','AddInvoicePayment','OpenTicket',
  'AddTicketReply','UpdateTicket','SendEmail','SendAdminEmail',
  'TriggerNotificationEvent','SetConfigurationValue',
]);
export function assertReadAction(action: string): void {
  if (WRITE_DENY_EXACT.has(action) || WRITE_DENY_PREFIX.test(action)) throw new WriteActionError(action);
  if (!READ_ALLOWLIST.has(action)) throw new WriteActionError(action); // deny by default
}
```

- [ ] **Step 4: Wire into WhmcsClient.read()** — Modify `src/whmcs/WhmcsClient.ts` `read<T>()`: first line of body `assertReadAction(action);` (import `assertReadAction` from `./actionPolicy.js`). Do NOT add to `call()`/`mutate()` (mutate is the legitimate write path, already mode-gated).

- [ ] **Step 5: Run → PASS** `npx vitest run tests/whmcs/actionPolicy.test.ts` then full `npx vitest run` (must stay 88 green — existing read actions are all allowlisted; verify GetActivityLog/GetAdminDetails/DomainWhois used by integration tests are in the allowlist).

- [ ] **Step 6: Commit** `git add src/whmcs/actionPolicy.ts src/whmcs/WhmcsClient.ts tests/whmcs/actionPolicy.test.ts && git commit -m "feat(security): server-side read-only action policy guard"`

---

## Task 2: Shared list-tool factory

**Files:** Create `src/tools/listTools.ts`; Test `tests/tools/listTools.test.ts` (factory behaviour via a fake config).

- [ ] **Step 1: Write failing test** (pagination mapping + envelope + client-mode + normalization)

```ts
import { describe, it, expect, vi } from 'vitest';
vi.mock('../../src/config.js', () => ({ config: { MCP_MAX_PAGE_SIZE: 100 }, isToolAllowed: () => true }));
vi.mock('../../src/security.js', () => ({ AUTH_SHAPE: {}, ensureToolAuth: () => null, isClientMode: () => false, ensureClientAllowed: () => null }));
import { registerListTool } from '../../src/tools/listTools.js';

function harness() {
  const handlers: Record<string, any> = {};
  const server = { registerTool: (n: string, _cfg: unknown, cb: any) => { handlers[n] = cb; } };
  const childLogger: any = { logToolCall: vi.fn(), logToolResult: vi.fn(), info: vi.fn(), error: vi.fn(), child: () => childLogger };
  const logger: any = { child: () => childLogger };
  const rateLimiter: any = { tryConsume: () => true };
  return { server, handlers, logger, rateLimiter };
}

it('maps limit/offset→limitnum/limitstart and returns envelope', async () => {
  const { server, handlers, logger, rateLimiter } = harness();
  const read = vi.fn().mockResolvedValue({ totalresults: 3, numreturned: 2, startnumber: 0, things: { thing: { '0': { id: 1 }, '1': { id: 2 } } } });
  registerListTool(server as any, { read } as any, logger, rateLimiter, {
    name: 'list_things', description: 'd', action: 'GetThings',
    clientParam: 'clientid', normalizerPath: 'things',
    extraSchema: {}, mapItem: (t: any) => ({ id: t.id }),
  });
  const res = await handlers['list_things']({ clientid: 5, limit: 2, offset: 0 });
  expect(read).toHaveBeenCalledWith('GetThings', { clientid: 5, limitnum: 2, limitstart: 0 });
  const p = JSON.parse(res.content[0].text);
  expect(p).toMatchObject({ total: 3, count: 2, offset: 0, items: [{ id: 1 }, { id: 2 }] });
});

it('enforces client-mode scope', async () => {
  vi.resetModules();
  vi.doMock('../../src/security.js', () => ({ AUTH_SHAPE: {}, ensureToolAuth: () => null, isClientMode: () => true, ensureClientAllowed: () => ({ content: [{ type: 'text', text: '{"isError":true}' }], isError: true }) }));
  const { registerListTool: rlt } = await import('../../src/tools/listTools.js');
  const { server, handlers, logger, rateLimiter } = harness();
  rlt(server as any, { read: vi.fn() } as any, logger, rateLimiter, { name: 'list_x', description: 'd', action: 'GetX', clientParam: 'clientid', normalizerPath: 'x', extraSchema: {}, mapItem: (t: any) => t });
  const res = await handlers['list_x']({ clientid: 999 });
  expect(res.isError).toBe(true);
});
```

- [ ] **Step 2: Run → FAIL** (module missing).

- [ ] **Step 3: Implement** `src/tools/listTools.ts`

```ts
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WhmcsClient, WhmcsBusinessError } from '../whmcs/WhmcsClient.js';
import { Logger } from '../logging.js';
import { RateLimiter, RateLimitError } from '../rateLimiter.js';
import { config, isToolAllowed } from '../config.js';
import { ensureToolAuth, isClientMode, ensureClientAllowed, AUTH_SHAPE } from '../security.js';
import { normalizeToArray } from '../whmcs/normalizers.js';

const READ_ONLY_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export interface ListToolConfig<T> {
  name: string;
  description: string;
  action: string;            // WHMCS read action
  clientParam: 'clientid' | 'userid';
  normalizerPath: string;    // e.g. 'products' → response.products.product
  singular?: string;         // override; default derived in normalizer
  extraSchema: z.ZodRawShape; // e.g. { status: z.string().optional() }
  mapItem: (raw: any) => T;   // map a raw WHMCS row → safe output (no unneeded PII)
  postSort?: (items: T[]) => T[]; // client-side sort when server order unproven
  extraPayload?: Record<string, unknown>; // e.g. discovery note
}

export function registerListTool<T>(
  server: McpServer, whmcs: WhmcsClient, logger: Logger, rl: RateLimiter, c: ListToolConfig<T>
): void {
  if (!isToolAllowed(c.name)) return;
  const schema = z.object({
    clientid: z.number().int().positive(),
    limit: z.number().int().min(1).max(config.MCP_MAX_PAGE_SIZE).default(10),
    offset: z.number().int().min(0).default(0),
    ...c.extraSchema,
  });
  server.registerTool(
    c.name,
    { description: c.description, inputSchema: { ...schema.shape, ...AUTH_SHAPE }, annotations: READ_ONLY_ANNOTATIONS },
    async (params: any) => {
      const log = logger.child(); const t0 = Date.now();
      try {
        const authErr = ensureToolAuth(params); if (authErr) return authErr;
        if (isClientMode()) { const s = ensureClientAllowed(params.clientid); if (s) return s; }
        log.logToolCall(c.name, params, false);
        if (!rl.tryConsume()) throw new RateLimitError();
        const { limit = 10, offset = 0, clientid } = params;
        const apiParams: Record<string, unknown> = { [c.clientParam]: clientid, limitnum: limit, limitstart: offset };
        for (const k of Object.keys(c.extraSchema)) if (params[k] !== undefined) apiParams[k] = params[k];
        const resp = await whmcs.read<Record<string, any>>(c.action, apiParams);
        const container = resp[c.normalizerPath];
        const singular = c.singular ?? c.normalizerPath.replace(/ies$/, 'y').replace(/s$/, '');
        const rows = normalizeToArray<any>(container && typeof container === 'object' ? (container[singular] ?? container) : container);
        let items = rows.map(c.mapItem);
        if (c.postSort) items = c.postSort(items);
        log.logToolResult(c.name, true, Date.now() - t0);
        return { content: [{ type: 'text' as const, text: JSON.stringify({
          items, total: resp.totalresults ?? items.length, count: resp.numreturned ?? items.length,
          offset: resp.startnumber ?? offset, limit, ...(c.extraPayload ?? {}),
        }) }] };
      } catch (e) {
        log.logToolResult(c.name, false, Date.now() - t0, e instanceof Error ? e.message : String(e));
        if (e instanceof RateLimitError || e instanceof WhmcsBusinessError)
          return { content: [{ type: 'text' as const, text: JSON.stringify({ isError: true, error: (e as Error).message }) }], isError: true };
        throw e;
      }
    }
  );
}
```

- [ ] **Step 4: Run → PASS** `npx vitest run tests/tools/listTools.test.ts`.
- [ ] **Step 5: Commit** `git add src/tools/listTools.ts tests/tools/listTools.test.ts && git commit -m "feat(tools): shared read-only list-tool factory"`

---

## Task 3: `list_client_services` (GetClientsProducts)

**Files:** Modify `src/tools/listTools.ts` (add `registerListTools` aggregator + this config); Test `tests/tools/listTools.test.ts` (add case).

- [ ] **Step 1: Failing test** — mock `read` returns `{ totalresults:3,numreturned:2,startnumber:0, products:{ product:[{id:545,pid:413,name:'Business Web Hosting',domain:'example.org',status:'Active',billingcycle:'Triennially',nextduedate:'2030-04-14',recurringamount:'3.00',paymentmethod:'razorpay'}] } }`; assert handler `list_client_services` returns `items[0]` = `{serviceid:545,pid:413,product:'Business Web Hosting',domain:'example.org',status:'Active',billing_cycle:'Triennially',next_due_date:'2030-04-14',recurring_amount:'3.00',payment_method:'razorpay'}` and read called with `('GetClientsProducts',{clientid,limitnum:10,limitstart:0})`.
- [ ] **Step 2: Run → FAIL** (`list_client_services` not registered).
- [ ] **Step 3: Implement** — append to `listTools.ts`:

```ts
export function registerListTools(server: McpServer, w: WhmcsClient, l: Logger, rl: RateLimiter): void {
  registerListTool(server, w, l, rl, {
    name: 'list_client_services',
    description: 'List a client’s products/services (read-only). Pagination via limit/offset.',
    action: 'GetClientsProducts', clientParam: 'clientid', normalizerPath: 'products',
    extraSchema: { status: z.string().optional() },
    mapItem: (p) => ({ serviceid: p.id, pid: p.pid, product: p.name, domain: p.domain, status: p.status,
      billing_cycle: p.billingcycle, next_due_date: p.nextduedate, recurring_amount: p.recurringamount, payment_method: p.paymentmethod }),
  });
  // Tasks 4-7 append their registerListTool calls here.
}
```

- [ ] **Step 4: Run → PASS**. **Step 5: Commit** `feat(tools): list_client_services`.

---

## Task 4: `list_client_domains` (GetClientsDomains)

- [ ] **Step 1: Failing test** — mock `domains:{domain:[{id:615,domainname:'example.net',registrar:'20i',status:'Active',regdate:'2025-05-30',expirydate:'2026-07-09',nextduedate:'2026-07-09',donotrenew:'0'}]}`; expect `items[0]` = `{domainid:615,domain:'example.net',registrar:'20i',status:'Active',regdate:'2025-05-30',expiry_date:'2026-07-09',next_due_date:'2026-07-09',donotrenew:'0'}`.
- [ ] **Step 2: FAIL**.
- [ ] **Step 3: Implement** — add to `registerListTools`:

```ts
registerListTool(server, w, l, rl, {
  name: 'list_client_domains',
  description: 'List a client’s domains (read-only). Pagination via limit/offset.',
  action: 'GetClientsDomains', clientParam: 'clientid', normalizerPath: 'domains',
  extraSchema: { status: z.string().optional() },
  mapItem: (d) => ({ domainid: d.id, domain: d.domainname, registrar: d.registrar, status: d.status,
    regdate: d.regdate, expiry_date: d.expirydate, next_due_date: d.nextduedate, donotrenew: d.donotrenew }),
});
```

- [ ] **Step 4: PASS**. **Step 5: Commit** `feat(tools): list_client_domains`.

---

## Task 5: `list_client_invoices` (GetInvoices — server-side status + date desc, verified)

- [ ] **Step 1: Failing test** — mock `invoices:{invoice:[{id:300003331,invoicenum:'2026...',date:'2025-12-31',duedate:'2026-01-15',datepaid:'2025-12-31',status:'Cancelled',total:'9000.00'}]}`; call with `{clientid,status:'Unpaid'}`; assert `read` called with `('GetInvoices',{userid,limitnum:10,limitstart:0,status:'Unpaid',orderby:'date',order:'desc'})` and `items[0]={invoiceid:300003331,invoicenum:'2026...',date:'2025-12-31',duedate:'2026-01-15',datepaid:'2025-12-31',status:'Cancelled',total:'9000.00'}`.
- [ ] **Step 2: FAIL**.
- [ ] **Step 3: Implement** — uses `clientParam:'userid'`; inject fixed `orderby:'date',order:'desc'` via a small `fixedParams` addition to the factory config (add `fixedParams?: Record<string,unknown>` to `ListToolConfig`, merged into `apiParams` in factory Step-3 code — update factory + its test accordingly).

```ts
registerListTool(server, w, l, rl, {
  name: 'list_client_invoices',
  description: 'List a client’s invoices (read-only), newest first; optional status filter (Unpaid/Overdue/Paid/Cancelled/Refunded).',
  action: 'GetInvoices', clientParam: 'userid', normalizerPath: 'invoices',
  extraSchema: { status: z.string().optional() },
  fixedParams: { orderby: 'date', order: 'desc' },
  mapItem: (i) => ({ invoiceid: i.id, invoicenum: i.invoicenum, date: i.date, duedate: i.duedate,
    datepaid: i.datepaid, status: i.status, total: i.total, balance: i.balance }),
});
```

- [ ] **Step 4: PASS** (also update factory test for `fixedParams`). **Step 5: Commit** `feat(tools): list_client_invoices (server-side status+order)`.

---

## Task 6: `list_client_tickets` (GetTickets — client-side sort + C1/C2 caveat)

- [ ] **Step 1: Failing test** — mock `tickets:{ticket:[{id:1001,tid:'TST01',subject:'x',status:'Answered',deptname:'Help Desk',date:'2026-05-18 07:21:49',lastreply:'2026-05-18 07:31:27'},{id:1,tid:'AAA',subject:'y',status:'Open',deptname:'Billing',date:'2026-01-01 00:00:00',lastreply:'2026-02-01 00:00:00'}]}`; assert items sorted by `lastreply` desc (1001 first), each `{ticketid,tid,subject,status,deptname,date,lastreply}`, and payload includes `discovery:'best-effort'` and a `note` containing "may miss operator/admin-created tickets" (C1) and that `get_ticket_thread` by id is reliable.
- [ ] **Step 2: FAIL**.
- [ ] **Step 3: Implement**:

```ts
registerListTool(server, w, l, rl, {
  name: 'list_client_tickets',
  description: 'List a client’s support tickets (read-only). NOTE: WHMCS GetTickets clientid filter may MISS operator/admin-created tickets; for reliable retrieval use get_ticket_thread with a known ticketid/tid.',
  action: 'GetTickets', clientParam: 'clientid', normalizerPath: 'tickets',
  extraSchema: { status: z.string().optional(), deptid: z.number().int().optional(), subject: z.string().optional() },
  mapItem: (t) => ({ ticketid: t.id, tid: t.tid, subject: t.subject, status: t.status,
    deptname: t.deptname, date: t.date, lastreply: t.lastreply }),
  postSort: (xs: any[]) => [...xs].sort((a, b) => String(b.lastreply || b.date).localeCompare(String(a.lastreply || a.date))),
  extraPayload: { discovery: 'best-effort',
    note: 'GetTickets clientid discovery may miss operator/admin-created tickets; use get_ticket_thread by known ticketid/tid for reliable retrieval.' },
});
```

- [ ] **Step 4: PASS**. **Step 5: Commit** `feat(tools): list_client_tickets (best-effort, client-side sort)`.

---

## Task 7: `list_client_orders` (GetOrders — role permits; client-side sort)

- [ ] **Step 1: Failing test** — mock `orders:{order:[{id:967,ordernum:'...',date:'2025-08-25',amount:'699.00',status:'Cancelled',invoiceid:300003103,name:'...'},{id:1,date:'2020-01-01',amount:'1',status:'Active',invoiceid:1,name:'a'}]}`; expect sorted by date desc, `items[0]={orderid:967,ordernum:'...',date:'2025-08-25',amount:'699.00',status:'Cancelled',invoiceid:300003103,name:'...'}`, read called `('GetOrders',{userid,limitnum:10,limitstart:0})`.
- [ ] **Step 2: FAIL**.
- [ ] **Step 3: Implement**:

```ts
registerListTool(server, w, l, rl, {
  name: 'list_client_orders',
  description: 'List a client’s orders (read-only), newest first. Order not server-sorted by WHMCS; sorted client-side.',
  action: 'GetOrders', clientParam: 'userid', normalizerPath: 'orders',
  extraSchema: { status: z.string().optional() },
  mapItem: (o) => ({ orderid: o.id, ordernum: o.ordernum, date: o.date, amount: o.amount,
    status: o.status, invoiceid: o.invoiceid, name: o.name }),
  postSort: (xs: any[]) => [...xs].sort((a, b) => String(b.date).localeCompare(String(a.date))),
});
```

- [ ] **Step 4: PASS**. **Step 5: Commit** `feat(tools): list_client_orders`.

---

## Task 8: Extract `formatTicketThread` + `get_ticket_thread` tool

**Files:** Create `src/whmcs/ticketThread.ts`; Modify `src/resources/index.ts` (use it); Create `src/tools/ticketThreadTool.ts`; Tests `tests/whmcs/ticketThread.test.ts`, `tests/tools/ticketThreadTool.test.ts`.

- [ ] **Step 1: Failing test** `ticketThread.test.ts` — `formatTicketThread({ ticketid:1001, tid:'TST01', deptname:'Help Desk', subject:'s', status:'Answered', date:'d', replies:{reply:[{message:'open',name:'C',date:'d1'},{message:'reply2',admin:'A',date:'d2'}]}, notes:[] })` → `{ticketid:1001,ticket_number:'TST01',department:'Help Desk',subject:'s',status:'Answered',date:'d',initial_message:'open',replies:[{message:'reply2',is_admin:true,...}],internal_notes:[]}`. And `ticketThreadTool.test.ts` — handler `get_ticket_thread({ticketid:1001})` calls `read('GetTicket',{ticketid:1001})` and returns the formatted payload; read-only annotations present.
- [ ] **Step 2: FAIL**.
- [ ] **Step 3: Implement** — move the body that builds `{ticketid,ticket_number,...,initial_message,replies,internal_notes}` out of `resources/index.ts` ticket-thread handler into `export function formatTicketThread(ticket): {...}` in `src/whmcs/ticketThread.ts` (use `normalizeToArray(ticket.replies?.reply)`, `opening=allReplies[0]`, `subsequent=slice(1)` — identical logic already fixed in #11; just relocated). Resource handler now: `return { contents:[{uri:safeUri,mimeType:'application/json',text:JSON.stringify(formatTicketThread(ticket),null,2)}] }`. New tool `src/tools/ticketThreadTool.ts` `registerTicketThreadTool(server,whmcs,logger,rl)`: zod `{ ticketid: z.number().int().positive() }`, `registerTool` with READ_ONLY_ANNOTATIONS, `ensureToolAuth`, allowlist gate, rate-limit, client-mode ownership check via `ticket.userid` (mirror resource), `whmcs.read('GetTicket',{ticketid})`, return `formatTicketThread`.
- [ ] **Step 4: PASS** + full suite (resource tests `tests/resources.tickets.test.ts` must still pass — behaviour unchanged, only relocated). **Step 5: Commit** `feat(tools): get_ticket_thread tool + shared formatTicketThread`.

---

## Task 9: Fix `clients/{id}/log` ordering + best-effort tickets (C3)

**Files:** Modify `src/resources/index.ts` (client-log handler); Test `tests/resources.log.test.ts`.

- [ ] **Step 1: Failing test** — mock `whmcsClient.read`: `GetInvoices` asserted called with `{userid:<id>,limitnum:10,orderby:'date',order:'desc'}`; `GetOrders`/`GetTickets` fetched with a bounded window (`limitnum:25`) then the handler returns `recent_orders`/`tickets_best_effort` sorted by date/lastreply desc, truncated to 10; payload key is `tickets_best_effort` (C3), not `recent_tickets`.
- [ ] **Step 2: FAIL**.
- [ ] **Step 3: Implement** — in client-log handler: GetInvoices call adds `orderby:'date',order:'desc'`, `limitnum:10`. GetOrders/GetTickets call `limitnum:25`, then `normalizeToArray(...).sort(byDateDesc).slice(0,10)`. Rename output `recent_tickets` → `tickets_best_effort`; add `tickets_note: 'best-effort; not guaranteed full support history (GetTickets clientid may miss operator/admin tickets)'`.
- [ ] **Step 4: PASS** + full suite. **Step 5: Commit** `fix(resource): clients/{id}/log newest-first ordering + best-effort tickets`.

---

## Task 10: Register, full verify, prod proof

**Files:** Modify `src/index.ts`.

- [ ] **Step 1:** Modify `src/index.ts`: import + call `registerListTools(server, whmcsClient, logger, rateLimiter)` and `registerTicketThreadTool(server, whmcsClient, logger, rateLimiter)` after existing tool registrations.
- [ ] **Step 2:** `npm run build` → success. `npx vitest run` → all green (88 + new). `npx tsc --noEmit` → error count ≤ pre-existing 26 (no new). `npx eslint src/tools/listTools.ts src/tools/ticketThreadTool.ts src/whmcs/actionPolicy.ts src/whmcs/ticketThread.ts` → no NEW errors vs baseline patterns.
- [ ] **Step 3: Prod verification (read-only, the anchor client, small limits, redacted)** — via `scripts/mcp-demo.mjs`:
  - `list_client_services {clientid}` → `total:3`, serviceid 545 present.
  - `list_client_domains {clientid,limit:5}` → `total:23`.
  - `list_client_invoices {clientid,status:"Paid",limit:3}` → newest-first dates, `total` ~62.
  - `list_client_tickets {clientid}` → `discovery:'best-effort'`, note present.
  - `list_client_orders {clientid,limit:3}` → `total` ~49, date-desc.
  - `get_ticket_thread {ticketid:1001}` → initial_message + 1 reply (real content).
  Pipe through `scripts/redact.mjs` (`REDACT_MODE=secrets-only`). No addresses/phones/secrets.
- [ ] **Step 4: Commit** `feat: register Phase-1 discovery tools + prod-verified`.
- [ ] **Step 5:** STOP. Report; do NOT push (user-gated). Phase 2 (aggregators) → separate plan.

---

## Self-Review

- **Spec coverage:** services/domains/invoices/tickets/orders/get_ticket_thread → Tasks 3–8 ✅; log fix → Task 9 ✅; pagination/envelope → Task 2 ✅; read-only annotations → Task 2 (`READ_ONLY_ANNOTATIONS`) ✅; write denylist → Task 1 ✅; client-mode scope → Task 2 ✅; TDD + edge shapes → every task + Task 2 normalization ✅; prod verification → Task 10 ✅. Aggregators = Phase 2 (out of this plan, per spec phasing) ✅.
- **Placeholders:** none — every code step has complete code; Task 5 explicitly notes the `fixedParams` factory addition (no "similar to").
- **Type consistency:** `ListToolConfig` fields (`name/description/action/clientParam/normalizerPath/extraSchema/mapItem/postSort/extraPayload/fixedParams`) used identically across Tasks 2–7; `registerListTool`/`registerListTools`/`registerTicketThreadTool`/`formatTicketThread`/`assertReadAction` names consistent across tasks and `index.ts`.
- **Clarifications:** C1 in Task 6 description+note; C2 via `discovery:'best-effort'` hook (Phase-2 aggregators must honor); C3 `tickets_best_effort` in Task 9.

## Phase 2 (separate plan, after Phase 1 stable)

`get_account_360`, `get_billing_snapshot`, `get_support_snapshot`, `get_renewal_snapshot` — compose Phase 1 tools + `GetClientsDetails(stats=true)`; must not assume clientid ticket discovery complete (C2). Own spec section already exists; own plan to be written post-Phase-1 verification.
