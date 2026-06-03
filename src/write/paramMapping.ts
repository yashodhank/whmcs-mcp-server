/**
 * Phase G+ — Intent → WHMCS parameter mapping (pure functions).
 *
 * WHY THIS EXISTS:
 *   The write-flow's intent contract uses canonical/semantic keys (e.g. for
 *   `client_note:write`: `{clientid, note}`), but the underlying WHMCS API
 *   actions require different field names (`AddClientNote` wants `{userid,
 *   notes}`). Prior to this module the flow passed `intent.params` straight
 *   into `whmcs.mutate(...)`, which on the prod allowlist path would have
 *   produced empty/wrong WHMCS payloads (missing payment fields, phantom
 *   revenue via mis-set `amountin`, etc.) — a latent production-billing bug
 *   the Track E proof script masked by passing both naming flavours.
 *
 *   This module is the SINGLE source of truth for that translation. The
 *   write-flow now passes ONLY intent-shape keys through validation, and
 *   `intentToWhmcsParams(scope, intent.params, ctx)` produces the exact
 *   WHMCS-shape payload right before `whmcs.mutate()` is called.
 *
 * SAFETY:
 *   - Pure functions, no I/O, no globals, no Date.now() / Math.random().
 *   - Idempotency-derived transids: a retry with the same idempotency_key
 *     produces the SAME transid (gives WHMCS-side dedup as a second-layer
 *     backstop against double-charging on retries).
 *   - The refund mapper NEVER sets `amountin` (phantom-revenue guard); only
 *     `amountout` is set, and `credit: true` is only set for the Credit type.
 *   - `billing:invoice:create` FLATTENS `items[]` into WHMCS's
 *     `itemdescription{N}/itemamount{N}/itemtaxed{N}` shape and the original
 *     `items` key is removed from the output.
 */

import { createHash } from 'node:crypto';
import type { WriteScope } from './types.js';

/** Caller-supplied mapping context. Only fields the mapper needs. */
export interface MappingContext {
  /** Intent's idempotency_key. Drives deterministic transid synthesis. */
  readonly idempotency_key?: string;
}

/* ───────────────────────────  Helpers  ──────────────────────────────────── */

/** First 16 hex chars of sha256(`${prefix}|${key}`). Stable across retries. */
function deterministicTransIdFromIdempotency(prefix: string, key: string | undefined): string {
  const k = typeof key === 'string' && key.length > 0 ? key : 'noop';
  return `${prefix}-${createHash('sha256').update(`${prefix}|${k}`, 'utf8').digest('hex').slice(0, 16)}`;
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Safely stringify a value for use in a transid prefix. Only primitive
 * conversions; any object / nullish value becomes 'noinv' so we never leak an
 * `[object Object]` into a WHMCS transid.
 */
function safeIdPart(v: unknown, fallback: string): string {
  if (typeof v === 'string') return v.length > 0 ? v : fallback;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'bigint') return v.toString();
  return fallback;
}

/**
 * Canonical WHMCS UpdateClientProduct field for setting a service's recurring
 * price. Pinned by `scripts/price-restore-spike.ts` + GetClientsProducts
 * read-back verification on dev WHMCS9: WHMCS returns the recurring price
 * under the key `recurringamount` (alongside `firstpaymentamount`).
 */
export const PRICE_RESTORE_RECURRING_FIELD = 'recurringamount';

/* ───────────────────────────  Per-scope mappers  ────────────────────────── */

/**
 * `client_note:write` `{clientid, note, [sticky?]}` →
 *   WHMCS `AddClientNote` `{userid, notes, [sticky]}`.
 * Intent-shape keys MUST NOT appear in the output.
 */
export function mapClientNoteParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    userid: params.clientid,
    notes: params.note,
  };
  if (params.sticky !== undefined) out.sticky = params.sticky;
  return out;
}

/** Copy only the listed, present (non-undefined) keys from `params` into a fresh object. */
function pickFields(
  params: Record<string, unknown>,
  allow: readonly string[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of allow) {
    if (params[key] !== undefined) out[key] = params[key];
  }
  return out;
}

