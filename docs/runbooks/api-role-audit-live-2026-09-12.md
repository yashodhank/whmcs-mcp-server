# Live API-role audit — 2026-09-12

Companion to [auth-layers-whmcs-vs-mcp.md](./auth-layers-whmcs-vs-mcp.md).

**Credential:** API Admin (`adminid` 8), identifier prefix `eALWGk…qgT7`.
**Notes field:** WHMPress / WordPress sync admin (created 2016-12-24).
**Method:** production Admin API over IPv4 with impossible entity IDs (999999001). Business errors ⇒ permission present; `Invalid Permissions` ⇒ role gap. No real rows mutated.
**Admin UI permissions:** extremely broad (includes API Access, Manage Quotes, Manage Billable Items, Edit Services/Domains, etc.).

## Summary

- **40/45** granted write scopes: Admin API role allows the mapped action.
- **1** denied by API role.
- **1** mapped to a non-existent WHMCS API action.
- **3** not Admin-API (custom / DB-direct).

## Gaps

### 1. `ticket:merge` → `MergeTicket` — DENIED

Live: `Invalid Permissions: API action "mergeticket" is not allowed`.
Fix: enable MergeTicket on this API credential role in WHMCS, **or** remove `ticket:merge` from operator-reconcile / `MCP_PROD_WRITE_AUTHORIZED` until then.

### 2. `billing:billable_item:update` → `UpdateBillableItem` — INVALID ACTION

Live: `Invalid API Action: "updatebillableitem" is not a valid API action`.
`AddBillableItem` works (role OK). Update path needs a different design (or drop the scope).

### 3. Non-Admin-API scopes (infrastructure, not role)

| Scope | Path | Status |
|---|---|---|
| `billing:credit:transfer` | `CREDIT_TRANSFER_ACTION` | custom — confirm executor |
| `service:transfer_owner` | `DB_DIRECT_ACTION` | needs DB DSN |
| `billing:invoice:reassign` | `DB_DIRECT_ACTION` | needs DB DSN |

### 4. Read gap (not a write scope)

`WhmcsDetails` denied — use `GetAdminDetails` / `GetCurrencies` (already in connector guidance).

## Full matrix

| Scope | Action | Result | Evidence |
|---|---|---|---|
| `client_note:write` | `AddClientNote` | ALLOWED | Client ID not found |
| `ticket:create` | `OpenTicket` | ALLOWED | Client ID Not Found |
| `ticket:reply` | `AddTicketReply` | ALLOWED | Ticket ID Not Found |
| `ticket:status` | `UpdateTicket` | ALLOWED | Ticket ID Not Found |
| `ticket:note` | `AddTicketNote` | ALLOWED | Ticket ID not found |
| `ticket:merge` | `MergeTicket` | DENIED | Invalid Permissions: API action "mergeticket" is not allowed |
| `billing:invoice:create` | `CreateInvoice` | ALLOWED | Client ID Not Found |
| `billing:invoice:update` | `UpdateInvoice` | ALLOWED | Invoice ID Not Found |
| `billing:billable_item:add` | `AddBillableItem` | ALLOWED | Client ID not Found |
| `billing:billable_item:update` | `UpdateBillableItem` | INVALID_ACTION | Invalid API Action: "updatebillableitem" is not a valid API action |
| `billing:quote:create` | `CreateQuote` | ALLOWED | Invalid Stage |
| `billing:quote:update` | `UpdateQuote` | ALLOWED | Quote ID Not Found |
| `billing:quote:send` | `SendQuote` | ALLOWED | Quote ID Not Found |
| `client:create` | `AddClient` | ALLOWED | The email address you entered was not valid |
| `client:update` | `UpdateClient` | ALLOWED | Client ID Not Found |
| `client:contact:add` | `AddContact` | ALLOWED | Client ID Not Found |
| `client:contact:update` | `UpdateContact` | ALLOWED | Contact ID Not Found |
| `client:close` | `CloseClient` | ALLOWED | Client ID Not Found |
| `service:suspend` | `ModuleSuspend` | ALLOWED | Service ID not found |
| `service:unsuspend` | `ModuleUnsuspend` | ALLOWED | Service ID not found |
| `service:domain_rename` | `UpdateClientProduct` | ALLOWED | Service ID Not Found |
| `service:change_package` | `ModuleChangePackage` | ALLOWED | Service ID not found |
| `domain:nameservers:update` | `DomainUpdateNameservers` | ALLOWED | Domain ID Not Found |
| `domain:lock:toggle` | `DomainUpdateLockingStatus` | ALLOWED | Domain ID Not Found |
| `domain:idprotect:toggle` | `DomainToggleIdProtect` | ALLOWED | Domain ID Not Found |
| `domain:record:update` | `UpdateClientDomain` | ALLOWED | Domain ID Not Found |
| `domain:epp:request` | `DomainRequestEPP` | ALLOWED | Domain ID Not Found |
| `order:accept` | `AcceptOrder` | ALLOWED | Order ID not found or Status not Pending |
| `order:cancel` | `CancelOrder` | ALLOWED | Order ID not found or Status not Pending |
| `order:pending` | `PendingOrder` | ALLOWED | Order ID Not Found |
| `support:cancel_request:add` | `AddCancelRequest` | ALLOWED | Service ID Not Found |
| `billing:payment:add` | `AddInvoicePayment` | ALLOWED | Invoice ID Not Found |
| `billing:payment:capture` | `CapturePayment` | ALLOWED | Invoice Not Found or Not Unpaid |
| `billing:credit:add` | `AddCredit` | ALLOWED | Client ID Not Found |
| `billing:credit:apply` | `ApplyCredit` | ALLOWED | Invoice ID Not Found |
| `billing:credit:transfer` | `CREDIT_TRANSFER (custom)` | SPECIAL | CREDIT_TRANSFER (custom) |
| `billing:refund:record` | `AddTransaction` | ALLOWED | Invoice ID Not Found |
| `billing:quote:accept` | `AcceptQuote` | ALLOWED | Quote ID Not Found |
| `domain:register` | `DomainRegister` | ALLOWED | Domain Not Found |
| `domain:renew` | `DomainRenew` | ALLOWED | Domain Not Found |
| `order:create` | `AddOrder` | ALLOWED | Client ID Not Found |
| `service:upgrade` | `UpgradeProduct` | ALLOWED | Service ID Not Found |
| `service:price_restore` | `UpdateClientProduct` | ALLOWED | Service ID Not Found |
| `service:transfer_owner` | `DB_DIRECT (needs DSN)` | SPECIAL | DB_DIRECT (needs DSN) |
| `billing:invoice:reassign` | `DB_DIRECT (needs DSN)` | SPECIAL | DB_DIRECT (needs DSN) |
