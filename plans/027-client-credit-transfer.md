# Plan 027: Governed client-to-client account-credit transfer

> Stamped against `b19b97e` on 2026-08-10. Pre-implementation WHMCS 8.x/9.x
> E2E and persistence audits are complete and green. Implementation may proceed
> only without weakening the verified invariants below.

## Goal

Add a simple, WHMCS-aligned workflow that transfers unallocated account credit
from one client to one other client. The default path is explicitly
self-approved. A distinct finance/CA approval can be required by configuration,
but is disabled by default. Every completed transfer and reversal must leave
correlated WHMCS credit rows, client-linked activity entries, and durable,
intelligent profile notes on both clients.

The workflow supports WHMCS 8.x and 9.x and uses WHMCS-native timestamps only.
It never writes WHMCS database tables directly.

## Verified pre-implementation evidence

### Credential and environment posture

- Existing devbox API credential files were searched before provisioning:
  `find projects -maxdepth 2 -name api-credentials.json -print` returned no
  paths. Disposable credentials were created only after that result; secrets
  stayed in ignored local files and were never printed or copied here.
- Verified WHMCS versions: `8.13.4-release.1` and `9.0.5-release.1`.
- The exact required API role actions are: `GetClients`, `GetClientsDetails`,
  `GetCredits`, `AddCredit`, `AddClientNote`, `LogActivity`, `GetActivityLog`,
  `GetConfigurationValue`, and `GetInvoices` for the audit invariant.
- `SetConfigurationValue` is restricted to the WHMCS Internal API. Production
  code only reads `TaxEnabled`; it must never try to change WHMCS tax settings.

### Financial and audit behavior

- `AddCredit(type=remove)` rejects an amount above available credit with
  `Insufficient Credit Balance` on both versions. Preflight and locking remain
  mandatory; the WHMCS guard is the final line of defense.
- A paired source removal and destination addition conserved net credit exactly
  on both versions. A linked reversal restored both balances exactly.
- A simulated destination-leg failure returned `Client ID Not Found`; a source
  `AddCredit(type=add)` compensation restored the source exactly.
- Credit movement did not create an invoice when tax was disabled on 8.x or
  temporarily enabled on 9.x. Account-credit transfer is not itself a taxable
  supply or an invoice-generation trigger.
- `GetCredits` exposes the native credit date as `YYYY-MM-DD` only.
  `GetActivityLog` exposes the full native datetime as
  `YYYY-MM-DD HH:MM:SS`. Therefore the verified order is:
  financial legs -> `LogActivity` on both clients -> activity readback ->
  profile notes embedding the source activity's exact native datetime.
- `AddClientNote` persisted native `created`/`modified` timestamps and associated
  `adminid` values. MCP boolean encoding (`false` -> `0`) produced non-sticky
  notes on both versions. Never send the literal string `false`, which WHMCS
  treats as truthy.
- Final readback proved source/destination balances and tax settings were
  restored. Database audit through WHMCS bootstrap proved two completed notes,
  two reversal notes, client-linked activity rows, and correlated credit rows
  per version.

## Public tool surface

### `transfer_client_credit`

Required input:

- `source_clientid`: positive WHMCS client ID.
- `destination_clientid`: different positive WHMCS client ID.
- `amount`: canonical decimal string with at most two fractional digits in v1.
- `reason`: 3-500 characters; stored in both profile notes.
- `request_id`: caller-stable idempotency key, 8-128 safe characters.
- `confirm`: must be `true` for the default self-approved execution path.

Optional input:

- `reverses_transfer_id`: immutable completed-transfer ID. When present, the
  engine validates and executes a linked reversal rather than editing history.

The tool returns a completed record or `pending_finance_approval`. It never
returns success while either balance, note, activity, or reconciliation state is
unknown.

### `get_client_credit_transfer`

Read a transfer by ID for reconciliation/reporting. Return state, client IDs,
amount/currency, approval mode, tax posture, native WHMCS timestamps, credit,
note and activity references, reversal linkage, and unresolved repair work.

Optional finance approval reuses the existing `approve_write_intent` and
`execute_write_intent` tools. The transfer tool creates a governed intent and
returns its ID when distinct approval is configured.

## Approval and tax policy

New governed scope: `billing:credit:transfer`; risk remains `high`.

Configuration defaults:

```text
MCP_CREDIT_TRANSFER_REQUIRE_FINANCE_APPROVAL=false
MCP_CREDIT_TRANSFER_REQUIRE_FINANCE_WHEN_TAX_ENABLED=false
MCP_CREDIT_TRANSFER_FINANCE_APPROVER_IDS=
MCP_CREDIT_TRANSFER_STATE_PATH=
```

- Normal write authorization, production allowlisting and amount/day caps still
  apply. “Self-approved by default” does not mean unauthenticated or uncapped.
- Only this scope may self-approve when both approval flags are false. Do not
  relax the global high-risk separation-of-duties rule.
- If general finance approval is enabled, require a distinct authenticated
  consumer whose ID is in `MCP_CREDIT_TRANSFER_FINANCE_APPROVER_IDS`.
- Read `TaxEnabled` before execution. When enabled, always return
  `finance_review_recommended=true`. Require distinct approval only when
  `MCP_CREDIT_TRANSFER_REQUIRE_FINANCE_WHEN_TAX_ENABLED=true`.
- If tax state cannot be read, return `tax_status=unknown` and recommend review;
  block only when the tax-specific approval flag is enabled.
- Do not create an invoice, GST credit note, or debit note for a plain transfer
  of unallocated account credit. A future taxable transfer fee or correction of
  an originating taxable invoice is a separate workflow and outside this plan.

