/**
 * Canonical mappers — WHMCS billing read entities:
 *
 *   - `mapToCanonicalPayMethods`  ← WHMCS `GetPayMethods` (a client's stored
 *     pay methods: cards, bank accounts, gateway-remote tokens).
 *   - `mapToCanonicalCredits`     ← WHMCS `GetCredits` (a client's credit
 *     ledger entries).
 *
 * Both are CLIENT-SCOPED reads (clientid required at the tool boundary).
 *
 * SECURITY — PCI/financial-instrument data is the whole point of this module.
 * WHMCS `GetPayMethods` returns full stored payment-instrument material:
 * card number, expiry date, CVV/start date, issue number, bank account number,
 * routing/sort code, and opaque gateway tokens. NONE of that may ever leave
 * the local boundary, so every such field is classified `secret.credential`.
 * The projector DROPS `secret.credential` for ALL non-local contracts (it is
 * only ever visible to the `debug_local` / `none_local_only` contracts), which
 * means a misconfigured or LLM/client/operator consumer can NEVER receive raw
 * PAN, expiry, CVV, account/routing numbers, or tokens.
 *
 * We surface a masked `lastFour` (business.label) ONLY when WHMCS already
 * provides a pre-masked value (`lastfour` / a masked `cardnum` like
 * `************1111`). We NEVER derive last4 from a raw PAN, and we NEVER emit
 * the raw PAN under any class. When a field's sensitivity is ambiguous, it is
 * classified `secret.credential` (fail-closed).
 *
 * Data is COMPLETE; projection/redaction happens later at the output boundary
 * (the canonical layer never decides who sees what). See
 * docs/PHASE_B_GOVERNANCE.md §2/§3.
 *
 * READ-ONLY. PURE. Never calls WHMCS, never registers a tool.
 */
import type { Canonical } from '../governance/types.js';
import { asRecord, str, num, listOf, ClassMapBuilder } from './_shared.js';

/* ───────────────────────────────  Pay methods  ──────────────────────────── */

/**
 * Stored card material. EVERY field here is raw payment-instrument data and is
 * classified `secret.credential` — none of it survives projection outside the
 * local boundary. `lastFour` is the only display-safe value and lives on the
 * parent record, populated ONLY from a WHMCS-provided masked value.
 */
export interface CanonicalPayMethodCard {
  cardNumber: string | null;
  expiryDate: string | null;
  startDate: string | null;
  issueNumber: string | null;
}

/** Stored bank-account material. All `secret.credential`. */
export interface CanonicalPayMethodBankAccount {
  accountNumber: string | null;
  accountType: string | null;
  routingNumber: string | null;
  bankName: string | null;
}

export interface CanonicalPayMethod {
  payMethodId: number | null;
  /** WHMCS pay-method type, e.g. CreditCard / BankAccount / RemoteToken. */
  type: string | null;
  /** Operator-facing display label (e.g. "Visa ending 4242"). */
  description: string | null;
  /** Gateway/module reference, e.g. stripe. */
  gateway: string | null;
  /** Masked last four — ONLY if WHMCS already provides a masked value. */
  lastFour: string | null;
  /** Opaque gateway token / remote storage reference. SECRET. */
  remoteToken: string | null;
  /** Raw stored card material. SECRET. Null when not a card. */
  card: CanonicalPayMethodCard | null;
  /** Raw stored bank material. SECRET. Null when not a bank account. */
  bankAccount: CanonicalPayMethodBankAccount | null;
}

/**
 * Extract a masked last-four ONLY from a value WHMCS already masked.
 *  - an explicit `lastfour` / `last4` field (WHMCS returns the safe 4 digits),
 *  - or a masked `cardnum` such as `************1111` / `XXXXXXXXXXXX1111`.
 * A bare all-digit `cardnum` is a RAW PAN — we refuse it and return null.
 */
