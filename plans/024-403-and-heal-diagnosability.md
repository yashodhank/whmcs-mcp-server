# Plan 024: Make HTTP 403 + IP-heal decisions self-diagnosing

> Written against commit `2b7f665`. If `src/whmcs/WhmcsClient.ts` changed around
> the 403 handler / `extractWhmcsError` since then, re-read before proceeding.

## Why this matters (full incident context — executor has not seen it)

A WHMCS API outage took hours to diagnose twice. The second failure class: after
the URL was fixed, the MCP server's requests got an **edge/WAF HTTP 403** (a
bot/TLS-fingerprint block on the Node/axios client — `curl` from the *same IP*
returns 200). The surfaced error was a bare `"WHMCS HTTP error: 403"` with **no
hint**, and the IP-allowlist auto-heal correctly did *not* fire (the 403 had no
WHMCS `"Invalid IP <X>"` message) — but **why it didn't fire was invisible**: the
decision is logged only to the MCP server's stderr, which an operator using the
MCP tools never sees.

Root cause of "why the IP-heal didn't detect/apply", confirmed in code:
`src/whmcs/WhmcsClient.ts` heals only when the 403 body matches `/invalid ip/i`
(by design — a WAF/permission/auth 403 must not trigger a pointless SSH run). A
WAF 403 has no such body, so it's classified "not an IP-allowlist rejection" and
skipped. Correct behavior — but undiagnosable from the caller's side.

This plan makes a 403 explain itself: the surfaced error carries a **classified
hint** (IP-allowlist vs WAF/fingerprint vs permission/auth) **and** the **heal
decision** (skipped-not-ip / skipped-cooldown / skipped-disabled / attempted-and-
failed / applied). Same idea as the existing `"An admin user is required"`
enrichment (`WhmcsClient.ts` ~line 270), extended to 403.

## Current state (exact)

`src/whmcs/WhmcsClient.ts`:
- `extractWhmcsError(error)` (~line 106) returns `{ message?, reportedIp? }` from the axios error body.
- The 403 handler (~line 338):
```ts
if (statusCode === 403 && this.config.WHMCS_AUTO_IP_HEAL && !healAttempted) {
  const { message, reportedIp } = extractWhmcsError(error);
  if (message && /invalid\s+ip/i.test(message)) {
    healAttempted = true;
    const healed = await attemptIpAllowlistHeal(this.config, this.logger, reportedIp);
    if (healed) { /* log + attempt = -1; continue */ }
  } else {
    this.logger.warn('WHMCS 403 is not an IP-allowlist rejection; not auto-healing', { action, message });
  }
}
```
- The throw path (~line 360+) builds `WhmcsTransportError` with a generic message; for 403 it's effectively `"WHMCS HTTP error: 403"`.
- `healthCheck.ts` already has `classifyConnectivityError(error, endpoint)` returning `{ reason, hint }` with a `forbidden` case ("…caller IP not in the WHMCS API allowlist…"). The runtime path does NOT use it.

## Repo conventions
- Pure helpers + JSDoc; tests in `tests/whmcs/*.test.ts` (vitest) — mirror `tests/whmcs/whmcsClient403Heal.test.ts` and `tests/whmcs/whmcsClientAdminHint.test.ts`.
- `npm run typecheck && npm run lint && npm run format:check && npm test` must stay green.

## Steps

### Step 1 — Track the heal decision as a string
In the 403 handler, replace the bare `else` log and capture a `healNote` describing what happened, for inclusion in the thrown error. Introduce (near the top of the retry loop, where `healAttempted` is declared) `let healNote: string | undefined;`. Then:

```ts
if (statusCode === 403) {
  const { message, reportedIp } = extractWhmcsError(error);
  const isInvalidIp = !!message && /invalid\s+ip/i.test(message);
  if (this.config.WHMCS_AUTO_IP_HEAL && !healAttempted && isInvalidIp) {
    healAttempted = true;
    const healed = await attemptIpAllowlistHeal(this.config, this.logger, reportedIp);
    if (healed) {
      this.logger.warn('WHMCS 403 (Invalid IP): allowlist updated, retrying once', { action, reportedIp });
      attempt = -1;
      continue;
    }
    healNote = 'auto-heal ran but did not resolve the allowlist (check SSH identity / updater logs)';
  } else if (isInvalidIp && !this.config.WHMCS_AUTO_IP_HEAL) {
    healNote = 'looks like an IP-allowlist rejection but WHMCS_AUTO_IP_HEAL is off';
  } else if (isInvalidIp && healAttempted) {
    healNote = 'IP-allowlist rejection persisted after one heal attempt';
  } else {
    // Not an "Invalid IP" message: permission/auth OR an edge/WAF 403 (empty/HTML body).
    healNote = message
      ? 'not an IP-allowlist rejection (permission/auth) — auto-heal not applicable'
      : 'no WHMCS error body — likely an edge/WAF/proxy 403 (client fingerprint blocked) — auto-heal cannot fix this';
    this.logger.warn('WHMCS 403 not auto-healed', { action, message, healNote });
  }
}
```
Keep the cooldown/single-flight handling inside `attemptIpAllowlistHeal` (already there); this layer only narrates.