## Execution state machine

Persist every transition before issuing the next external mutation:

```text
prepared -> pending_finance_approval | authorized
authorized -> source_debit_pending -> source_debited
source_debited -> destination_credit_pending -> financially_completed
financially_completed -> activity_pending -> activity_logged
activity_logged -> notes_pending -> notes_written
notes_written -> reconciled -> completed

destination_credit_failed -> compensation_pending
compensation_pending -> compensated | manual_reconciliation_required
```

- Use an immutable random UUID transfer ID; do not embed a host timestamp.
- Require a durable transfer state path whenever real execution is armed.
- Use request ID plus canonical parameters for replay identity. A reused request
  ID with different parameters is rejected.
- Serialize transfers per source client. The tested WHMCS insufficient-balance
  guard remains authoritative if another process races the local lock.
- Count the transfer amount once for high-risk per-action/day caps, not once per
  WHMCS leg.
- Never auto-retry `AddCredit`. Resume from durable state and reconcile first.

## Native timestamp contract

- No transfer record field may use `Date.now()`, `new Date()`, an MCP host clock,
  or a converted timezone value.
- Credit rows retain the native `GetCredits.date` value.
- After both financial legs, write client-linked `LogActivity` rows and read them
  back by the exact transfer ID. The source activity `date` is the canonical
  `occurred_at`; retain the destination activity's native date separately.
- Build both notes only after this readback and embed the exact source activity
  date string. WHMCS creates each note's own native `created` timestamp.
- Pending approval and approval events that require timestamps must likewise use
  a WHMCS `LogActivity` row and readback, or remain untimestamped ordered states;
  never fill the gap with host time.
- Transfer audit records must accept an explicit WHMCS-native timestamp instead
  of calling the current generic audit timestamp helper.

## Validation and reconciliation

Before source debit:

- Admin access only; client-scoped mode is denied.
- Both clients exist, are Active, are different, and use the same currency.
- Amount is positive, canonical, within configured caps, and source credit is
  sufficient.
- All required API permissions are capability-probed before the first leg.
- Original transfer exists, is completed, is not already fully reversed, and
  the current destination has enough credit when reversing.

After each financial leg:

- Read `GetClientsDetails` and `GetCredits` with cache bypass.
- Locate the unique transfer ID in the native credit description and retain its
  credit row ID/date/amount.
- Verify exact balance delta and net-credit conservation.
- On destination failure, compensate the source immediately. If compensation
  cannot be proved, return `manual_reconciliation_required`, emit a prominent
  built-in activity entry when possible, and never claim completion.

After notes/logs:

- Retain both note IDs and both activity IDs/dates.
- A note/log failure does not undo a proven financial transfer. Persist
  `audit_repair_required`, retry idempotently, and withhold `completed` until the
  missing audit artifact is verified.

## Profile note template requirements

Both non-sticky notes include:

- Transfer/reversal ID and direction (`OUT`/`IN`).
- Currency and exact amount.
- Counterparty client ID; optionally safe display/company name, but no email,
  address, GSTIN, or contact details.
- `WHMCS AddCredit remove/add` processing method.
- Exact WHMCS-native occurrence datetime.
- Authenticated actor, self/finance approval mode, and approver identity.
- Source/destination balance before and after.
- Both credit IDs and both activity IDs.
- Reason, status, and original transfer ID for reversals.

## Implementation slices

1. Add transfer configuration and `billing:credit:transfer` scope/risk metadata.
   Add fail-closed config validation for finance approval without approver IDs
   and real execution without a durable state path.
2. Add pure decimal, validation, note-description and reconciliation helpers
   with unit tests.
3. Add a durable transfer store and per-source execution lock. Add crash/replay
   tests for every state boundary.
4. Add the composite executor using only supported WHMCS API actions and cache-
   bypass readback. Add compensation and linked reversal behavior.
5. Add the narrow transfer self-approval policy and optional finance-approver
   allowlist without changing unrelated high-risk scopes.
6. Register `transfer_client_credit` and `get_client_credit_transfer` in a new
   focused tool module; wire schemas, structured output, catalog metadata, and
   governance contracts.
7. Add unit/contract tests and guarded devbox E2E coverage for 8.x tax-disabled
   and 9.x tax-enabled fixtures, including native timestamp and persistence
   assertions.
8. Update `.env.example`, README, controlled-write documentation, local WHMCS
   testing runbook, operations handoff, capability catalog, and audit record.

## Done criteria

- Exact source/destination deltas and net-credit conservation are proven on
  WHMCS 8.x and 9.x.
- Idempotent replay and concurrent source requests cannot duplicate/overspend.
- Crash after source debit resumes or compensates exactly once.
- Default explicit self-approval works; configured finance/CA approval blocks
  until a distinct allowlisted approver approves.
- Tax disabled never requires tax invoicing. Tax enabled recommends finance
  review, optionally requires configured approval, and still creates no invoice
  for a plain account-credit transfer.
- Completed transfers and reversals have two native credit rows, two client-
  linked activity rows, two non-sticky profile notes, exact native timestamps,
  and immutable cross-references.
- Reporting exposes transfer, approval, reversal, compensation and audit-repair
  states without synthesizing timestamps.
- Focused tests, typecheck, lint, formatting, full tests, contract/conformance,
  devbox integration matrix and dependency audit are green.

## Out of scope

- Direct WHMCS database mutation.
- Cross-currency conversion.
- Cross-legal-entity or cross-GST-registration transfer.
- Automatic GST invoice/credit-note generation.
- Moving an applied invoice payment or editing finalized WHMCS 9 invoices.
