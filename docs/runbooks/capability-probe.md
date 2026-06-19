# Capability Probe Runbook (Operator)

> Read-only. This runbook **verifies** whether 5 gated WHMCS read actions work
> on a target install. It does **not** add support, fake data, or expand the
> read allowlist. Promotion is a separate, reviewed code change (see §5).

## 1. Scope — the 5 unverified actions

These actions are declared `unverified` in
`src/governance/capabilities.ts` (`UNVERIFIED_READS`):

| WHMCS action | capability id | declared status |
|---|---|---|
| `GetTransactions` | `list_client_transactions` | `unverified` |
| `GetStats` | `get_system_stats` | `unverified` |
| `GetUsers` | `list_users` | `unverified` |
| `GetToDoItems` | `list_todo_items` | `unverified` |
| `GetAutomationLog` | `list_automation_log` | `unverified` |

## 2. Current status (verified from code)

- These actions are **NOT** in `READ_ALLOWLIST`
  (`src/whmcs/actionPolicy.ts`). The read path rejects them via
  `assertReadAction` (`WriteActionError`).
- Any tool needing one returns a structured `capability_unavailable`
  payload (`capabilityUnavailablePayload`), `status:"unverified"`,
  `retriable:true`, `guidance:"...operator must run a read-only probe"`.
  **Data is never fabricated.**
- Why gated: the registry note states they are "Needed by Phase C but not
  yet allowlisted." They stay `unverified` until a deliberate per-tool
  allowlist extension. *(Assumption: the inline note says "Phase C"; task
  framing references Phase F. The codebase wording is "Phase C" — treat the
  phase label as the project's; the gating mechanism below is what matters.)*

## 3. The allowlist gate (why a raw probe alone won't promote)

`probeCapability(action, deps)` is the only promotion path, and it is
**hard-gated** by `deps.isAllowlisted`:

- If the action is **not** allowlisted, `probeCapability` returns
  `unsupported`, caches it, and **never calls WHMCS**. No probe traffic.
- A probe can only reach WHMCS once the action is in `READ_ALLOWLIST`.

So verification on a real install requires the §5 allowlist extension first.
There is no operator-only runtime flag that bypasses this.

## 4. Read-only probe procedure (post-allowlisting)

Once an action is allowlisted (§5), `probeCapability` issues **at most one**
minimal read with `{ limitnum: 1 }` (merged first, caller params override
nothing critical), against the configured production read-only credentials.
Outcomes (from `classifyFailure` / success path):

| Observation | Resulting status | Operator reading |
|---|---|---|
| Read succeeds | `supported` (`verifiedAt` set) | Action works; safe to promote |
| Error text: access denied / permission / unauthor / authentication failed | `not_authorized` | WHMCS API role lacks permission — adjust API role, not code |
| Error text: action not found / invalid/unknown action | `unsupported` | Not present on this install/version — do not retry |
| Transport / other error | `degraded` | Retriable; re-run the probe later |

The result is cached in-process for the process lifetime (one probe per
action; subsequent calls short-circuit). Restart the process to re-probe,
or use the test-only `__resetCapabilityCacheForTests` (not for prod).

Probe params stay minimal (`limitnum:1`); no PII is requested, no IDs are
needed. Use synthetic/no filters — the goal is reachability, not data.

## 5. Promotion = a separate reviewed change

To promote any of the 5, in one deliberate, reviewed, TDD change:

1. Add the WHMCS action to `READ_ALLOWLIST` in
   `src/whmcs/actionPolicy.ts` (per-tool, **not** a broad expansion; the
   `WRITE_DENY_*` guards must still hold for that name).
2. Move the `[action, capability]` pair from `UNVERIFIED_READS` to
   `SUPPORTED_READS` in `src/governance/capabilities.ts` **only after** a
   real probe returns `supported` on the target install.
3. Add/extend tests; record the probe `verifiedAt` evidence in the PR.

Do **not**:

- Skip step 1 and "just probe" (the gate blocks it — see §3).
- Mark anything `supported` without a real `supported` probe result.
- Fake support, stub data, or widen the allowlist beyond the one action.
- Treat `not_authorized`/`unsupported` as promotable — they are terminal
  for this build.

Promotion of each action is its own reviewed change. No secrets or PII in
probes, logs, or PRs — synthetic/minimal inputs only.
