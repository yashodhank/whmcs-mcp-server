# Plan 004: Composable WHMCS execution pipeline and read acceleration

> Written against `ebab2c5` on 2026-08-07. Requires plan 001. Drift check:
> inspect `WhmcsClient.call()` around `src/whmcs/WhmcsClient.ts:223-463`,
> `read()` at `:469-491`, `mutate()` at `:506-520`, and
> `src/whmcs/readCache.ts:67-140`.

## Finding

`WhmcsClient.call()` combines credential encoding, axios transport, retry and
backoff, business-error normalization, admin hints, 403 classification,
IP-allowlist repair, socket reset and logging. It has high structural complexity
and is the shared dependency of most tools. `read()` provides a small TTL cache
but no in-flight request coalescing, deadline propagation, action-specific
policy or cache metrics. This central seam is both the best performance leverage
and the highest regression risk.

Impact: high. Effort: large. Risk: medium. Confidence: high.

## Goal

Keep the public `WhmcsClient.read()`/`mutate()` API initially unchanged while
moving execution concerns into typed, separately tested pipeline stages. Add
safe read coalescing, bounded concurrency, deadlines and telemetry without ever
retrying, caching or coalescing writes.

## Scope

Expected files:

- `src/whmcs/request/*` — request types, encoder, transport, response decoder,
  error classifier, retry/repair policy, telemetry hooks.
- `src/whmcs/readCoordinator.ts` — in-flight coalescing and concurrency.
- `src/whmcs/cachePolicy.ts` and `readCache.ts` — action-specific policies,
  tags and metrics.
- `WhmcsClient.ts` — thin facade and compatibility methods.
- `src/observability/*` — OpenTelemetry interface/no-op implementation.
- focused tests in `tests/whmcs/` plus aggregator load tests.

Out of scope:

- Changing normalizers or domain response shapes.
- Distributed caching before per-instance semantics are proven.
- Automatic mutation retries, speculative writes or hedged writes.
- Logging request params/response bodies as telemetry.
- Raising global WHMCS concurrency without measured installation limits.

## Steps

### 1. Characterize the current pipeline

Add table-driven tests for every existing branch:

- simulate mutation;
- successful read/write;
- WHMCS business error normalization and admin hint;
- retryable 429/5xx/network reset with exact attempt budget;
- non-retryable 4xx;
- Invalid-IP heal success/failure/cooldown;
- edge/WAF 403 fresh-socket retry;
- timeout and cancellation;
- read cache hit/miss/expiry/eviction;
- policy denial before cache lookup.

Use fake timers and mocked transport; no sleeps or live API calls.

### 2. Introduce explicit request/result types

Define `WhmcsRequestContext` with action, normalized params, effect, request id,
deadline, abort signal, attempt budget and safe telemetry attributes. Define a
discriminated internal result/error taxonomy. Credentials are supplied only to
the encoder/transport stage and must not appear in context serialization.

Preserve the external error classes and messages through an adapter until a
separate compatibility decision changes them.

### 3. Extract pure stages in parity commits

Recommended extraction order:

1. parameter encoding and endpoint resolution;
2. response/business-error decoding;
3. transport-error classification;
4. retry/backoff decision;
5. 403 socket reset/IP-heal repair decision;
6. telemetry emission;
7. facade orchestration.

Each stage returns a decision; it does not mutate loop indices such as the
current `attempt = -1` branches (`WhmcsClient.ts:368,384`). Express repair retry
budgets explicitly so a heal/reset cannot accidentally refresh unrelated 5xx
budgets.

Verify focused characterization tests after every extraction commit.

### 4. Propagate deadline and cancellation

Accept optional call options on `read()`/`mutate()` while keeping current calls
valid. Derive a bounded timeout from request context and pass `AbortSignal` to
axios, backoff waits and safe fan-out workflows. A client cancellation stops
queued/not-started reads and suppresses retries; it cannot interrupt an already
accepted WHMCS mutation in a way that falsely reports rollback.

Mutation cancellation responses must say outcome may be unknown if the remote
call was sent but no response was received.

### 5. Add safe in-flight read coalescing

Between policy guard and transport, maintain a map keyed by installation,
action, normalized params and cache-policy version. Concurrent identical reads
share one promise. Always remove settled/rejected entries in `finally`.

Do not coalesce:

- mutations/drafts;
- capability probes whose caller needs independent evidence;
- requests with different auth/governance data scopes if raw results differ;
- actions not explicitly marked coalescible.

Projection remains per caller after the shared raw read. Add a test with two
consumer contracts proving they receive distinct governed projections from one
coalesced API response.

### 6. Add bounded scheduling and adaptive cache policy

Replace only fan-out reads with a fair, abortable scheduler. Limits are per
installation with optional per-consumer fairness; the existing token-bucket
rate limit remains a hard ceiling. Avoid unbounded `Promise.all` in aggregators.

Extend cache policy by action with TTL, max entries, tags and freshness class.
Start conservative:

- reference/catalog data: longer TTL;
- account/invoice/ticket reads: short TTL only where existing behavior allows;
- activity/automation logs and capability probes: no cache by default;
- all writes: impossible by type/invariant.

Invalidate related tags after a successful mutation only when the affected
entity/action relationship is proven. Unknown writes clear the safe local read
cache rather than guessing narrowly.

### 7. Measure, benchmark and roll out

Emit low-cardinality metrics/spans: action class (allowlisted name), outcome,
latency, queue time, attempts, repair class, cache/coalesce outcome and response
size bucket. Never emit params, tokens, PII or response bodies.

Add deterministic benchmarks for 1/10/100 identical reads and representative
aggregators. Acceptance targets, measured against plan-001 baseline on the same
machine:

- 100 identical concurrent cacheable reads cause one transport call;
- p95 queue + execution latency does not regress more than 10% for a single
  uncached read;
- aggregator peak in-flight calls never exceed configured bound;
- rejected/cancelled work leaves no in-flight entries.

Ship coalescing/cache policies behind flags, canary, then default only after
metrics show correctness.

## Tests

- Full current error/retry/repair characterization.
- Explicit retry budget state-machine tests.
- Policy-before-cache invariant.
- Coalescing success/error/cancellation cleanup.
- Cross-consumer projection isolation.
- Mutation type/property tests prove no cache/coalesce/retry.
- Scheduler fairness, bound and abort behavior.
- Telemetry redaction tests.

## Done criteria

- `WhmcsClient` is a thin facade over independently tested stages.
- Read coalescing and bounded scheduling meet acceptance targets.
- Deadlines propagate from MCP request to queue, transport and backoff.
- Mutation safety semantics and public errors remain compatible.
- Global, contract and focused benchmark gates pass.

## STOP conditions

- A performance optimization requires sharing governed output between consumers.
- Any mutation can enter cache, coalescer or automatic transport retry.
- Repair/retry budgets cannot be expressed without changing behavior; add tests
  and a separate compatibility decision first.
- Benchmarks are noisy enough that the 10% regression threshold is meaningless.

## Maintenance

New actions must declare cache/coalescing policy in the catalog (plan 003).
Review latency/error budgets per installation; never auto-tune write behavior.
