# PlanIR client patterns

All examples use placeholders. Supply authentication through the MCP
transport/tool boundary, never inside the candidate PlanIR.

## Basic client

1. Call `inspect_operation_catalog`.
2. Build a structured candidate with exact operation ids and typed slots for
   unknown values.
3. Call `compile_operation_plan` and display alternatives, blockers, hash,
   expiry and `executable:false`.

This works without prompt support and makes no WHMCS request during compile.

## Prompt-aware hosts (Claude, Cursor and generic MCP hosts)

Request `plan_whmcs_operation` with a sanitized goal and maximum mode. The host
brainstorms two or three strategies, then uses the same catalog/compile tools.
Prompt output remains untrusted and must never be parsed as an executable plan.

## Modern clients

Clients with modern discovery/cache hints may cache only the versioned catalog
ETag and must refresh on catalog/config/consumer changes. MRTR may be used for
missing non-sensitive slots when supported. A decline or cancellation stops;
it is never interpreted as approval.

Completions are safe only when consumer-filtered, paginated and governed. Do
not offer completions over tokens, credentials, secrets or unrestricted free
text.

## Offline snapshots

An exported/signed catalog snapshot may help draft a candidate offline, but it
is stale and non-executable by definition. Online compilation with current
transport identity and fresh evidence is mandatory before preflight or draft.

Long-lived/task-aware plans are future work and require a separately approved
encrypted durable store, revocation semantics and retention policy.
