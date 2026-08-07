# WHMCS request pipeline and safe read acceleration

Status: implemented behind conservative runtime controls (Plan 004)

## Boundary

`WhmcsClient.read()`, `mutate()`, and `call()` remain source-compatible facades.
The facade now delegates request work to explicit stages:

```text
read policy guard
  -> cache policy / cache lookup
  -> raw-data-scope coalescing key
  -> fair bounded read scheduler
  -> request context + deadline
  -> credential encoder
  -> Axios transport
  -> response decoder / business-error normalizer
  -> transport classifier
  -> bounded read retry OR one read-only 403 repair
  -> redacted telemetry event
```

Credentials exist only at the encoder/transport boundary. Request parameters,
response bodies, credentials, consumer identifiers, and free-form error text are
not telemetry attributes. The default telemetry adapter is a no-op; the typed
interface can be bridged to OpenTelemetry without adding an SDK/provider to the
server. Successful transport events include only a response-size bucket. It is
derived from the UTF-8 byte length of a raw string or compact-JSON serialization
of another decoded value: exactly zero bytes, 1–10 KiB, 10 KiB + 1 byte–100 KiB,
greater than 100 KiB, or `unknown` when serialization is impossible. The body
and measured byte count are never emitted.

This pipeline uses only the WHMCS External API. It does not add a direct database
read path. Direct database access remains restricted to the separately guarded,
opt-in owner-transfer write transaction documented in the operations handoff.

## Mutation invariants

Mutations are excluded by construction from `ReadCoordinator`, `ReadCache`, and
read retry decisions. `mutate()` forces retry off even if a caller supplies a
conflicting option. A cancellation after transport dispatch reports that the
mutation outcome may be unknown; it never claims rollback. Successful known
client mutations invalidate proven local entity tags, while other successful
mutations conservatively clear the process-local read cache.

Controlled and roadmap-created writes still use the intent state machine,
consumer scopes, execution gate, kill switch, and `WhmcsClient.mutate()`
backstop. Opt-in legacy direct-mutate tools remain the documented exception:
they bypass the intent state machine/execution gate, retain their tool-specific
controls and mode backstop, and are not expanded by this work.

## Read acceleration and isolation

- Every `WhmcsClient.read()` call enters the scheduler, not only aggregator
  fan-out. This is a deliberate per-`WhmcsClient`/WHMCS-installation bound: it
  prevents a direct single-tool read path from bypassing the same active-read
  ceiling. The scheduler round-robins queued consumer lanes, and queue
  cancellation prevents a read from starting.
- In-flight coalescing is limited to explicitly cache-allowlisted actions. Its
  key contains the WHMCS installation endpoint, normalized action/parameters,
  cache-policy version, and caller-supplied raw-data governance scope.
- Each coalesced caller receives a structured clone, so one caller cannot
  mutate another caller's result. A caller cancellation does not abort another
  subscriber; the shared transport is aborted when no subscribers remain.
- Activity/log/probe actions are never cacheable or coalescible. Mutations,
  drafts, and probes never enter the read accelerator.
- The policy guard runs before cache lookup and coalescing. A denied action can
  never be satisfied by an accelerated path.

The cache remains in-memory, per-client, bounded, and default-off. It now tracks
aggregate hit/miss/expiration/eviction/invalidation counters and internal tags;
neither tags nor keys are exported as telemetry.

## Runtime controls and rollout

| Variable | Default | Effect |
|---|---:|---|
| `MCP_READ_MAX_CONCURRENCY` | `8` | Per-process active-read ceiling (`1..64`); the existing global rate limiter remains the upper request-rate ceiling |
| `MCP_READ_COALESCE_ENABLED` | `false` | Canary opt-in for identical, cache-allowlisted in-flight reads |
| `MCP_READ_CACHE_TTL_MS` | `0` | Enables process-local completed-result caching only when greater than zero |
| `MCP_READ_CACHE_ACTIONS` | static reference allowlist | Defines the maximum action set eligible for cache and coalescing |

Roll out coalescing in a non-production canary first. Observe only the safe
action-class/outcome, queue depth, attempts, repair, cache/coalesce, and latency
metrics. Roll back by setting `MCP_READ_COALESCE_ENABLED=false`; set cache TTL to
zero to disable completed-result caching. Lower the concurrency bound if WHMCS
latency or 429 responses rise. No restart-independent control file is introduced;
these environment changes take effect on process restart.

## Deterministic characterization

The focused suite uses mocked transports and timers; it needs no WHMCS or
production credentials. It proves:

- one, ten, and one hundred identical coalescible reads each cause one raw
  operation, with no leaked in-flight entry;
- one uncached, non-coalesced read makes exactly one queue pass and one raw
  operation, with no residual queue/in-flight state. This deterministic hop
  count is the local single-read overhead characterization;
- peak operations never exceed the configured scheduler bound and queued aborts
  never dispatch;
- two consumers sharing a raw-data scope receive distinct projections from the
  real governance boundary after one coalesced API response; distinct raw-data
  scopes do not join, and coalesced callers receive independent result objects;
- success, business errors, 429/5xx/network budgets, non-retryable 4xx, Invalid
  IP repair, edge/WAF connection reset, cancellation, and deadlines preserve
  their classified outcomes;
- mutations cannot be cached, coalesced, or automatically retried; and
- serialized telemetry contains no action names, parameters, bodies, credentials,
  or entity values.

The deterministic tests intentionally assert queue/operation counts and bounds
rather than a noisy workstation p95. The sub-10% uncached p95 target remains a
canary acceptance criterion; production enablement must record same-host
before/after evidence rather than treating local wall-clock jitter as proof.
