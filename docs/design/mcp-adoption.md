# MCP protocol adoption and compatibility

Status: Plan 001 safety baseline, 2026-08-07

This document defines the protocol boundary the server supports today and the
gates for adopting MCP `2026-07-28`. It is a compatibility contract, not a
claim that roadmap-only behavior is already live.

## Support matrix

| Client or protocol era | stdio | Streamable HTTP | Current posture |
|---|---:|---:|---|
| MCP `2025-11-25` | Supported | Supported when `MCP_TRANSPORT=http` | Primary implemented protocol; HTTP uses `initialize` plus `Mcp-Session-Id` |
| Earlier versions negotiated by SDK v1 (`2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07`) | Compatibility path | Compatibility path | Preserve while measured clients still require them; contract tests pin the published catalog rather than promising every older optional feature |
| MCP `2026-07-28` stateless requests | Not yet supported | Not yet supported | Approved Plan 002 direction; do not route production traffic until its dual-era adapter and rollout gates pass |
| `io.modelcontextprotocol/tasks` | Not advertised | Not advertised | Tasks is an opt-in extension in `2026-07-28`, not experimental core behavior; adoption belongs after the modern protocol adapter and durable task semantics exist |

The current TypeScript SDK dependency is the patched v1 line and negotiates
`2025-11-25`. The [2026-07-28 release](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
removes the protocol handshake and session header, moves identity/capabilities
to each request, and exposes optional discovery. Those semantics require the
Plan 002 adapter; changing a version string or disabling session storage is not
a migration.

## Catalog compatibility policy

`npm run mcp:test:contracts` constructs the exported `buildServer` factory with
the official in-memory SDK transport and a WHMCS call tripwire. It discovers
and normalizes the complete public catalog, then compares it with
`tests/fixtures/mcp/catalog-v1.json`.

The command launches its probes and Vitest files with a minimal child
environment instead of inheriting the operator shell. It pins every current
catalog-shaping input: `MCP_TOOL_ALLOWLIST` is empty,
`MCP_ENABLE_LEGACY_WRITE_TOOLS` is false, and `MCP_MAX_PAGE_SIZE` is 100.
Environment-file loading is disabled only in these hermetic test children, so
an operator `.env` cannot restore those switches or expose local credentials.
A hostile-shell and hostile-`.env` sentinel must still discover exactly 57
tools, 9 prompts, 3 concrete resources, and 9 resource templates.

Normalization sorts catalog entries and JSON object keys only. It preserves:

- tool input and output JSON Schemas, including required fields and constraints;
- tool annotations, execution metadata, descriptions, and names;
- prompt names, descriptions, and arguments;
- concrete resource URIs and resource-template URI patterns; and
- advertised server capabilities and server identity.

Any intentional catalog change must update the fixture in the same PR and
explain compatibility impact. Ordering-only changes may be normalized. Never
normalize away fields that a client can observe or use for validation.

## Transport, authentication, and error contract

- stdio remains the default transport and reserves stdout for JSON-RPC.
- Direct-entry detection compares canonical real paths. Launching the built
  entry point through a symlink starts stdio normally; missing, non-file, or
  unresolvable entry paths fail closed for safe factory imports.
- Streamable HTTP remains opt-in and stateful for the implemented 2025-era
  protocol. Every session is bound to the consumer that initialized it.
- HTTP checks the Origin boundary before bearer/OAuth authentication. Missing
  or invalid credentials return bounded `401` responses; forbidden origins or
  session-owner mismatches return bounded `403` responses. Tokens and internal
  credential details must never appear in response bodies or logs.
- Malformed JSON, unsupported content types/methods, unknown capabilities, and
  invalid tool arguments produce protocol-shaped, bounded errors. Negative
  requests must not call WHMCS or mutate server state.
- A client that proposes an unknown 2025-era protocol version receives the
  server's supported negotiated version in the initialize response and remains
  responsible for accepting it or disconnecting, as required by that lifecycle.
- The future `2026-07-28` path must bind identity and policy on every request;
  it may not infer authorization from a removed transport session.

## Conformance policy

The local official runner is exactly
`@modelcontextprotocol/conformance@0.1.16`, including its lockfile integrity.
Run:

```bash
npm run mcp:test:conformance
```

The command builds the server, starts a loopback-only stateless adapter around
the real `buildServer` surface with inert credentials and a WHMCS tripwire, and
runs the official `2025-11-25` scenarios for initialization, logging level,
ping, tool listing, resource listing, and prompt listing. A missing package,
version mismatch, scenario removal, runner failure, or WHMCS call exits
nonzero. The wrapper overwrites WHMCS configuration with inert values and
launches every external runner process with an explicit minimal environment;
a sentinel child-process self-check fails if parent-only environment data can
cross that boundary. Results and the isolated child home live only in temporary
directories.

The runner prints every official scenario it does not run. Most excluded
scenarios require conformance-fixture-specific tools, resources, prompts,
sampling, elicitation, subscriptions, or SSE behavior that this product does
not advertise. The DNS-rebinding scenario is also excluded from the loopback
adapter because its unauthenticated localhost policy requires accepting local
browser Origins, while the production transport's safer default denies every
present Origin unless the operator explicitly allowlists it. The deterministic
HTTP contract tests cover the actual project policy.

This baseline does not claim `2026-07-28` conformance. Plan 002 must pin a
runner version that understands the stateless lifecycle and add the applicable
modern scenarios before enabling that protocol in production.

## Retirement gates

Do not retire the 2025-era path until all of the following are true:

1. The dual-era adapter passes deterministic catalog, auth, negative transport,
   identity-binding, and official conformance gates for both eras.
2. Production client inventory and telemetry show which protocol each named
   consumer uses; unknown clients count as legacy.
3. Every supported host has a tested `2026-07-28` configuration and rollback
   path, including per-request identity and governance evidence.
4. A canary period demonstrates no catalog drift, authorization regressions,
   write-path changes, or material latency/error-rate regression.
5. Operators publish a dated deprecation window no shorter than the applicable
   MCP lifecycle policy and confirm that rollback remains available throughout.
6. The handoff, client configuration examples, runbooks, and saved catalog are
   updated in the retirement PR.

Tasks-extension support has separate gates: explicit extension negotiation,
durable task state, tenant isolation, cancellation/idempotency semantics,
bounded polling, and proof that non-opted-in clients still receive ordinary
tool results. A Tasks implementation must not be represented as core MCP
support.

## Product feature boundaries

Protocol adoption feeds the existing policy engine; it does not replace it:

- Field-class projection remains the per-consumer output boundary. MCP does not
  provide field-level authorization.
- The capability registry remains the allow/deny and evidence source. Future
  OAuth scopes map into it rather than bypassing it.
- Transport identity performs authentication; governance and the controlled
  write-flow continue to perform authorization, approval, execution gating,
  auditing, and idempotency.
- Rate limiting and the durable audit log remain server responsibilities.
- Sampling and Roots are not adopted for this API-backed billing/operations
  server. Any future proposal must establish a concrete product need and a new
  threat model first.
- Do not add the legacy HTTP+SSE transport. Dynamic Client Registration remains
  a compatibility fallback, not the preferred identity-registration path.

The ranked implementation sequence is maintained in
[`advisor-plans/README.md`](../../advisor-plans/README.md). That roadmap now
supersedes the historical feature wish-list formerly kept in this document:
Plan 001 pins safety and compatibility, Plan 002 adds a dual-era protocol
adapter, Plans 003 and 004 unify catalog policy and the WHMCS execution
pipeline, and Plan 005 adds a deterministic safe-operations planner.

## Authoritative references

- [MCP 2026-07-28 release](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- [MCP 2025-11-25 specification](https://modelcontextprotocol.io/specification/2025-11-25)
- [MCP Tasks extension](https://modelcontextprotocol.io/extensions/tasks/overview)
- [Official MCP conformance framework](https://github.com/modelcontextprotocol/conformance)
- [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
