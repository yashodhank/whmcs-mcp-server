# MCP Spec & TypeScript SDK Adoption Plan

How the official [Model Context Protocol](https://github.com/modelcontextprotocol) (spec + TypeScript SDK) can make **this WHMCS MCP server** sharper, safer, and more interoperable.

## Executive summary

This server is already a mature MCP citizen: ~60 governed tools (reads, aggregators, capability shells, a tiered governed write-flow), MCP Prompts, a few resources, `outputSchema` / `structuredContent`, and tool annotations — all sitting behind an in-house governance layer (consumer/bearer-token auth, field-class projection, capability registry, rate limiting, audit log). The biggest near-term wins from the upstream project are not new in-house machinery but *adopting standard primitives we currently hand-roll or skip*: **Elicitation** (interactive write confirmation / missing-param capture), **completions** (argument autosuggest for clients/services), the **logging utility** and **progress notifications** (visibility into long aggregators and the write-flow), **resource templates**, and **tool `_meta`** (carry our governance/capability hints in a spec-blessed slot). Medium-term, **Streamable HTTP + OAuth 2.1 resource-server + CIMD** unlocks remote/multi-client deployment without our bespoke bearer scheme, and the experimental **Tasks** primitive is the natural home for the long-running governed write-flow. We **skip Sampling and Roots** — neither fits a server-side billing/ops backend.

**Verified facts (checked June 2026):**
- **Latest stable spec revision: `2025-11-25`** ([spec hub](https://modelcontextprotocol.io/specification/2025-11-25), [changelog](https://modelcontextprotocol.io/specification/2025-11-25/changelog)). A `2026-07-28` release candidate is in draft and not final.
- **TypeScript SDK: `@modelcontextprotocol/sdk` stable `1.x` (latest `1.29.x`)** on npm; a `2.0.0-alpha` monorepo split is in pre-release and not production-ready. We are on `~1.29`, i.e. current. ([npm](https://www.npmjs.com/package/@modelcontextprotocol/sdk), [SDK repo](https://github.com/modelcontextprotocol/typescript-sdk))

---

## 1. Ranked adoption table

Ranked by value-per-effort for this server. All spec citations are against revision **2025-11-25** unless noted.

| # | Feature | What it is | Spec status | Concrete fit for THIS WHMCS server | Effort | Value | Status |
|---|---------|-----------|-------------|-------------------------------------|:------:|:-----:|--------|
| 1 | **Elicitation** | Server-initiated, schema-typed request for more input from the user mid-call | Stable; refined in 2025-11-25 (`ElicitResult`/`EnumSchema` standards-based — SEP-1330; defaults for primitives — SEP-1034; URL-mode — SEP-1036) | Replace ad-hoc "missing param" errors and out-of-band write confirmation. The tiered governed write-flow (draft → validate → approve → execute) can elicit the final human "approve" and any missing fields with a typed schema instead of forcing a second tool call. | M | **High** | In progress |
| 2 | **Prompts** | Templated, parameterized message workflows the user invokes | Stable | Already shipped — encode common ops playbooks (account 360 triage, reconciliation walkthrough, dunning). Keep adding; wire `completions` into prompt args (#4). | — | High | **Done** |
| 3 | **Pagination cursors** | Opaque `cursor` / `nextCursor` for `list`-family results | Stable | Already shipped — apply consistently to every large list tool (`list_invoices`, `list_services`, `list_users`, `search_clients`) so clients never truncate. | — | High | **Done** |
| 4 | **Completions** | `completion/complete` argument autosuggest for prompt and resource-template params | Stable | High-leverage UX: autosuggest client IDs, service IDs, ticket departments, product IDs as the user types prompt/template args — backed by our existing list/search tools. Pairs naturally with #2 and #6. | M | High | Planned |
| 5 | **Progress notifications** | `notifications/progress` keyed by a `progressToken` from request `_meta` | Stable | The heavy aggregators (`get_account_360`, the `*_snapshot` family) and the multi-step write-flow do real work; stream progress so clients show motion instead of a spinner that may look hung. | S | Med-High | Planned |
| 6 | **Resource templates** | Parameterized resource URIs (e.g. `whmcs://client/{id}/360`) with `completions` support | Stable | Turn read aggregators into addressable, cacheable resources the host can pin/reference (`whmcs://invoice/{id}`, `whmcs://client/{id}`). Complements, not replaces, the read tools. | M | Med-High | Planned |
| 7 | **Logging utility** | Standard `logging/setLevel` + `notifications/message` server→client log stream | Stable (stdio servers MAY also use stderr — PR #670) | Surface governance decisions (capability denials, projection redactions, rate-limit hits) as structured, level-filtered client-visible logs — without leaking into tool payloads. Bridges to our audit log. | S | Med-High | Planned |
| 8 | **Tool `_meta`** | Reserved, namespaced metadata slot on tools/results | Stable | Carry our capability-registry tags, field-class info, write-tier, and audit correlation IDs in the spec-blessed `_meta` channel instead of overloading descriptions or output payloads. Low-risk, additive. | S | Med | Planned |
| 9 | **Streamable HTTP + OAuth 2.1 resource-server + CIMD** | Recommended remote transport; OAuth 2.0 Protected Resource Metadata per RFC 9728 (SEP-985); incremental scope consent via `WWW-Authenticate` (SEP-835); **Client ID Metadata Documents** as recommended client registration (SEP-991) | Stable | The path off stdio to a remote, multi-client deployment. Lets us retire the bespoke bearer-token scheme in favor of standard OAuth resource-server semantics, mapping scopes → our capability registry. CIMD avoids per-client registration friction. **Origin check must return HTTP 403 (PR #1439).** | L | High (multi-client) | Planned |
| 10 | **Tasks** | "Call-now, fetch-later": any request can return a task handle for polling / deferred result retrieval (SEP-1686) | **Experimental** (2025-11-25) — "may change without notice" | Natural home for the long-running governed write-flow and slow aggregations: issue a task, let the client poll/resume. Hold until it stabilizes, but design the write-flow so it can adopt Tasks cleanly. | M | Med (future) | Planned (watch) |
| 11 | **Sampling** | Server asks the *client's* LLM to generate (now with `tools`/`toolChoice` — SEP-1577) | Stable | No fit. A billing/ops backend has no reason to drive recursive client-side LLM calls; adds attack surface and consent burden for zero product value. | — | — | **Skip** |
| 12 | **Roots** | Client advertises filesystem/URI boundaries to the server | Stable | No fit. We operate against the WHMCS API, not a client workspace/filesystem. | — | — | **Skip** |

---

## 2. Concrete correctness now

Low-effort, high-confidence alignment work that needs no new feature — just conformance to 2025-11-25:

- **SEP-1303 — validation errors as Tool Execution Errors, not protocol errors.** When a tool's input fails our validation, return a normal `CallToolResult` with `isError: true` and a *descriptive, model-readable* message ("invoice id must be a positive integer; got 'abc'") rather than a JSON-RPC protocol error. The model can see Tool Execution Errors and self-correct; it cannot see protocol errors. Backwards-compatible clarification — audit every validation/guard path in the write-flow and read tools. ([SEP-1303](https://modelcontextprotocol.io/community/seps/1303-input-validation-errors-as-tool-execution-errors))
- **Audit all four tool annotation hints.** Set `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint` correctly on every tool. Reads/aggregators → `readOnlyHint: true`. Write-flow steps and `suspend_service`/`terminate_service`/`record_refund` → `readOnlyHint: false`, `destructiveHint: true`. Idempotent setters (e.g. `mark_invoice_paid`) → `idempotentHint: true`. Tools hitting external registrars/registries → `openWorldHint: true`. Remember: per the spec these are **untrusted hints**, so they inform UX, not our server-side enforcement (which stays in the capability registry).
- **JSON Schema 2020-12 as the default dialect (SEP-1613).** Confirm all `inputSchema` / `outputSchema` definitions are valid 2020-12 and that our Zod (`zod/v4`, the SDK's internal target) → JSON Schema emission produces 2020-12-compatible output. Avoid drafts/keywords that don't round-trip.

---

## 3. What we keep in-house (no spec equivalent)

The spec deliberately does not standardize server-side authorization or data governance — these remain ours, and should be *mapped onto* spec primitives rather than replaced:

- **Field-class projection** — per-consumer redaction/shaping of response fields. No MCP primitive covers output-field-level access control. Keep; optionally annotate redactions via `_meta` (#8) and structured logs (#7).
- **Capability registry** — the allow/deny matrix per consumer per tool. No spec equivalent. When we move to OAuth (#9), map OAuth **scopes → capability registry entries** so the standard layer feeds, but does not replace, ours.
- **Per-consumer governance** (consumer/bearer-token identity + policy) — in-house until OAuth resource-server adoption; then OAuth handles *authentication/transport* while our policy engine handles *authorization*.
- **Rate limiting** — not an MCP concern. Keep; surface limit hits via the logging utility (#7).
- **Audit log** — keep as the system of record. Correlate with MCP via `_meta` correlation IDs (#8) and mirror governance-relevant events to client logs (#7).

---

## 4. Deprecations to avoid

- **HTTP+SSE transport (the old two-endpoint transport).** Superseded by **Streamable HTTP**. When we leave stdio, go straight to Streamable HTTP — do not implement the legacy SSE transport. (Note SEP-1699: GET streams now support polling/resumption, all within Streamable HTTP.)
- **Dynamic Client Registration (DCR / RFC 7591) as the primary path.** The 2025-11-25 spec recommends **Client ID Metadata Documents (CIMD, SEP-991)** for client registration. Prefer CIMD-based flows; treat DCR as legacy fallback only.

---

## 5. Recommended sequencing / roadmap

**Phase 0 — Correctness (now, days).** Section 2 in full: SEP-1303 error semantics across all validation paths, the four annotation hints audited, JSON Schema 2020-12 confirmed. Zero new features, immediate conformance and better model self-correction.

**Phase 1 — Low-effort visibility & metadata (S).** Logging utility (#7), progress notifications on aggregators + write-flow (#5), tool `_meta` carrying governance/capability/audit hints (#8). Wires our in-house governance into spec-standard channels.

**Phase 2 — Interactive & discoverable UX (M).** Finish **Elicitation** (#1) for write-flow approval and missing-param capture; add **completions** (#4) for client/service/product/department args; introduce **resource templates** (#6) for the top read aggregators. (Prompts #2 and pagination #3 already done — extend completions into prompt args here.)

**Phase 3 — Remote & multi-client (L).** **Streamable HTTP + OAuth 2.1 resource-server + CIMD** (#9): map OAuth scopes onto the capability registry, keep field-class projection/rate-limit/audit in-house. Origin check returns 403. This is the gating step for a hosted, multi-tenant deployment.

**Phase 4 — Watch & adopt when stable.** **Tasks** (#10) for the long-running write-flow once it graduates from experimental. Design the write-flow now so a task handle can slot in without a rewrite. **Skip** Sampling (#11) and Roots (#12) indefinitely.

---

## 6. Links

**Spec**
- Spec hub (current): https://modelcontextprotocol.io/specification/2025-11-25
- Changelog (2025-11-25): https://modelcontextprotocol.io/specification/2025-11-25/changelog
- Server features: https://modelcontextprotocol.io/specification/2025-11-25/server
- Client features (Elicitation): https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation
- Tasks (experimental): https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks
- Authorization / OAuth: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- SEP-1303 (validation errors as tool errors): https://modelcontextprotocol.io/community/seps/1303-input-validation-errors-as-tool-execution-errors
- Spec + schema repo: https://github.com/modelcontextprotocol/modelcontextprotocol
- 2026 roadmap: https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/

**SDK**
- npm package: https://www.npmjs.com/package/@modelcontextprotocol/sdk
- TypeScript SDK repo: https://github.com/modelcontextprotocol/typescript-sdk
- SDK server guide (`server.md`): https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md
- SDK releases: https://github.com/modelcontextprotocol/typescript-sdk/releases

**Org**
- MCP org: https://github.com/modelcontextprotocol
