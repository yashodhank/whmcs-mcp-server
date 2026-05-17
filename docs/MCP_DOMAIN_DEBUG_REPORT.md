# WHMCS MCP – Domain check live debug report

**Date:** 2025-02-05  
**Instance:** Production read-only (my.securiace.com)  
**Test domains:** dsri-marks.com (not registered), securiace.com (registered)

---

## 1. How MCP is queried (flow)

### 1.1 Configuration

- **Cursor MCP config:** `cursor-mcp-config.json` defines server `whmcs` with:
  - `command`: `node`
  - `args`: `[ ".../whmcs-mcp-server/dist/index.js" ]`
  - `env`: `WHMCS_API_URL`, `WHMCS_IDENTIFIER`, `WHMCS_SECRET`, `MCP_MODE=read_only`, `MCP_DEBUG=false`

- **MCP server:** Loads `.env` (or env from Cursor), validates via `src/config.ts` (Zod), starts stdio transport, registers tools including `check_domain_availability`.

- **Domain tool:** `src/tools/domains.ts` registers `check_domain_availability` which:
  1. Validates and normalizes domain (e.g. `dsri-marks.com` → lowercased).
  2. Checks domain format (IDN/punycode allowed).
  3. Consumes rate limit.
  4. Calls `whmcsClient.read('DomainWhois', { domain })`.

### 1.2 WHMCS API call

- **Client:** `src/whmcs/WhmcsClient.ts`
  - `read()` → `call()` with `isMutating: false`.
  - Builds POST body: `action=DomainWhois`, `identifier`, `secret`, `responsetype=json`, `domain=<value>`.
  - POST to `{WHMCS_API_URL}/includes/api.php` (e.g. `https://my.securiace.com/includes/api.php`).
  - On HTTP 5xx: retries up to 3 times (exponential backoff), then throws `WhmcsTransportError` with status code.
  - **Enhancement:** On final 5xx, the client now logs the response body (first 2000 chars) when throwing, so stderr shows WHMCS error output when MCP_DEBUG is enabled or in logs.

### 1.3 MCP tool response

- **Success:** Returns JSON content: `{ domain, status: 'available'|'unavailable'|'unknown', raw_status, reason? }`.
- **Error:** Returns `isError: true` and message (e.g. rate limit, invalid domain, or WHMCS error).

---

## 2. Live test results (real WHMCS prod)

### 2.1 MCP tool invocations (via Cursor)

| Domain           | Expected (typical) | Actual MCP result      |
|------------------|--------------------|------------------------|
| dsri-marks.com   | available          | **WHMCS HTTP error: 500** |
| securiace.com    | unavailable        | **WHMCS HTTP error: 500** |

Both calls reached the WHMCS API (auth and routing are OK). The server responded with HTTP 500 for both domains.

### 2.2 Raw API debug (npm run debug:domain-whois)

Script: `scripts/debug-domain-whois.ts` (default domains: dsri-marks.com, securiace.com).

**Command run:**

```bash
npm run debug:domain-whois
```

**Result:** HTTP 500 for both domains. Response body is HTML (WHMCS error page), not JSON.

---

## 3. Curl vs MCP comparison (root cause isolation)

To confirm whether the failure is client-specific or server-side, the same DomainWhois request was sent in two ways:

| Test | How | HTTP status | Response body |
|------|-----|-------------|----------------|
| **Curl (direct)** | `npm run curl:domain-whois` → spawns `curl -X POST .../api.php --data-binary @tmpfile` (same endpoint, same POST body as MCP) | **500** | Same HTML error page with `EmitterException: Output has been emitted previously` |
| **Node / MCP path** | `npm run debug:domain-whois` → axios POST with same URL and body (identical to WhmcsClient) | **500** | Same HTML error page |
| **MCP server** | Cursor → MCP tool `check_domain_availability` → WhmcsClient.read('DomainWhois', { domain }) | **500** | Same (MCP returns “WHMCS HTTP error: 500” to the client) |

**Conclusion:** Curl and Node (and therefore MCP) get the **same** HTTP 500 and the **same** response body. The request method and client do not matter. The failure is **entirely on the WHMCS server**: something sends output before the API emits the JSON response, so Laminas throws and WHMCS returns the 500 error page. No change to the MCP server or client code can fix this; the fix must be on the WHMCS host.

---

## 4. Root cause (WHMCS server-side)

The 500 response body shows:

```
Laminas\HttpHandlerRunner\Exception\EmitterException: Output has been emitted previously; cannot emit response
  in .../laminas-httphandlerrunner/.../EmitterException.php
  ...
  SapiEmitter->assertNoPreviousOutput()
  ...
  includes/api.php(0): ... SapiEmitter->emit(Object(WHMCS\Http\Message\JsonResponse))
```

**Meaning:** Something executed before the API sends the JSON response has already sent output (e.g. `echo`, `print`, stray whitespace, BOM, or a hook/addon writing to stdout). Laminas then refuses to send the real response, and WHMCS returns a 500 error page.

So:

- **DomainWhois** and the MCP client are behaving as designed.
- The failure is **on the WHMCS server**: unintended output before the API response.

Common causes:

1. PHP notice/warning/error printed before JSON.
2. Hook or addon that runs on API requests and echoes or prints.
3. BOM or whitespace in an included file (e.g. `api.php` or a required module).
4. Debug/error handler that prints before the JSON response.