/**
 * STRICT allowlist of WHMCS `OpenTicket` fields the `ticket:create` scope is
 * permitted to forward (matches the intent contract: deptid/subject/message
 * required, clientid OR name+email identity, optional priority/serviceid). Any
 * other caller key — admin-only / injected (status, adminid, date, markdown,
 * etc.) — is DROPPED (defense in depth, mirrors the other strict mappers).
 */
const TICKET_CREATE_FIELD_ALLOWLIST: readonly string[] = [
  'deptid',
  'subject',
  'message',
  'clientid',
  'name',
  'email',
  'priority',
  'serviceid',
];

/**
 * `ticket:create` → WHMCS `OpenTicket`. STRICT: only the allowlisted OpenTicket
 * fields pass through; injected/admin-only keys (status, adminid, date,
 * markdown, …) are dropped.
 */
export function mapTicketCreateParams(params: Record<string, unknown>): Record<string, unknown> {
  return pickFields(params, TICKET_CREATE_FIELD_ALLOWLIST);
}

/**
 * STRICT allowlist of WHMCS `AddTicketReply` fields the `ticket:reply` scope
 * may forward (ticketid + message required; clientid OR name+email identity).
 * `markdown` is intentionally NOT included — the scope does not model it. Any
 * other key (status, adminid, …) is dropped.
 */
const TICKET_REPLY_FIELD_ALLOWLIST: readonly string[] = [
  'ticketid',
  'message',
  'clientid',
  'name',
  'email',
];

/**
 * `ticket:reply` → WHMCS `AddTicketReply`. STRICT: only allowlisted fields pass
 * through; status/adminid/etc. are dropped.
 */
export function mapTicketReplyParams(params: Record<string, unknown>): Record<string, unknown> {
  return pickFields(params, TICKET_REPLY_FIELD_ALLOWLIST);
}

/** STRICT allowlist of WHMCS `UpdateTicket` fields for `ticket:status`. */
const TICKET_STATUS_FIELD_ALLOWLIST: readonly string[] = ['ticketid', 'status'];

/**
 * `ticket:status` → WHMCS `UpdateTicket`. STRICT: emits ONLY ticketid + status;
 * every other caller key (adminid, flag overrides, etc.) is dropped.
 */
export function mapTicketStatusParams(params: Record<string, unknown>): Record<string, unknown> {
  return pickFields(params, TICKET_STATUS_FIELD_ALLOWLIST);
}

/**
 * STRICT allowlist of top-level WHMCS `CreateInvoice` fields the
 * `billing:invoice:create` scope may forward (beyond the flattened
 * itemdescription{N}/itemamount{N}/itemtaxed{N} keys this mapper builds from
 * `items`). Any other caller key (status overrides beyond the listed `status`,
 * sendinvoice, autoapplycredit, injected keys, etc. — anything not listed) is
 * dropped. `items` is consumed by the flattener and never copied verbatim.
 */
const INVOICE_CREATE_FIELD_ALLOWLIST: readonly string[] = [
  'userid',
  'status',
  'date',
  'duedate',
  'paymentmethod',
  'taxrate',
  'taxrate2',
  'notes',
];

/**
 * `billing:invoice:create` `{userid, items: [{description, amount, taxed}], ...}`
 * → flatten items into WHMCS `CreateInvoice` `itemdescription{N}/itemamount{N}/
 * itemtaxed{N}` shape (1-based). STRICT: only the allowlisted top-level fields
 * pass through; the original `items` key is consumed (never copied) and any
 * unknown caller key is dropped.
 */
export function mapInvoiceCreateParams(params: Record<string, unknown>): Record<string, unknown> {
  // Only allowlisted top-level fields; `items` is flattened below, never copied.
  const out: Record<string, unknown> = pickFields(params, INVOICE_CREATE_FIELD_ALLOWLIST);

  const items = Array.isArray(params.items) ? params.items : [];
  items.forEach((item, i) => {
    const idx = i + 1;
    const it = asRecord(item);
    out[`itemdescription${idx}`] = it.description;
    out[`itemamount${idx}`] = it.amount;
    if (it.taxed !== undefined) {
      out[`itemtaxed${idx}`] = it.taxed ? 1 : 0;
    }
  });

  return out;
}

