# WHMCS MCP Server — AI Agent Handoff Prompt

> Paste this whole file as the opening context for another AI coding agent that
> will work on this repository. It describes what the project is, how it is
> built, the invariants you must not break, and how to extend it safely.

---

## Your role

You are a senior engineer working on the **WHMCS MCP Server** — a Model Context
Protocol (MCP) server that exposes a WHMCS billing/hosting install to AI agents
and apps as governed, projection-safe tools and resources. The codebase is
mature and security-sensitive (it can read PII/financial data and, when armed,
mutate billing). Prefer surgical, well-tested changes that respect the existing
seams. When in doubt about a production write, a destructive action, secrets, or
an unclear safety classification: STOP and ask.

## What the project is

- **Language/stack:** TypeScript, ESM, Node. MCP TypeScript SDK ~1.29 (spec rev
  2025-11-25). Build with `tsup` → `dist/index.js`. Tests with `vitest`. Lint
  with ESLint (`eslint src/ tests/`), types with `tsc --noEmit`.
- **Transports:** stdio (default) and Streamable HTTP. HTTP adds session
  management, Origin/DNS-rebinding guard, session-owner binding, and an optional
  OAuth 2.1 resource-server mode (PRM/RFC 9728 + JWT verify via `jose`).
- **What it talks to:** the WHMCS External API (`/includes/api.php`), ~150
  actions across ~17 categories. The server reaches ~60 of them today (see
  Coverage below).
- **Module-import convention:** NodeNext — TS source imports use `.js`
  specifiers (e.g. `import { x } from './foo.js'`) even though the file is
  `foo.ts`.

## Architecture — the read path

1. **Action policy** (`src/whmcs/actionPolicy.ts`) — `READ_ALLOWLIST`. The read
   client (`assertReadAction`) rejects any non-allowlisted action. There are
   `WRITE_DENY_*` guards so a write action name can't sneak through the read
   path.
2. **Canonical mappers** (`src/canonical/*`) — normalize raw WHMCS responses
   into stable canonical shapes and assign a **FieldClass** to every field path
   (e.g. `pii.email`, `financial.amount`, `secret.credential`, `public.safe`).
3. **Field-class projection** (`src/governance/projection.ts`) — `project()` /
   `projectWithTrace()` walk the canonical tree **recursively** and, per the
   consumer's contract, allow / mask / drop / wrap / summarize each field.
   Unmapped leaves are dropped; classified containers are gated (allow recurses,
   non-allow drops the whole subtree). `secret.credential` is dropped in all
   non-local contracts (this is how raw card/bank/token data never leaks).
4. **Contracts / consumers** (`src/governance/{contracts,consumers,types}.ts`) —
   each consumer (registry bearer or OAuth claims) maps to a `ContractName`
   (e.g. `ops_operator`, `billing_reconciliation`, `llm_safe_summary`,
   `admin_full_trusted`). The contract decides projection behavior.
5. **Tools/resources** — `src/tools/*` register read tools, aggregators,
   capability shells; `src/resources/*` mirror resources. Output goes through
   the projection boundary when `MCP_GOVERNANCE_ENABLED=true` (OFF ⇒
   byte-identical legacy output, for backward-compat).

**Capability shells + probe/promote:** some reads are declared `unverified` in
`src/governance/capabilities.ts` (`UNVERIFIED_READS`). They return a structured
`capability_unavailable` payload instead of fabricating data. Promotion to
`SUPPORTED_READS` is a deliberate reviewed change after a real probe returns
`supported` on the target install (see `docs/runbooks/capability-probe.md`).

## Architecture — the governed write path (tiered friction)

All mutations flow through ONE governed model. There are **no** direct
`whmcs.mutate()` write tools by default (legacy ones are retired behind
`MCP_ENABLE_LEGACY_WRITE_TOOLS`).

- **Flow:** `draft_write_intent` → `validate_write_intent` → `approve_write_intent`
  → `execute_write_intent` (tools in `src/tools/writeFlow.ts`). A write *intent*
  is a pure, non-executing description; nothing hits WHMCS until execute.
- **The frozen seam** (`src/write/types.ts`): every scope is one entry in
  `WRITE_SCOPES` + `SCOPE_ACTION` (→ WHMCS action) + `SCOPE_RISK`
  (low/medium/high). `z.enum(WRITE_SCOPES)` auto-exposes new scopes through the
  flow; `src/auth/scopes.ts` derives the coarse OAuth scope from the risk tier
  automatically.
- **Validation** (`src/write/validation.ts`): `REQUIRED_PARAMS` per scope + a
  per-scope custom validator block. Intent params use SEMANTIC names; the mapper
  bridges to WHMCS field names. The validator also invokes the mapper in a
  try/catch so structural mapping errors surface at validate time.
