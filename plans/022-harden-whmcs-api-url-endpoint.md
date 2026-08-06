# Plan 022: Harden WHMCS_API_URL → endpoint resolution (no more doubled `/includes/api.php`)

> Written against commit `1275532`. If `src/config.ts` has materially changed
> around `getWhmcsApiEndpoint` since then, re-read it before proceeding.

## Why this matters (full context — executor has not seen the incident)

On 2026-06-19 the entire WHMCS MCP server returned `{"result":"error","message":"An admin user is required"}` for **every** API call (reads and writes). Hours were spent inspecting the credential, the admin account, admin roles, and the IP allowlist on the production server — all of which were fine.

**Actual root cause:** `WHMCS_API_URL` in the deployment env was set to the *full* endpoint `https://my.securiace.com/includes/api.php`, but `getWhmcsApiEndpoint()` unconditionally appends `/includes/api.php`. The effective request URL became:

```
https://my.securiace.com/includes/api.php/includes/api.php
```

WHMCS serves that doubled path with **HTTP 200** (PHP `PATH_INFO` routing) but dispatches it to an admin-session handler instead of the API-credential handler, so it rejects with `"An admin user is required"` — *before* validating the credential. Proof from the incident: the single-path URL with the identical credentials returned `result: success`, the doubled path returned the error, and the web access log literally showed `POST /includes/api.php/includes/api.php`.

This is a foot-gun: pasting the obvious-looking full endpoint into `WHMCS_API_URL` silently breaks everything with a misleading error. The fix makes endpoint resolution tolerant of both the base origin and the full endpoint, and adds a startup signal when normalization had to intervene.

## Current state

`src/config.ts:416-419`:

```ts
export function getWhmcsApiEndpoint(): string {
  const baseUrl = config.WHMCS_API_URL.replace(/\/$/, ''); // Remove trailing slash
  return `${baseUrl}/includes/api.php`;
}
```

- It strips a single trailing slash, then **always** appends `/includes/api.php`.
- It reads the module-level `config` singleton directly, so it is not unit-testable with varying inputs without re-importing the module. We will extract a pure helper.
- `WHMCS_API_URL` is validated in the zod `superRefine` block at `src/config.ts:341-373` (SEC-005: must be a valid absolute URL, https unless `WHMCS_ALLOW_HTTP`, not a blocked host). That block is where a "you pasted the full endpoint" notice belongs, but it must **not** hard-fail — normalization handles it; we only warn.

## Repo conventions to follow

- Pure, exported helpers with JSDoc; see the existing `getWhmcsApiEndpoint` / `isToolAllowed` style in `src/config.ts`.
- Tests are `vitest`, files under `tests/`, run with `npm test`. For a pure function, prefer a direct unit test (no config mocking) — see `tests/whmcs/whmcsClientCache.test.ts` for the project's vitest style, but you will NOT need its `vi.mock('../../src/config.js')` dance because the new helper takes its input as a parameter.
- Formatting is enforced: `npm run format:check` and `npm run lint` must stay green.

## Steps

### Step 1 — Extract a pure, tolerant resolver

In `src/config.ts`, replace the `getWhmcsApiEndpoint` function with:

```ts
/**
 * Normalize a configured WHMCS base URL into the full legacy API endpoint.
 *
 * Tolerant by design: operators frequently paste the *full* endpoint
 * (`https://host/includes/api.php`) or add trailing slashes. Appending the API
 * path unconditionally then produces `/includes/api.php/includes/api.php`, which
 * WHMCS serves with HTTP 200 but routes to an admin-session handler — surfacing
 * the misleading `"An admin user is required"` for every call. This function
 * accepts either the base origin or the full endpoint and always returns the
 * correct single-path endpoint. Pure + exported for testing.
 */
export function resolveWhmcsApiEndpoint(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, ''); // strip whitespace + trailing slashes
  // Already a full endpoint? Don't append again (case-insensitive on the path).
  if (/\/includes\/api\.php$/i.test(trimmed)) return trimmed;
  return `${trimmed}/includes/api.php`;
}

/**
 * Get the full WHMCS API endpoint URL from the active config.
 */
export function getWhmcsApiEndpoint(): string {
  return resolveWhmcsApiEndpoint(config.WHMCS_API_URL);
}
```

**Verify:** `npm run typecheck` → exit 0.

### Step 2 — Warn at startup when the operator pasted the full endpoint

This is the diagnostic signal that would have saved the incident. In the `superRefine` block in `src/config.ts` (the SEC-005 area around line 352, inside `if (parsedUrl) { ... }`), add — **after** the existing https/host checks, do NOT add a `ctx.addIssue` (that would hard-fail); instead emit a one-time warning to stderr:

```ts
      // DX: the resolver tolerates a full endpoint, but warn so the operator
      // fixes the env — a doubled path historically caused a silent outage.
      if (/\/includes\/api\.php\/?$/i.test(parsedUrl.pathname)) {
        // eslint-disable-next-line no-console
        console.warn(
          '[config] WHMCS_API_URL includes "/includes/api.php"; expected the base origin ' +
            '(e.g. https://billing.example.com). It will be normalized, but set the base URL to avoid ambiguity.'
        );
      }
