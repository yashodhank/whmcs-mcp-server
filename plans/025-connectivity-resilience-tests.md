# Plan 025: Regression tests for the connectivity / IP-heal / boot-check surface

> Written against commit `2b7f665`. Pure test additions — NO source changes.
> If Plan 024 lands first, also add its 403-hint assertions (noted below).

## Why this matters
The recent outage surfaced behavior that has thin or no test coverage. These are
the regression guards that would have caught (or will prevent re-breaking) the
failure modes we just lived through. All are low-risk test-only additions.

## Repo conventions
- vitest; tests under `tests/`. Mirror existing files:
  - `tests/whmcs/whmcsClient403Heal.test.ts` (axios + config `vi.mock`, mocked heal),
  - `tests/whmcs/ipAllowlistHeal.test.ts` (spawn mock, `_resetIpHealStateForTests`),
  - `tests/whmcs/healthCheck.test.ts` (pure classifier + wrapper),
  - `tests/config/apiEndpoint.test.ts` (pure config helper).
- Run: `WHMCS_API_URL=https://example.test WHMCS_IDENTIFIER=x WHMCS_SECRET=x MCP_INTEGRATION_SKIP=1 npm test`.
- Control the clock with `vi.spyOn(Date,'now')` or `vi.useFakeTimers()` — do NOT sleep.

## Steps (each is an independent test addition; all must end green)

### Step 1 — WAF / non-IP 403 is not healed (in `whmcsClient403Heal.test.ts`)
Add cases: a 403 with body `{message:'Access Denied'}`, a 403 with an **empty/HTML** body, and a 403 with `{message:'Invalid Permissions: ...'}`. Assert `attemptIpAllowlistHeal` is **not** called and the original 403 is thrown. If Plan 024 has landed, also assert the thrown message contains `api-connectivity-troubleshooting.md` and (for the empty-body case) `WAF`.

### Step 2 — `healAttempted` bounds healing to once per call
Mock `post()` to return `"Invalid IP 1.2.3.4"` 403 **twice**, and `attemptIpAllowlistHeal` to resolve `true` both times. Call a read. Assert `attemptIpAllowlistHeal` was called **exactly once** and the second 403 is thrown (no infinite heal loop).

### Step 3 — post-heal single retry: success AND failure (in `whmcsClient403Heal.test.ts`)
- Success: 403(Invalid IP) → heal true → second `post()` resolves success → result returned.
- Failure: 403(Invalid IP) → heal true → second `post()` 403 again → the 403 is thrown (not healed again — ties to Step 2).

### Step 4 — cooldown expiry re-runs the updater (in `ipAllowlistHeal.test.ts`)
With `vi.useFakeTimers()`: first `attemptIpAllowlistHeal` spawns + resolves; a second call within `WHMCS_AUTO_IP_HEAL_COOLDOWN_MS` is skipped (already covered — keep); then advance time past the cooldown and assert a third call **spawns again**. Use `_resetIpHealStateForTests()` in `beforeEach`.

### Step 5 — boot health-check modes (new `tests/startup.test.ts`)
`runStartupHealthCheck` currently lives in `src/index.ts` and is not exported. Two options — pick the lower-risk one and note it in the plan status:
- (preferred) This step is BLOCKED on a one-line source change (export `runStartupHealthCheck`). If you may not edit source under this test-only plan, instead test the building blocks directly: `checkWhmcsConnectivity` (already exported) with a mocked client for ok/!ok, and assert `classifyConnectivityError` mapping (already partly covered). Record that the `off|warn|strict` orchestration in `index.ts` remains untested and recommend Plan 024-or-later export it.
Assert, for the parts you can reach: success → `{ok:true}`; failure → `{ok:false, reason, hint}` non-throwing.

### Step 6 — doubled-path config warning (new `tests/config/healConfig.test.ts` or extend apiEndpoint test)
The config superRefine `console.warn`s when `WHMCS_API_URL` ends in `/includes/api.php`. Because `config` loads once at import, test the **observable contract** instead: assert `resolveWhmcsApiEndpoint('https://h/includes/api.php')` does not double (already in `apiEndpoint.test.ts`) AND add an `extractWhmcsError` / IPv6 case below. (Testing the actual `console.warn` requires re-importing config with a mutated env via `vi.resetModules()` + `vi.stubEnv` — include this only if straightforward; otherwise note it as not-cheaply-testable.)

### Step 7 — `extractWhmcsError` IPv6 + malformed extraction (in `whmcsClient403Heal.test.ts` or a focused test)
`extractWhmcsError` is not exported. If reachable only via the client, drive it through a mocked 403 with `"Invalid IP 2001:db8::1"` and assert the heal receives the IPv6 (or, if you export it in a tiny source change, unit-test it directly — note which you chose). Also a `"Invalid IP not-an-ip"` case → `isIpLiteral` rejects → updater called without the `--ipv4/--ipv6` target.

### Step 8 — Full gate
`npm run typecheck && npm run lint && npm test` all green.

## In scope
- `tests/whmcs/whmcsClient403Heal.test.ts`, `tests/whmcs/ipAllowlistHeal.test.ts`, optionally new `tests/startup.test.ts`, `tests/config/healConfig.test.ts`.

## Out of scope
- Source changes — EXCEPT, if you choose, a single additive `export` for `runStartupHealthCheck` / `extractWhmcsError` to enable a unit test. If you make that export, note it in the plan status and keep it export-only (no logic change). If that feels like scope creep, STOP and leave those two as "covered indirectly" with a note.

## Done criteria
- New tests for: non-IP/WAF 403 not healed; heal-once bound; post-heal retry success+failure; cooldown expiry re-run. All green under `npm test`.

## Maintenance note
These lock in the heal's **scope** (only `Invalid IP` 403s) and the single-retry/single-heal bounds. If someone broadens the heal trigger or the retryable codes, these tests should fail — that's intended.

## Escape hatch
If a referenced test file's mock setup differs substantially from what's described (e.g. heal not mockable as shown), STOP and report the actual structure rather than forcing the pattern.
