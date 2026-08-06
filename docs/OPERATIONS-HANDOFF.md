# WHMCS MCP Server — Product, Ownership, and Operations Handoff

Status: current as of 2026-08-07
Canonical code: [`yashodhank/whmcs-mcp-server`](https://github.com/yashodhank/whmcs-mcp-server)
Canonical branch: `main`

This is the authoritative handoff for the addon/integration. It answers what
exists, where it lives, how it works, who changes it, and what must be updated
when future work is done. If another document conflicts with this one, update
that document or record the exception here; do not make a new undocumented
assumption.

## Executive answer

This project is a standalone Node.js/TypeScript **Model Context Protocol (MCP)
server** that connects AI hosts to the WHMCS External API. It is not a PHP
addon uploaded into a WHMCS installation, and it does not become part of the
WHMCS core codebase.

It is maintained in the existing `yashodhank/whmcs-mcp-server` GitHub
repository. There is no separate addon repository. Keep new MCP tools,
governance, approval controls, WHMCS mappings, tests, and operational docs in
this repository unless a future decision explicitly creates a separately
owned product.

The WHMCS installation remains the system of record for customer, billing,
service, domain, ticket, and invoice data. This server is an access and
governance layer; it is not a second CRM, billing database, or source of truth.

## What it does and why it exists

The server exists to give an AI agent a controlled, observable interface to
WHMCS without handing the agent unrestricted database or administrator access.
It provides:

- read tools for clients, services, domains, invoices, tickets, products, and
  operational snapshots;
- canonical response mapping and governance projection for consumer-scoped
  access;
- capability probes so unsupported WHMCS actions are reported honestly;
- controlled write intents with validation, approval, authorization, audit,
  idempotency, caps, and execution-time checks;
- draft-only workflow tools that prepare work without executing it; and
- compatibility and operational runbooks for local WHMCS 8.13/9.x testing.

The safety boundary is intentional: default operation is read-only, production
writes are sealed unless explicitly authorized, and direct database access is
limited to the owner-transfer capability because WHMCS does not provide the
required ownership-reassignment API.

## Runtime model

```text
AI host (Cursor / Claude / other MCP host)
        │ 2025 compatibility or 2026 request-stateless MCP
        ▼
Protocol adapters → authenticated request/policy context
        │
        ▼
Control plane: typed catalog + capability evidence + governance + PlanIR
        │
        ▼
Execution plane: domain handlers + controlled write flow
        │
        ▼
Typed WHMCS request pipeline
        ├─ HTTPS → WHMCS External API
        └─ guarded opt-in owner-transfer only → direct DB write transaction
```

Startup reads configuration from environment files and process environment.
The default transport is stdio. HTTP transport is opt-in through
`MCP_TRANSPORT=http`; HTTP uses the consumer registry/bearer-auth boundary.
The server builds the same tool surface for both transports.

The normal write lifecycle is:

```text
draft → validate → approve (when required) → execute → audit/idempotency result
```

`MCP_PROD_WRITE_AUTHORIZED_FILE` is a protected owner-only JSON allowlist. It
is read on every production execution, so adding or revoking an authorized
action takes effect without restarting the MCP process for high-risk,
strict-scoped, or strict-mode writes. Under the default tiered policy, clearing
the allowlist does not stop low- or medium-risk non-strict scopes. Missing,
malformed, or group/other-readable files fail closed when loaded. A production
allowlist also requires `MCP_WRITE_AUDIT_PATH` so the mutation has a durable
audit trail.

Important distinction: the live authorization file does not make approval
records or intent IDs durable. A restart removes pending in-memory intents and
approvals; operators must draft and validate a new intent, then obtain a new
approval. Durable audit, idempotency, and daily-cap paths must be configured
separately.

## Repository and project boundary

| Boundary | Current decision / fact |
|---|---|
| Canonical repository | Public GitHub repository `yashodhank/whmcs-mcp-server` |
| Default branch | `main`; all changes enter through pull requests |
| Product placement | Keep the MCP adapter, governance, write-flow, tests, and docs together in this repository |
| WHMCS application | External dependency and system of record; do not patch WHMCS core from this repository |
| Local WHMCS test stack | `deploy/whmcs-test/` in this repository; intentionally separate from `securiace-vps-platform` |
| Client proposals | `securiace-clients-proposals` is a separate business/proposal workspace; never copy secrets or customer PII into this public repository |
| Production deployment | No production host, image registry, service name, or immutable image digest is declared in this repository; record those in the private deployment inventory before claiming a deployment |
| Separate GitHub repository | None currently; do not create one for ordinary addon changes |

The Dockerfile and `docker-compose.yml` provide a buildable container and a
local/dev-oriented compose setup. They are not proof of a production
deployment. Production deployment ownership, host, proxy, image registry,
secret injection, backups, and rollback identity must be recorded in the
private operations inventory when a deployment is made.

## Ownership and maintenance

The repository account `yashodhank` is the current GitHub escalation point. A
named human/team owner is not encoded in the repository yet; this is an
explicit assignment gap, not a reason to guess. Until assigned, use this
interim responsibility model:

| Responsibility | Interim owner | Required handoff |
|---|---|---|
| Product decisions and scope | Securiace technology/product owner — **name pending** | Approve new capabilities, risk changes, and customer commitments |
| Code and test maintenance | Repository maintainer through `yashodhank/whmcs-mcp-server` PRs — **named maintainer pending** | Keep CI green; update tests and docs in the same PR |
| Production operations | Securiace infrastructure/operator — **name and host inventory pending** | Own runtime, secrets, process health, backups, deployment, and rollback |
| Approval authority | Separate authorized operator/approver — **name/group pending** | Approve production write intents; do not self-approve high-risk work |
| Security review | Securiace security owner — **name pending** | Review auth, secret handling, direct DB access, and production write changes |
| WHMCS administration | Client WHMCS administrator or designated client operator | Own WHMCS roles, API credentials, IP allowlist, and WHMCS-side changes |
| Customer delivery records | Client/proposal workspace, not this public repository | Keep quotes, billing identifiers, PII, and private execution evidence private |

Required assignments before the next production deployment:

1. product owner and technical maintainer;
2. production operator and backup operator;
3. approval authority/group and escalation contact;
4. production host/service/image registry identity;
5. backup/restore owner and incident channel; and
6. support SLA and change window.

## Change, release, and review process

Every code, configuration, governance, or operational behavior change must:

1. start on a feature/fix branch, never directly on `main`;
2. include focused tests and the relevant documentation/handoff update;
3. be committed in logical, cherry-pickable chunks;
4. pass `npm run lint`, `npm run typecheck`, `npm run build`, and the relevant
   test suite before push;
5. be published as a PR with what/why/verification/migration notes;
6. address substantive automated or human review comments, including comments
   added after a PR was closed or merged; and
7. merge only after required GitHub checks are green.

The CI gate currently runs Node build, typecheck, lint, the full Vitest suite,
Python tests for the optional IP updater, and PHP syntax checks. No release
tagging or image-digest policy is currently declared; establish those before
production deployment rather than treating a mutable image tag as release
identity.

## Operational rules

- Never commit WHMCS identifiers, secrets, bearer tokens, registry tokens,
  customer PII, production database dumps, or quote/invoice payloads.
- Keep production credentials in the deployment secret manager/environment;
  keep only non-secret configuration and path posture in repository docs.
- Default new deployments to `MCP_MODE=read_only` and verify the actual tool
  surface and downstream WHMCS connectivity before enabling writes.
- Use `MCP_PROD_WRITE_AUTHORIZED_FILE` for live action/scope rotation where
  possible; protect it with owner-only permissions and pair it with durable
  audit/idempotency paths.
- Treat an empty production allowlist as revocation only for high-risk,
  strict-scoped, or strict-mode writes. Universal emergency shutdown requires
  `MCP_WRITE_KILL_SWITCH=true` and an MCP service/process restart. An HTTP
  client reconnect or new session is insufficient; a stdio reconnect qualifies
  only when the host terminates and respawns the child with the updated
  environment.
- Treat `approve_write_intent` as an authorization event, not a conversational
  acknowledgement. High-risk operations require a distinct approver and
  execution-time authorization/precondition checks.
- Do not use direct WHMCS DB access except for the documented owner-transfer
  capability, and never enable that capability without its probe, transaction,
  mixed-invoice safeguards, rollback tests, and operator approval.
- Treat `billing:invoice:reassign` as an internal composed-only v1 scope. It is
  not independently executable or schedulable; invoice ownership changes occur
  only inside the governed `service:transfer_owner` path.
- Use the local WHMCS test stack for behavior changes. Never run write tests
  against production data.
- When a production or client operation happens, record sanitized evidence in
  the private audit ledger; keep public docs limited to non-sensitive facts.

## Current delivery handoff

The approval hot-reload work, subsequent automated review fixes, operations
handoff, artifact governance, and sanitized production write runbook are
present on `main`. The current code includes live authorization reload, durable
audit-path enforcement, transaction-safe owner transfers, complete mixed-
invoice validation with type-aware Addon ownership checks, official WHMCS quote
line-item encoding, and numeric-string quote amount handling restricted to
decimal/scientific syntax. This handoff update also records the tiered allowlist,
post-restart replacement ceremony, and composed-only invoice-reassignment
semantics identified in the post-merge PR #77 review. Quarantined local
workspace artifacts are excluded from both Git tracking and Docker build
contexts.

Historical plans 001–021 have been reconciled against their merged outcomes.
Their local source files are preserved by hash but are not active backlog;
current code, tests, decisions, and runbooks are authoritative.

All operator-facing kill-switch references must preserve the startup boundary:
editing `MCP_WRITE_KILL_SWITCH` does not affect an existing process. Restart an
HTTP service/process, or respawn the stdio child, before claiming the emergency
seal is active.

## Approved MCP architecture roadmap

The MCP server/client intelligence roadmap was approved in PR #87 and fully
implemented through PR #97 on 2026-08-07. Its canonical index and completion
record are
[`advisor-plans/README.md`](../advisor-plans/README.md). The plans are approved
product direction plus design history; current runtime posture is described
below. The implementation used separate focused PRs in this order:

| Order | Plan | Priority | Implemented outcome | Evidence |
|---:|---|---:|---|---|
| 1 | [Safety baseline, protocol contracts and conformance](../advisor-plans/001-protocol-contract-baseline.md) | P0 | Pinned public MCP contracts, hermetic catalog checks, symlink entry smoke, and official conformance | PRs [#90](https://github.com/yashodhank/whmcs-mcp-server/pull/90), [#91](https://github.com/yashodhank/whmcs-mcp-server/pull/91) |
| 2 | [MCP v2 dual-era stateless runtime](../advisor-plans/002-mcp-v2-stateless-runtime.md) | P0 | Added modern request-stateless MCP alongside measured 2025 compatibility | PR [#92](https://github.com/yashodhank/whmcs-mcp-server/pull/92) |
| 3 | [Unified capability catalog](../advisor-plans/003-unified-capability-catalog.md) | P1 | Added typed catalog metadata, target-scoped capability evidence, and consumer-filtered discovery | PR [#93](https://github.com/yashodhank/whmcs-mcp-server/pull/93) |
| 4 | [Composable WHMCS execution pipeline](../advisor-plans/004-whmcs-execution-pipeline.md) | P1 | Added typed stages, bounded/fair safe reads, opt-in coalescing, deadlines, and low-cardinality telemetry | PR [#94](https://github.com/yashodhank/whmcs-mcp-server/pull/94) |
| 5 | [Safe operations planner](../advisor-plans/005-safe-operations-planner.md) | P1 | Added host-side brainstorming plus deterministic, non-executable PlanIR and governed draft-only conversion | PR [#97](https://github.com/yashodhank/whmcs-mcp-server/pull/97) |

PR #95 integrated authenticated request context, cancellation, deadlines, fair
consumer lanes, and catalog grants across Plans 002–004; its persistent-stdio
review fix derives a fresh bounded context for every callback. PR #96 fixed the
write-flow PAN guard so opaque transport/intent controls cannot be mistaken for
operator-supplied card content while semantic write fields remain scanned.

Plans 001 and 002 establish the implementation baseline: split MCP SDK v2
`2.0.0` is the primary dual-era runtime, `2026-07-28` HTTP requests are
request-stateless, and the retained SDK v1 path serves measured 2025-era
compatibility. Set `MCP_PROTOCOL_RUNTIME=legacy` and restart/respawn only for a
bounded rollback. Do not remove v1 until telemetry shows 30 consecutive days
without legacy or unknown clients and official modern conformance is available
and green. The public catalog is
pinned as a compatibility-significant fixture (57 tools, 9 prompts, 3 concrete
resources, and 9 resource templates at this baseline). In-process discovery
and negative transport/auth tests use a WHMCS tripwire, and CI runs both
`npm run mcp:test:contracts` and the exact official conformance package through
`npm run mcp:test:conformance`. The conformance command states unsupported
scenarios explicitly and does not require live WHMCS or operator credentials.
Its external runner receives only an explicit minimal environment, and CI also
checks repository-wide formatting plus import safety when no entry argv exists.
The contract command likewise uses a minimal child environment, explicitly
pins all current catalog-shaping switches, disables env-file loading in test
children, and proves a hostile shell/`.env` cannot change the 57/9/3/9
baseline or pass parent secrets through. Direct-entry detection resolves real
paths, so a built `dist/index.js` launched through a symlink starts the stdio
transport; the bounded contract smoke test proves startup and clean shutdown.
Modern HTTP keeps no protocol session maps, derives identity/scopes for every
request, propagates disconnect/deadline cancellation through the compatibility
bridge, rejects Host/Origin/auth/routing failures before dispatch, and drains
in-flight work for at most `MCP_HTTP_DRAIN_TIMEOUT_MS`. Modern discovery and
catalog lists use a private 30-second TTL partitioned by a descriptor hash;
dynamic resource reads remain private with zero TTL. Tasks and multi-round-trip
input remain unadvertised. Plan 005 uses the normal prompt/tool loop and did not
add a synthetic MRTR surface or change write authorization. The pinned
official conformance runner covers `2025-11-25`; deterministic dual-era tests
cover the modern lifecycle until an official `2026-07-28` runner is published.
The detailed protocol matrix, error contract, conformance scope, and retirement
gates are in [`docs/design/mcp-adoption.md`](design/mcp-adoption.md).

Plan 003 now has an implemented incremental foundation. A typed, immutable
catalog validates operation effects, risk, capability, governance, cache, cost,
auth and pagination metadata at startup. The compatibility adapter registers
`get_capability_matrix` as the first migrated capability-pack operation without
changing its existing public tool contract. All allowlisted WHMCS read actions
are declared once for legacy migration tracking, including internal probe or
enrichment actions. Capability evidence is isolated by opaque installation and
configuration fingerprints, probe shape and catalog version, and carries
expiry and provenance. The additive `whmcs://capabilities/v2` resource exposes
only globally permitted/effective catalog operations. Modern HTTP discovery
intersects consumer-filtered operations with bounded grants from the
transport-authenticated `ConsumerProfile`; request bodies cannot override
identity or grants. Legacy and stdio reads have no authenticated transport
profile and fail closed for those operations. CI checks the deterministic
catalog fixture and the Plan 001 public catalog. Plan 005 adds descriptor-only
planner operations; their handlers still use the existing governed seams.
Remaining capability shells and other domains are manual and must migrate one
pack per focused PR; controlled-write execution has not moved into the catalog.
See [`docs/design/capability-catalog.md`](design/capability-catalog.md).

Plan 005 now adds the first deterministic safe-planning slice. The host prompt
brainstorms alternatives while the server validates a versioned, expiring,
hashed and permanently non-executable PlanIR. Catalog inspection and compile
are pure; preflight is restricted to an explicit safe-operation allowlist; and
drafting calls only the existing governed draft-intent seam. No planner path
validates, approves, executes, calls a model provider, stores long-term client
data, or introduces a database path. See
[`docs/design/safe-operations-planner.md`](design/safe-operations-planner.md).

PlanIR provenance is bound to opaque installation, configuration, catalog and
consumer-policy fingerprints. The policy fingerprint covers the authenticated
consumer id plus effective capability, write-scope, contract, write-mode and
client-allowlist grants without storing any raw identity or bearer token.
Preflight and drafting require an exact current match and recheck operation
visibility. Preflight emits status only and propagates cancellation to the
bounded WHMCS read without caching cancellation as degraded evidence. Drafting
reruns bounded privacy and strict catalog-schema validation even for a
self-consistent caller-rehashed plan. Multi-step drafting stops on the first
denial and reports partial results explicitly; already-created records remain
drafts only.

The current public catalog is 61 tools, 10 prompts, 5 concrete resources, and
9 resource templates. The additive Plan 003/005 surfaces are
`whmcs://capabilities/v2`, `whmcs://planning/planir/v1`, four planning tools,
and the `plan_whmcs_operation` prompt.

Plan 004 is now implemented as a compatible `WhmcsClient` facade over typed
encoding, transport, decoding, classification, retry/repair, deadline and
telemetry stages. Every `read()` call deliberately passes through one fair
per-`WhmcsClient`/WHMCS-installation scheduler capped by
`MCP_READ_MAX_CONCURRENCY` (default `8`), so direct reads cannot bypass the
bound. Completed-result caching remains off
by default (`MCP_READ_CACHE_TTL_MS=0`), and identical in-flight read coalescing
is a canary opt-in (`MCP_READ_COALESCE_ENABLED=false`). Coalescing is restricted
to cache-allowlisted, non-log/non-probe reads and keys on installation, normalized
request, policy version and raw-data governance scope. Cancellation covers queue,
transport and backoff; a dispatched mutation whose response is lost is reported
as outcome-unknown. Low-cardinality telemetry omits parameters, bodies,
credentials, entity identifiers and error text; successful transports expose
only a documented UTF-8 response-size bucket, never the body or exact byte
count. See
[`docs/design/whmcs-request-pipeline.md`](design/whmcs-request-pipeline.md) for
rollout, rollback and deterministic load characterization.

Roadmap invariants remain operational requirements:

- model-proposed plans are data, never authorization;
- the planner cannot approve or execute a write;
- controlled and roadmap-created mutations continue through the existing intent
  state machine, consumer scope checks, execution gate, kill switch and
  `WhmcsClient.mutate()` backstop;
- opt-in legacy direct-mutate tools enabled by
  `MCP_ENABLE_LEGACY_WRITE_TOOLS=true` together with `MCP_MODE=full` are an
  explicit exception: they bypass the intent state machine and execution gate,
  retain their tool-level controls plus the `WhmcsClient.mutate()` mode
  backstop, and must not be expanded or used by this roadmap;
- mutation requests are never cached, coalesced or automatically retried;
- transport identity cannot be overridden by tool arguments;
- governance remains the governed-data output boundary; and
- direct database access remains limited to the documented owner-transfer
  capability and its guarded write transaction. The roadmap does not authorize
  general WHMCS database reads or another direct-database execution path.

Every roadmap implementation PR must update this handoff when it changes
runtime/transport posture, compatibility retirement criteria, data access,
write behavior, operational ownership or deployment requirements.

A production discovery quote was prepared as an unsent draft through the
governed flow. The current tree omits customer identity and commercial terms;
private evidence remains in the audit ledger and client/proposal workspace.
The repository owner approved and completed a coordinated branch-history
rewrite on 2026-08-06. Remote branch heads and known fork heads were verified
to contain no matches for the removed customer/commercial text. GitHub-hosted
pull-request references and cached views still require Support-side
dereferencing and garbage collection: **PENDING — Support ticket/date needed**.
Collaborators with a pre-rewrite clone must start from a fresh clone and
cherry-pick only collaborator-owned commits after inspecting each patch for the
removed material. Never merge or normally rebase a pre-rewrite branch onto the
new history, because that can make the disclosure reachable again. Before a
final invoice, the client/proposal workspace owner must confirm the billing
legal name, billing address, GSTIN applicability, and PO requirement:
**PENDING — workspace owner/date needed**.

## Handoff-update rule

This document must be updated in the same change set whenever any of the
following changes: repository placement, runtime/transport, deployment target,
owner or approver, environment variable posture, write scope, database access,
customer delivery status, release process, incident/backup process, or a
substantive review finding.

The PR author must include this checklist in the PR description:

```text
Handoff updated: yes/no
Operational docs changed: <paths or none>
Owner/deployment/release facts changed: yes/no
Secrets or customer PII added to repository: no
Audit ledger entry required: yes/no
```

If a fact cannot be verified, write `PENDING — owner/date needed` and name the
exact command, system, or person that must confirm it. Never silently fill the
gap from memory.

## Source map

- [`AGENTS.md`](../AGENTS.md) — contributor and agent rules.
- [`README.md`](../README.md) — installation, configuration, and tool catalog.
- [`docs/design/architecture.md`](design/architecture.md) — implementation architecture.
- [`docs/design/governance.md`](design/governance.md) — consumer projection and contracts.
- [`docs/design/capability-catalog.md`](design/capability-catalog.md) — typed catalog, evidence, discovery, and migration rules.
- [`docs/design/controlled-writes-phase-f.md`](design/controlled-writes-phase-f.md) — write-flow design.
- [`docs/runbooks/ai-agent-local.md`](runbooks/ai-agent-local.md) — local operator troubleshooting.
- [`docs/runbooks/production-test-program.md`](runbooks/production-test-program.md) — production validation.
- [`docs/runbooks/production-governed-writes.md`](runbooks/production-governed-writes.md) — host-neutral production write ceremony and revocation.
- [`docs/reference/agent-context.md`](reference/agent-context.md) — current technical context.
- [`docs/reference/workspace-artifact-manifest.md`](reference/workspace-artifact-manifest.md) — quarantined local artifact hashes and dispositions.
- Private audit ledger under `/Users/kritananda/.ai-audit/ledger/` — sanitized client and production evidence.