/**
 * `billing:payment:add` `{invoiceid, amount, gateway?, transid?}` →
 *   WHMCS `AddInvoicePayment` `{invoiceid, amount, gateway, transid}`.
 *
 * `transid` defaults to a deterministic hash of the idempotency_key so a
 * retry produces the SAME transid (WHMCS-side dedup as a second-layer
 * backstop against double-charging).
 */
export function mapInvoicePaymentParams(
  params: Record<string, unknown>,
  ctx?: MappingContext
): Record<string, unknown> {
  // STRICT: only AddInvoicePayment fields. invoiceid/amount/date copied if
  // present; transid synthesized below; gateway only when a non-empty caller
  // value (else omitted so WHMCS uses the invoice's recorded paymentmethod).
  const out: Record<string, unknown> = pickFields(params, ['invoiceid', 'amount', 'date']);

  const explicitTransid = params.transid;
  if (explicitTransid !== undefined && explicitTransid !== '' && explicitTransid !== null) {
    out.transid = explicitTransid;
  } else {
    const invoiceid = safeIdPart(params.invoiceid, 'noinv');
    out.transid = deterministicTransIdFromIdempotency(`PAY-${invoiceid}`, ctx?.idempotency_key);
  }

  const gateway = params.gateway;
  if (gateway !== undefined && gateway !== '' && gateway !== null) {
    out.gateway = gateway;
  }
  // else: leave gateway off — mapper can't infer it without reading WHMCS, and
  // omitting lets WHMCS fall back to the invoice's recorded paymentmethod.
  return out;
}

/**
 * `billing:credit:add` `{clientid, amount, description}` →
 *   WHMCS `AddCredit` `{clientid, amount, description}`.
 * `description` is REQUIRED (the validator enforces this); the mapper does
 * not synthesize a placeholder — that would mask a missing-description bug.
 */
export function mapCreditAddParams(params: Record<string, unknown>): Record<string, unknown> {
  return {
    clientid: params.clientid,
    amount: params.amount,
    description: params.description,
  };
}

/**
 * `billing:refund:record` →
 *   WHMCS `AddTransaction` (refund leg). NEVER sets `amountin` (phantom-
 *   revenue guard). `Credit` sets `credit: true`; `GatewayRecord` omits it.
 *
 * Required intent params (enforced by validator):
 *   {invoiceid, amount, refund_type: 'Credit'|'GatewayRecord', paymentmethod}
 * Optional: description (synthesized to a benign default if absent).
 */
export function mapRefundRecordParams(
  params: Record<string, unknown>,
  ctx?: MappingContext
): Record<string, unknown> {
  const invoiceid = params.invoiceid;
  const amount = params.amount;
  const refundType = params.refund_type;
  const paymentmethod = params.paymentmethod;
  const description =
    typeof params.description === 'string' && params.description.trim().length > 0
      ? params.description
      : 'Refund';

  const transid = deterministicTransIdFromIdempotency(
    `REFUND-${safeIdPart(invoiceid, 'noinv')}`,
    ctx?.idempotency_key
  );

  const base: Record<string, unknown> = {
    invoiceid,
    amountout: amount, // phantom-revenue guard: NEVER set amountin
    description,
    paymentmethod,
    transid,
  };
  if (refundType === 'Credit') {
    base.credit = true;
  }
  return base;
}

/**
 * Per-target mapper for `service:price_restore`. Pure; strict 2-key output.
 * Any extra keys on the input target are intentionally dropped (defense in
 * depth against future-scope or operator leakage).
 */
export function mapServicePriceRestoreTarget(target: {
  readonly serviceid: number;
  readonly new_amount: number;
}): Record<string, unknown> {
  return {
    serviceid: target.serviceid,
    [PRICE_RESTORE_RECURRING_FIELD]: target.new_amount,
  };
}

/**
 * Canonical hostname/domain normalization — the SINGLE place a domain value is
 * cleaned, so validation and the mapper agree on the EXACT string sent to
 * WHMCS (otherwise validation could trim/lowercase for its check while the
 * mapper sends the raw value — a validate-vs-execute divergence). Lowercases,
 * trims surrounding whitespace, and strips a single trailing FQDN-root dot.
 * Non-string input yields '' (the validator rejects that as missing/invalid).
 */
