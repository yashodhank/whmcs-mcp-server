# WHMCS Operational Intelligence MCP Layer — Design Spec

**Date:** 2026-05-18
**Status:** Draft for user review (brainstorming gate; no implementation until approved)
**Depends on:** commit `e6114cb` (#10/#11 WHMCS response-mapping fixes) — already landed.
**Cycle:** Separate feature cycle (own feature branch / commit set).

## 1. Goal

A **read-only** WHMCS Operational Intelligence MCP layer for real production use
against `the production WHMCS`, with **zero production mutations**. From a client ID
an operator/agent can discover services, domains, invoices, tickets, orders, and
ticket threads, and run Account-360 → Billing → Support-triage entirely via MCP
(no WHMCS admin UI), with usable follow-up IDs and counts matching the WHMCS UI.

## 2. Verified facts (live raw API + installed SDK, 2026-05-18)

These are confirmed, not assumed:

- **GetClientsDetails** returns counts ONLY in `stats` and ONLY with `stats=true`
  (fixed in #10). Parse defensively from root, and from `client` / `client.stats`
  shapes if present (WHMCS has returned both a root projection and a nested
  `client` object in observed responses).
- **GetClientsProducts**(`clientid`,`limitstart`,`limitnum`) → `result`,
  `totalresults`, `numreturned`, `startnumber`, `products.product[]`; item `id`
  is the serviceid. Fields incl. pid, name, domain, status, billingcycle,
  nextduedate, recurringamount, paymentmethod, regdate, username.
- **GetClientsDomains**(`clientid`,`limitstart`,`limitnum`) → `totalresults`,
  `numreturned`, `domains.domain[]`; item `id` is the domainid. Fields incl.
  domainname, registrar, regdate, expirydate, nextduedate, status, donotrenew.
- **GetInvoices**(`userid`,`status`,`orderby=date`,`order=desc`,`limitstart`,
  `limitnum`) → server-side status filter AND date ordering are **honored**
  (verified: descending dates, total=62). Item `id` is invoiceid; fields incl.
  invoicenum, date, duedate, datepaid, total, balance(derived), status.
- **GetTickets**(`clientid`,`deptid`,`status`,`subject`,`limitstart`,`limitnum`):
  `orderby/order` are **accepted but NOT provably honored** (WHMCS silently
  ignores unknown params). Also: `GetTickets(clientid)` returned **0** even
  though ticket 1001 has `userid` (operator/admin-side ticket not surfaced
  by the clientid filter). ⇒ Do NOT rely on server-side ticket ordering;
  fetch a bounded window and sort client-side by `lastreply`/`date`. Document
  the clientid-filter limitation; `subject` filter and `get_ticket_thread`
  (by id) are the reliable paths.
- **GetOrders**(`userid`,`limitstart`,`limitnum`): the current limited API role
  **permits** it (verified total=49). Item `id` is orderid; fields incl.
  ordernum, date, amount, status, invoiceid, name. Ordering: same caution as
  tickets → client-side sort.
- **GetTicket** opening message is `replies.reply[0]`, subsequent are
  `replies.reply.slice(1)` (fixed in #11).
- **MCP SDK 1.29**: `ToolAnnotations` + `registerTool(name,{description,
  inputSchema,annotations},cb)` are supported. Existing tools use the
  deprecated `tool()` overload. New tools use `registerTool` + annotations.

## 3. Scope

### 3.1 New read-only base tools

All: zod input schema; `registerTool` with annotations
`{ readOnlyHint:true, destructiveHint:false, idempotentHint:true,
openWorldHint:true }`; `ensureToolAuth`; `isToolAllowed` gating; rate-limit;
`normalizeToArray` on the WHMCS nested/numeric-keyed shapes; client-mode
`ensureClientAllowed(clientid)`; no `mutate` calls. Pagination: `limit`
(default 10, 1..`MCP_MAX_PAGE_SIZE`) + `offset` (≥0) → WHMCS
`limitnum`/`limitstart`. Every response returns `total` (totalresults),
`offset`/`startnumber`, `count`/`numreturned`, and `items[]`.

| Tool | WHMCS action | Filters | Returned id(s) + key business fields |
|---|---|---|---|
| `list_client_services` | GetClientsProducts | clientid, status? | serviceid(id), pid, product(name), domain, status, billing_cycle, next_due_date, recurring_amount, payment_method |
| `list_client_domains` | GetClientsDomains | clientid, status? | domainid(id), domain(domainname), registrar, status, regdate, expiry_date, next_due_date, donotrenew |
| `list_client_invoices` | GetInvoices | clientid(userid), status?, orderby=date, order=desc (server-side, verified) | invoiceid(id), invoicenum, date, duedate, datepaid, status, total, balance |
| `list_client_tickets` | GetTickets | clientid, status?, deptid?, subject? | ticketid(id), tid, subject, status, deptname, date, lastreply — **client-side sorted** by lastreply desc |
| `list_client_orders` | GetOrders | clientid(userid), status? | orderid(id), ordernum, date, amount, status, invoiceid, name — **client-side sorted** by date desc |
| `get_ticket_thread` | GetTicket | ticketid | ticketid, tid, deptname, subject, status, date, initial_message (= reply[0]), replies[] (= rest), internal_notes[] |

`get_ticket_thread` is the tool form of the (now-fixed) `tickets/{id}/thread`
resource — exposed as a tool so agents can call it by id from
`list_client_tickets` output (the resource stays too).

### 3.2 `clients/{id}/log` resource fix

Becomes a compact recent operational timeline (summary only — detailed
filtering belongs to the tools above):
- Invoices: `GetInvoices` with `orderby=date` (or duedate), `order=desc`
  (server-side, verified).
- Tickets & orders: do NOT assume server-side ordering — fetch a bounded
  window (e.g. limitnum 25) and sort client-side by `lastreply`/`date` desc,
  return top N (10).
- No URI-query filtering (SDK `$`-anchored URI matching is unreliable — Task
  resource-auth finding). Resource stays parameter-free + summary-focused.

### 3.3 Aggregator tools (after base tools are stable)

Composed from base tools + `GetClientsDetails(stats=true)`; read-only;
same annotations:
- `get_account_360` — identity/status/credit + stats counts + recent
  services/domains/invoices/tickets summary.
- `get_billing_snapshot` — unpaid/overdue/paid totals (from stats) + recent
  invoices + balance signals.
- `get_support_snapshot` — open/awaiting tickets (departments) + recent ticket
  list.
- `get_renewal_snapshot` — upcoming service/domain next-due/expiry within a
  window.

### 3.4 Implementation phasing

- **Phase 1:** 6 base read-only tools + `clients/{id}/log` resource fix +
  full TDD + prod verification. Self-contained; shippable on its own.
- **Phase 2:** the 4 aggregator tools (compose Phase 1 tools). Only after
  Phase 1 is stable/verified. Separate plan/commits within the feature cycle.

## 4. Security

- WHMCS prod access remains **read-only**; only `read()` (never `mutate()`).
- Static **action allowlist** of read actions; explicit **write-action
  denylist**: `Add*`, `Update*`, `Delete*`, `Create*`, `CapturePayment`,
  `ApplyCredit`, `AddCredit`, `AddInvoicePayment`, `OpenTicket`,
  `AddTicketReply`, `UpdateTicket`, `Module*`, `DomainRegister`,
  `DomainRenew`, `DomainTransfer`, `SendEmail`, `SendAdminEmail`,
  `TriggerNotificationEvent`, `SetConfigurationValue`, and any
  config/credential/secret actions. Enforced server-side in WhmcsClient
  (not annotation-trust).
- MCP annotations are advisory only; keep server-side `ensureToolAuth`,
  `isToolAllowed`, client-mode scope checks.
- Keep WHMCS API role limited to required read actions; keep IP allowlisting;
  do NOT use `accesskey` to bypass IP allowlist as the normal path.
- If any requested tool could mutate production → stop and ask for explicit
  approval.

## 5. Testing (TDD — failing tests first)

- Normalizer shapes: nested `{x:[...]}`, numeric-keyed objects, plain arrays,
  empty objects, single object, empty arrays — for products/domains/invoices/
  tickets/orders/replies/notes.
- Pagination mapping: `limit`/`offset` → `limitnum`/`limitstart`; `total`/
  `count`/`offset` surfaced.
- `GetClientsDetails` stats=true is sent; defensive parse of root vs
  `client`/`client.stats`.
- Client-mode access denial; auth/allowlist gating; write actions blocked
  (denylist unit test).
- `clients/{id}/log` recent-ordering behavior (client-side sort path).
- Full suite green, build green, no new TypeScript errors.

## 6. Production verification (read-only)

Small limits only; the anchor client unless specified; pipe through `redact.mjs`;
show enough real MCP data to prove correctness (IDs, counts, statuses, dates).
Do not dump addresses, full phones, secrets/credentials/tokens/auth headers/
keys/SMTP creds, or unnecessary private notes. Expected anchors: the anchor client →
3 services, 23 domains, 62 paid invoices, 49 orders, ticket TST01/1001.

## 7. Acceptance criteria

- From a client ID: discover services, domains, invoices, tickets, orders,
  and thread detail without the WHMCS admin UI.
- Account 360 → Billing → Support triage doable via MCP only.
- Outputs contain usable follow-up IDs (serviceid/domainid/invoiceid/
  ticketid/tid/orderid).
- Counts match WHMCS admin where applicable.
- No production data modified; #10/#11 remain fixed (regression suite green).

## 8. Open caveats (documented, accepted)

- `GetTickets(clientid=X)` may not surface operator/admin-created tickets
  (observed for ticket 1001). `list_client_tickets` documents this; reliable
  retrieval is `get_ticket_thread` by known id, or `subject` filter.
- Ticket/order server-side ordering unproven → client-side sort (bounded
  window). Large ticket/order histories beyond the window need explicit
  pagination by the caller.

## 9. Out of scope

Any write/mutation; bypassing IP allowlist; migrating existing deprecated
`tool()` calls to `registerTool` (separate cleanup); the local validation
helpers (`scripts/mcp-demo.mjs`, `redact.mjs`, `shape.mjs`) remain
uncommitted local-only unless separately decided.
