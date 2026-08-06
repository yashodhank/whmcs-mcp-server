# Runbook: governed production writes

Use this runbook to enable, approve, execute, verify, and revoke production
writes through the WHMCS MCP server. It is intentionally host-neutral and
contains no customer identifiers, real credentials, production paths, payment
provider details, or approved monetary limits.

Production-specific values belong in the private operator inventory and secret
manager. This public runbook defines the safety ceremony and failure behavior.

## Safety model

Production writes are deny-by-default. A write reaches WHMCS only when all
applicable gates pass:

- the process is configured for production write execution;
- the kill switch is not active;
- the calling consumer has `execution_allowed` capability and the requested
  write scope;
- the intent is drafted and validated;
- high-risk work has a distinct human approver;
- when allowlisting applies, the action or scope is present in the production
  authorization allowlist;
- monetary caps and preconditions pass;
- the idempotency key has not already been recorded; and
- the action/scope is not permanently production-blocked.

Nothing in a chat message, ticket, or natural-language acknowledgement bypasses
these gates. `approve_write_intent` is the approval event of record.

## Required durable paths

Before enabling production authorization, configure durable storage outside the
repository and make it writable only by the MCP service account:

- `MCP_WRITE_AUDIT_PATH` — required whenever either production authorization
  allowlist is non-empty/configured;
- `MCP_WRITE_IDEMPOTENCY_PATH` — strongly required for production so a process
  restart does not permit a duplicate execution; and
- `MCP_WRITE_DAY_AMOUNTS_PATH` — required when a daily high-risk monetary cap
  is used so the tally survives restart.

Never place these files under the Git checkout or publish their contents.

## Configure consumer identities

Use `MCP_CONSUMER_REGISTRY_FILE` with an owner-only JSON file. Store only token
SHA-256 hashes in the registry; raw bearer tokens belong in the secret manager.

Create at least two identities for high-risk work:

1. an executor identity that drafts, validates, and executes; and
2. a separate approver identity that approves or rejects.

Each profile must explicitly declare its allowed write scopes and production
environment restriction. Never use an anonymous consumer for writes.

Introducing or changing the `MCP_CONSUMER_REGISTRY_FILE` environment variable
requires a process restart/reconnect because environment variables are read at
startup. Once the running process already points to the file, edits to the file
are picked up after the registry cache TTL and do not require a restart.

## Configure live production authorization

Prefer `MCP_PROD_WRITE_AUTHORIZED_FILE` over the inline
`MCP_PROD_WRITE_AUTHORIZED` environment list. The file may contain either:

```json
["billing:payment:add", "client_note:write"]
```

or:

```json
{
  "authorized": ["billing:payment:add", "client_note:write"]
}
```

Requirements:

- use a regular file owned by the MCP service account;
- on Unix-like systems, set mode `0600`;
- authorize the narrow write scope instead of a broad WHMCS action whenever
  possible;
- set `MCP_WRITE_AUDIT_PATH` before startup; and
- start with an empty authorization list and add only the approved scope for
  the scheduled operation.

The authorization file is read on every production execution. Grant, scope
reduction, and revocation therefore take effect on the next execution attempt
without restarting the MCP process **for writes that consult the allowlist**:
high-risk intents, scopes listed in `MCP_WRITE_STRICT_SCOPES`, and all intents
when `MCP_WRITE_STRICT_ALLOWLIST=true`. With the default strict mode disabled,
low- and medium-risk scopes that are not strict-scoped do not consult this
allowlist. A missing, unreadable, malformed, or group/other-accessible file
fails closed when the running process tries to load it.

## Restart matrix

| Change | Restart/reconnect required? | Reason |
|---|---:|---|
| Edit scopes inside the existing `MCP_PROD_WRITE_AUTHORIZED_FILE` | No | Read on every execution; affects allowlist-gated writes only |
| Clear the existing authorization file with `{"authorized":[]}` | No | Revokes high-risk, strict-scoped, and strict-mode writes only; it is not a universal stop under the default tiered policy |
| Remove execution capability/scopes from every write-capable profile in the existing consumer registry file | No, after cache TTL | Registry file is re-read after cache expiry and the current scope grant is checked at execution |
| Set/change `MCP_PROD_WRITE_AUTHORIZED_FILE` environment variable | Yes | Environment is read at process start |
| Set/change `MCP_CONSUMER_REGISTRY_FILE` environment variable | Yes | Environment is read at process start |
| Set `MCP_WRITE_KILL_SWITCH=true` for a universal emergency stop | Yes | The kill switch is static runtime configuration and must be loaded by a restarted/reconnected process |
| Change `MCP_MODE`, caps, or durable paths | Yes | Static runtime configuration |
| Restart with a pending draft, validated, or approved intent | Fresh ceremony required | Intent IDs and approval records are process-local; draft and validate a new intent, then obtain a new approval |