- **Param mapping** (`src/write/paramMapping.ts`): one **strict** mapper per
  scope. Strict = emit only a fixed/allowlisted key set; drop everything else
  (defense in depth — a malformed/over-broad intent can never leak an
  unintended field into a high-impact WHMCS action). A `switch` dispatcher has a
  `never` exhaustiveness guard, so adding a `WriteScope` is a typescript-checked
  obligation to add a mapper.
- **Execution gate** (`src/write/executionGate.ts`) — DENY-BY-DEFAULT, risk-tiered:
  - Universal gates (all tiers): kill switch off, mode ≠ `read_only`, intent
    approved, consumer `execution_allowed`, no idempotency replay, action/scope
    not permanently blocked.
  - LOW/MEDIUM: audit-gated — execute once the universal gates pass; NO
    per-action allowlist (low-friction path for ordinary work).
  - HIGH-RISK (money + destructive): FULL gate — per-environment allowlist +
    human approval record + monetary caps + amount context.
  - **KEYSTONE:** with no env configured (empty `MCP_PROD_WRITE_AUTHORIZED`,
    zero caps), high-risk production is 100% sealed. A high-risk request can only
    ever reach `action_not_prod_authorized` (or an earlier denial).
  - **Permanent blocks:** `PROD_NEVER_EXECUTABLE` (action-keyed) and
    `PROD_NEVER_EXECUTABLE_SCOPES` (scope-keyed) — e.g. `ModuleTerminate`,
    `DomainTransfer`, `DomainRelease`, all `Delete*`, admin/config/credential
    mutations. Checked BEFORE any allowlist, in EVERY env (even local).
- **Idempotency + audit:** idempotency key = `consumer|action|scope|naturalKey|window`;
  durable JSONL audit + idempotency ledger when their paths are configured.
- **Money safety:** the refund mapper NEVER sets `amountin` (phantom-revenue
  guard); transids are deterministic from the idempotency key (retry-safe).
- **PAN scanner:** write input is scanned for credit-card numbers (Luhn,
  13–19 digits); a detected PAN rejects the draft. Never send raw card data
  through any tool.

## Coverage today (~60 of ~150 WHMCS actions)

Well-covered: client read/create/update + contacts, full billing reads + most
billing writes (invoice/payment/credit/refund/transactions/billable-item +
quotes create/update/send/accept), service lifecycle (suspend/unsuspend/
terminate/upgrade/change-package), domain ops (register/renew/nameservers/
idprotect/lock + whois/tld/registrars reads), tickets (read + open/reply/note/
status/merge), orders (read + accept), servers (GetServers/GetHealthStatus),
system refs (stats/activity/automation/todos/currencies/payment-methods).

Notable still-missing (see `docs/` coverage notes for the full matrix):
- Reads: `DomainGetNameservers/LockingStatus/WhoisInfo`, `GetTicketNotes`,
  `GetTicketPredefinedReplies/Cats`, `GetOrderStatuses`, `GetPromotions`,
  `GetEmailTemplates`, `GetStaffOnline`, `GetAdminUsers`.
- Writes: `UpdateInvoice`, `GenInvoices`, `AddPayMethod`, `ModuleChangePw`,
  `DomainRequestEPP`, `UpdateClientDomain`, `AddCancelRequest`, order
  create/cancel/pending, `DeleteContact`.
- Whole modules absent: **Project Management**, **Users/permissions**,
  **Affiliates**, product **Addons**.

Deliberately excluded (do NOT add): all `Delete*`, `GetClientPassword`,
`DomainTransfer`/`DomainRelease` (permanently blocked), Auth/SSO/OAuth-credential
CRUD, live `SetConfigurationValue`/`SendEmail`.

## How to extend

**Add a READ tool** (shell → probe → promote):
1. Allowlist the action in `src/whmcs/actionPolicy.ts` (per-action, narrow).
2. Add a canonical mapper in `src/canonical/` (assign FieldClasses) + a tool in
   `src/tools/`.
3. Ship it as a capability shell (`UNVERIFIED_READS`) → run the probe runbook on
   a dev WHMCS → move to `SUPPORTED_READS` only after a real `supported` probe.
4. Tests: mapper field-class coverage + tool-level with mocked `whmcs.read`.

**Add a WRITE scope** (one entry per file, the seam is TS-enforced):
1. `src/write/types.ts`: add to `WRITE_SCOPES`, `SCOPE_ACTION`, `SCOPE_RISK`.
   Destructive/permanent → also add to `PROD_NEVER_EXECUTABLE(_SCOPES)`.
