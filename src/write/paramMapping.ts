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

/**
 * `ticket:create` — passthrough. WHMCS `OpenTicket` accepts the intent-shape
 * keys 1:1; the mapper exists so future field divergence has a single home.
 */
export function mapTicketCreateParams(params: Record<string, unknown>): Record<string, unknown> {
  return { ...params };
}

/** `ticket:reply` — passthrough (intent shape == WHMCS shape today). */
export function mapTicketReplyParams(params: Record<string, unknown>): Record<string, unknown> {
  return { ...params };
}

/** `ticket:status` — passthrough. */
export function mapTicketStatusParams(params: Record<string, unknown>): Record<string, unknown> {
  return { ...params };
}

/**
 * `billing:invoice:create` `{userid, items: [{description, amount, taxed}], ...}`
 * → flatten items into WHMCS `CreateInvoice` `itemdescription{N}/itemamount{N}/
 * itemtaxed{N}` shape (1-based). The original `items` key is REMOVED.
 */
export function mapInvoiceCreateParams(params: Record<string, unknown>): Record<string, unknown> {
  // Carry over every key EXCEPT items.
  const { items: _ignored, ...rest } = params;
  void _ignored;
  const out: Record<string, unknown> = { ...rest };

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
  const out: Record<string, unknown> = { ...params };
  if (out.transid === undefined || out.transid === '' || out.transid === null) {
    const invoiceid = safeIdPart(params.invoiceid, 'noinv');
    out.transid = deterministicTransIdFromIdempotency(`PAY-${invoiceid}`, ctx?.idempotency_key);
  }
  if (out.gateway === undefined || out.gateway === '' || out.gateway === null) {
    // Mapper cannot infer gateway from an invoice without reading WHMCS; the
    // caller is expected to supply it. We leave the key off so WHMCS uses the
    // invoice's recorded paymentmethod rather than a wrong default.
    delete out.gateway;
  }
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
