# Write Capability Probe Runbook (Operator)

> Governed writes. This runbook **verifies** whether a single Track C2 write
> scope behaves correctly on a **disposable dev WHMCS** before an operator
> opts it into production. It does **not** add support, fake success, widen
> the grant beyond the one scope, or touch production. Promotion to prod is a
> separate, reviewed change (see §5).

## 1. Scope — the 13 Track C2 write scopes

Declared in `src/write/types.ts` (`WRITE_SCOPES` + `SCOPE_ACTION` +
`SCOPE_RISK`). All are **sealed deny-by-default** (not on any allowlist).

| write scope | WHMCS action | risk | money? | notes |
|---|---|---|---|---|
| `service:change_package` | `ModuleChangePackage` | medium | no | re-provisions module package; reversible |
| `service:upgrade` | `UpgradeProduct` | **high** | **yes** | creates upgrade order, charges/prorates — **moves money** |
| `domain:idprotect:toggle` | `DomainToggleIdProtect` | low | no | reversible privacy flag |
| `domain:lock:toggle` | `DomainUpdateLockingStatus` | medium | no | unlocking enables outbound transfers (security-relevant) |
| `client:contact:add` | `AddContact` | medium | no | PII create |
| `client:contact:update` | `UpdateContact` | medium | no | PII edit |
| `billing:billable_item:add` | `AddBillableItem` | medium | future | becomes a charge on next invoice run; reversible before invoicing |
| `billing:quote:create` | `CreateQuote` | medium | no | non-binding sales doc |
| `billing:quote:update` | `UpdateQuote` | medium | no | non-binding sales doc |
| `billing:quote:send` | `SendQuote` | low | no | emails the quote |
| `billing:quote:accept` | `AcceptQuote` | **high** | **yes** | **converts quote → invoice** (financial commitment) |
| `ticket:note` | `AddTicketNote` | low | no | internal note |
| `ticket:merge` | `MergeTicket` | medium | no | combines threads; semi-reversible |

**Treat with extra care:** `service:upgrade` (UpgradeProduct) and
`billing:quote:accept` (AcceptQuote) are **high-risk money** scopes — they
raise charges/invoices even on dev. There is no destructive (delete/terminate)
scope in C2; destructive actions remain in `PROD_NEVER_EXECUTABLE` /
`PROD_NEVER_EXECUTABLE_SCOPES` and can never execute in prod.

## 2. Governance model recap (two seals + per-tier friction)

A C2 write reaches WHMCS only when **every** gate below passes. The default
posture denies all of them.

1. **Production keystone seal.** `MCP_PROD_WRITE_AUTHORIZED` is empty by
   default ⇒ every action is prod-sealed (byte-identical to the legacy
   absolute deny). For dev/staging the equivalent runtime allowlist is
   `MCP_WRITE_EXECUTION_AUTHORIZED` (also empty by default).
2. **Per-consumer deny-by-default.** A consumer can use a scope only if that
   scope is in its registry `allowedWriteScopes` **and** its `writeCapability`
   permits execution (`execution_allowed`). Omitting `allowedWriteScopes` ⇒ no
   write scopes; it is **never inferred** from `allowedScopes`/`allowedActions`.
3. **Mode + approval + caps.** MCP mode must not be `read_only`; the intent
   must be `approved`; high-risk (money) scopes additionally require a
   `humanApproval` record and pass the per-action / daily caps
   (`MCP_PROD_HIGH_RISK_PER_ACTION_CAP`, `MCP_PROD_HIGH_RISK_DAILY_CAP`, both
   default `0` ⇒ money denied until set).
4. **Permanent blocks** (`PROD_NEVER_EXECUTABLE` / `_SCOPES`) are checked
   before the allowlist, so an allowlist mistake can never reach a destructive
   action. `MCP_WRITE_KILL_SWITCH=true` seals everything instantly.

The execution authorizer is **deny-by-default**: it returns `allowed:true`
only when all of the above hold.

## 3. SAFETY — never probe against production

- **NEVER** point a write probe at production (`my.securiace.com`) or any
  real licensed install. Use the **local dockerized dev WHMCS only**:
  - WHMCS 9: <http://localhost:8890>
  - WHMCS 8: <http://localhost:8813>
  - Bring-up / seeding / reset commands live in
    `docs/runbooks/local-whmcs-testing.md`.
- **Money scopes really move money on dev too.** `UpgradeProduct`
  (`service:upgrade`) raises an upgrade order + charge; `AcceptQuote`
  (`billing:quote:accept`) raises an invoice. Probe these **only** against
  **throwaway seeded entities** (a scrubbed seed client/service/quote you do
  not care about), never against anything resembling real data.
