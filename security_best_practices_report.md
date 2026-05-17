# Security & Best Practices Audit Report

**Project:** WHMCS MCP Server  
**Date:** 2025-02-05  
**Scope:** Full codebase (config, security, tools, resources, WHMCS client, logging, errors, rate limiting)

---

## Executive Summary

The WHMCS MCP Server is a TypeScript/Node.js MCP (Model Context Protocol) server that proxies to the WHMCS API. The codebase shows **solid security hygiene** in several areas: Zod-validated config, optional MCP auth, client-scoped access mode, rate limiting, idempotency for high-risk operations, log redaction of sensitive fields, and error-message sanitization. No hardcoded secrets were found; credentials are loaded from environment variables.

**Critical and high-severity issues** identified are limited but important: **auth token comparison is not constant-time** (timing attack surface), **resource responses and error paths can expose the auth token** via the full URI (including query params), and **resource path parameters from URIs may be strings** while access checks expect numbers (potential bypass or denial). **Medium** items include: WHMCS API URL not restricted to `https`, CVV in tool params (PCI consideration), and large-refund threshold hardcoded. **Low / best-practice** items cover validation consistency, dependency hygiene, and minor code-quality improvements.

Recommended next steps: fix token comparison and URI handling (no token in responses/errors), coerce and validate resource IDs, then address medium/low items as capacity allows.

---

## Fixes applied (2025-02-05)

The following findings were addressed in code and docs:

| ID | Fix |
|----|-----|
| **SEC-001** | Auth token comparison now uses `crypto.timingSafeEqual` on SHA-256 hashes of both strings in `src/security.ts` (`safeCompareTokens`). |
| **SEC-002** | All resource and playbook responses use `stripAuthFromUri(uri)` so `contents[].uri` never includes `token` or `auth_token` query params. |
| **SEC-003** | Resource handlers in `src/resources/index.ts` parse path params with `parsePositiveId()`; `clientid`, `invoiceid`, and `ticketid` are coerced to positive integers and rejected with a clear error if invalid. |
| **SEC-004** | `resourceError()` is called with `stripAuthFromUri(uri)` instead of `uri.href`, so auth failure responses do not echo the token. |
| **SEC-005** | HTTPS scheme enforcement in `config.ts`: `WHMCS_API_URL` is parsed as a URL in the schema's `superRefine` and must use scheme `https:`; `http:` is rejected unless the new opt-in `WHMCS_ALLOW_HTTP=true` (boolean, default false), and any other scheme is rejected. Documented in README and `.env.example`. |
| **SEC-006** | PCI comment added next to the `cvv` schema field in `src/tools/billing.ts` stating CVV must never be logged/cached/persisted; the `capture_payment` handler strips `cvv` from params before `logToolCall` (defense-in-depth over key-name redaction); idempotency cache stores only the result object (no CVV). |
| **SEC-007** | Large refund threshold is configurable via `MCP_LARGE_REFUND_THRESHOLD` (Zod in `config.ts`, default 1000); documented in README and `.env.example`. |

Documentation updated: **README.md** (Security Considerations, optional env table, large refund wording), **.env.example** (`MCP_LARGE_REFUND_THRESHOLD`), and this report.

---

## Critical

### SEC-001: Auth token comparison is not constant-time

**Severity:** Critical  
**Location:** `src/security.ts`, lines 83–84 (tool auth), 98–99 (resource auth)

**Evidence:**
```typescript
if (!token || token !== required) {
  return toolError('Unauthorized: missing or invalid auth_token.');
}
```
```typescript
if (!token || token !== required) {
  return { ok: false, response: resourceError(uri.href, 'Unauthorized: missing or invalid token.') };
}
```

**Impact:** A remote attacker who can measure response timing could perform a timing attack to guess the MCP auth token character-by-character, especially when the token is passed in every request (tools) or in resource URIs.

**Fix:** Use `crypto.timingSafeEqual` for comparing token and required value. Ensure both buffers are the same length (e.g., hash both with a fixed algorithm, or pad to a fixed length) before comparison, and reject immediately if lengths differ.