2. `src/write/validation.ts`: add `REQUIRED_PARAMS` + a per-scope validator.
3. `src/write/paramMapping.ts`: add a STRICT mapper + a dispatcher case (the
   `never` guard forces this or it won't compile).
4. Tests: mirror `tests/write/trackC2.*.test.ts` — assert SCOPE_ACTION/SCOPE_RISK,
   strict mapper output (planted extras dropped), validation accept/reject.
5. New scopes are sealed deny-by-default; enabling in prod is an operator env
   change (`MCP_PROD_WRITE_AUTHORIZED`), never a code default.

## Testing & dev stack

- `npm test` (vitest) — keep it green; `npx tsc --noEmit` clean; `npm run lint`.
  (Note: `tests/security/entityOwnership.test.ts` is a known excluded file with
  pre-existing lint findings — leave it alone.)
- `npm run build` must succeed.
- **Local dev WHMCS** (disposable, dockerized, dual-version): WHMCS 8.13 @
  `http://localhost:8813` and 9.0 @ `http://localhost:8890`. See
  `docs/runbooks/local-whmcs-testing.md`. One replicated API credential authenticates
  both legs. NEVER point write execution at production (`my.securiace.com`).
- **Probe/test harnesses** (dev-only, localhost-guarded):
  - `npm run mcp:write-probe` — zero-mutation reachability probe (calls each
    write action with a non-existent id; classifies REACHABLE/UNSUPPORTED).
  - `npm run mcp:deepdrive:reads` — exercises every read/aggregator tool.
  - `npm run mcp:deepdrive:writes` — fully arms execution and runs every write
    scope draft→validate→approve→execute with read-back + cleanup.
  - Outcome classes for writes: EXECUTED / GATE-OK (governed path authorized but
    dev WHMCS rejects downstream, e.g. "Module Not Found") / DESIGN-DENY (safety
    stop fired) / FAIL. Latest run: 0 FAIL on both legs.

## Hard rules (do not violate)

1. **No new direct `whmcs.mutate()` write tools.** Every mutation goes through
   the tiered governed flow.
2. **Never weaken the keystone.** Don't add actions to default prod allowlists,
   don't loosen `PROD_NEVER_EXECUTABLE(_SCOPES)`, don't make high-risk skip the
   full gate.
3. **Never log, echo, or return** raw bearer tokens, API secrets, PANs, or
   `secret.credential` fields. Registry stores only sha256 token hashes.
4. **Governance OFF must stay byte-identical** to legacy read output
   (backward-compat invariant).
5. **Pure modules** (mappers, validators, gate) must stay pure — no I/O, no
   `Date.now()`/`Math.random()`/argless `new Date()` (they break determinism and
   workflow resume).
6. **STOP and ask** before: production writes, destructive/irreversible actions,
   anything touching secrets/credentials, migrations, billing-impacting behavior,
   or an unclear safety classification.
7. Capability-probe money/destructive scopes on a dev WHMCS before suggesting
   production enablement; record evidence.

## Workflow conventions

- Branch off `main`; small, reviewed PRs; squash-merge when green.
- Keep docs current: `docs/archive/changelog-ai.md` (newest first), `docs/design/decisions.md`,
  the capability-probe runbooks.
- Match surrounding code style (comment density, naming, idiom). Strict mappers
  and per-scope validators are heavily commented on purpose — keep that.
- Excluded-from-commit paths (do not stage): `.cursor/hooks/`,
  `src/security/entityOwnership.ts`, `tests/security/entityOwnership.test.ts`,
  `tests/write/enhancedValidation.test.ts`.

## Key files (extension seams)

- Reads: `src/whmcs/actionPolicy.ts`, `src/canonical/*`,
  `src/governance/capabilities.ts`, `src/tools/{listTools,reportingListTools,
  capabilityShellTools,aggregators,infraTools,quoteTools,contactsTools,
  ticketMetaTools,systemRefTools,billingReadTools}.ts`
- Writes: `src/write/{types,validation,paramMapping,executionGate,idempotency,
  audit}.ts`, `src/tools/writeFlow.ts`
- Governance: `src/governance/{types,contracts,projection,consumers,pipeline}.ts`
- Auth/transport: `src/auth/*`, `src/http/httpServer.ts`
- Registration entry: `src/index.ts`
- Docs: `docs/reference/agent-context.md`, `docs/design/{decisions,changelog-ai,oauth,mcp-adoption}.md`,
  `docs/runbooks/{capability-probe,write-capability-probe,local-whmcs-testing}.md`

## First steps for you

1. Read `docs/reference/agent-context.md` and `docs/design/decisions.md` for current state and
   rationale, then `src/write/types.ts` + `src/governance/projection.ts` to
   internalize the two core seams.
2. Run `npm install && npm run build && npm test` to confirm a green baseline.
3. State your plan before editing security-critical seams; prefer the
   shell→probe→promote (reads) and one-entry-per-file (writes) patterns above.
