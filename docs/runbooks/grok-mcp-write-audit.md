# Grok MCP write / ops audit (2026-09-12)

Project audit of what Grok can do on WHMCS **8.13.7** versus what still needs
code, API-role grants, or operator infra. Grants alone do not fix mapper or
DSN gaps.

## Stay sealed (by design)

| Item | Why |
|---|---|
| `service:terminate` / `ModuleTerminate` | `PROD_NEVER_EXECUTABLE` + scope block |
| Domain transfer / release | No write scope; `DomainTransfer` / `DomainRelease` never-executable |
| `client:contact:delete` / `DeleteContact` | Never-executable action + destructive phrase gate |
| `DeleteClient`, OAuth-credential CRUD, `ValidateLogin` | Forbidden from the bot |

Do **not** unseal these from chat or a consumer grant.

## Fixed in code (this change)

| Gap | Fix |
|---|---|
| `order:accept` provisioned by default | Mapper always sends `autosetup` + `sendemail`; **default false**. Explicit `true` only when ModuleCreate is intended. Safer than optional-omit (#109). |
| `service:change_package` cannot pick a package | New `service:product:set` (`UpdateClientProduct` `{serviceid,pid}`) then `service:change_package` to push the module. Billed path remains `service:upgrade` (high). |
| No service CF / packageId write | New `service:customfields:update` (`{serviceid, customfields:{id:value}}` → WHMCS base64 PHP-serialize). |
| Grok playbook named retired tools | Playbook rewritten: jobs first, governed writes only, sealed list. |
| Doctor silent on write posture | `mcp_doctor.grok_write` lists sealed, package path, merge, DSN, high-risk ceremony. |

## Still needs infra / role (not a mapper bug)

| Gap | What to do |
|---|---|
| `ticket:merge` / `MergeTicket` | Mapper + validation exist. Production API role must allow **`mergeticket`**. Do not execute merge to “test” prod. |
| `service:transfer_owner` / `billing:invoice:reassign` | Direct-DB. Set `MCP_WHMCS_DB_*` (host/user/name; password in secrets). High-risk + distinct approver. |
| High-risk money writes | Distinct approver ≠ drafter. Caps + prod allowlist. |
| Operator backups | Live **outside this repo** (local secret directory / env backups). Never commit them. |
| Customer invoice/ticket APIs | Unproven on 8.13.7 — customer `ops_ask` stays link/handoff. |
| Access-token JWT vs opaque | Phase 0 **PENDING** (no PKCE in this environment). |

## Grok job path

Staff: `ops_ask` + Admin API machine credential + staff allow-list.
Customer: OIDC link in the browser; WhatsApp bind outside this MCP.
HTTP: federation AS mints `aud=MCP_OAUTH_RESOURCE`. WHMCS Bearer is rejected.

## Related PRs

- #108 — standards RS + 8.13.7 jobs (this branch).
- #109 — optional `order:accept` flags (omit = WHMCS default **true**). Prefer
  the Grok-safe default-false mapper on this branch.