```

If `console.warn` violates a lint rule with no inline-disable convention in this file, instead import and use the project `Logger` only if one is already imported in `config.ts`; **do not** add a new import that creates a circular dependency (`config.ts` is imported by `logging.ts`). If neither `console.warn` (with disable) nor an existing logger is clean, **STOP** and report — emitting the warning from `WhmcsClient` constructor instead is the fallback, but check with the maintainer first.

**Verify:** `npm run lint` → exit 0; `npm run typecheck` → exit 0.

### Step 3 — Unit-test the resolver across the edge-case matrix

Create `tests/config/apiEndpoint.test.ts`:

```ts
/**
 * resolveWhmcsApiEndpoint — tolerant WHMCS endpoint normalization.
 * Regression guard for the 2026-06-19 doubled-path outage (Plan 022).
 */
import { describe, it, expect } from 'vitest';
import { resolveWhmcsApiEndpoint } from '../../src/config.js';

describe('resolveWhmcsApiEndpoint', () => {
  const E = 'https://h.example.com/includes/api.php';
  it('appends the API path to a bare origin', () => {
    expect(resolveWhmcsApiEndpoint('https://h.example.com')).toBe(E);
  });
  it('strips a trailing slash then appends', () => {
    expect(resolveWhmcsApiEndpoint('https://h.example.com/')).toBe(E);
  });
  it('strips multiple trailing slashes', () => {
    expect(resolveWhmcsApiEndpoint('https://h.example.com///')).toBe(E);
  });
  it('does NOT double when the full endpoint is given', () => {
    expect(resolveWhmcsApiEndpoint('https://h.example.com/includes/api.php')).toBe(E);
  });
  it('does NOT double when the full endpoint has a trailing slash', () => {
    expect(resolveWhmcsApiEndpoint('https://h.example.com/includes/api.php/')).toBe(E);
  });
  it('is case-insensitive on the api path segment', () => {
    expect(resolveWhmcsApiEndpoint('https://h.example.com/Includes/Api.php')).toBe(
      'https://h.example.com/Includes/Api.php'
    );
  });
  it('trims surrounding whitespace', () => {
    expect(resolveWhmcsApiEndpoint('  https://h.example.com  ')).toBe(E);
  });
  it('preserves a sub-path install (WHMCS not at web root)', () => {
    expect(resolveWhmcsApiEndpoint('https://h.example.com/billing')).toBe(
      'https://h.example.com/billing/includes/api.php'
    );
  });
  it('does not double for a sub-path install already pointing at the endpoint', () => {
    expect(resolveWhmcsApiEndpoint('https://h.example.com/billing/includes/api.php')).toBe(
      'https://h.example.com/billing/includes/api.php'
    );
  });
});
```

**Verify:** `npx vitest run tests/config/apiEndpoint.test.ts` → all pass.

### Step 4 — Full gate

Run, all must be green:
- `npm run typecheck`
- `npm run lint`
- `npm run format:check` (if it fails only on the new files, run `npx prettier --write` on the two changed files and re-check)
- `npm test` (set dummy creds as the suite's global setup requires: `WHMCS_API_URL`, `WHMCS_IDENTIFIER`, `WHMCS_SECRET` must be present — e.g. `WHMCS_API_URL=https://example.test WHMCS_IDENTIFIER=x WHMCS_SECRET=x MCP_INTEGRATION_SKIP=1 npm test`)

## In scope
- `src/config.ts` — `getWhmcsApiEndpoint` refactor + new `resolveWhmcsApiEndpoint` + the startup warning.
- `tests/config/apiEndpoint.test.ts` — new.

## Out of scope (do NOT touch)
- `WhmcsClient.ts` request logic, retry, auth params — the bug is purely endpoint resolution.
- The SEC-005 https/host validation rules — leave their behavior unchanged; only ADD the warning.
- `.env*` files — operator config, not code (the deployment value is fixed separately).

## Done criteria (machine-checkable)
- `resolveWhmcsApiEndpoint('https://h/includes/api.php')` returns `https://h/includes/api.php` (no doubling) — asserted by the new test.
- `resolveWhmcsApiEndpoint('https://h')` returns `https://h/includes/api.php` — asserted.
- `npm run typecheck && npm run lint && npm test` all exit 0.

## Maintenance note
Anyone changing `WHMCS_API_URL` semantics, or adding a non-legacy (REST) endpoint, must update `resolveWhmcsApiEndpoint` and its test matrix. The doubled-path failure mode is silent at the HTTP layer (200, not 4xx) — keep the regression tests.

## Escape hatch
If, when you open `src/config.ts`, `getWhmcsApiEndpoint` already normalizes (someone fixed it), STOP and report "already fixed" rather than rewriting. If `WHMCS_API_URL` is no longer a plain string in config (schema changed), STOP and report.
