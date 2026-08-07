# Capability Probe Runbook (Operator)

> Read-only. This runbook **verifies** whether 5 gated WHMCS read actions work
> on a target install. It does **not** add support, fake data, or expand the
> read allowlist. Promotion is a separate, reviewed code change (see §5).

## 1. Scope — the original 5 gated actions

These actions are declared in `src/catalog/declaredCapabilities.ts`:

| WHMCS action | capability id | declared status |
|---|---|---|
| `GetTransactions` | `list_client_transactions` | `supported` |
| `GetStats` | `get_system_stats` | `supported` |
| `GetUsers` | `list_users` | `unverified` (`external_only`) |
| `GetToDoItems` | `list_todo_items` | `supported` |
| `GetAutomationLog` | `list_automation_log` | `supported` |

## 2. Current status (verified from code)

- Four actions are allowlisted and supported after approved evidence. `GetUsers`
  remains outside `READ_ALLOWLIST`, is declared `external_only`, and returns a
  structured `capability_unavailable` payload. **Data is never fabricated.**
- `GetUsers` remains gated because prior authorized tests were degraded and an
  ordinary in-process probe is not sufficient evidence to change that posture.

## 3. The allowlist gate (why a raw probe alone won't promote)

`probeCapability(action, deps)` is the in-process read-probe path, and it is
**hard-gated** by both the catalog declaration and `deps.isAllowlisted`:

- If the action is **not** allowlisted, `probeCapability` returns
  `unsupported`, caches it, and **never calls WHMCS**. No probe traffic.
- A probe can only reach WHMCS once the action is in `READ_ALLOWLIST`.
- A declaration marked `external_only` (currently `GetUsers`) never reaches
  WHMCS through this path; an operator-approved external test must record its
  evidence separately.

So verification on a real install requires the §5 allowlist extension first.
There is no operator-only runtime flag that bypasses this.

## 4. Read-only probe procedure (post-allowlisting)

Once an action is allowlisted (§5), `probeCapability` issues
**at most one minimal read per evidence key within its TTL** with `{ limitnum: 1 }` forced
after caller filters, against the configured production read-only credentials.
Outcomes (from `classifyFailure` / success path):

| Observation | Resulting status | Operator reading |
|---|---|---|
| Read succeeds | `supported` (`verifiedAt` set) | Action works; safe to promote |
| Error text: access denied / permission / unauthor / authentication failed | `not_authorized` | WHMCS API role lacks permission — adjust API role, not code |
| Error text: action not found / invalid/unknown action | `unsupported` | Not present on this install/version — do not retry |
| Transport / other error | `degraded` | Retriable; re-run the probe later |

The result is cached in-process with a bounded TTL. The evidence key includes
opaque installation/configuration fingerprints, catalog version, action, and
safe probe shape; it is never keyed by action alone. Restart the process to
clear all evidence immediately, or use the test-only
`__resetCapabilityCacheForTests` (not for prod).

Probe params stay minimal (`limitnum:1`); no PII is requested, no IDs are
needed. Use synthetic/no filters — the goal is reachability, not data.

## 5. Promotion = a separate reviewed change

To promote any of the 5, in one deliberate, reviewed, TDD change:

1. Add the WHMCS action to `READ_ALLOWLIST` in
   `src/whmcs/actionPolicy.ts` (per-tool, **not** a broad expansion; the
   `WRITE_DENY_*` guards must still hold for that name).
2. Change the server-owned declaration in
   `src/catalog/declaredCapabilities.ts` from `unverified` to `supported`
   **only after** approved evidence is `supported` on the target install.
3. Add/extend tests; record the probe `verifiedAt` evidence in the PR.

Do **not**:

- Skip step 1 and "just probe" (the gate blocks it — see §3).
- Mark anything `supported` without a real `supported` probe result.
- Fake support, stub data, or widen the allowlist beyond the one action.
- Treat `not_authorized`/`unsupported` as promotable — they are terminal
  for this build.

Promotion of each action is its own reviewed change. No secrets or PII in
probes, logs, or PRs — synthetic/minimal inputs only.
