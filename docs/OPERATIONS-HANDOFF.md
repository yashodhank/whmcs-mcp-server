# WHMCS MCP Server — Product, Ownership, and Operations Handoff

Status: current as of 2026-08-06
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
        │ MCP stdio by default, Streamable HTTP when explicitly enabled
        ▼
whmcs-mcp-server (this repository)
        ├─ tool/resource/prompt registrations: src/index.ts
        ├─ input validation + canonical output mapping
        ├─ governance and consumer projection
        ├─ controlled write-flow and live authorization
        └─ HTTPS requests to WHMCS External API
                 │
                 ▼
        WHMCS installation (system of record)
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
action takes effect without restarting the MCP process. Missing, malformed,
or group/other-readable files fail closed. A production allowlist also requires
`MCP_WRITE_AUDIT_PATH` so the mutation has a durable audit trail.

Important distinction: the live authorization file does not make approval
records durable. Approval records are process-local; a restart invalidates
pending in-memory approvals and a high-risk intent must be approved again.
Durable audit, idempotency, and daily-cap paths must be configured separately.

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
| WHMCS administration | Haikawa/client WHMCS administrator or designated client operator | Own WHMCS roles, API credentials, IP allowlist, and WHMCS-side changes |
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
- Treat `approve_write_intent` as an authorization event, not a conversational
  acknowledgement. High-risk operations require a distinct approver and
  execution-time authorization/precondition checks.
- Do not use direct WHMCS DB access except for the documented owner-transfer
  capability, and never enable that capability without its probe, transaction,
  mixed-invoice safeguards, rollback tests, and operator approval.
- Use the local WHMCS test stack for behavior changes. Never run write tests
  against production data.
- When a production or client operation happens, record sanitized evidence in
  the private audit ledger; keep public docs limited to non-sensitive facts.

## Current delivery handoff

The approval hot-reload work and subsequent automated review fixes are merged
through PR #74. The current code includes live authorization reload, durable
audit-path enforcement, transaction-safe owner transfers, complete mixed-
invoice validation, official WHMCS quote line-item encoding, and numeric-string
quote amount handling.

The Haikawa client and ₹65,000 discovery quote were prepared in production as
an unsent draft through the governed flow. Customer identifiers, production
record IDs, billing address, GSTIN, PO requirement, and execution evidence are
kept in the private audit ledger and client/proposal workspace, not this public
repository. Before a final invoice, obtain the billing legal name, billing
address, GSTIN if applicable, and PO requirement.

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
- [`docs/design/controlled-writes-phase-f.md`](design/controlled-writes-phase-f.md) — write-flow design.
- [`docs/runbooks/ai-agent-local.md`](runbooks/ai-agent-local.md) — local operator troubleshooting.
- [`docs/runbooks/production-test-program.md`](runbooks/production-test-program.md) — production validation.
- [`docs/reference/agent-context.md`](reference/agent-context.md) — current technical context.
- [`docs/reference/workspace-artifact-manifest.md`](reference/workspace-artifact-manifest.md) — quarantined local artifact hashes and dispositions.
- Private audit ledger under `/Users/kritananda/.ai-audit/ledger/` — sanitized client and production evidence.
