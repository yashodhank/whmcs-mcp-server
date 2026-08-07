# Safe operations planner and PlanIR

Status: initial deterministic implementation, 2026-08-07.

The host supplies creative reasoning; the server supplies facts and policy. The
`plan_whmcs_operation` prompt helps an MCP host compare alternatives, but its
candidate is untrusted until `compile_operation_plan` validates it against the
effective catalog, fresh installation/configuration-scoped evidence, current
transport-derived consumer grants and server limits. The resulting hash binds
an opaque policy fingerprint derived from the consumer id and effective grants;
it contains neither the raw consumer id nor an auth token. There is no server-side
model provider, sampling call or provider credential.

Every compiled PlanIR is versioned, hashed, expiring and permanently
`executable:false`. It records operation ids, typed values or unresolved slots,
dependencies, effects, risk, cost, evidence age, conditions, verification,
failure/fallback and compensation notes. It never stores auth material or raw
PII. IDs and capability proof may not be inferred from prose.

## Threat model and invariants

| Threat | Deterministic response |
|---|---|
| Prompt injection in tickets or other WHMCS text | Treat downstream text as data; it is never parsed into operations or authorization |
| Hallucinated operation or entity ids | Catalog ids only; unknown ids fail; unknown entity values remain typed slots |
| Stale/foreign capability proof | Evidence must match opaque installation, configuration and catalog fingerprints and remain unexpired |
| Replay or edited plans | Verify the canonical hash, catalog version, target/config/policy fingerprints and expiry immediately before preflight/drafting |
| Confused deputy or consumer change | Bind the hash to an opaque fingerprint of consumer id, actions, scopes, contracts, write capability and effective client allowlist; require an exact current match |
| Scope escalation/hidden writes | Effect and risk must equal server metadata; analyse permits pure only, read_only permits pure/read, draft_only still stops at drafts |
| Excess calls, pagination or fan-out | Enforce server-owned step/call/page/concurrency bounds before any preflight |
| Secret/PII leakage | Reject credential/PII-shaped keys, email/phone-like values, deep/oversized collections and long nested strings; use identifiers or typed slots |
| Partial failures | Return status-only preflight checks and per-step draft results; stop at the first denial and mark any already-created drafts as partial |

`draft_operation_plan` first verifies the complete plan and every eligible
scope, then reruns bounded privacy checks and the strict server-owned operation
schema even when a caller supplies a self-consistent recomputed hash. It calls
only the existing `draftWorkflowIntent` seam. It cannot
validate, approve or execute an intent and never reaches `WhmcsClient.mutate()`.
Multi-step drafting is intentionally non-atomic: it stops on the first denial,
returns each attempted result, and sets `partial:true` when an earlier draft was
created. Those records remain unvalidated drafts.
The separate controlled-write ceremony remains mandatory. Opt-in legacy direct
mutators are the documented exception, but the planner never selects them.

Direct database access is unchanged: only the guarded opt-in owner-transfer
write path may use it. Planning, catalog inspection, compilation and preflight
do not add database reads or any other database path.

## Tools and modes

- `inspect_operation_catalog`: consumer-filtered, client-safe metadata.
- `compile_operation_plan`: pure deterministic validation and canonical hash.
- `preflight_operation_plan`: only explicitly allowlisted pure/safe-read
  operations with resolved inputs; returns result status, not raw WHMCS data.
  Cancellation reaches the HTTP request and never records degraded capability
  evidence for the cancelled probe.
- `draft_operation_plan`: creates governed draft intent IDs only; returns
  `executed:false`, per-step results and an explicit partial flag.

There is intentionally no `run_plan` tool. Modern MRTR/discovery/caching may
improve interaction when supported by the modern adapter, but decline,
cancellation and expiry always remain non-executable.

## Rollout

1. Shadow: compile representative candidates and measure blocker classes.
2. Analyse: enable catalog inspection and compilation only.
3. Read-only preflight: permit the small reviewed preflight allowlist.
4. Draft-only: enable only consumers with explicit write scopes; execution
   counts must remain zero.
5. Future task-backed plans require a separately approved durable encrypted
   store. No client data is retained by this implementation.

Telemetry is limited to low-cardinality plan hash/correlation and blocker
classes. Estimates are conservative API-call/latency hints, not billing or
accounting facts. Review scenarios after an incident and at least quarterly;
every catalog operation addition must update effect/risk/cost planner tests.
