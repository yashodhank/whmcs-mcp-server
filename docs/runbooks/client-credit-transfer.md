# Client account-credit transfer runbook

## Purpose and boundary

`transfer_client_credit` moves unallocated account credit from one active WHMCS
client to one other active client in the same currency. It does not move an
invoice payment, edit an invoice, convert currencies, or create a supply. The
workflow calls WHMCS's documented `AddCredit` action once with `type=remove`
and once with `type=add`; WHMCS requires a positive decimal amount and supports
both operation types.

WHMCS references:

- [AddCredit](https://developers.whmcs.com/api-reference/addcredit/)
- [GetCredits](https://developers.whmcs.com/api-reference/getcredits/)
- [LogActivity](https://developers.whmcs.com/api-reference/logactivity/)
- [GetActivityLog](https://developers.whmcs.com/api-reference/getactivitylog/)
- [AddClientNote](https://developers.whmcs.com/api-reference/addclientnote/)

## Enablement

Keep the normal sealed defaults until the operator has configured:

1. An authenticated consumer with `execution_allowed` and the narrow
   `billing:credit:transfer` write scope.
2. `billing:credit:transfer` in the production or non-production execution
   allowlist.
3. Non-zero per-action and daily high-risk caps.
4. Owner-only durable paths for the general write audit/idempotency/day-amount
   stores and `MCP_CREDIT_TRANSFER_STATE_PATH`.
5. A WHMCS API role containing `GetClientsDetails`, `GetCredits`, `AddCredit`,
   `AddClientNote`, `LogActivity`, `GetActivityLog`,
   `GetConfigurationValue`, and `GetInvoices`.

The tool requires distinct active clients, matching currency, sufficient source
credit, a positive two-decimal string amount, a meaningful reason, a stable
request ID and `confirm: true`.

## Approval policy

Self-approval is enabled by default. It removes only the separate approver
ceremony; authentication, scope permission, kill switch, mode, execution
allowlist, idempotency and monetary caps remain mandatory.

Set `MCP_CREDIT_TRANSFER_REQUIRE_FINANCE_APPROVAL=true` to require finance/CA
approval for every transfer. Alternatively, set
`MCP_CREDIT_TRANSFER_REQUIRE_FINANCE_WHEN_TAX_ENABLED=true` to require it only
when WHMCS `TaxEnabled` is on. Either option requires one or more authenticated
consumer IDs in `MCP_CREDIT_TRANSFER_FINANCE_APPROVER_IDS`; the approver must
be distinct from the drafter. Tax-enabled transfers recommend finance/CA review
even when the requirement remains disabled.

## Ledger and audit sequence

The completed sequence is:

1. Read both clients, tax posture and invoice counts without using cached data.
2. Persist `prepared`, remove source credit, then persist `source_debited`.
3. Add destination credit. If it fails, add the exact source amount back and
   return `compensated`; never claim success.
4. Read both native credit rows and both balances. Require exact deltas and
   conservation of combined credit.
5. Write client-linked `LogActivity` entries and read them back.
6. Use the source activity row's WHMCS-native `YYYY-MM-DD HH:MM:SS` as the
   occurrence time in both non-sticky profile notes. Do not convert it with the
   MCP host clock or timezone.
7. Verify invoice counts remain unchanged and persist all credit, activity and
   note IDs as a `completed` record.

The credit rows expose only a native `YYYY-MM-DD` date; the activity log is the
authoritative full native datetime. Notes record direction, both clients,
currency/amount, method, balances, reason, approval, tax posture and all native
references. They deliberately omit email, address, GSTIN and contact PII.

## Reversal and reconciliation

Never edit or delete historical credit rows. Reverse with a new request and
`reverses_transfer_id`; the engine swaps the original clients, reuses the exact
currency/amount and cross-links both immutable records. Only one completed
reversal is allowed.

Use `get_client_credit_transfer` by transfer ID or request ID. Meanings:

- `completed`: exact financial and audit readback passed.
- `compensated`: destination failed and source was restored; no net movement.
- `audit_repair_required`: do not repeat the financial legs. Reconcile the
  recorded credit IDs/balances and repair missing notes/logs manually.
- `prepared`, `source_debited`, or `financially_completed`: execution was
  interrupted. Freeze retry, compare the unique transfer marker in both
  clients' credit rows, and involve finance before any corrective entry.

## India GST/accounting posture

A transfer of an already-recorded customer credit liability is not, by itself,
evidence of a new supply. This workflow therefore creates no invoice and
changes no tax setting. If the underlying money was an advance against a
taxable supply, or the source and destination represent different legal
persons/GST registrations, stop and obtain CA review; the correct document may
be a receipt voucher, refund voucher, tax invoice or credit note outside this
workflow. CBIC rules require true and correct accounts with the relevant source
documents and prescribe receipt-voucher particulars for advances:

- [CBIC GST invoice and voucher rules](https://cbic-gst.gov.in/gst-invoice-rules.html)
- [CBIC accounts and records rules](https://cbic-gst.gov.in/accnt-record-rules.html)

This is an operational control, not tax advice. The entity's CA remains the
authority for chart-of-accounts mapping, GST treatment, period close and
document retention.

## Tested compatibility

The reversible devbox matrix passed on WHMCS `8.13.4-release.1` (tax disabled)
and `9.0.5-release.1` (tax temporarily enabled under a guarded fixture). It
proved exact balances, native credit/activity timestamps, paired notes/logs,
unchanged invoices, linked reversal, compensation, insufficient-balance
rejection and restoration of all test balances/tax settings.