- Use **synthetic, non-PII** inputs only — no real names, emails, phone
  numbers, or card data. The seed data is already PII-scrubbed
  (`dev+<id>@example.test`); keep it that way.
- One scope at a time. Do not widen the dev grant beyond the single scope
  under test.

## 4. Per-scope probe procedure (on dev WHMCS)

Repeat for **each** scope you intend to verify. Verify exactly one scope per
run; record evidence in the PR.

### (a) Bring up the dev WHMCS

Follow `docs/runbooks/local-whmcs-testing.md`. Typical fresh path:

```bash
npm run whmcs:test:up          # both legs
npm run whmcs:test:ps          # wait for healthy
npm run whmcs:test:reset       # restore the seeded snapshot ("start over")
```

Point the MCP at a leg via `.env.local`
(`WHMCS_API_URL=http://localhost:8890` for WHMCS 9, `:8813` for WHMCS 8;
`MCP_ENV=local`). Verify the API credential works with the `GetStats` curl in
that doc before continuing.

### (b) Grant the single scope to a dev consumer + arm runtime execution

In the dev consumer registry (`MCP_CONSUMER_REGISTRY`, e.g. derived from
`docs/reference/consumer-registry.c2-example.json`), the dev consumer must have:

- the **one** scope under test in `allowedWriteScopes`, and
- `"writeCapability": "execution_allowed"`, and
- `envRestrictions` limited to non-prod (`["local","staging"]`).

Then arm the **non-prod** runtime allowlist with the WHMCS action for that
scope (NOT the prod keystone — leave `MCP_PROD_WRITE_AUTHORIZED` empty):

```bash
# example: probing ticket:note (AddTicketNote) on the local leg
export MCP_ENV=local
export MCP_MODE=full                       # not read_only
export MCP_WRITE_EXECUTION_AUTHORIZED=AddTicketNote
# high-risk money scopes ALSO need caps (and the flow needs a human approval):
#   service:upgrade  → MCP_WRITE_EXECUTION_AUTHORIZED=UpgradeProduct
#   billing:quote:accept → MCP_WRITE_EXECUTION_AUTHORIZED=AcceptQuote
#   export MCP_PROD_HIGH_RISK_PER_ACTION_CAP=<small> MCP_PROD_HIGH_RISK_DAILY_CAP=<small>
```

Set only the action you are probing. The map from scope → action is the
`SCOPE_ACTION` table in §1.

### (c) Run draft → validate → approve → execute

Use the governed write-flow tools (never a direct mutate):

1. `draft_write_intent` — scope + synthetic params against a throwaway seeded
   entity. Returns a `WriteIntent` (`would_call` shows the action + params;
   nothing executes yet).
2. `validate_write_intent` — must return `ok:true` (no `error` issues);
   review `compat_warnings` for WHMCS 8/9 differences.
3. `approve_write_intent` — moves the intent to `approved`. For high-risk
   (money) scopes, supply the human-approval record.
4. `execute_write_intent` — only now does the gated mutation run, and only
   because (b) armed the runtime allowlist on this non-prod leg. A denial
   surfaces as a structured `blocked_reason` (e.g.
   `action_not_runtime_authorized`, `human_approval_required`,
   `amount_cap_exceeded`) — that is the gate working, not a bug.

### (d) Read back the affected entity

Confirm the **actual effect** with a read tool against the same leg (e.g.
`get_ticket_thread` after `ticket:note`, `get_service_details` after
`service:change_package`/`upgrade`, `get_client_details` after a contact
op, `get_invoice`/billing snapshot after `billing:quote:accept`). The
write-flow's own post-action `verified` flag should agree with what you read.

### (e) Record evidence in the PR

Capture, with no real PII:

- the scope + WHMCS action probed, and the leg (8.13 / 9.0),
- the synthetic params sent,
- the entity **before** and **after** (read-back),
- the observed result (`executed:true` + `verified:true`, or the
  `blocked_reason`),
- any `compat_warnings`.

## 5. Promotion to production = a separate reviewed change

Enabling a verified scope in production is its own deliberate, reviewed step —
**operator environment, not code**:

1. Add the WHMCS action to `MCP_PROD_WRITE_AUTHORIZED` (comma list) in the
   **production deployment env**, sourced from the secret/config manager. This
   also **requires** `MCP_WRITE_AUDIT_PATH` to be set (config fails fast
   otherwise — prod mutations must be durably auditable).
2. Grant the scope to the **production** consumer's `allowedWriteScopes` with
   an appropriate `writeCapability` (and `envRestrictions` including
   `production`).