export function normalizeDomain(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let d = raw.trim().toLowerCase();
  if (d.endsWith('.')) d = d.slice(0, -1);
  return d;
}

/**
 * `service:domain_rename` `{serviceid, domain}` →
 *   WHMCS `UpdateClientProduct` `{serviceid, domain}`.
 *
 * STRICT 2-key output. `UpdateClientProduct` accepts many high-impact fields
 * (recurringamount, status, billingcycle, paymentmethod, …); this mapper emits
 * ONLY serviceid + the NORMALIZED domain so a malformed/over-broad intent can
 * NEVER leak an unintended field into the live call. Any extra key on the
 * input is dropped (defense in depth, mirrors mapServicePriceRestoreTarget).
 */
export function mapServiceDomainRenameParams(
  params: Record<string, unknown>
): Record<string, unknown> {
  return {
    serviceid: params.serviceid,
    domain: normalizeDomain(params.domain),
  };
}

/**
 * `service:suspend` `{serviceid, [suspendreason]}` → WHMCS `ModuleSuspend`.
 * STRICT: only serviceid (+ suspendreason when a non-empty string). ModuleSuspend
 * also accepts no other meaningful fields; dropping extras prevents leakage.
 */
export function mapServiceSuspendParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { serviceid: params.serviceid };
  if (typeof params.suspendreason === 'string' && params.suspendreason.trim() !== '') {
    out.suspendreason = params.suspendreason;
  }
  return out;
}

/** `service:unsuspend` `{serviceid}` → WHMCS `ModuleUnsuspend`. STRICT 1-key. */
export function mapServiceUnsuspendParams(
  params: Record<string, unknown>
): Record<string, unknown> {
  return { serviceid: params.serviceid };
}

/** `service:terminate` `{serviceid}` → WHMCS `ModuleTerminate`. STRICT 1-key. */
export function mapServiceTerminateParams(
  params: Record<string, unknown>
): Record<string, unknown> {
  return { serviceid: params.serviceid };
}

/**
 * `domain:nameservers:update` `{domainid, nameservers:[...]}` → WHMCS
 * `DomainUpdateNameservers` `{domainid, ns1..nsN}`. STRICT: emits ONLY domainid
 * + the positional ns keys (normalized lowercase/trim); any extra input key is
 * dropped. Validation guarantees 2–5 valid hostnames.
 */
export function mapDomainNameserversParams(
  params: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { domainid: params.domainid };
  const ns = Array.isArray(params.nameservers) ? params.nameservers : [];
  ns.slice(0, 5).forEach((n, i) => {
    out[`ns${String(i + 1)}`] = typeof n === 'string' ? n.trim().toLowerCase() : n;
  });
  return out;
}

/**
 * `billing:payment:capture` `{invoiceid}` → WHMCS `CapturePayment` `{invoiceid}`.
 * STRICT 1-key output. CVV is NEVER accepted or emitted by this governed path
 * (the legacy capture_payment tool forwarded an optional CVV; the governed
 * scope deliberately omits it — no card data flows through the write-flow).
 * Any extra input key is dropped (defense in depth).
 */
export function mapPaymentCaptureParams(
  params: Record<string, unknown>
): Record<string, unknown> {
  return { invoiceid: params.invoiceid };
}

/**
 * `billing:credit:apply` `{invoiceid, amount}` → WHMCS `ApplyCredit`
 * `{invoiceid, amount}`. STRICT 2-key output; extras dropped.
 */
export function mapCreditApplyParams(params: Record<string, unknown>): Record<string, unknown> {
  return {
    invoiceid: params.invoiceid,
    amount: params.amount,
  };
}

/**
 * `domain:register` `{domainid, [ns1..ns5]}` → WHMCS `DomainRegister`
 * `{domainid, [ns1..nsN]}`. STRICT: emits ONLY domainid + any supplied
 * positional ns keys (normalized lowercase/trim, reusing the nameserver
 * approach from mapDomainNameserversParams). Any extra input key — including
 * any cost / pricing / status override — is dropped (defense in depth so a
 * malformed intent can never leak an unintended field into the live call).
 */
export function mapDomainRegisterParams(
  params: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { domainid: params.domainid };
  for (let i = 1; i <= 5; i++) {
    const v = params[`ns${String(i)}`];
    if (typeof v === 'string' && v.trim() !== '') {
      out[`ns${String(i)}`] = v.trim().toLowerCase();
    }
  }
  return out;
}

