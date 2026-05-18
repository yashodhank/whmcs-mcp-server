# Phase I — Production-Grade Controlled Writes: Recommendation (DECISION + PLAN ONLY)

> **Status: recommendation + plan. NOT implemented. No write code, no
> mutation tool, no production write path is created or enabled by this
> document. Production execution remains hard-gated by Phase G.**

## 0. TL;DR

**Recommendation: NO-GO for ungating production writes now. GO to build a
small, separately-reviewed Phase H.1 verification-hardening first, re-run
the pilot for authoritative evidence, then reconsider a narrowly-scoped
Phase I.**

The blocker is **not** a discovered leak (none was found) and **not** the
write design (Phase F machinery + Phase G hard-gate are sound). The blocker
is that we currently **cannot produce authoritative, evidence-based proof
that projection is correct on real production data** — and a production
write go-decision requires exactly that proof, because the write path's
core safety guarantees ("no secret echoed in projected params", correct
audit redaction) ride on the same projection layer.

## 1. Production read-only pilot — what was run

- **5 real clients**, auto-selected for variety by a governed discovery
  (numeric ids only; no PII retained): a transaction-heavy account, a
  domain-heavy account, a minimal active account, an empty/inactive
  account, a sparse inactive account.
- **5 aggregators** × **6 consumers** × **5 clients = 150 runs** driven
  through the sanctioned `scripts/mcp-exposure-audit.mjs` with governance
  **ON**. Raw values were written only to the git-ignored `.audit-local/`
  (operator-local, since purged); stdout/analysis used only the redacted
  reports. Aggregators: `get_account_360`, `get_billing_snapshot`,
  `get_support_snapshot`, `get_renewal_snapshot`,
  `get_reconciliation_snapshot`. Consumers: `llm_chat`, `ops_operator`,
  `billing_dashboard`, `renewal_worker`, `support_console`,
  `admin_full_trusted`.

## 2. Findings (redacted)

### 2.1 No real exposure failure detected

- **Zero real drop-violations** across all successful runs: every reported
  "violation" was identical to the "unknown_fields" set (i.e. the auditor
  could not classify the path, not the contract emitting a `drop` field).
- **Zero sensitive-class fields emitted raw against policy**: no `secret.*`
  or `pii.email|phone|tax|address` path was emitted-raw-and-not-allowed in
  any consumer × tool.
- This is consistent with the independently LIVE-verified governance
  behavior matrix in `docs/rollout-validation-report.md` §4.

### 2.2 The headline "violations" are a MEASUREMENT ARTIFACT

`classmap_source: "inferred (classmap unavailable from tool output)"` on
every run. Governed aggregator output deliberately does **not** carry the
server's internal field-class map, so the auditor fell back to
**key-name inference**. Any aggregate/structural path whose name the
inference ruleset does not match (`partial_errors`, `window_days`,
`horizon`, `counts.*`, `reconciliation_ledger.*`, `ledger_adjustments.*`,
`source_*_ids`, `truncated.*`, …) is conservatively flagged
`UNKNOWN` — which the auditor also counts as a `violation`. These are
**not** real over-exposure; the real projection already ran correctly
server-side.

### 2.3 The few "under-masked" hits are false positives

`upcoming[].name` (renewal snapshot) and `departments[].name` (support
snapshot) flagged under `llm_chat`/`renewal_worker`. These are a
**product/domain name** and a **support-department label**
(`public.safe`), not a person's name — the substring `name` tripped the
`pii.name` inference. No real PII under-masking.

### 2.4 Instrument + harness gaps (the real deliverable of this pilot)

1. **The exposure auditor is not authoritative for governed
   aggregator/tool output** — it cannot see the real classmap, so it
   cannot prove projection correctness; it can only name-guess. This is
   the single most important gap.
2. **Harness reliability**: 43/150 runs (29%) produced no parseable
   report (disproportionately `get_account_360` and some
   `get_reconciliation_snapshot`), likely stdio/timeout under
   concurrency. Not yet a dependable production verification gate.