**Mitigation:** Keep tokens long and random; limit brute-force attempts via rate limiting (already present).

---

### SEC-002: Auth token exposed in resource URI in responses and error paths

**Severity:** Critical  
**Location:**  
- `src/security.ts` line 100: `resourceError(uri.href, ...)`  
- `src/resources/index.ts`: all resource handlers return `uri: uri.href` in `contents[].uri`  
- `src/playbook/whmcsOpsPlaybook.ts` line 129: `uri: uri.href`

**Evidence:**  
Resource templates use `{?token,auth_token}`. The full URI (including query string) is returned to the MCP client in (1) success responses as `contents[].uri`, and (2) auth failure responses via `resourceError(uri.href, ...)`.

**Impact:** The MCP auth token can be leaked to the client (e.g., AI host or logs), enabling unauthorized access to tools and resources.

**Fix:**
1. **Strict:** Never return the raw URI with query params. Introduce a helper that returns the URI with auth query params stripped (e.g., remove `token`, `auth_token`), and use that for all `contents[].uri` and for the first argument to `resourceError`.
2. In `resourceError`, pass only the path (or path + non-sensitive query), not `uri.href` (so the token is never echoed back).

**Mitigation:** Until fixed, advise operators not to log MCP client responses and to use short-lived or scoped tokens.

---

## High

### SEC-003: Resource path parameters may be strings; access checks expect numbers

**Severity:** High  
**Location:** `src/resources/index.ts` – all resource handlers use `params.clientid`, `params.invoiceid`, `params.ticketid` from the URI template.

**Evidence:**  
MCP resource template params from the URI (e.g. `whmcs://clients/123/summary`) are typically strings. Code passes them to:
- `ensureClientAllowed(clientid)` in `security.ts`, which uses `config.MCP_ALLOWED_CLIENT_IDS.includes(clientId)` (array of numbers).
- WHMCS API calls such as `GetClientsDetails`, `GetInvoice`, `GetTicket` which expect numeric IDs.

**Impact:**  
- If `clientid` is the string `"123"` and allowed list is `[123]`, `allowed.includes("123")` is false → legitimate client is denied (availability issue).  
- If the runtime or API coerces strings to numbers elsewhere, type confusion could lead to inconsistent access control (e.g., `"0123"` vs `123`).

**Fix:**  
At the start of each resource handler, coerce and validate path params (e.g. `clientid`, `invoiceid`, `ticketid`) to integers with Zod or equivalent (positive integers), and reject with a 400-style error if invalid. Use the coerced number for both `ensureClientAllowed` / `ensureClientOwnership` and WHMCS API calls.

---

### SEC-004: Error response can echo URI with token (resource auth failure)

**Severity:** High  
**Location:** `src/security.ts` line 100

**Evidence:**  
`resourceError(uri.href, 'Unauthorized: missing or invalid token.')` passes the full URI (including `?token=...` or `?auth_token=...`) as the first argument. That value is then used in the resource error response (see `resourceError` building `contents[].uri`).

**Impact:** On auth failure, the client receives the exact URI it requested, including the (possibly wrong) token, which could leak a mistyped secret or confirm token format. It also reinforces SEC-002 (token in responses).

**Fix:** Same as SEC-002: strip auth params from any URI returned to the client, and in `resourceError` use a sanitized URI (path only or path + non-auth query) for the `uri` field in the response.

---

## Medium

### SEC-005: WHMCS API URL not restricted to HTTPS

**Severity:** Medium  
**Location:** `src/config.ts` lines 21–22, 104–106

**Evidence:**  
`WHMCS_API_URL` is validated only as non-empty string. `getWhmcsApiEndpoint()` only trims a trailing slash. There is no scheme or host allowlist.

**Impact:** Misconfiguration (e.g. `http://` or typo like `ftp://`) could send API credentials over an insecure or wrong protocol, leading to credential theft or SSRF-like behavior.