3. For high-risk **money** scopes (`service:upgrade`, `billing:quote:accept`)
   keep the human-approval requirement and set non-zero
   `MCP_PROD_HIGH_RISK_PER_ACTION_CAP` / `MCP_PROD_HIGH_RISK_DAILY_CAP`. They
   stay gated; they are never made one-call.
4. Each scope is promoted on its own, with the §4 dev evidence attached.

Money/destructive scopes stay gated by design. Destructive actions in
`PROD_NEVER_EXECUTABLE` / `PROD_NEVER_EXECUTABLE_SCOPES` are **never**
promotable — adding them to the prod allowlist is rejected at config time.

## 6. Do **not**

- Probe any write scope against production / a real licensed install — dev
  WHMCS (`:8890` / `:8813`) only.
- Run money scopes (`UpgradeProduct`, `AcceptQuote`) against anything but a
  throwaway seeded entity — they move money/raise invoices even on dev.
- Mark a scope verified without a real `executed:true` + `verified:true`
  read-back on the target leg.
- Fake success, stub the effect, or treat a `blocked_reason` as a pass.
- Widen the grant beyond the single scope under test
  (`allowedWriteScopes`/`MCP_WRITE_EXECUTION_AUTHORIZED`).
- Use real PII or card data — synthetic, scrubbed inputs only.
- Set `MCP_PROD_WRITE_AUTHORIZED` (or prod caps) as part of a dev probe — that
  is the §5 production change, not part of verification.
- Commit real bearer tokens — only the lowercase `sha256` hash is ever stored.

---

## Appendix — 2026-06-04 reachability probe (dev WHMCS 9.0.1, localhost:8890)

Run: `npm run mcp:write-probe` (source `.env.local` first). The probe calls each
C2 action with a **non-existent entity id (99999999)** so WHMCS rejects at
entity lookup — **no mutation**. Hard-guarded to a `localhost`/`127.0.0.1`
target with `MCP_ENV != production`. Classifies the response as REACHABLE
(action exists + param shape accepted, rejected at lookup), UNSUPPORTED
(invalid action), or REVIEW.

| Scope | WHMCS action | Verdict | Observation |
|---|---|---|---|
| service:change_package | ModuleChangePackage | ✓ REACHABLE | "Service ID not found" |
| service:upgrade | UpgradeProduct | ✓ REACHABLE | "Service ID Not Found" |
| domain:idprotect:toggle | DomainToggleIdProtect | ✓ REACHABLE | "Domain ID Not Found" |
| domain:lock:toggle | DomainUpdateLockingStatus | ✓ REACHABLE | "Domain ID Not Found" |
| client:contact:add | AddContact | ✓ REACHABLE | "Client ID Not Found" |
| client:contact:update | UpdateContact | ✓ REACHABLE | "Contact ID Not Found" |
| billing:billable_item:add | AddBillableItem | ✓ REACHABLE | "Client ID not Found" |
| billing:quote:create | CreateQuote | ✓ REACHABLE (live call skipped) | see note 1 |
| billing:quote:update | UpdateQuote | ✓ REACHABLE | "Quote ID Not Found" |
| billing:quote:send | SendQuote | ✓ REACHABLE | "Quote ID Not Found" |
| billing:quote:accept | AcceptQuote | ✓ REACHABLE | "Quote ID Not Found" |
| ticket:note | AddTicketNote | ✓ REACHABLE | "Ticket ID not found" |
| ticket:merge | MergeTicket | ? REVIEW | see note 2 |

**Result: 12/13 reachable** — including both high-risk money actions
(`UpgradeProduct`, `AcceptQuote`). Each accepted the governed mapper's exact
param shape and was rejected only at entity lookup.

**Note 1 — CreateQuote is NOT entity-validated.** WHMCS created a quote even for
a non-existent `userid` (the only C2 action that mutates on a bogus id). The
probe therefore **skips** the live `CreateQuote` call (`live: false`) and treats
it as reachable-by-construction — the sibling quote actions confirm the quote
subsystem is API-exposed. (The single orphan quote created during the first
exploratory run was deleted via `DeleteQuote`.) A real `billing:quote:create`
probe must use a **seeded throwaway client** and delete the quote afterward.

**Note 2 — MergeTicket is API-permission-gated.** `MergeTicket` returned
`Invalid Permissions: API action "mergeticket" is not allowed` — it is not in
the default WHMCS API permission set. The scope's mapper/validation are correct,
but it can only execute on an install whose API role explicitly permits
`mergeticket`. Do **not** enable `ticket:merge` in production without first
confirming that permission on the target install (re-run this probe there).

Re-running the probe is side-effect-free (zero mutations); re-verify on the
production-equivalent install's API role before promoting any scope.

### 2026-06-04 — cross-version run (WHMCS 8.13 @ :8813 AND 9.0 @ :8890)