/**
 * `domain:renew` `{domainid, regperiod}` → WHMCS `DomainRenew`
 * `{domainid, regperiod}`. STRICT 2-key output; extras dropped.
 */
export function mapDomainRenewParams(params: Record<string, unknown>): Record<string, unknown> {
  return {
    domainid: params.domainid,
    regperiod: params.regperiod,
  };
}

/**
 * `order:accept` `{orderid}` → WHMCS `AcceptOrder` `{orderid}`. STRICT 1-key
 * output; ALL extras dropped. In particular fraud-bypass / module-control flags
 * (e.g. `fraudbypass`, `sendregistrar`, `autosetup`, `sendemail`) are NEVER
 * auto-sent — accepting an order must not silently override WHMCS's fraud
 * checks or provisioning defaults.
 */
export function mapOrderAcceptParams(params: Record<string, unknown>): Record<string, unknown> {
  return { orderid: params.orderid };
}

/**
 * Shared allowlist of WHMCS AddClient / UpdateClient fields the governed client
 * scopes are permitted to forward. ANYTHING not in this set is dropped (defense
 * in depth, mirrors the other strict mappers). NOTE: `password2` is forwarded
 * ONLY when the caller explicitly supplies it — the mapper is pure/deterministic
 * and NEVER generates a password (no Math.random / crypto here). If absent, the
 * key is omitted and WHMCS will require the caller to have supplied one for
 * AddClient. High-impact fields (owner, status, group overrides beyond the listed
 * `clientgroup`, etc.) are intentionally NOT in the allowlist.
 */
const CLIENT_FIELD_ALLOWLIST: readonly string[] = [
  'firstname',
  'lastname',
  'email',
  'companyname',
  'address1',
  'address2',
  'city',
  'state',
  'postcode',
  'country',
  'phonenumber',
  'password2',
  'currency',
  'clientgroup',
  'notes',
  'customfields',
];

/** Copy only allowlisted, present (non-undefined) client fields into `out`. */
function pickClientFields(
  params: Record<string, unknown>,
  out: Record<string, unknown>
): Record<string, unknown> {
  for (const key of CLIENT_FIELD_ALLOWLIST) {
    if (params[key] !== undefined) out[key] = params[key];
  }
  return out;
}

/**
 * `client:create` `{firstname, lastname, email, ...optional}` → WHMCS `AddClient`.
 * STRICT: only the AddClient fields in CLIENT_FIELD_ALLOWLIST pass through; any
 * other input key (owner overrides, status, raw `password`, etc.) is dropped.
 * Pure: the mapper NEVER generates a password — `password2` is forwarded only
 * if the caller supplied it, otherwise omitted (the caller must provide it or
 * WHMCS will reject the create).
 */
export function mapClientCreateParams(params: Record<string, unknown>): Record<string, unknown> {
  return pickClientFields(params, {});
}

/**
 * `client:update` `{clientid, ...≥1 allowlisted field}` → WHMCS `UpdateClient`.
 * STRICT: emits clientid plus only the present allowlisted fields; extras
 * dropped. The validator guarantees clientid + at least one updatable field, so
 * the mapper never produces a clientid-only (no-op) payload.
 */
export function mapClientUpdateParams(params: Record<string, unknown>): Record<string, unknown> {
  return pickClientFields(params, { clientid: params.clientid });
}

/* ─────────────────────────  Track C2 mappers  ───────────────────────────── */

/**
 * `service:change_package` `{serviceid}` → WHMCS `ModuleChangePackage`
 * `{serviceid}`. STRICT 1-key output. ModuleChangePackage re-runs the module's
 * ChangePackage against the service's CURRENT product/config — it takes no
 * package-selection fields, so the mapper emits only serviceid and drops any
 * extra caller key (defense in depth).
 */
export function mapServiceChangePackageParams(
  params: Record<string, unknown>
): Record<string, unknown> {
  return { serviceid: params.serviceid };
}