**Fix:** In config schema, validate that `WHMCS_API_URL` is a URL with scheme `https` (and optionally allow `http` only when `NODE_ENV !== 'production'` or an explicit `WHMCS_ALLOW_HTTP=true`). Reject other schemes.

**Status:** Fixed — `config.ts` now parses `WHMCS_API_URL` as a URL in the schema's `superRefine`; `https:` is required, `http:` is rejected unless `WHMCS_ALLOW_HTTP=true` (new boolean env, default false), and any other scheme is rejected. Documented in README and `.env.example`.

---

### SEC-006: CVV in tool parameters (PCI scope)

**Severity:** Medium  
**Location:** `src/tools/billing.ts` lines 109–112, 417–418

**Evidence:**  
`capturePaymentSchema` includes `cvv: z.string().optional()`, and the value is passed to WHMCS `CapturePayment`. CVV is PCI-sensitive and must not be stored or logged.

**Impact:** If CVV is ever logged (e.g. via tool inputs before redaction), or stored in idempotency cache, it could violate PCI DSS. Current logging redacts by key name (`cvv` is in `SENSITIVE_FIELDS` in `logging.ts`), so normal tool logs are safe; the main risk is future code paths or caches that might persist request payloads.

**Fix:**  
- Confirm that idempotency cache for `capture_payment` does not store CVV (it currently caches a result object that does not include CVV – good).  
- Document in code that CVV must never be stored or logged; consider stripping it from any object before caching or logging if the schema is extended.  
- Optional: add a short comment next to `cvv` in the schema that it is PCI-sensitive and must not be persisted.

**Status:** Fixed — a PCI comment was added next to the `cvv` schema field in `src/tools/billing.ts` (must never be logged/cached/persisted); the `capture_payment` handler strips `cvv` from params before `logToolCall` (defense-in-depth over key-name redaction); the idempotency cache stores only the result object (no CVV).

---

### SEC-007: Large refund threshold hardcoded

**Severity:** Medium (operational / best practice)  
**Location:** `src/tools/billing.ts` line 91

**Evidence:**  
`const LARGE_REFUND_THRESHOLD = 1000;`

**Impact:** Threshold cannot be tuned per environment (e.g. different currencies or risk appetites) without code change.

**Fix:** Read from environment (e.g. `MCP_LARGE_REFUND_THRESHOLD`) with Zod, default `1000`, and document in `.env.example`.

---

## Low / Best Practices

### BP-001: Logging tool inputs before Zod parse

**Severity:** Low  
**Location:** Various tool handlers (e.g. `src/tools/clients.ts`, `src/tools/billing.ts`) – `toolLogger.logToolCall(toolName, params, ...)` is called with `params` as received by the handler.

**Evidence:** MCP may pass params that are then validated by the tool’s schema. If validation fails at the framework layer, the handler might not run; if it runs, `params` are typically already parsed. The main risk would be if raw/unparsed input were ever logged – currently the handler receives parsed params, and redaction applies. So this is low risk.

**Recommendation:** Ensure no code path logs raw request bodies before validation. Current flow appears safe; add a short comment in logging that tool logs must only receive validated/sanitized params.

---

### BP-002: Create_client simulate response uses random clientid

**Severity:** Low  
**Location:** `src/tools/clients.ts` lines 221–223

**Evidence:**  
`performClientCreation` passes `{ clientid: Math.floor(Math.random() * 10000) + 1000 }` as the third argument to `mutate`, which is used as the simulated response in simulate mode.

**Impact:** Simulate mode returns a different fake ID on each call; no security impact, but tests or docs might expect a stable value.

**Recommendation:** Use a fixed placeholder (e.g. `0` or `99999`) for simulate mode so behavior is deterministic and documented.

---

### BP-003: search_clients search term not sanitized

**Severity:** Low  
**Location:** `src/tools/clients.ts` – `search_clients` passes `params.search` directly to WHMCS `GetClients`.

**Evidence:** Other client-facing text (e.g. create_client) uses `sanitizeTextInput`; search does not. WHMCS API is server-side and should parameterize; risk is low but inconsistent with rest of codebase.

