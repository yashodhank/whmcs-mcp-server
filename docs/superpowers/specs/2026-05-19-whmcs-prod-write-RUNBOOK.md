# WHMCS MCP Production-Write — Operations Runbook (Tracks G & F)

Companion to `2026-05-19-whmcs-prod-write-enablement-design.md`. Covers the
scoped Cowork consumer (Track G) and the **prep-only** production canary
(Track F). Nothing here auto-runs a production mutation.

## 0. Current posture (after this branch, before any env change)

Production is **SEALED**. Verified by `tests/write/executionGate.test.ts`
keystone tests + `tests/tools/writeFlow.prodsafety.test.ts`: with no new env,
a production execute returns `action_not_prod_authorized`, `whmcs.mutate`
never called — byte-identical to the legacy absolute deny.

## 1. Track G — Claude Cowork scoped consumer (example, synthetic token)

Add ONE `execution_allowed` consumer to `MCP_CONSUMER_REGISTRY`. **Narrow by
action.** No god-mode. The raw token lives only in env (and the caller); the
registry stores its sha256.

Generate a token + hash (do NOT commit the raw token):

```bash
RAW="$(openssl rand -hex 24)"          # the bearer token Cowork sends as auth_token
echo "$RAW"                             # store in your secret manager / claude.json env
printf '%s' "$RAW" | shasum -a 256      # the token_sha256 for the registry
```

`MCP_CONSUMER_REGISTRY` entry (JSON; `<SHA>` = the digest above):

```json
[{
  "id": "claude-cowork-ops",
  "token_sha256": "<SHA>",
  "allowedScopes": ["read"],
  "defaultContract": "ops_operator",
  "allowedContracts": ["ops_operator"],
  "allowedActions": [],
  "writeCapability": "execution_allowed",
  "allowedWriteScopes": ["client_note:write"],
  "envRestrictions": [],
  "anonymous": false
}]
```

- Start with **`client_note:write` only** in `allowedWriteScopes`. Add
  `ticket:create` / `ticket:reply` / `ticket:status` only at S5.
- **Do NOT** add `billing:*` write scopes here until S7 (money tier).
- `execution_allowed` is necessary but **not sufficient** — the action must
  also be in `MCP_PROD_WRITE_AUTHORIZED` and pass risk-tier policy.

## 2. Environment reference (all default to SEALED)

| Env var | Default | Effect |
|---|---|---|
| `MCP_PROD_WRITE_AUTHORIZED` | `` (empty) | Per-action prod allowlist. Empty ⇒ nothing executes in prod. |
| `MCP_WRITE_KILL_SWITCH` | `false` | `true`/`1` ⇒ instant global seal, beats everything. |
| `MCP_WRITE_AUDIT_PATH` | `` (in-memory) | JSONL durable audit. **Required** (config fails fast) once `MCP_PROD_WRITE_AUTHORIZED` is non-empty. |
| `MCP_WRITE_IDEMPOTENCY_PATH` | `` (in-memory) | Durable replay guard across restart. |
| `MCP_PROD_HIGH_RISK_PER_ACTION_CAP` | `0` | High-risk per-action cap. 0 ⇒ all money actions denied. |
| `MCP_PROD_HIGH_RISK_DAILY_CAP` | `0` | High-risk per-(action,day) cap. 0 ⇒ denied. |

Config also **fails fast** if `MCP_PROD_WRITE_AUTHORIZED` contains a
`PROD_NEVER_EXECUTABLE` action, or is non-empty without an audit path.

## 3. Track F — production canary readiness (S4, do NOT auto-run)

The AddClientNote-only canary is **prepared, not executed**. It requires an
explicit, separate human decision to set the env below. Until then production
stays sealed.

**Pre-canary checklist**
1. Track G consumer added with `allowedWriteScopes: ["client_note:write"]`.
2. `MCP_WRITE_AUDIT_PATH` + `MCP_WRITE_IDEMPOTENCY_PATH` set to durable paths
   on persistent storage.
3. `MCP_WRITE_KILL_SWITCH=false`, caps left at `0`.
4. Rebuild (`npm run build`) + restart the MCP (it runs from `dist/`).

**Canary enable (one action only):**
```
MCP_ENV=production
MCP_MODE=full
MCP_PROD_WRITE_AUTHORIZED=AddClientNote
```
Then, via Cowork: draft → validate → approve → execute a single
`client_note:write` against a known internal/test client; confirm the note in
WHMCS admin and in the durable audit JSONL. **Roll back** by clearing
`MCP_PROD_WRITE_AUTHORIZED` (or `MCP_WRITE_KILL_SWITCH=1`).

**Do NOT** add ticket/billing/service/domain/payment actions to the prod
allowlist until the note canary has succeeded and been reviewed (S5+). Money
actions (S7) additionally require: a real human approver via
`approve_write_intent`, non-zero caps, and durable audit (enforced by config +
the authorizer; proven in the high-risk test suite).

## 4. Kill switch (instant seal, any time)

Set `MCP_WRITE_KILL_SWITCH=1` (or `true`) and restart — every write intent is
denied `kill_switch_engaged` regardless of allowlist/approval. It is the first
gate checked.

## 5. Spike 0 / dev execution proof — remaining blocker & unblock

Dev WHMCS 9 (`localhost:8890`) is up & healthy but its `APIAllowedIPs` is a
strict exact-match list rejecting the Docker host-gateway `192.168.65.1`.
Opening it is a raw DB / admin change (a hard stop for the agent).

**To unblock (operator action):**
```
deploy/whmcs-test/post-install-fixup.sh        # harness auto-whitelists the rejected IP (dev-only)
# OR: WHMCS admin → Setup → General Settings → Security → API IP Access → add 192.168.65.1
```
Then re-run the Spike 0 probe (`GetPromotions` / `AddPromotion` /
`UpdatePromotion`) and the dev full-cycle execution proof (Track E). Until a
safe promotion API is proven, **promotions are created manually in WHMCS
admin**; the MCP only reads/verifies. `promotion:create` is deliberately NOT
in the codebase yet (gated on Spike 0).