---

## 5. Solution required to fix it

The fix must be applied **on the WHMCS server** (my.securiace.com), not in the MCP server or Cursor.

1. **Find what emits output before the API response**
   - Check PHP/WHMCS error logs for notices or warnings when hitting `includes/api.php`.
   - Disable third-party addons/hooks one by one; after each change run `npm run curl:domain-whois` or `npm run debug:domain-whois`. When the 500 stops, the last disabled addon/hook is the likely source.
   - Search for `echo`, `print`, `var_dump`, or BOM/whitespace in:
     - `includes/api.php` and any customizations,
     - Files included early in the WHMCS bootstrap,
     - Addon or hook code that runs on every request (e.g. `ClientAreaHeadOutput`, `AdminAreaHeadOutput`, or API hooks).
   - Ensure no `display_errors=On` or similar in PHP for the API path; use `log_errors=On` and a file `error_log` only.

2. **Remove or fix the source**
   - If it’s an addon: fix the addon so it does not echo/print on API requests, or disable it for the API (e.g. skip hook when request is to `api.php`).
   - If it’s a BOM/whitespace: save the file as UTF-8 without BOM and remove trailing newlines/whitespace before `<?php`.
   - If it’s a PHP notice: fix the underlying code or suppress/log it so nothing is sent to the client before the JSON response.

3. **Optional short-term mitigation (if you cannot fix the source immediately)**
   - In WHMCS, wrap the API response emission in output buffering so any stray output is discarded before sending the JSON. Only the WHMCS/core or host maintainer can do this (e.g. in `includes/api.php` or the entry point that calls `SapiEmitter::emit`). Example idea: ensure `ob_start()` is called at the very start of the API bootstrap and `ob_end_clean()` (or `ob_get_clean()`) is called right before emitting the response. This hides the symptom; removing the source of output is still recommended.

4. **Verify**
   - Run: `npm run curl:domain-whois` and `npm run debug:domain-whois`.
   - Expect HTTP 200 and JSON: `{"result":"success","status":"available",...}` or `"unavailable"`.
   - Then re-test MCP `check_domain_availability` from Cursor for dsri-marks.com and securiace.com.

---

## 6. Debug improvements added in this session

| Change | Purpose |
|--------|--------|
| **WhmcsClient 5xx logging** | On HTTP 5xx, log the response body (first 2000 chars) to stderr so that when the MCP server runs (e.g. with `MCP_DEBUG=true` or log capture), you see the actual WHMCS error instead of only “HTTP 500”. |
| **scripts/debug-domain-whois.ts** | Node/axios script that POSTs `DomainWhois` to the configured WHMCS URL and prints full HTTP status and body (same as MCP client). |
| **scripts/curl-domain-whois.ts** | Curl-based script: same request via `curl` only (no Node HTTP stack). Confirms that the 500 is independent of client. |
| **npm scripts** | `npm run debug:domain-whois [domain1] [domain2]` and `npm run curl:domain-whois [domain]` (default domain: dsri-marks.com). |

---

## 7. Recommendations

### 7.1 Fix WHMCS 500 (required for domain check to work)

1. **Enable WHMCS / PHP error logging** (no display to browser):
   - In WHMCS/PHP, set `display_errors=Off`, `log_errors=On`, and a `error_log` path.
2. **Track down “output emitted”**:
   - Temporarily enable WHMCS debug/hooks log.
   - Disable addons/hooks one by one and retry `DomainWhois` (e.g. via `npm run debug:domain-whois`) until 500 stops.
   - Search for `echo`/`print`/BOM in files loaded for the API (e.g. customizations in `includes/` or addon code that runs on every request).
3. **Optional:** Wrap API entry (e.g. in a bootstrap or custom `api.php` wrapper) with `ob_start()` and `ob_end_clean()` so any stray output is discarded before the JSON response (only if you cannot remove the source of the output).

After fixing, rerun:

```bash
npm run debug:domain-whois
```

You should get HTTP 200 and JSON like:

```json
{ "result": "success", "status": "available", "whois": "..." }
```
or
```json
{ "result": "success", "status": "unavailable", "whois": "..." }
```

### 7.2 MCP / Cursor

- **Read-only:** Keep `MCP_MODE=read_only` for production; domain check is read-only and safe.
- **Debug:** Set `MCP_DEBUG=true` in the MCP server env to get tool and WHMCS 5xx body in stderr.
- **Re-test:** After fixing WHMCS, trigger `check_domain_availability` again from Cursor (e.g. for dsri-marks.com and securiace.com) and confirm you get `available` and `unavailable` respectively.

---

## 8. Summary

| Item | Status |
|------|--------|
| MCP server and config | OK (connects, authenticates, calls WHMCS) |
| Domain tool (validation, rate limit, DomainWhois call) | OK |
| WHMCS DomainWhois API (action/params) | Correct (action=DomainWhois, domain=...) |
| WHMCS server response | **HTTP 500** – Laminas “Output has been emitted previously” |
| Cause | Server-side: output sent before JSON response (hook/addon/BOM/error) |
| Next step | Fix WHMCS output emission, then re-run debug script and MCP domain check |

---

*Report generated from live MCP invocations, `npm run debug:domain-whois`, and `npm run curl:domain-whois` against the configured production WHMCS instance.*