**Recommendation:** Run `params.search` through a sanitizer (e.g. same as `sanitizeTextInput` or a search-specific allowlist) for consistency and defense-in-depth.

---

### BP-004: Dependency and audit hygiene

**Severity:** Low  
**Location:** `package.json`, lockfile, CI

**Evidence:** Dependencies use caret ranges; lockfile pins versions. No `npm audit` or similar step was observed in the repo.

**Recommendation:**  
- Run `npm audit` (and optionally `npm audit fix`) periodically; address critical/high advisories.  
- Consider adding a CI step that runs `npm audit --audit-level=high` (or similar) so new vulnerabilities are flagged.  
- Keep `@modelcontextprotocol/sdk` and `axios` updated for security patches.

---

### BP-005: Error messages and stack traces in production

**Severity:** Low  
**Location:** `src/index.ts` (uncaughtException, unhandledRejection), and tool/resource catch blocks that rethrow.

**Evidence:** Uncaught handlers write `error.message` and `error.stack` to stderr and exit. Tool/resource handlers often return a JSON error message to the client and sometimes rethrow. MCP clients typically see only the JSON content; stderr is process-local.

**Impact:** If stderr is ever captured or forwarded to a logging system accessible to untrusted parties, stack traces could leak internal paths or logic. Current design (stdio MCP, stderr for logs) is reasonable.

**Recommendation:** In production, avoid writing full `error.stack` to any channel that might leave the trusted boundary; log stacks server-side only and ensure log aggregation access is restricted.

---

## Positive Findings

- **Configuration:** Zod schema for env vars; fail-fast on missing/invalid config; no secrets in code.
- **Secrets in logs:** `SENSITIVE_FIELDS` and `redactSensitive()` in `logging.ts`; error sanitization in `errors.ts` with `sanitizeErrorMessage`.
- **Auth:** Optional MCP auth token; client mode with `MCP_ALLOWED_CLIENT_IDS`; tool allowlist; admin vs client access enforced in security module.
- **Rate limiting:** Token-bucket rate limiter; applied to tools and resources.
- **Idempotency:** High-risk tools (`capture_payment`, `record_refund`, `accept_order`, `terminate_service`) use idempotency keys and cache to reduce duplicate operations.
- **Input validation:** Zod schemas on all tools; sanitization (e.g. `sanitizeTextInput`) on client-facing text; numeric bounds (e.g. `MCP_MAX_PAGE_SIZE`).
- **Safety guards:** Large refund confirmation; terminate confirmation; read_only/simulate/full modes.
- **Docker:** Non-root user, multi-stage build, production deps only, healthcheck.
- **No SQL/NoSQL/command injection:** No raw queries or shell execution; all external calls go through the WHMCS API client with structured params.

---

## Summary Table

| ID       | Severity  | Topic                              | Status |
|----------|-----------|-------------------------------------|--------|
| SEC-001  | Critical  | Constant-time token comparison      | **Fixed** (safeCompareTokens) |
| SEC-002  | Critical  | Token in resource URI in responses  | **Fixed** (stripAuthFromUri) |
| SEC-003  | High      | Resource path params type/validation| **Fixed** (parsePositiveId) |
| SEC-004  | High      | Token in auth error response       | **Fixed** (stripAuthFromUri in resourceError) |
| SEC-005  | Medium    | WHMCS URL scheme                    | **Fixed** (https enforced; WHMCS_ALLOW_HTTP opt-in) |
| SEC-006  | Medium    | CVV in tool params                  | **Fixed** (PCI comment; cvv stripped before log; not cached) |
| SEC-007  | Medium    | Large refund threshold              | **Fixed** (MCP_LARGE_REFUND_THRESHOLD) |
| BP-001–BP-005 | Low  | Logging, simulate, search, deps, errors | Optional improvements |

---

## References

- OWASP Node.js Security Cheat Sheet  
- Express/Node security best practices (conceptually applied to MCP stdio server)  
- Project skill: `security-best-practices` (references/javascript-express-web-server-security.md)
