# WHMCS MCP Production Test Program

## Purpose
This program implements a production-safe, root-cause-oriented test framework for WHMCS MCP across Kilo and Claude hosts. It focuses on L0-L6 quality layers: config integrity, connectivity/auth, output contract, business correctness, access control, resilience, and operational quality.

## What This Adds
- A deterministic executable harness: `scripts/mcp-production-test-program.mjs`.
- A root-cause analysis module for defect ledger generation: `src/testProgram/rca.ts`.
- Unit tests for RCA severity, grouping, and layer heatmap summaries: `tests/testProgram/rca.test.ts`.

## Execution Safety
- Read-only by design: only read tools are called.
- No production writes, no mutation flow, no restart operations.
- Failing assertions produce evidence artifacts instead of retries that hide errors.

## Coverage Map (L0-L6)
- `L1 connectivity/auth`: preflight read call and deterministic failure capture.
- `L2 contract integrity`: checks `structuredContent` for schema-bearing tools.
- `L3 operator reads`: verifies status correctness (`Active` defensive post-filter behavior).
- `L4 access control`: verifies client-mode denial behavior for disallowed client IDs.
- `L5 validation + pagination`: validates `limit` guardrails and metadata coherence.
- `L6 operational quality`: verifies deterministic error behavior on invalid inputs.

## Required Environment
- Built server: `npm run build`.
- Working WHMCS MCP runtime env vars (same as normal server execution).
- Optional execution selectors:
  - `TEST_HOST` (`kilo`, `claude_code`, `claude_desktop`) for evidence labeling.
  - `TEST_MODE` (`admin`, `client`) for expected access behavior.
  - `TEST_CLIENT_ID` (default `30`) known-good test client.
  - `TEST_BLOCKED_CLIENT_ID` (default `31`) cross-client denial probe.

## Run Command
```bash
node scripts/mcp-production-test-program.mjs
```

## Evidence Output
Each run writes artifacts under:
- `.audit-local/prod-test-program-<timestamp>/summary.json`
- `.audit-local/prod-test-program-<timestamp>/findings.json`

Per test record includes:
- `testId`, `suite`, `layer`
- expected vs actual
- pass/fail
- host/mode
- failure kind classification
- normalized raw MCP result (for reproducibility)

## Root-Cause Analysis Usage
Use `src/testProgram/rca.ts` to convert findings into:
- severity labels (`P0`, `P1`, `P2`)
- grouped defect ledger entries
- layer-level pass-rate summaries (heatmap input)

Severity policy:
- `P0`: schema mismatch, access leak, write bypass
- `P1`: auth/network ambiguity, validation, pagination drift, timeout/rate-limit weaknesses
- `P2`: ordering instability, observability gaps, unknown residuals

## Reporting Structure
Use artifacts to produce the final readiness memo with:
- test matrix and pass/fail heatmap (by layer and host)
- defect ledger grouped by failure kind and severity
- likely root cause hypothesis per defect class
- recommended hardening actions and owner ETA

## Notes
- The script intentionally fails CI/run exit code when any test fails.
- This is designed for iterative bug-hunt cycles: execute, classify, fix, rerun, compare.

## Reliability sprint — preflight & known semantics
- **Governance preflight (fail-fast):** if `MCP_GOVERNANCE_ENABLED=true` but no
  `auth_token`/`MCP_CONSUMER_REGISTRY` is available, the harness exits with a
  `harness_config_error` *before running any case* — blanket
  `consumer denied: no_token` results are no longer mislabeled as product
  failures. Governance OFF runs the legacy path; governance ON requires an
  injected synthetic test consumer token. Tool names are validated against the
  live `tools/list` at startup (no hardcoded drift; the dept tool is
  `get_ticket_departments`).
- **RCA taxonomy:** `consumer_denied`/`no_token` → `harness_config_error`
  (P2, unless the case sets `expectsDenial`); advertised-but-unapplied filter →
  `filter_correctness`; `pagination_drift` only for genuinely incoherent
  count/total/offset/limit.
- **`list_client_domains` status filter:** WHMCS `GetClientsDomains` has no
  native status filter, so filtering is **client-side** via a bounded
  multi-page scan. The envelope reports `filter_mode:'client_side'`,
  `filter_applied`, `requested_status`, `scanned_count`, `matched_count`,
  `returned_count`, `scan_complete`, and a `warning` when the scan cap is hit.
  Pagination is honest over the filtered set.
- **`get_ticket_departments`:** now declares an `outputSchema` and returns
  `structuredContent` (text preserved) so strict MCP runtimes accept it.
