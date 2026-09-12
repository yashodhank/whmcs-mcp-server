# Auth layers: WHMCS Admin API vs WHMCS OpenID/OAuth vs MCP OAuth

**Audience:** operators and agents working in this repo (especially Grok Bot / stdio).
**Status:** canonical clarification (2026-09-12). Read this before proposing “switch MCP to WHMCS OAuth.”
**Related:** [grokbot-stdio-access.md](./grokbot-stdio-access.md), [design/oauth.md](../design/oauth.md), [production-governed-writes.md](./production-governed-writes.md), [api-connectivity-troubleshooting.md](./api-connectivity-troubleshooting.md).

---

## TL;DR

| Layer | What it authenticates | Use for Grok Bot admin ops? |
|---|---|---|
| **WHMCS Admin API Credentials** (`identifier` + `secret`) | MCP → `includes/api.php` (admin API) | **Yes — required** |
| **WHMCS OpenID Connect / OAuth apps** (`CreateOAuthCredential`, client-area SSO) | End-user apps / client-area identity & SSO | **No — cannot replace admin API** |
| **MCP consumer bearer** (registry token, e.g. `operator-reconcile`) | Grok Bot → MCP governance | **Yes — required for governed tools** |
| **MCP OAuth 2.1 resource server** ([design/oauth.md](../design/oauth.md)) | HTTP MCP clients ↔ MCP (IdP JWTs) | **Future / HTTP only** — not stdio today |

**Do not** try to replace `WHMCS_IDENTIFIER` / `WHMCS_SECRET` with WHMCS OpenID access tokens for AcceptOrder, AddInvoicePayment, GetInvoices, etc. WHMCS documents admin API auth as API Credentials (or legacy admin username + MD5 password) — not OpenID bearer tokens.

---

## Architecture (current Grok Bot path)

```
Grok Bot (trusted local)
  └─ stdio ─▶ WHMCS MCP Server
                 ├─ Consumer identity: operator-reconcile
                 │     (MCP_DEFAULT_CONSUMER_AUTH_TOKEN or per-call auth_token)
                 ├─ Governance: contracts, write scopes, audit, caps
                 └─ WHMCS HTTPS API
                       WHMCS_API_URL + WHMCS_IDENTIFIER + WHMCS_SECRET
                       + APIAllowedIPs (dokploy IP heal)
```