## Per-intent ceremony

For high-risk work, use the executor token for draft/validate/execute and the
distinct approver token for approve:

```text
draft_write_intent
  → validate_write_intent
  → approve_write_intent (distinct approver)
  → execute_write_intent (original executor)
  → read back the WHMCS record
```

Before approval, compare the displayed semantic parameters and mapped WHMCS
parameters with the approved change request. Reject and redraft if either is
wrong. Do not edit an approved intent in place.

After execution, perform a read-back appropriate to the scope—for example,
invoice transactions after recording a payment, quote details after a quote
update, or service ownership after a transfer. An MCP success envelope without
the expected WHMCS state is not completion evidence.

## Ambiguous timeout rule

A timeout on a non-idempotent or financial call is ambiguous: WHMCS may have
committed the mutation before the response was lost.

Never blind-retry. Instead:

1. read back the target record;
2. search for the expected transaction/reference/idempotency marker;
3. if present, treat the operation as completed and do not retry;
4. if absent, document the read-back evidence; and
5. only then create a fresh intent according to the operator-approved recovery
   procedure.

An `idempotency_replay` denial is a safety result, not an instruction to invent
a new key. A new natural key is allowed only after read-back proves the earlier
attempt did not land and the operator approves the recovery.

## Emergency containment and universal shutdown

To immediately revoke **allowlist-gated** writes without restarting, replace
the existing live authorization file contents with:

```json
{
  "authorized": []
}
```

Verify owner-only permissions remain intact, then use a controlled execution
attempt for a high-risk or strict-scoped intent and confirm it is denied as
`action_not_prod_authorized` (or by an earlier gate). Preserve the audit
evidence. This does **not** stop a low- or medium-risk scope when strict mode is
disabled and the scope is not listed in `MCP_WRITE_STRICT_SCOPES`.

For broader no-restart containment, remove `execution_allowed` capability or
the applicable write scopes from every write-capable profile in the existing
consumer registry file, wait for its cache TTL, and verify denial. Do not treat
that TTL-delayed control as the universal emergency gate.

For a universal emergency shutdown, set `MCP_WRITE_KILL_SWITCH=true`, restart
or reconnect the MCP process, and prove the running process loaded the new
configuration. A controlled execution attempt that reaches the authorization
gate must be denied as `kill_switch_engaged`. Keep the authorization file empty
as defence in depth, but do not substitute allowlist clearing for the kill
switch.

## Direct database ownership transfers

`service:transfer_owner` is an executable, exceptional high-risk scope backed
by direct WHMCS database access because the External API cannot reassign
ownership. Keep the database DSN disabled unless a service-owner transfer is
specifically scheduled.

`billing:invoice:reassign` is composed-only in v1. It is used internally by the
service-owner transfer path when invoices are included, but it has no standalone
executor: a standalone execution returns `unsupported_capability`. Do not draft,
authorize, or schedule `billing:invoice:reassign` as an independent production
write.

Before enabling `service:transfer_owner`, require:

- source/destination client and currency preflight;
- complete invoice-item scope validation, including non-Hosting item types;
- rejection of mixed invoices unless every linked service is in scope;
- transaction-boundary rollback verification;
- dry-run/read-back evidence; and
- an explicit operator and distinct approver.

## Closeout

After the scheduled operation:

1. revoke the temporary scope from the live authorization file;
2. verify a subsequent execution attempt is denied;
3. confirm the durable audit and idempotency files were written;
4. record sanitized read-back evidence in the private audit ledger;
5. update the client/private handoff; and
6. never copy raw payloads, bearer tokens, or customer PII into the public
   repository or PR.