/**
 * STRICT allowlist of WHMCS `UpgradeProduct` fields `service:upgrade` may
 * forward. High-impact field (any cost override) is NOT in the set. `calconly`
 * is intentionally excluded: this is a real upgrade scope, not a quote — a
 * preview is the read-side concern, not a governed mutation.
 */
const UPGRADE_FIELD_ALLOWLIST: readonly string[] = [
  'serviceid',
  'type',
  'newproductid',
  'newproductbillingcycle',
  'configoptions',
  'addonid',
  'promocode',
  'paymentmethod',
];

/**
 * `service:upgrade` → WHMCS `UpgradeProduct`. STRICT: only the allowlisted
 * upgrade fields pass through; any other caller key is dropped. The validator
 * guarantees serviceid + a recognized `type` and the per-type required field
 * (product ⇒ newproductid, configoptions ⇒ configoptions, addon ⇒ addonid).
 */
export function mapServiceUpgradeParams(params: Record<string, unknown>): Record<string, unknown> {
  return pickFields(params, UPGRADE_FIELD_ALLOWLIST);
}

/**
 * `domain:idprotect:toggle` `{domainid, idprotect}` → WHMCS
 * `DomainToggleIdProtect` `{domainid, idprotect}`. STRICT: emits domainid + a
 * normalized boolean idprotect; extras dropped.
 */
export function mapDomainIdProtectParams(
  params: Record<string, unknown>
): Record<string, unknown> {
  return {
    domainid: params.domainid,
    idprotect: params.idprotect === true,
  };
}

/**
 * `domain:lock:toggle` `{domainid, lockstatus}` → WHMCS
 * `DomainUpdateLockingStatus` `{domainid, lockstatus}`. STRICT: emits domainid +
 * a normalized boolean lockstatus (true ⇒ locked); extras dropped.
 */
export function mapDomainLockParams(params: Record<string, unknown>): Record<string, unknown> {
  return {
    domainid: params.domainid,
    lockstatus: params.lockstatus === true,
  };
}

/**
 * STRICT allowlist of WHMCS contact (`AddContact`/`UpdateContact`) fields the
 * governed client:contact:* scopes may forward. High-impact / permission fields
 * (the per-area `...email`/`...message` permission booleans, `generalemails`,
 * `subaccount`, password) are intentionally NOT included — adding a contact
 * must not silently grant a sub-account login or notification permissions.
 */
const CONTACT_FIELD_ALLOWLIST: readonly string[] = [
  'firstname',
  'lastname',
  'email',
  'companyname',
  'address1',
  'address2',
  'city',
  'state',
  'postcode',
  'country',
  'phonenumber',
];

/**
 * `client:contact:add` `{clientid, ...contact fields}` → WHMCS `AddContact`.
 * STRICT: clientid + only the allowlisted contact fields; permission/subaccount
 * keys dropped.
 */
export function mapContactAddParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { clientid: params.clientid };
  for (const key of CONTACT_FIELD_ALLOWLIST) {
    if (params[key] !== undefined) out[key] = params[key];
  }
  return out;
}

/**
 * `client:contact:update` `{contactid, ...≥1 contact field}` → WHMCS
 * `UpdateContact`. STRICT: contactid + only the present allowlisted fields.
 */
export function mapContactUpdateParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { contactid: params.contactid };
  for (const key of CONTACT_FIELD_ALLOWLIST) {
    if (params[key] !== undefined) out[key] = params[key];
  }
  return out;
}

/** STRICT allowlist of WHMCS `AddBillableItem` fields. */
const BILLABLE_ITEM_FIELD_ALLOWLIST: readonly string[] = [
  'clientid',
  'description',
  'amount',
  'recur',
  'recurcycle',
  'recurfor',
  'invoiceaction',
  'duedate',
];

/**
 * `billing:billable_item:add` `{clientid, description, amount, ...}` → WHMCS
 * `AddBillableItem`. STRICT: only the allowlisted fields pass through; extras
 * dropped. `invoiceaction` (when supplied) controls whether/when WHMCS raises an
 * invoice — the mapper forwards the caller's choice but never injects one.
 */
export function mapBillableItemParams(params: Record<string, unknown>): Record<string, unknown> {
  return pickFields(params, BILLABLE_ITEM_FIELD_ALLOWLIST);
}