Official WHMCS admin API auth: [Authentication](https://developers.whmcs.com/api/authentication/) and [API Credentials](https://docs.whmcs.com/9-0/system/authentication/api-credentials/).

---

## Layer A — WHMCS Admin API Credentials (identifier / secret)

### What it is

- Created in Admin: **Configuration → System Settings → Manage API Credentials**.
- Bound to an **admin user** + one or more **API roles** (allowed actions).
- Sent on every `includes/api.php` call as `identifier` + `secret` (or legacy `username`/`password` fields carrying the same pair).
- Independent of the admin’s interactive login password (password changes do not invalidate API credentials).

### Why MCP uses this

Grok Bot needs **admin** operations: invoices, orders, services, tickets, payments, AcceptOrder, etc. Those are WHMCS **Admin API** actions. The supported credential for that surface is Admin API Credentials.

### Ops notes for this install

- Env: `WHMCS_API_URL`, `WHMCS_IDENTIFIER`, `WHMCS_SECRET` (typically `.env.production` on the Mac MCP host).
- IP allowlist: `APIAllowedIPs`; Mac healer `scripts/whmcs-ip-updater/dokploy/dokploy_ip_heal.sh` (`WHMCS_HEAL_MODE=dokploy`, `WHMCS_HEAL_EXTRA_IPS` may include Grok Bot egress).
- Prefer fixing **Invalid Permissions** by adjusting the API **role**, not by switching to OAuth.
- Prefer fixing **Invalid IP** via the healer, not by widening credentials.

---

## Layer B — WHMCS OpenID Connect / OAuth apps

### What it is

- OpenID Connect apps / OAuth client credentials (`authorization_code`, `single_sign_on`).
- Provisioned via Admin **OpenID Connect** UI or API helpers (`ListOAuthCredentials`, `CreateOAuthCredential`, …).
- Typical flow: user authorizes app → code → access token → client-area / userinfo / SSO style access.
- Docs: [OAuth auth workflow](https://developers.whmcs.com/oauth/auth-workflow/), [OpenID Connect development](https://docs.whmcs.com/9-0/system/authentication/openid-connect-development/).

### What it is not

- **Not** the credential type WHMCS documents for authenticating Admin API `action=GetInvoices` / `AcceptOrder` / `AddInvoicePayment` calls.
- **Not** a substitute for Layer A in this MCP server’s WHMCS client.

### MCP posture

`CreateOAuthCredential`, `UpdateOAuthCredential`, `DeleteOAuthCredential` (and related security actions) are in **`PROD_NEVER_EXECUTABLE`**. Agents must not attempt to manage WHMCS OAuth clients through governed writes.

### When Layer B *is* appropriate

- Building a **client-area** “Connect to WHMCS” app.
- **SSO** into client area / application links.
- Admin **browser** SSO (separate product config) — still unrelated to MCP → Admin API.

---

## Layer C — MCP consumer bearer (registry)

### What it is

- SHA-256-hashed tokens in `MCP_CONSUMER_REGISTRY_FILE` (e.g. `~/.config/whmcs-mcp/consumer-registry.production.json`).
- Profiles such as `operator-reconcile` / `operator-approver` carry `allowedActions`, `allowedWriteScopes`, `writeCapability`, contracts.
- Stdio may auto-inject `MCP_DEFAULT_CONSUMER_AUTH_TOKEN` when the caller omits `auth_token` ([grokbot-stdio-access.md](./grokbot-stdio-access.md)).

### Why it exists alongside Layer A

| Concern | Layer A (WHMCS) | Layer C (MCP) |
|---|---|---|
| Who may call WHMCS API at all | Admin API credential + role + IP | — |
| Which MCP tools / write scopes an agent may use | — | Consumer registry |
| Approvals, caps, audit, sealed destructives | — | Write engine / execution gate |

Both are required for production governed ops. Layer C never replaces Layer A.

### Grok Bot write pack (as of 2026-09-12)

- **~45 write scopes** granted on `operator-reconcile` + `operator-approver`, mirrored into `MCP_PROD_WRITE_AUTHORIZED`.
- **Still sealed:** `service:terminate`, domain transfer/release, `client:contact:delete` (and other `PROD_NEVER_*` actions).
- **`order:accept`:** mapper always sends `autosetup` + `sendemail`, default **false** (Grok-safe; #109 omit-to-WHMCS-default was absorbed then superseded). Pass `autosetup: true` / `sendemail: true` only when ModuleCreate / Welcome Email are intended.

---

## Layer D — MCP OAuth 2.1 resource server (roadmap)

Documented in [design/oauth.md](../design/oauth.md). Summary:

- Applies to **HTTP** MCP transports (PRM + JWKS JWT validation + scope mapping → `ConsumerProfile`).
- **Stdio is out of scope** for MCP OAuth; stdio keeps env / registry bearer.
- Even after HTTP OAuth ships, the server still uses **Layer A** to talk to WHMCS.
- Status: **design / phased**; HTTP baseline today is bearer-bridge to the same consumer registry.

---

## Decision guide for agents

1. **Need invoices / orders / tickets / payments / AcceptOrder?** → Layer A + Layer C. Never Layer B.
2. **User said “use OAuth for MCP”?** → Clarify: MCP **HTTP client** OAuth (Layer D, future) vs WHMCS OpenID (Layer B, wrong for admin API). Keep Layer A.
3. **403 Invalid IP?** → Heal allowlist; do not rotate into OAuth.
4. **403 Invalid Permissions?** → Expand WHMCS **API role** actions (see checklist below); do not invent OAuth.
5. **Create/update WHMCS OAuth client via MCP write?** → Refuse; permanently blocked.

---

## Next step 1 — Audit API role vs granted MCP write scopes

**Goal:** Every WHMCS action behind an enabled MCP write scope must be allowed on the Admin API credential’s role(s). MCP grants alone cannot override WHMCS API roles.

### How to audit (operator)

1. Admin → **Configuration → System Settings → Manage API Credentials**.
2. Open the credential used by `WHMCS_IDENTIFIER` (description should identify MCP / Grok Bot).
3. Note assigned **API role(s)** → edit role → allowed API actions.
4. Compare to the **WHMCS action** column below. Missing actions → add to role (least privilege: only what you need).
5. Re-test with a read or draft-only probe; treat permission 403s as role gaps (not IP).

Optional automated aid: runbooks [write-capability-probe.md](./write-capability-probe.md) / [capability-probe.md](./capability-probe.md).

### Granted write scopes → WHMCS actions (reconcile checklist)

| MCP write scope | WHMCS action | Risk |
|---|---|---|
| `client_note:write` | `AddClientNote` | low |
| `ticket:create` | `OpenTicket` | low |
| `ticket:reply` | `AddTicketReply` | low |
| `ticket:status` | `UpdateTicket` | medium |
| `ticket:note` | `AddTicketNote` | low |
| `ticket:merge` | `MergeTicket` | medium — often **missing** from default API roles; probe before relying |
| `billing:invoice:create` | `CreateInvoice` | medium |
| `billing:invoice:update` | `UpdateInvoice` | medium |
| `billing:billable_item:add` | `AddBillableItem` | medium |
| `billing:billable_item:update` | `UpdateBillableItem` | medium |
| `billing:quote:create` | `CreateQuote` | medium |
| `billing:quote:update` | `UpdateQuote` | medium |
| `billing:quote:send` | `SendQuote` | low |
| `billing:quote:accept` | `AcceptQuote` | high |
| `billing:payment:add` | `AddInvoicePayment` | high |
| `billing:payment:capture` | `CapturePayment` | high |
| `billing:credit:add` | `AddCredit` | high |
| `billing:credit:apply` | `ApplyCredit` | high |
| `billing:credit:transfer` | composite / credit-transfer executor | high |
| `billing:refund:record` | `AddTransaction` | high |
| `billing:invoice:reassign` | direct-DB (`__db_direct__`) | high — needs opt-in DSN |
| `client:create` | `AddClient` | medium |
| `client:update` | `UpdateClient` | medium |
| `client:contact:add` | `AddContact` | medium |
| `client:contact:update` | `UpdateContact` | medium |
| `client:close` | `CloseClient` | medium |
| `service:suspend` | `ModuleSuspend` | medium |
| `service:unsuspend` | `ModuleUnsuspend` | medium |
| `service:domain_rename` | `UpdateClientProduct` | medium |
| `service:change_package` | `ModuleChangePackage` | medium — mapper is serviceid-only |
| `service:upgrade` | `UpgradeProduct` | high |
| `service:price_restore` | `UpdateClientProduct` | high |
| `service:transfer_owner` | direct-DB (`__db_direct__`) | high — needs opt-in DSN |
| `domain:nameservers:update` | `DomainUpdateNameservers` | medium |
| `domain:lock:toggle` | `DomainUpdateLockingStatus` | medium |
| `domain:idprotect:toggle` | `DomainToggleIdProtect` | low |
| `domain:record:update` | `UpdateClientDomain` | medium |
| `domain:epp:request` | `DomainRequestEPP` | low |
| `domain:register` | `DomainRegister` | high |
| `domain:renew` | `DomainRenew` | high |
| `order:accept` | `AcceptOrder` | medium — optional `autosetup`/`sendemail` booleans only |
| `order:create` | `AddOrder` | high |
| `order:cancel` | `CancelOrder` | medium |
| `order:pending` | `PendingOrder` | medium |
| `support:cancel_request:add` | `AddCancelRequest` | medium |

Also ensure common **reads** used by briefs/snapshots remain on the role (e.g. `GetInvoices`, `GetClientsProducts`, `GetClientsDetails`, `GetTickets`, `GetCurrencies`, …).

### Known non-role blockers (do not “fix” with OAuth)

- No MCP write scope for **service custom fields** (`packageId` / `friendlyname`).
- `service:change_package` cannot select target package via MCP mapper.
- Owner transfer / invoice reassign need **direct-DB DSN**, not API OAuth.
- Destructives (`ModuleTerminate`, etc.) stay never-executable in prod by design.

---

## Next step 2 — Rotate secrets checklist (API credential + MCP consumers)

Use when credentials leak, staff leave, or routine rotation is due. **Do not** rotate by migrating to WHMCS OpenID.

### A. WHMCS Admin API credential

1. Admin → Manage API Credentials → generate **new** credential for the same (or dedicated) admin + same API roles.
2. Copy **identifier** + **secret** once; store in secret manager / Mac keychain.
3. Update Mac MCP env (`.env.production` or process manager env): `WHMCS_IDENTIFIER`, `WHMCS_SECRET`.
4. Restart MCP stdio process / Grok Bot WHMCS connector (`RestartMcpServers` or host equivalent).
5. Smoke: `GetCurrencies` (or MCP `get_currencies`) from the Mac; confirm not Invalid IP / Invalid Permissions.
6. Delete the **old** API credential pair in WHMCS.
7. Record rotation in operator notes (date, who, credential description) — never paste secrets into chat/git.

### B. MCP consumer tokens (operator-reconcile / approver)

1. Generate new high-entropy bearer tokens; compute SHA-256 for registry entries.
2. Update `MCP_CONSUMER_REGISTRY_FILE` hashes for `operator-reconcile` / `operator-approver`.
3. Update `MCP_DEFAULT_CONSUMER_AUTH_TOKEN` / `_FILE` and approver token env/files.
4. Update any Grok Bot / box copies of consumer tokens (e.g. `/home/box/mcp/whmcs-consumer.token`) **without** committing secrets.
5. Restart MCP; smoke a governed read and a **draft-only** write if needed.
6. Invalidate old tokens (remove old hashes); confirm old token fails.

### C. After rotation

- Confirm `MCP_PROD_WRITE_AUTHORIZED` and registry `allowedWriteScopes` unchanged (rotation ≠ scope change).
- Confirm IP heal still healthy.
- Do **not** commit `.env.production`, raw tokens, or API secrets.

---

## Common confusion cheat-sheet

| Phrase someone says | What they usually mean | Correct action |
|---|---|---|
| “Use WHMCS OAuth for MCP” | Layer B for admin API | Explain Layer A; keep identifier/secret |
| “OAuth for MCP clients” | Layer D (HTTP MCP RS) | Point to design/oauth.md; stdio unchanged |
| “Update admin OAuth” | Layer B OpenID app or admin SSO | Out of band from MCP Admin API |
| “API login” | Layer A | Manage API Credentials |
| “MCP auth token” | Layer C | Consumer registry |

---

## Revision history

| Date (IST context) | Change |
|---|---|
| 2026-09-12 | Initial runbook: three/four-layer clarification, role-audit table for Grok Bot 45-scope pack, rotation checklists. |


## Related

- Live probe (2026-09-12): [api-role-audit-live-2026-09-12.md](./api-role-audit-live-2026-09-12.md)