3. **Coverage caveat**: the auto-picked client window contained no
   overdue-invoice-heavy or ticket-heavy account, so a few billing/
   support edge fields were unpopulated (structure still observed).

### 2.5 Missing fields / over-masking

`over_masked` was empty on every run → no signal that app consumers are
over-masked for these aggregators. **Caveat:** over-mask detection is also
classmap-dependent, so this is corroborating, not authoritative, evidence.

## 3. Why this is a NO-GO for Phase I right now

A production-write authorization decision must be **evidence-based and
positive** ("projection is proven correct on real data"), per the
project's deny-by-default, evidence-before-assertion posture. Today:

- "No evidence of a leak" was obtained via a **non-authoritative**
  instrument (inferred classmap). Absence of evidence through a blunt
  tool is not proof of safety.
- The write path's safety case (`src/write/*`, Phase F §1/§8) explicitly
  depends on projection: projected params must not echo secrets; the
  audit log redacts via the same projection rules. We cannot sign off on
  that for production without an authoritative projection audit.
- The verification harness itself is not yet reliable enough to be a gate.

The Phase F machinery (draft→validate→approve→execute→verify, idempotency,
per-consumer write scopes, write-specific allowlist, audit) and the
Phase G absolute production hard-gate
(`src/write/executionGate.ts`: `env === 'production'` ⇒
`production_execution_forbidden`, checked first) are **sound and should
remain unchanged** until the prerequisite below is met.

## 4. Prerequisite — Phase H.1 (small, separately reviewed, read-only)

1. **Make the exposure auditor authoritative.** Either (a) have the
   governed pipeline emit the real field-class map behind an
   operator/debug-gated, never-in-production-by-default sidecar
   (`__classmap`) consumed by the auditor, or (b) have the audit harness
   import the canonical/aggregator classifiers directly
   (`src/canonical/*`, `aggregators.ts#classifyAggregateKey`) instead of
   name inference. No change to runtime projection or contracts.
2. **Harden harness reliability** to ~100% report capture (stdio/timeout,
   serialize or backpressure server boots, explicit failure surfacing).
3. **Re-run this exact pilot** (5 aggregators × 6 consumers × varied real
   clients, incl. an overdue-heavy and a ticket-heavy account) and obtain
   an authoritative report: every emitted path mapped to its REAL class,
   real over/under-masking, real violations — TDD-covered.
4. Acceptance to proceed to Phase I: authoritative pilot shows **0 real
   drop-violations, 0 real under-masking of `pii.*`/`secret.*`/
   unauthorized `financial.reference`, and over-masking only where
   intended.**

## 5. Phase I (only after §4 passes) — narrowest viable scope

Follow `docs/phase-f-controlled-write-automation.md` §12 rollout order.
**Phase I ungates exactly ONE action: `add_client_note`** — additive, no
financial/state impact, trivially ignorable, lowest blast radius.

- Replace the Phase G blanket production hard-gate **only** with a
  per-action, per-consumer, explicitly-authorized production path for
  `add_client_note` and nothing else. Never a global switch; the env
  hard-gate stays the default for every other action.
- Required for that single action: dev/staging-proven end-to-end first;
  per-action production authorization flag (separate from mode);
  consumer `writeCapability=execution_allowed` + `allowedWriteScopes`
  includes `client_note:write`; write-specific per-consumer allowlist;
  deterministic idempotency key + replay ledger; append-only audit with
  projection-redacted before/after hashes; post-write re-read
  verification; documented compensation (note is additive — soft-delete
  or annotate, no destructive rollback needed).
- TDD, separate review, separate explicit authorization. Billing /
  service / domain / payment writes remain out of scope and hard-gated.

## 6. Hard stops (unchanged)

No production mutation is executed, wired, or enabled by this document.
No `READ_ALLOWLIST` change. `GetUsers` stays unpromoted. Production write
posture remains exactly as merged in Phase H. Any Phase I implementation
is a separate, explicitly-authorized, reviewed, TDD change.