/**
 * STRICT allowlist of top-level WHMCS `CreateQuote` fields (beyond the flattened
 * line-item keys this mapper builds from `items`). `proposal`/raw HTML and any
 * other unknown key are dropped.
 */
const QUOTE_CREATE_FIELD_ALLOWLIST: readonly string[] = [
  'subject',
  'stage',
  'validuntil',
  'userid',
  'firstname',
  'lastname',
  'companyname',
  'email',
  'currency',
  'datecreated',
  'customernotes',
];

/**
 * `billing:quote:create` `{subject, stage, validuntil, items:[{description,
 * amount, taxed}], ...}` → WHMCS `CreateQuote`. Flattens `items` into
 * `lineitemdescription{N}` / `lineitemamount{N}` / `lineitemtaxed{N}` (1-based)
 * — the WHMCS CreateQuote line-item shape — and copies only allowlisted
 * top-level fields. The original `items` key is consumed, never copied.
 */
export function mapQuoteCreateParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = pickFields(params, QUOTE_CREATE_FIELD_ALLOWLIST);
  const items = Array.isArray(params.items) ? params.items : [];
  items.forEach((item, i) => {
    const idx = i + 1;
    const it = asRecord(item);
    out[`lineitemdescription${idx}`] = it.description;
    out[`lineitemamount${idx}`] = it.amount;
    if (it.taxed !== undefined) out[`lineitemtaxed${idx}`] = it.taxed ? 1 : 0;
  });
  return out;
}

/**
 * STRICT allowlist of WHMCS `UpdateQuote` top-level fields. `quoteid` is always
 * emitted; line items, when supplied, are flattened like CreateQuote.
 */
const QUOTE_UPDATE_FIELD_ALLOWLIST: readonly string[] = [
  'quoteid',
  'subject',
  'stage',
  'validuntil',
  'currency',
  'customernotes',
];

/**
 * `billing:quote:update` `{quoteid, ...≥1 field}` → WHMCS `UpdateQuote`. STRICT:
 * quoteid + allowlisted fields; optional `items` flattened to the
 * lineitem{field}{N} shape. Extras dropped.
 */
export function mapQuoteUpdateParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = pickFields(params, QUOTE_UPDATE_FIELD_ALLOWLIST);
  if (Array.isArray(params.items)) {
    params.items.forEach((item, i) => {
      const idx = i + 1;
      const it = asRecord(item);
      out[`lineitemdescription${idx}`] = it.description;
      out[`lineitemamount${idx}`] = it.amount;
      if (it.taxed !== undefined) out[`lineitemtaxed${idx}`] = it.taxed ? 1 : 0;
    });
  }
  return out;
}

/**
 * `billing:quote:send` `{quoteid}` → WHMCS `SendQuote` `{quoteid}`. STRICT
 * 1-key output; extras dropped.
 */
export function mapQuoteSendParams(params: Record<string, unknown>): Record<string, unknown> {
  return { quoteid: params.quoteid };
}

/**
 * `billing:quote:accept` `{quoteid}` → WHMCS `AcceptQuote` `{quoteid}`. STRICT
 * 1-key output; extras dropped. Accepting converts the quote to an invoice — a
 * financial commitment — so no other field (e.g. an injected paymentmethod) is
 * ever forwarded.
 */
export function mapQuoteAcceptParams(params: Record<string, unknown>): Record<string, unknown> {
  return { quoteid: params.quoteid };
}

/** STRICT allowlist of WHMCS `AddTicketNote` fields for `ticket:note`. */
const TICKET_NOTE_FIELD_ALLOWLIST: readonly string[] = ['ticketid', 'message'];

/**
 * `ticket:note` `{ticketid, message}` → WHMCS `AddTicketNote`. STRICT: emits
 * only ticketid + message (the internal note body); markdown/adminid/etc.
 * dropped.
 */
export function mapTicketNoteParams(params: Record<string, unknown>): Record<string, unknown> {
  return pickFields(params, TICKET_NOTE_FIELD_ALLOWLIST);
}

/**
 * `ticket:merge` `{ticketid, mergeticketids:[...]}` → WHMCS `MergeTicket`
 * `{ticketid, mergeticketids}`. STRICT: emits the primary ticketid + a
 * comma-joined list of the tickets to merge into it; extras dropped. The
 * validator guarantees a non-empty array of positive-integer ids.
 */