One replicated API credential authenticates on both legs (see
`deploy/whmcs-test/replicate-cred.sh`). The reachability probe was run against
**both** versions:

| | WHMCS 8.13 (:8813) | WHMCS 9.0 (:8890) |
|---|---|---|
| Reachable | 12/13 | 12/13 |
| `ticket:merge` (MergeTicket) | REVIEW — `"API action 'mergeticket' is not allowed"` | REVIEW — same |

**Identical on both versions.** The `MergeTicket` permission gate is therefore
NOT version-specific — it is the default WHMCS API permission set on both 8.13
and 9.0. All 12 other C2 actions (incl. high-risk `UpgradeProduct` /
`AcceptQuote`) are reachable and accept the governed mapper's param shape on
both.

**Full execute + read-back proof (reversible scope).** Beyond reachability, a
complete governed write was exercised live on both legs using the safest
reversible scope `client:contact:add`:

| Step | WHMCS 8.13 | WHMCS 9.0 |
|---|---|---|
| `AddContact` (mapper shape, clientid=1) | success, contactid 116 | success, contactid 116 |
| read-back `GetContacts` | found (CapProbe Cleanup) | found (CapProbe Cleanup) |
| `DeleteContact` (cleanup) | success | success |
| residue after cleanup | 0 | 0 |

This confirms the governed mapper output is not just reachable but actually
executes and reads back correctly on both WHMCS versions, with no residue.

---

## Appendix — 2026-06-04 full read+write deep-drive (both legs)

Beyond the reachability probe, two end-to-end harnesses drive the BUILT MCP
server as a client against the local dev stack, on BOTH legs (WHMCS 9.0 @ :8890,
WHMCS 8.13 @ :8813). Dev-only (localhost-guarded).

- `npm run mcp:deepdrive:reads` — calls every read/aggregator/capability tool.
- `npm run mcp:deepdrive:writes` — arms write execution fully (MCP_MODE=full,
  all actions runtime-authorized, high caps, a consumer cleared for execution +
  granted every write scope) and runs EVERY write scope through
  draft→validate→approve→execute with read-back + cleanup.

### Reads — 44/46 on BOTH legs

2 GATED by design (`get_reconciliation_snapshot`, `list_users`/`GetUsers`).
2 dev API-role gaps (`get_pay_methods`/`GetPayMethods`,
`get_whmcs_details`/`GetWHMCSDetails` → HTTP 403; grant those actions to the
dev API role to clear). All single-entity, list, reference reads + all 13
aggregators returned non-error structured content on both versions.

### Writes — 0 FAIL on BOTH legs

| Leg | EXECUTED | GATE-OK | DESIGN-DENY | FAIL |
|---|---|---|---|---|
| WHMCS 9.0 (:8890) | 16 | 10 | 6 | 0 |
| WHMCS 8.13 (:8813) | 17 | 9 | 6 | 0 |

- **EXECUTED** — gate authorized AND WHMCS performed the write (read-back
  confirmed): client_note, client:update, ticket create/reply*/note/status,
  contact add/update, billable_item*, invoice:create, domain idprotect/lock*/
  nameservers, credit:add/payment:add/credit:apply, quote create/update/send.
- **GATE-OK** — governed path authorized; WHMCS rejected downstream due to the
  DEV environment, not our code: `Module Not Found` (no real provisioning
  server) for service:suspend/unsuspend/change_package; registrar/SMTP/data
  errors for some domain/refund/order/price_restore ops; `AddClient` blocked by
  the dev welcome-email attachment-storage bug (client:create). (Which scopes
  land EXECUTED vs GATE-OK differs by one between 8.13/9.0 — a WHMCS version
  behavior difference, not a defect.)
- **DESIGN-DENY (safety stops firing correctly)** — high-risk WITHOUT a bounding
  amount cap-denied: `billing:payment:capture`, `domain:register`,
  `domain:renew`, `service:upgrade`, `billing:quote:accept`
  (`amount_cap_exceeded`); and `service:terminate`
  (`action_permanently_blocked`).

Notes:
- `domain:transfer` / `domain:release` are NOT in `WRITE_SCOPES` — they exist
  only as defensive strings in `PROD_NEVER_EXECUTABLE_SCOPES`, so they are not
  draftable (`z.enum(WRITE_SCOPES)` rejects them). Intended.
- The write-path **PAN scanner** correctly rejected a draft whose synthetic
  email carried a 13-digit timestamp (credit-card length range) — the guard
  works; test data was shortened.
- Residue on dev: each writes run adds a small account credit to client 1 and a
  cancelled test invoice (`DeleteInvoice` is not a WHMCS API action, so test
  invoices are Cancelled, not deleted). Harmless on the scrubbed dev copy.
