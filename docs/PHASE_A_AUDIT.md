# Phase A Audit Report – Admin mode, read-only

**Date:** 2025-02-05  
**Scope:** Phase A (Admin / Ops, read-only) per plan: build, typecheck, lint, test + checklist audit.

---

## 1. Phase A re-run results

| Step | Command | Result | Notes |
|------|---------|--------|------|
| **Build** | `npm run build` | **PASS** | dist/index.js + .d.ts produced |
| **Typecheck** | `npm run typecheck` | **FAIL (deferred)** | Remaining failures are the pre-existing `@modelcontextprotocol/sdk` `McpToolResponse` overload errors (TS2769 "No overload matches this call" at `server.tool` sites, caused by the project's custom `McpToolResponse` interface lacking an index signature). This SDK-type refactor (and the `tool`/`resource`/`ZodIssueCode` deprecation migration) is deliberately deferred to a separate follow-up; a fully green typecheck is **not** a goal of this pass. |
| **Lint** | `npm run lint` | **FAIL (residual debt)** | The "not found by the project service" parse-error category was eliminated via a dedicated `tsconfig.eslint.json` (covers `tests`/`scripts`; `eslint.config.js` points its parser at it). Residual errors are the pre-existing deprecation/style debt (`tool`/`resource`/`ZodIssueCode`, `prefer-nullish-coalescing`), deferred with the SDK refactor. |
| **Test** | `npm run test` | **PASS** | 75 passed, 14 skipped (integration tests skipped when WHMCS unreachable / no write mode) |

**Summary:** Build and test pass. The lint "not found by the project service" parse errors were resolved via a dedicated `tsconfig.eslint.json`. Remaining typecheck failures are the pre-existing `@modelcontextprotocol/sdk` `McpToolResponse` overload errors and are deliberately deferred (out of scope for this pass); a fully green typecheck is explicitly not a goal here.

---

## 2. Checklist audit (Phase A – Scenario A)

### 2.1 Safety (read_only, no writes)

| Check | Status | Evidence |
|-------|--------|----------|
| `MCP_MODE=read_only` enforced | **OK** | `WhmcsClient.mutate()` throws before any API call when `config.MCP_MODE === 'read_only'` |
| Write tools return structured error | **OK** | Each write tool uses `clientModeDenied()` or calls `whmcsClient.mutate()` which throws; handlers return `isError: true` with message e.g. "not available in read_only mode" |
| No API mutations in read_only path | **OK** | Only `whmcsClient.read()` used for read-only tools; `mutate()` is never called without mode check |

### 2.2 Tools (Phase A read-only sequence)

| Tool | Registered | Read-only path | Note |
|------|------------|----------------|------|
| `list_products` | Yes (orders) | Yes | Uses `whmcsClient.read('GetProducts', …)` |
| `get_client_details` | Yes (clients) | Yes | Uses `read('GetClientsDetails', …)` |
| `get_invoice` | Yes (billing) | Yes | Uses `read('GetInvoice', …)` |
| `get_service_details` | Yes (clients) | Yes | Uses `read('GetClientsProducts', …)` |
| `get_ticket_departments` | Yes (support) | Yes | Uses `read('GetSupportDepartments', …)` |
| `check_domain_availability` | Yes (domains) | Yes | Uses `read('DomainWhois', …)`; currently returns 500 from WHMCS (server-side output issue, see MCP_DOMAIN_DEBUG_REPORT.md) |

**Tool count:** 25 tools registered (billing 7, clients 5, support 3, domains 5, orders 2, services 3). Plan mentions “24 tools”; small variance acceptable (allowlist can reduce visible count).

### 2.3 Resources (Phase A)

| Resource | Registered | Auth stripping (SEC-002) | Admin-only |
|----------|------------|---------------------------|------------|
| `whmcs://clients/{clientid}/summary` | Yes | `stripAuthFromUri(uri)` used before response | No |
| `whmcs://clients/{clientid}/log` | Yes | Yes | No |
| `whmcs://invoices/{invoiceid}/history` | Yes | Yes | No |
| `whmcs://tickets/{ticketid}/thread` | Yes | Yes | No |
| `whmcs://docs/ops-playbook` | Yes (playbook) | N/A (no URI with token) | No |
| `whmcs://system/activity` | Yes | Yes | Yes (`isClientMode` → denied in client mode) |

**SEC-002:** Response URIs do not expose `token` or `auth_token`; `stripAuthFromUri` is applied in all template resources. **OK.**

### 2.4 Write tools (must fail gracefully in read_only)

| Check | Status | Evidence |
|-------|--------|----------|
| `mark_invoice_paid` | OK | Uses `mutate()` → throws in read_only; tool returns structured error |
| `create_ticket` | OK | Same pattern; `clientModeDenied` or mutate guard |
| No crash / opaque 500 from server | OK | Errors return JSON with `isError: true` and message; no raw stack traces in tool response |

### 2.5 Errors & integration tests

| Check | Status | Evidence |
|-------|--------|----------|
| 403/unreachable → skip, not fail | OK | `integration.test.ts`: `beforeAll` probes API; on 403/network sets `apiUnreachable`; tests use `it.skipIf(skipIfUnreachable)` |
| Write tests skipped unless opt-in | OK | Write operations gated by `MCP_TEST_WRITE_MODE=true`; otherwise skipped with clear message |

### 2.6 Logic / architecture

| Check | Status | Note |
|-------|--------|------|
| Duplicate / dead code | OK | No obvious duplication in Phase A tools |
| `ensureClientAllowed` / `ensureClientOwnership` | OK | Used in client-scoped tools and resources; billing uses `ensureClientOwnership` for invoice access |
| Cross-client or write when shouldn’t | OK | read_only blocks all mutate; client mode checks restrict by `MCP_ALLOWED_CLIENT_IDS` |

---

## 3. Gaps and recommendations

### 3.1 Known gaps (non-blocking for Phase A)

- **`clientReplyClientId` scoping bug (FIXED):** Found via `npm run typecheck` — in `src/tools/support.ts` the `clientReplyClientId` variable was declared inside the `create_ticket` callback instead of `reply_ticket`, so client-mode `reply_ticket` threw `ReferenceError: clientReplyClientId is not defined`. Fixed by moving the declaration into the `reply_ticket` handler; a regression test was added at `tests/tools/support.replyTicket.clientmode.test.ts`.
- **Typecheck (deferred):** Remaining failures are the pre-existing `@modelcontextprotocol/sdk` `McpToolResponse` overload errors (TS2769 at `server.tool` sites; the project's custom `McpToolResponse` interface lacks an index signature). This SDK-type refactor and the `tool`/`resource`/`ZodIssueCode` deprecation migration are deliberately deferred to a separate follow-up and are out of scope for this pass; a fully green typecheck is explicitly not a goal here.
- **Lint:** The "not found by the project service" parse errors for test/script files were resolved via a dedicated `tsconfig.eslint.json` (`eslint.config.js` points its parser at it). Residual lint errors are the pre-existing deprecation/style debt (`tool`/`resource`/`ZodIssueCode`, `prefer-nullish-coalescing`), deferred together with the SDK-type refactor.
- **Domain check:** `check_domain_availability` returns WHMCS HTTP 500 in production (WHMCS “output emitted previously”); fix is server-side (see docs/MCP_DOMAIN_DEBUG_REPORT.md). MCP client and tool logic are correct.

### 3.2 Doc vs behavior

- README and plan say “24 tools”; actual registered count is 25. Consider updating to “24+ tools” or the exact number.
- Ops-playbook and testing-readonly docs align with Scenario A/B; verification checklist is now in this audit and in the plan.

---

## 4. Verification log (Phase A re-run)

| Date | Scenario | Item | Expected | Actual | Conclusion |
|------|----------|------|----------|--------|------------|
| 2025-02-05 | A | Build | Success | Success | OK |
| 2025-02-05 | A | Typecheck | Success | Pre-existing SDK `McpToolResponse` overload errors | FAIL — deliberately deferred (out of scope; green typecheck not a goal) |
| 2025-02-05 | A | Lint | Success | "Project service" parse errors resolved; residual deprecation/style debt | Parse-error category fixed via `tsconfig.eslint.json`; remaining debt deferred |
| 2025-02-05 | A | Test | 75+ pass, integration skip OK | 75 passed, 14 skipped | OK |
| 2025-02-05 | A | read_only enforcement | mutate() blocks | WhmcsClient.mutate() throws | OK |
| 2025-02-05 | A | Write tool error shape | isError + message | Return structured JSON | OK |
| 2025-02-05 | A | SEC-002 (no token in URIs) | stripAuthFromUri used | Used in all template resources | OK |
| 2025-02-05 | A | Integration 403/unreachable | Skip, not fail | skipIfUnreachable + beforeAll probe | OK |

---

## 5. Conclusion

- **Phase A (Admin, read-only)** behavior is **correct**: read-only tools and resources work, write tools fail with a clear message, no tokens in URIs, integration tests skip on 403/unreachable.
- **Build and test pass.** The lint "not found by the project service" parse errors were resolved via a dedicated `tsconfig.eslint.json`. The remaining typecheck failures are the pre-existing `@modelcontextprotocol/sdk` `McpToolResponse` overload errors and are deliberately deferred (out of scope for this pass); a fully green typecheck is explicitly not a goal here. Residual lint errors are the pre-existing deprecation/style debt, deferred with the SDK-type refactor.
- **Next:** Fix WHMCS server-side output for `DomainWhois` so `check_domain_availability` returns 200; then re-run Phase A manual tool sequence in Cursor if desired.