**Verify:** `npm run typecheck` exit 0.

### Step 2 — Enrich the thrown 403 with a classified hint + the heal note
Where the 403 `WhmcsTransportError` is constructed (the throw path ~line 360-390), when `status === 403` append a hint. Reuse the classification idea from `healthCheck.ts`:

```ts
if (status === 403) {
  const hint =
    'HTTP 403 from WHMCS. This is one of: (1) caller IP not in the WHMCS API ' +
    'allowlist (APIAllowedIPs); (2) an edge/WAF/proxy block on the client ' +
    'request fingerprint — verify by curling the same endpoint+IP (if curl ' +
    'works but this client gets 403, it is a WAF/fingerprint block, NOT an IP ' +
    'or credential issue); (3) a permission/role ACL on the credential. ' +
    (healNote ? `Auto-heal: ${healNote}. ` : '') +
    'See docs/runbooks/api-connectivity-troubleshooting.md';
  throw new WhmcsTransportError(`WHMCS HTTP error: 403 — ${hint}`, 403);
}
```
Place this so it only affects the 403 branch; leave other status handling unchanged.

**Verify:** `npm run typecheck` exit 0.

### Step 3 — Timeout-specific message (small, high-value)
In the connection-error throw path (the `axios.isAxiosError` branch without a response, ~line 386), distinguish a timeout: if `axiosError.code === 'ECONNABORTED'`, throw `new WhmcsTransportError('WHMCS request timed out after 30s — host slow or unreachable', undefined)` instead of the generic connection-error message. Leave other codes as-is.

**Verify:** `npm run typecheck` exit 0.

### Step 4 — Tests
Add to `tests/whmcs/whmcsClient403Heal.test.ts` (mirror its existing axios+config mock):
- A 403 with an **empty body** (WAF) → heal NOT attempted; thrown error message contains `WAF` and `api-connectivity-troubleshooting.md`.
- A 403 with a **permission** message (`"Invalid Permissions: ..."`) → heal NOT attempted; thrown error contains `permission/role`.
- A 403 with `"Invalid IP 1.2.3.4"` + `WHMCS_AUTO_IP_HEAL=false` → heal NOT attempted; thrown error mentions `WHMCS_AUTO_IP_HEAL is off`.
- (If the suite already mocks heal success) keep the existing happy-path test green.

**Verify:** `npx vitest run tests/whmcs/whmcsClient403Heal.test.ts` all pass.

### Step 5 — Full gate
`npm run typecheck && npm run lint && npm run format:check` clean; `WHMCS_API_URL=https://example.test WHMCS_IDENTIFIER=x WHMCS_SECRET=x MCP_INTEGRATION_SKIP=1 npm test` green.

## In scope
- `src/whmcs/WhmcsClient.ts` (403 handler narration + enriched 403/timeout throw).
- `tests/whmcs/whmcsClient403Heal.test.ts`.

## Out of scope (do NOT change)
- The `/invalid ip/i` heal gate semantics — keep heal scoped to genuine IP-403s.
- `RETRYABLE_STATUS_CODES` — 403 must remain non-retryable (don't retry auth/WAF).
- `attemptIpAllowlistHeal` internals (cooldown/single-flight/spawn).
- `childEnv` spread in `ipAllowlistHeal.ts` — it intentionally inherits `process.env` because the spawned SSH updater needs `HOME`/`PATH`/`SSH_AUTH_SOCK`/known-hosts; a strict whitelist would break SSH. (If you think it must change, STOP and report — it's a deliberate tradeoff.)

## Done criteria
- A 403 with no WHMCS body produces a thrown error whose message names a WAF/fingerprint possibility and points at the runbook — asserted by the new test.
- A 403 with `"Invalid IP"` + heal off mentions the disabled flag — asserted.
- `npm test` green.

## Maintenance note
The 403 hint and `healthCheck.ts`'s `forbidden` hint should stay consistent — if you change one, change the other (consider extracting a shared `forbidden` hint string in a later pass; not required here).

## Escape hatch
If the throw path has already been refactored to enrich 403s, only add what's missing. If `WhmcsTransportError`'s constructor signature differs from `(message, statusCode?)`, STOP and report.