function maskedLastFour(src: Record<string, unknown>): string | null {
  const explicit = str(src, 'lastfour') ?? str(src, 'last4');
  if (explicit !== undefined) {
    const digits = explicit.replace(/\D/g, '');
    if (digits.length >= 1 && digits.length <= 4) {
      return digits.padStart(4, '0').slice(-4);
    }
    return null;
  }
  const cardnum = str(src, 'cardnum') ?? str(src, 'cardnumber');
  if (cardnum !== undefined) {
    // Only trust it if it is actually masked (contains a masking char), so we
    // never derive last4 from a raw PAN.
    if (/[*xX•]/.test(cardnum)) {
      const tail = cardnum.replace(/\D/g, '').slice(-4);
      return tail.length > 0 ? tail : null;
    }
  }
  return null;
}

function mapCard(src: Record<string, unknown>): CanonicalPayMethodCard | null {
  const cardNumber = str(src, 'cardnum') ?? str(src, 'cardnumber') ?? null;
  const expiryDate = str(src, 'expdate') ?? str(src, 'cardexpiry') ?? null;
  const startDate = str(src, 'startdate') ?? str(src, 'cardstart') ?? null;
  const issueNumber = str(src, 'issuenumber') ?? null;
  if (
    cardNumber === null &&
    expiryDate === null &&
    startDate === null &&
    issueNumber === null
  ) {
    return null;
  }
  return { cardNumber, expiryDate, startDate, issueNumber };
}

function mapBank(
  src: Record<string, unknown>
): CanonicalPayMethodBankAccount | null {
  const accountNumber =
    str(src, 'accountnumber') ?? str(src, 'bankacct') ?? null;
  const accountType = str(src, 'accounttype') ?? str(src, 'bankacctype') ?? null;
  const routingNumber =
    str(src, 'routingnumber') ?? str(src, 'bankcode') ?? str(src, 'sortcode') ?? null;
  const bankName = str(src, 'bankname') ?? null;
  if (
    accountNumber === null &&
    accountType === null &&
    routingNumber === null &&
    bankName === null
  ) {
    return null;
  }
  return { accountNumber, accountType, routingNumber, bankName };
}

/**
 * WHMCS `GetPayMethods` nests the instrument detail one level down, under a
 * key that varies by type (`card`, `bankaccount`, `remotetoken`). We read from
 * the nested record when present, otherwise from the flat row (older shapes).
 */
function mapOnePayMethod(raw: Record<string, unknown>): CanonicalPayMethod {
  const card = asRecord(raw.card);
  const bank = asRecord(raw.bankaccount);
  const remote = asRecord(raw.remotetoken);

  const cardSrc = Object.keys(card).length > 0 ? card : raw;
  const bankSrc = Object.keys(bank).length > 0 ? bank : raw;

  const remoteToken =
    str(remote, 'token') ??
    str(raw, 'remotetoken') ??
    str(raw, 'token') ??
    str(raw, 'gatewayid') ??
    null;

  return {
    payMethodId: num(raw, 'id') ?? num(raw, 'paymethodid') ?? null,
    type: str(raw, 'type') ?? null,
    description: str(raw, 'description') ?? null,
    gateway:
      str(raw, 'gateway_name') ?? str(raw, 'gateway') ?? str(raw, 'paymentmethod') ?? null,
    lastFour: maskedLastFour(cardSrc),
    remoteToken,
    card: mapCard(cardSrc),
    bankAccount: mapBank(bankSrc),
  };
}

