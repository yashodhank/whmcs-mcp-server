# Plan 002: MCP v2 dual-era and stateless runtime migration

> Written against `ebab2c5` on 2026-08-07. Requires plan 001. Drift check:
> rerun the protocol contract suite and compare `src/http/httpServer.ts:152-476`,
> `src/index.ts:51-169`, and `package.json:57` before editing.

## Finding

The repo still depends on `@modelcontextprotocol/sdk` v1
(`package.json:57`). Its HTTP adapter maintains transport, activity and owner
maps (`src/http/httpServer.ts:195-203`), creates a server on initialize
(`:347-390`), and routes subsequent requests through a session
(`:413`). MCP `2026-07-28` and the stable split TypeScript SDK v2 support a
stateless core: self-describing requests, `server/discover`, cacheable catalogs,
header routing and MRTR. Keeping v1-only session machinery as the primary design
adds memory/DoS state, sticky-routing pressure and duplicated lifecycle code.

Impact: very high. Effort: large. Risk: high. Confidence: medium-high.

## Goal

Adopt stable SDK v2 and serve both modern stateless requests and the existing
2025-era clients through an explicit compatibility layer. Remove session state
from the modern path, preserve current authorization/governance semantics, and
make protocol era observable.

## Scope

Expected files (validate APIs against the official v2 migration guide first):

- `package.json`, lockfile — add split v2 server/client/core/node packages while
  retaining v1 during the incremental phase.
- `src/mcp/serverFactory.ts` — transport-neutral server construction.
- `src/mcp/requestContext.ts` — typed era/client/identity/deadline context.
- `src/http/httpServerV2.ts` — modern stateless adapter.
- `src/http/httpServer.ts` — legacy adapter retained temporarily.
- `src/index.ts` — select adapter without duplicating tool registration.
- `src/oauth/*` and governance consumer binding — per-request identity mapping.
- `tests/mcp/*` — dual-era compatibility and conformance.
- `docs/design/mcp-adoption.md`, `README.md`, env docs.

Out of scope:

- Tool handler refactors (plan 003).
- Changing write authorization or consumer contracts.
- Moving application state such as write intents into transport sessions.
- Adopting deprecated MCP Logging/Roots/Sampling on the new path.
- Removing legacy protocol support in the same PR.

## Steps

### 1. Freeze migration decisions in an ADR

Record:

- stable v2 package versions and supported protocol eras;
- modern HTTP is stateless; legacy support uses the SDK's documented adapter;
- stdio supports modern negotiation only if the v2 factory supports legacy
  fallback under tests;
- application state uses explicit handles (write intent/task id), not hidden
  transport sessions;
- OpenTelemetry/stderr replace new investment in deprecated MCP logging;
- MRTR may request missing input/confirmation but cannot authorize execution;
- Tasks are opt-in extension work after core migration.

Verify: ADR includes rollback to v1 dependency/path and a retirement metric for
legacy clients.

### 2. Install v2 alongside v1

Follow the official incremental migration order: add stable split packages,
update Zod only if required, and compile one isolated v2 smoke server. Do not
remove v1 imports until equivalent tests pass.

Run `npm ls` and audit the dependency tree. Ensure the build has one intentional
version of Zod semantics at each registration boundary.

Verify:

```bash
npm run typecheck
npm run test:mcp:contract
npm audit --audit-level=high
```

### 3. Extract a transport-neutral server factory

Move the registration sequence from `src/index.ts:51-111` into a factory that
accepts a request-context provider plus existing `WhmcsClient`, logger and rate
limiter dependencies. Preserve registrar order and catalog fixture exactly.

The factory must not capture HTTP bearer identity globally. Each call receives
an immutable context containing protocol era, authenticated consumer, granted
scopes, request/correlation id and deadline/abort signal.

Verify: v1 stdio and legacy HTTP contract fixtures are byte/shape compatible.

### 4. Add the modern stateless HTTP adapter

Use the documented v2 Node HTTP integration. For each request:

1. validate route, method, origin/host and size limits;
2. validate protocol version and required routing headers;
3. authenticate bearer and issuer/audience;
4. derive consumer/scopes without accepting body identity;
5. build immutable request context;
6. dispatch through the shared server factory;
7. emit standard error/auth headers and an OpenTelemetry span.

There must be no modern equivalents of `transports`, `lastSeen` or
`sessionOwner`. If a workflow needs continuity, it returns an explicit intent or
task handle.

Verify: 100 concurrent modern calls can be round-robin dispatched to two
in-process server instances with no shared session store and identical results.

### 5. Preserve legacy clients through one adapter

Prefer the SDK's official legacy compatibility option over maintaining two
business servers. If compatibility requires the existing adapter, isolate it
behind `legacyProtocolAdapter.ts` and mark the session maps as legacy-only.

Add protocol selection/negotiation telemetry with low-cardinality fields:
`protocol_era`, `transport`, `client_name`, `auth_mode`, outcome. Never include
tokens, params or PII.

Verify all plan-001 matrix cells; compare catalogs across eras.

### 6. Map 2026 protocol features deliberately

- `server/discover`: expose protocol capabilities, not WHMCS business
  capabilities. Link the business catalog resource/tool from metadata.
- list/read cache hints: deterministic ordering, catalog-scoped TTL and cache
  scope; invalidate when allowlist/catalog version changes.
- MRTR: implement only a no-write demonstration for missing planner input.
- header routing: verify `Mcp-Method`/`Mcp-Name` consistency before using them
  for gateway authorization or rate limiting.
- Tasks extension: advertise unsupported until a separate durable-store design
  lands; do not wrap the ephemeral `IntentStore` and call it durable.

### 7. Cut over and remove v1 in a later commit

Ship in logical commits: package smoke, shared factory, modern HTTP, legacy
compatibility, documentation. Run canary with dual-era telemetry. Remove the v1
dependency only after:

- official conformance passes for both supported eras;
- production client inventory shows no unknown legacy behavior;
- rollback has been rehearsed;
- catalog and governance contract suites remain identical.

## Tests

- Modern request succeeds without initialize/session id.
- Legacy initialize/session flow still passes.
- Modern concurrent requests work across independent server instances.
- Body identity cannot override transport identity in either era.
- Origin/host, issuer, audience and scope negative cases are fail-closed.
- Catalog cache hints invalidate on catalog/allowlist version change.
- MRTR cancellation/decline performs no write.
- Graceful drain stops new requests and lets bounded in-flight reads finish.

## Done criteria

- Stable v2 is the primary runtime; legacy support is explicit and measured.
- Modern HTTP stores no protocol session state.
- Public tool/resource/prompt contract is unchanged except reviewed protocol
  metadata/cache hints.
- Dual-era conformance and global verification gates pass.
- Documentation names exact supported eras and rollback steps.

## STOP conditions

- Stable v2 API behavior differs from the official migration/conformance docs.
- Compatibility requires accepting client-supplied identity or weakening auth.
- The modern path needs sticky sessions/shared state for ordinary tool calls.
- More than one migration concern (SDK, catalog rewrite, handler rewrite) appears
  in the same commit.

## Maintenance

Keep legacy removal criteria in operations handoff. Review protocol lifecycle
quarterly; extensions must be separately advertised, tested and versioned.