export function mapTicketMergeParams(params: Record<string, unknown>): Record<string, unknown> {
  const ids = Array.isArray(params.mergeticketids) ? params.mergeticketids : [];
  return {
    ticketid: params.ticketid,
    mergeticketids: ids.join(','),
  };
}

/* ───────────────────────────  Dispatcher  ───────────────────────────────── */

/**
 * Dispatch the intent params to the correct per-scope mapper.
 *
 * The mapper is invoked at two points in the write flow:
 *   - At draft/validate/approve render time, to populate `would_call.whmcs_params`
 *     so operators can see the exact call shape pre-execution.
 *   - Immediately before `whmcs.mutate(...)` at execute time.
 *
 * Any unknown scope returns the params unchanged. Adding a new scope to
 * `WriteScope` is a typescript-checked obligation to add a mapper here.
 */
export function intentToWhmcsParams(
  scope: WriteScope,
  intentParams: Record<string, unknown>,
  ctx?: MappingContext
): Record<string, unknown> {
  const params = isPlainObject(intentParams) ? intentParams : {};
  switch (scope) {
    case 'client_note:write':
      return mapClientNoteParams(params);
    case 'ticket:create':
      return mapTicketCreateParams(params);
    case 'ticket:reply':
      return mapTicketReplyParams(params);
    case 'ticket:status':
      return mapTicketStatusParams(params);
    case 'billing:invoice:create':
      return mapInvoiceCreateParams(params);
    case 'billing:payment:add':
      return mapInvoicePaymentParams(params, ctx);
    case 'billing:credit:add':
      return mapCreditAddParams(params);
    case 'billing:refund:record':
      return mapRefundRecordParams(params, ctx);
    case 'service:domain_rename':
      return mapServiceDomainRenameParams(params);
    case 'service:suspend':
      return mapServiceSuspendParams(params);
    case 'service:unsuspend':
      return mapServiceUnsuspendParams(params);
    case 'service:terminate':
      return mapServiceTerminateParams(params);
    case 'domain:nameservers:update':
      return mapDomainNameserversParams(params);
    case 'billing:payment:capture':
      return mapPaymentCaptureParams(params);
    case 'billing:credit:apply':
      return mapCreditApplyParams(params);
    case 'domain:register':
      return mapDomainRegisterParams(params);
    case 'domain:renew':
      return mapDomainRenewParams(params);
    case 'order:accept':
      return mapOrderAcceptParams(params);
    case 'client:create':
      return mapClientCreateParams(params);
    case 'client:update':
      return mapClientUpdateParams(params);
    case 'service:change_package':
      return mapServiceChangePackageParams(params);
    case 'service:upgrade':
      return mapServiceUpgradeParams(params);
    case 'domain:idprotect:toggle':
      return mapDomainIdProtectParams(params);
    case 'domain:lock:toggle':
      return mapDomainLockParams(params);
    case 'client:contact:add':
      return mapContactAddParams(params);
    case 'client:contact:update':
      return mapContactUpdateParams(params);
    case 'billing:billable_item:add':
      return mapBillableItemParams(params);
    case 'billing:quote:create':
      return mapQuoteCreateParams(params);
    case 'billing:quote:update':
      return mapQuoteUpdateParams(params);
    case 'billing:quote:send':
      return mapQuoteSendParams(params);
    case 'billing:quote:accept':
      return mapQuoteAcceptParams(params);
    case 'ticket:note':
      return mapTicketNoteParams(params);
    case 'ticket:merge':
      return mapTicketMergeParams(params);
    case 'service:price_restore': {
      // Batch scope — the dispatcher's single-call contract doesn't fit.
      // The write-flow's executePriceRestoreBatch helper calls
      // mapServicePriceRestoreTarget per target directly. This case throws
      // to surface any accidental dispatcher use as a clear bug.
      throw new Error(
        'service:price_restore is batch-shaped; call mapServicePriceRestoreTarget per target'
      );
    }
    default: {
      // Exhaustiveness guard — typescript will flag any new scope here.
      const _exhaustive: never = scope;
      void _exhaustive;
      return { ...params };
    }
  }
}
