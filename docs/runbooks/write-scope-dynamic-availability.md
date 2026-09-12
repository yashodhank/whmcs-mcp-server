# Write-scope dynamic availability

> **Date:** 2026-09-12
> **Context:** [api-role-audit-live-2026-09-12.md](./api-role-audit-live-2026-09-12.md)

## Principle

Write scopes are **never removed** from consumer grants, env allowlists, or
`MCP_PROD_WRITE_AUTHORIZED` based on API availability. Instead, availability
is surfaced **dynamically** through the `list_write_scope_availability` tool
and the `get_capability_matrix` `write_scope_availability_summary` section.

## How it works

1. **Static catalog** (`src/write/actionAvailability.ts`) tags each
   `WriteScope` → WHMCS action with:
   - `api_surface`: `admin_api` | `custom` | `db_direct` | `none`
   - `whmcs_api_exists`: false for `UpdateBillableItem`
   - `unavailable_on`: version families (e.g. `['9.x']` for invoice update)
   - `note`: distinguishes role vs version vs missing-API vs needs-DB-DSN

2. **Dynamic resolver** combines the static catalog with the live WHMCS
   version (via `getWhmcsVersionProfile`) to produce per-scope availability:
   `executable` | `missing_api` | `version_gated` | `needs_infra`

3. **Tools**:
   - `list_write_scope_availability` — full matrix with grant status + availability
   - `get_capability_matrix` — now includes `write_scope_availability_summary`

## Known gaps (2026-09-12, WHMCS 8.13.7)

| Scope | Status | Type |
|---|---|---|
| `billing:billable_item:update` → `UpdateBillableItem` | `missing_api` | Not a WHMCS API action (any version) |
| `ticket:merge` → `MergeTicket` | `executable` (role gap separate) | API exists but commonly role-denied |
| `billing:invoice:update` → `UpdateInvoice` | `version_gated` on 9.x | Immutable non-draft invoices |
| `billing:credit:transfer` | `needs_infra` | Custom executor, not Admin API |
| `service:transfer_owner`, `billing:invoice:reassign` | `needs_infra` | DB-direct, needs DSN |

## Role vs availability

`list_write_scope_availability` reports **API availability**, not role
permission. A scope marked `executable` may still fail at runtime if the API
credential role denies the action (e.g. `ticket:merge` / `MergeTicket`).
Role probing is a separate concern — the tool notes this distinction.

A future enhancement could add a safe "impossible ID" write-probe cache that
promotes `role_unknown` → `role_denied` / `executable` based on the error
classification (`Invalid Permissions` vs business error). This is out of scope
for v1 — static catalog + version probe is sufficient.

## Version probe hardening

`getWhmcsVersionProfile` now probes in order:
1. `WhmcsDetails` (preferred but often role-denied)
2. `GetAdminDetails` → `whmcs.version` (works on 8.13.7 prod)
3. `GetConfigurationValue(Version)` (most-permissive fallback)

## See also

- [api-role-audit-live-2026-09-12.md](./api-role-audit-live-2026-09-12.md)
- [docs/reference/whmcs-api-catalog-prompt.md](../reference/whmcs-api-catalog-prompt.md)
- [docs/reference/whmcs9-credit-debit-notes.md](../reference/whmcs9-credit-debit-notes.md)