const PAY_METHOD_CLASSES = new ClassMapBuilder()
  // SECURITY (CRITICAL fix): the container itself is secret.credential, NOT
  // public.safe. `project()` walks only top-level keys, so the per-leaf
  // `payMethods[].card.*` secret labels below were DEAD — the whole array
  // (raw PAN / bank / token) leaked to every consumer. Classing the container
  // secret makes it fail-closed (dropped in all non-local contracts). Per-leaf
  // labels are retained for when projection recurses (then a granular safe
  // subset can be restored). Until then payment instruments are local/admin
  // only — the correct PCI posture.
  .set('payMethods', 'secret.credential')
  .set('payMethods[].payMethodId', 'business.identifier')
  .set('payMethods[].type', 'public.safe')
  .set('payMethods[].description', 'business.label')
  .set('payMethods[].gateway', 'financial.reference')
  // The ONLY display-safe card-ish value, and only ever populated from a
  // WHMCS-provided masked number.
  .set('payMethods[].lastFour', 'business.label')
  // ── SECRET: dropped for every non-local contract ──────────────────────────
  .set('payMethods[].remoteToken', 'secret.credential')
  .set('payMethods[].card', 'secret.credential')
  .set('payMethods[].card.cardNumber', 'secret.credential')
  .set('payMethods[].card.expiryDate', 'secret.credential')
  .set('payMethods[].card.startDate', 'secret.credential')
  .set('payMethods[].card.issueNumber', 'secret.credential')
  .set('payMethods[].bankAccount', 'secret.credential')
  .set('payMethods[].bankAccount.accountNumber', 'secret.credential')
  .set('payMethods[].bankAccount.accountType', 'secret.credential')
  .set('payMethods[].bankAccount.routingNumber', 'secret.credential')
  .set('payMethods[].bankAccount.bankName', 'secret.credential')
  .build();

export interface CanonicalPayMethods {
  clientId: number | null;
  payMethods: CanonicalPayMethod[];
}

export function mapToCanonicalPayMethods(
  raw: unknown
): Canonical<CanonicalPayMethods> {
  const src = asRecord(raw);
  const rows = listOf(src.paymethods, 'paymethod');
  const data: CanonicalPayMethods = {
    clientId: num(src, 'clientid') ?? num(src, 'userid') ?? null,
    payMethods: rows.map((r) => mapOnePayMethod(r)),
  };
  const classes = new ClassMapBuilder()
    .set('clientId', 'business.identifier')
    .build();
  return {
    entity: 'transaction',
    data,
    // Merge the per-row classmap with the top-level clientId class.
    classes: Object.freeze({ ...PAY_METHOD_CLASSES, ...classes }),
  };
}

/* ────────────────────────────────  Credits  ─────────────────────────────── */

export interface CanonicalCredit {
  creditId: number | null;
  date: string | null;
  /** Free-text/operator description of the credit entry. */
  description: string | null;
  amount: number | null;
  /** Related record id (e.g. invoice the credit was applied to). */
  relatedId: number | null;
}

export interface CanonicalCredits {
  clientId: number | null;
  credits: CanonicalCredit[];
}

function mapOneCredit(raw: Record<string, unknown>): CanonicalCredit {
  return {
    creditId: num(raw, 'id') ?? num(raw, 'creditid') ?? null,
    date: str(raw, 'date') ?? null,
    description: str(raw, 'description') ?? null,
    amount: num(raw, 'amount') ?? null,
    relatedId: num(raw, 'relid') ?? null,
  };
}

const CREDIT_CLASSES = new ClassMapBuilder()
  .set('clientId', 'business.identifier')
  .set('credits', 'public.safe')
  .set('credits[].creditId', 'business.identifier')
  .set('credits[].relatedId', 'business.identifier')
  .set('credits[].date', 'public.safe')
  .set('credits[].description', 'business.label')
  .set('credits[].amount', 'financial.amount')
  .build();

export function mapToCanonicalCredits(
  raw: unknown
): Canonical<CanonicalCredits> {
  const src = asRecord(raw);
  const rows = listOf(src.credits, 'credit');
  const data: CanonicalCredits = {
    clientId: num(src, 'clientid') ?? num(src, 'userid') ?? null,
    credits: rows.map((r) => mapOneCredit(r)),
  };
  return { entity: 'transaction', data, classes: CREDIT_CLASSES };
}
