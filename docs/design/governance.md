# Phase B — Policy-Based Integration Governance

> Status: design (B0). This document is the **frozen coordination contract**.
> Tier-1 modules (B1–B4) are built in parallel against `src/governance/types.ts`
> and MUST NOT change the seam without updating this doc + all dependents.

## 1. Why

This MCP is an **integration gateway**, not an LLM-safe chat wrapper. The risk is
not "production data reaches a consumer" — it is "the **wrong** consumer reaches
the **wrong** data". Blunt global redaction breaks dashboards, reconciliation,
renewals, support and portals. Governance solves both: canonical data stays
complete internally; visibility is decided **once, at the output boundary**, from
the authenticated consumer + contract + environment.

## 2. Data flow (the five seams)

```
WHMCS raw
  └─ L1 Transport      WhmcsClient.call (unchanged)
  └─ L2 Canonical      mapToCanonical*()  → typed, COMPLETE domain object
                        + FieldClassMap (path → FieldClass)            [B1]
  └─ L3 Governance     resolveConsumer(token) → ConsumerProfile        [B3]
                        capability(action) → CapabilityStatus           [B4]
  └─ L4 Projection     project(canonical, classMap, contract, env)     [B2]
                        ← THE ONLY place data is dropped/masked/wrapped
  └─ L5 Output         structuredContent (projected) + content (LLM text)
```

**Canonical objects are never mutated.** Business logic / aggregators operate on
canonical. Projection is pure and applied exactly once, last.

## 3. Field classification (B1)

Every canonical field is classified by a static `FieldClassMap` (path → class).
Classes (frozen):

| Class | Examples |
|---|---|
| `business.identifier` | clientid, invoiceid, serviceid, domainid, ticketid, orderid |
| `financial.amount` | total, balance, credit, recurringamount |
| `financial.reference` | transaction id, gateway, payment ref, invoice number |
| `pii.name` | first/last/company name |
| `pii.email` | email |
| `pii.phone` | phone |
| `pii.address` | address1/2, city, state, postcode, country line |
| `pii.tax` | tax id / VAT / GSTIN |
| `pii.custom_field` | client/service custom fields |
| `secret.credential` | passwords, API creds, tokens, keys |
| `untrusted.free_text` | ticket subject/body, replies, notes, client notes |
| `internal.private_note` | admin-only private notes |
| `system.audit` | activity log lines, timestamps of admin actions |
| `public.safe` | status, dates, counts, currency code, booleans |

Unknown / unmapped path ⇒ treated as **restricted** (most conservative), never
silently `public.safe`.

## 4. Data contracts (B2)

A contract is a per-class **action** policy plus metadata:

`action ∈ { allow | mask | drop | wrap_untrusted | summarize }`

- `allow` — emit value as-is.
- `mask` — partial reveal (email `a***@d***`, phone last-4, address city only).
- `drop` — omit the field entirely.
- `wrap_untrusted` — emit as `{ untrusted: true, value }` (LLM-facing) so the
  model treats it as quoted data, never instructions.
- `summarize` — emit a derived summary, not raw (used for free_text to LLM).

Named contracts (frozen set):

| Contract | Intent | secret | untrusted.free_text | pii.* | financial.* | gate |
|---|---|---|---|---|---|---|
| `llm_safe_summary` | LLM chat default | drop | summarize | mask | allow | default for unknown/LLM |
| `ops_operator` | internal human operator | drop | wrap_untrusted | allow | allow | authed consumer |
| `billing_reconciliation` | reconcile payments | drop | drop | mask(name/email allow) | allow | authed |
| `renewal_automation` | renewal workers | drop | drop | allow(email) mask(rest) | allow | authed |
| `support_triage` | support tools | drop | allow (verbatim) | allow | allow | authed |
| `client_portal_self` | portal, own data only | drop | allow | allow (own) | allow | authed + ownership |
| `admin_full_trusted` | admin dashboards | drop | allow | allow | allow | authed + profile-permitted |
| `debug_local` | local debugging | mask | allow | allow | allow | MCP_ENV=local only |
| `none_local_only` | raw, no projection | allow | allow | allow | allow | **HARD-reject unless MCP_ENV=local** |

