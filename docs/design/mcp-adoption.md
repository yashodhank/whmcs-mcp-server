# MCP protocol adoption and compatibility

Status: Plan 002 dual-era runtime, 2026-08-07

This document defines the protocol boundary the server supports today and the
gates for eventually retiring the 2025-era compatibility path.

## Support matrix

| Client or protocol era | stdio | Streamable HTTP | Current posture |
|---|---:|---:|---|
| MCP `2025-11-25` | Supported | Supported when `MCP_TRANSPORT=http` | Explicit compatibility path; HTTP uses `initialize` plus `Mcp-Session-Id` |
| Earlier versions negotiated by SDK v1 (`2025-06-18`, `2025-03-26`, `2024-11-05`, `2024-10-07`) | Compatibility path | Compatibility path | Preserve while measured clients still require them; contract tests pin the published catalog rather than promising every older optional feature |
| MCP `2026-07-28` stateless requests | Supported by the v2 stdio router | Supported when `MCP_TRANSPORT=http` | Primary runtime (`MCP_PROTOCOL_RUNTIME=v2`); HTTP creates one request-scoped server and emits no session header |
| `io.modelcontextprotocol/tasks` | Not advertised | Not advertised | Tasks is an opt-in extension in `2026-07-28`, not experimental core behavior; adoption belongs after the modern protocol adapter and durable task semantics exist |

The runtime pins split SDK v2 packages (`@modelcontextprotocol/server`,
`client`, `core`, and `node`) at `2.0.0` and Zod at `4.4.3`, while retaining
the patched v1 SDK during the compatibility period. The modern factory reaches
the unchanged v1 business surface only through a linked in-memory JSON-RPC
transport; v1 and v2 SDK objects do not cross that boundary. Plan 003 can
replace this bridge with the unified catalog without changing either transport
adapter.

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

The modern catalog is identical except that `execution.taskSupport` is absent:
the 2026 protocol removed that 2025-only field. Discovery and catalog-list
results use a bounded private 30-second TTL. Their server identity includes a
12-hex SHA-256 revision of the canonical published descriptors, so a catalog or
allowlist change creates a different client cache partition. Dynamic resource
reads remain private with `ttlMs: 0`. `server/discover` describes protocol
capabilities and directs clients to the standard list methods and
`get_capability_matrix` for WHMCS evidence; it does not conflate protocol
discovery with business authorization.

## Transport, authentication, and error contract

- stdio remains the default transport and reserves stdout for JSON-RPC.
- Direct-entry detection compares canonical real paths. Launching the built
  entry point through a symlink starts stdio normally; missing, non-file, or
  unresolvable entry paths fail closed for safe factory imports.
- With `MCP_PROTOCOL_RUNTIME=v2` (the default), stdio uses the official v2
  dual-era router. A modern connection receives v2 framing; a 2025 opening is
  pinned to a compatibility instance for that connection. Stdio retains the
  existing tool-supplied consumer credential because it has no authenticated
  HTTP transport identity.
- Modern Streamable HTTP is request-stateless: it has no transport,
  last-activity, or session-owner map. The 2025-era adapter remains stateful and
  binds every session to its initializing consumer.
- HTTP checks Host and Origin before bearer/OAuth authentication. Missing or
  invalid credentials return bounded `401` responses; forbidden hosts,
  origins, or legacy session-owner mismatches return bounded `403` responses.
  Tokens and internal credential details never appear in response bodies or
  protocol telemetry.
- Modern HTTP derives consumer identity and OAuth scopes on every request and
  overwrites any body `auth_token` with the transport-authenticated identity.
  The validated v2 header/body routing ladder runs before dispatch.
- Malformed JSON, unsupported content types/methods, unknown capabilities, and
  invalid tool arguments produce protocol-shaped, bounded errors. Negative
  requests must not call WHMCS or mutate server state.
- A client that proposes an unknown 2025-era protocol version receives the
  server's supported negotiated version in the initialize response and remains
  responsible for accepting it or disconnecting, as required by that lifecycle.
- Graceful shutdown rejects new modern work with `503`, waits up to
  `MCP_HTTP_DRAIN_TIMEOUT_MS` for in-flight work, and then closes the adapter.
- Structured stderr telemetry uses bounded fields only: `protocol_era`,
  `transport`, registry consumer id as `client_name`, `auth_mode`, `outcome`,
  and `duration_ms`. It contains no params, PII, or credential values.

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

The pinned official runner has no `2026-07-28` scenarios. Therefore this
release does not claim official modern conformance. `npm run
mcp:test:contracts` adds a deterministic v2 suite covering stateless HTTP,
catalog parity, cache posture, 100 round-robin requests across independent
instances, cache-identity rollover, per-request identity binding, propagated
cancellation/deadlines, modern stdio, header/body mismatch, contained factory
failure, and bounded drain. Pin and run an official modern suite as soon as
one is published; this remains a retirement gate, not a reason to mislabel the
existing runner.

## Rollback and application-state boundary

Set `MCP_PROTOCOL_RUNTIME=legacy` and restart the HTTP process or respawn the
stdio child to return to the pre-v2 SDK transport path. Do not remove the v1
dependency or legacy tests until the retirement gates pass. The switch changes
only protocol serving; it does not change catalog, governance, write
authorization, or WHMCS request behavior.

Application continuity uses explicit handles such as write-intent ids, never a
protocol session. Multi-round-trip input and the Tasks extension remain
unadvertised. Plan 005 landed a prompt/tool planning loop without adding a
synthetic MRTR surface or changing write authorization. Any future MRTR PR must
add executable no-write, decline, cancellation, and retry tests before
advertising the feature. Ephemeral intent state must not be presented as a
durable task store.

## Retirement gates

Do not retire the 2025-era path until all of the following are true:

1. The dual-era adapter passes deterministic catalog, auth, negative transport,
   identity-binding, and official conformance gates for both eras once a modern
   official runner exists.
2. Production client inventory and telemetry show **30 consecutive days** with
   no legacy or unknown traffic; unknown clients count as legacy.
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