Rules:
- `secret.credential` is **drop** in every contract except `debug_local`(mask)/
  `none_local_only`(local-only). It is **never** emitted in prod, any contract.
- Projection is resolved from the **authenticated consumer profile**, never from
  a caller-supplied arbitrary contract name.
- A caller cannot obtain `admin_full_trusted` unless its resolved profile lists
  it in `allowedContracts`.
- `none_local_only` and `debug_local` throw if `env !== 'local'`.

## 5. Consumer registry (B3)

Consumer authenticates with a **bearer token** (existing `auth_token` tool param
or transport header). Server hashes it (sha256) and looks it up in an
**env-provided** registry (`MCP_CONSUMER_REGISTRY`, JSON, zod-validated at
startup). Token values/hashes live ONLY in env — never committed. Audit logs
record `consumer_id`, never the token.

`ConsumerProfile`: `{ id, allowedScopes[], defaultContract, allowedContracts[],
allowedActions[] (capability names), writeCapability, envRestrictions[] }`.

`writeCapability ∈ { false | draft_only | approval_required | disabled }` is
**modeled but inert** this engagement — production writes remain disabled by the
existing verified 2-layer block; no write execution path is built.

Anonymous / unknown / bad token:
- `MCP_ENV=production` ⇒ **denied**, unless a deliberate anonymous profile is
  configured (`MCP_ALLOW_ANON_LLM=true` + an `anonymous` registry entry pinned
  to `llm_safe_summary`).
- `MCP_ENV=local|staging` ⇒ fall back to `llm_safe_summary` only if
  `MCP_ALLOW_ANON_LLM=true`; else denied.

Contracts, field-class maps, default scopes, capability defs, output schemas
live in **committed, typed, tested TS**. Only token→profile mapping, enabled
consumers per env, and per-deployment overrides come from env.

## 6. Capability registry (B4)

Per WHMCS action: `status ∈ { supported | unsupported | not_authorized |
unverified | degraded | fallback_available }`.

- Tools/aggregators consult capability **before** calling.
- `unverified` ⇒ a single small read-only **probe** may promote to
  `supported`/`not_authorized`/`unsupported` (cached). No probe ⇒ stays
  `unverified` and the tool returns a structured unavailable status.
- `unsupported`/`not_authorized` ⇒ return structured status, never fake data,
  never broadly expand `READ_ALLOWLIST`.
- Probes are read-only and respect existing `assertReadAction` allowlist; an
  action absent from the allowlist is reported `unsupported` until the allowlist
  is deliberately extended per-tool in Phase C.

## 7. Output design

Governed tools return **both**: `structuredContent` (stable, projected, schema'd)
and human-readable `content` (LLM). `outputSchema` added where practical.

## 8. Test obligations (per the user spec)

canonical complete internally · projection only at boundary · `llm_safe_summary`
isolates secret+untrusted · `billing_reconciliation` keeps txn refs+invoice
fields · `renewal_automation` keeps email/domain/expiry · `support_triage` keeps
ticket content for authorized · `client_portal_self` cannot cross clients ·
`admin_full_trusted` unavailable to untrusted · `none_local_only` rejected in
prod · secrets never exposed in any contract · unsupported capability ⇒
structured status · write actions require scope+approval even if MCP mode
misconfigured.

## 9. Parallelization map

- **B0** (this doc + `types.ts`) — me, serial. Frozen.
- **B1 canonical** `src/canonical/*` — agent, parallel.
- **B2 contracts/projection** `src/governance/contracts.ts`,`projection.ts` — agent, parallel.
- **B3 consumers** `src/governance/consumers.ts` — agent, parallel.
- **B4 capabilities** `src/governance/capabilities.ts` — agent, parallel.
- **B5–B7 integration** (wire `project()` into existing tools/resources) — me, serial.

Tier-1 agents touch **only their own new files** + import from `types.ts`. No
edits to existing `src/tools/*`, `src/resources/*`, `index.ts` (that is B5).
