/**
 * Composite client-to-client account-credit transfer for WHMCS 8.x/9.x.
 *
 * WHMCS has no atomic "transfer credit" API action. This executor therefore
 * uses the supported AddCredit remove/add pair, compensates the source if the
 * destination leg fails, verifies both credit rows and balances, records two
 * built-in activity entries, then creates paired non-sticky client notes.
 * Business timestamps are read back from WHMCS; host-clock timestamps are not
 * written into the transfer record or client notes.
 */

import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export type CreditTransferState =
  | 'prepared'
  | 'source_debited'
  | 'financially_completed'
  | 'completed'
  | 'compensated'
  | 'audit_repair_required';

export interface CreditTransferRecord {
  readonly transfer_id: string;
  readonly request_id: string;
  readonly source_clientid: number;
  readonly destination_clientid: number;
  readonly amount: string;
  readonly currency: string;
  readonly reason: string;
  readonly state: CreditTransferState;
  readonly approval: {
    readonly mode: 'self-approved' | 'finance-approved';
    readonly actor_consumer_id: string;
    readonly approver_consumer_id?: string;
  };
  readonly tax: {
    readonly enabled: boolean;
    readonly approval_recommended: boolean;
    readonly invoice_created: false;
  };
  readonly reverses_transfer_id?: string;
  readonly reversed_by_transfer_id?: string;
  readonly whmcs_native_occurred_at?: string;
  readonly whmcs_native_credit_date?: string;
  readonly source_credit_id?: number;
  readonly destination_credit_id?: number;
  readonly source_activity_id?: number;
  readonly destination_activity_id?: number;
  readonly source_note_id?: number;
  readonly destination_note_id?: number;
  readonly compensation_credit_id?: number;
  readonly balances: {
    readonly source_before: string;
    readonly destination_before: string;
    readonly source_after?: string;
    readonly destination_after?: string;
    readonly conserved?: boolean;
  };
  readonly invoice_counts: {
    readonly source_before: number;
    readonly destination_before: number;
    readonly source_after?: number;
    readonly destination_after?: number;
    readonly unchanged?: boolean;
  };
  readonly failure?: string;
}

export interface CreditTransferWhmcs {
  read<T>(
    action: string,
    params?: Record<string, unknown>,
    options?: { readonly bypassCache?: boolean }
  ): Promise<T>;
  mutate<T>(action: string, params?: Record<string, unknown>): Promise<T>;
}

export interface CreditTransferInput {
  readonly source_clientid: number;
  readonly destination_clientid: number;
  readonly amount: string;
  readonly reason: string;
  readonly request_id: string;
  readonly approval: CreditTransferRecord['approval'];
  readonly reverses_transfer_id?: string;
}

function rows(value: unknown, outer: string, inner: string): Record<string, unknown>[] {
  const root = value as Record<string, unknown> | null;
  const group = root?.[outer] as Record<string, unknown> | undefined;
  const found = group?.[inner];
  if (found === undefined || found === null) return [];
  return Array.isArray(found)
    ? (found as Record<string, unknown>[])
    : [found as Record<string, unknown>];
}

function money(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error('invalid monetary value returned by WHMCS');
  return n.toFixed(2);
}

function cents(value: unknown): number {
  return Math.round(Number(money(value)) * 100);
}

function safeText(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 500);
}

function scalarText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return '';
}

function boolSetting(value: unknown): boolean {
  return ['1', 'on', 'true', 'yes'].includes(scalarText(value).trim().toLowerCase());
}

export class CreditTransferStore {
  private readonly records = new Map<string, CreditTransferRecord>();
  private readonly byRequest = new Map<string, string>();

  constructor(private readonly path?: string) {
    if (!path || !existsSync(path)) return;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const record = JSON.parse(line) as CreditTransferRecord;
      this.records.set(record.transfer_id, record);
      this.byRequest.set(record.request_id, record.transfer_id);
    }
  }

  get(id: string): CreditTransferRecord | undefined {
    return this.records.get(id) ?? this.records.get(this.byRequest.get(id) ?? '');
  }

  put(record: CreditTransferRecord): void {
    const existing = this.byRequest.get(record.request_id);
    if (existing !== undefined && existing !== record.transfer_id) {
      throw new Error('request_id already belongs to another transfer');
    }
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const fd = openSync(this.path, 'a', 0o600);
      try {
        appendFileSync(fd, JSON.stringify(record) + '\n', 'utf8');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    this.records.set(record.transfer_id, record);
    this.byRequest.set(record.request_id, record.transfer_id);
  }

  clear(): void {
    this.records.clear();
    this.byRequest.clear();
  }
}

interface ClientSnapshot {
  readonly clientid: number;
  readonly status: string;
  readonly currency: string;
  readonly credit: string;
}

async function clientDetails(
  whmcs: CreditTransferWhmcs,
  clientid: number
): Promise<ClientSnapshot> {
  const response = await whmcs.read<Record<string, unknown>>(
    'GetClientsDetails',
    {
      clientid,
      stats: true,
    },
    { bypassCache: true }
  );
  const client = (response.client as Record<string, unknown> | undefined) ?? response;
  return {
    clientid,
    status: scalarText(client.status),
    currency: scalarText(client.currency_code) || scalarText(client.currency),
    credit: money(client.credit),
  };
}

async function invoiceCount(whmcs: CreditTransferWhmcs, clientid: number): Promise<number> {
  const response = await whmcs.read<Record<string, unknown>>(
    'GetInvoices',
    {
      userid: clientid,
      limitstart: 0,
      limitnum: 1,
    },
    { bypassCache: true }
  );
  return Number(response.totalresults ?? 0);
}

async function configuration(whmcs: CreditTransferWhmcs, setting: string): Promise<unknown> {
  const response = await whmcs.read<Record<string, unknown>>(
    'GetConfigurationValue',
    { setting },
    { bypassCache: true }
  );
  return response.value ?? '';
}

async function creditByDescription(
  whmcs: CreditTransferWhmcs,
  clientid: number,
  description: string
): Promise<Record<string, unknown> | undefined> {
  const response = await whmcs.read<Record<string, unknown>>(
    'GetCredits',
    { clientid },
    { bypassCache: true }
  );
  return rows(response, 'credits', 'credit').find((entry) => entry.description === description);
}

async function activityByDescription(
  whmcs: CreditTransferWhmcs,
  description: string
): Promise<Record<string, unknown> | undefined> {
  const response = await whmcs.read<Record<string, unknown>>(
    'GetActivityLog',
    {
      search: description,
      limitstart: 0,
      limitnum: 100,
    },
    { bypassCache: true }
  );
  return rows(response, 'activity', 'entry').find((entry) => entry.description === description);
}

export async function getCreditTransferTaxPolicy(whmcs: CreditTransferWhmcs): Promise<{
  tax_enabled: boolean;
  approval_recommended: boolean;
}> {
  const tax_enabled = boolSetting(await configuration(whmcs, 'TaxEnabled'));
  return { tax_enabled, approval_recommended: tax_enabled };
}

export function resolveCreditTransferApprovalPolicy(input: {
  readonly tax_enabled: boolean;
  readonly require_finance_approval: boolean;
  readonly require_finance_when_tax_enabled: boolean;
}): { readonly finance_required: boolean; readonly finance_recommended: boolean } {
  return {
    finance_required:
      input.require_finance_approval ||
      (input.tax_enabled && input.require_finance_when_tax_enabled),
    finance_recommended: input.tax_enabled,
  };
}

function assertRecordMatches(record: CreditTransferRecord, input: CreditTransferInput): void {
  if (
    record.source_clientid !== input.source_clientid ||
    record.destination_clientid !== input.destination_clientid ||
    record.amount !== money(input.amount) ||
    record.reason !== safeText(input.reason) ||
    record.reverses_transfer_id !== input.reverses_transfer_id
  ) {
    throw new Error('request_id replayed with different transfer parameters');
  }
}

function nativeId(value: unknown, label: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`WHMCS did not return ${label}`);
  return id;
}

const locks = new Map<string, Promise<CreditTransferRecord>>();

/** Serializes transfers sharing either client inside this MCP process. */
export async function executeClientCreditTransfer(args: {
  readonly whmcs: CreditTransferWhmcs;
  readonly store: CreditTransferStore;
  readonly input: CreditTransferInput;
}): Promise<CreditTransferRecord> {
  const lockKey = [args.input.source_clientid, args.input.destination_clientid]
    .sort((a, b) => a - b)
    .join(':');
  const previous = locks.get(lockKey);
  if (previous) await previous.catch(() => undefined);
  const running = executeUnlocked(args).finally(() => {
    if (locks.get(lockKey) === running) locks.delete(lockKey);
  });
  locks.set(lockKey, running);
  return running;
}

async function executeUnlocked(args: {
  readonly whmcs: CreditTransferWhmcs;
  readonly store: CreditTransferStore;
  readonly input: CreditTransferInput;
}): Promise<CreditTransferRecord> {
  const { whmcs, store } = args;
  let input = args.input;
  const existing = store.get(input.request_id);
  if (existing) {
    assertRecordMatches(existing, input);
    if (existing.state === 'completed') return existing;
    throw new Error(`transfer requires reconciliation before retry (state=${existing.state})`);
  }

  if (input.reverses_transfer_id) {
    const original = store.get(input.reverses_transfer_id);
    if (original?.state !== 'completed') throw new Error('original completed transfer not found');
    if (original.reversed_by_transfer_id) throw new Error('original transfer is already reversed');
    input = {
      ...input,
      source_clientid: original.destination_clientid,
      destination_clientid: original.source_clientid,
      amount: original.amount,
    };
  }

  if (input.source_clientid === input.destination_clientid)
    throw new Error('clients must be different');
  const amount = money(input.amount);
  if (cents(amount) <= 0) throw new Error('amount must be positive');
  const [source, destination] = await Promise.all([
    clientDetails(whmcs, input.source_clientid),
    clientDetails(whmcs, input.destination_clientid),
  ]);
  if (source.status !== 'Active' || destination.status !== 'Active') {
    throw new Error('both clients must be Active');
  }
  if (!source.currency || source.currency !== destination.currency) {
    throw new Error('client currencies must match');
  }
  if (cents(source.credit) < cents(amount)) throw new Error('insufficient source credit balance');

  const taxEnabled = boolSetting(await configuration(whmcs, 'TaxEnabled'));
  const [sourceInvoices, destinationInvoices] = await Promise.all([
    invoiceCount(whmcs, source.clientid),
    invoiceCount(whmcs, destination.clientid),
  ]);
  const transferId = `${input.reverses_transfer_id ? 'CTR' : 'CT'}-${randomUUID()}`;
  const reason = safeText(input.reason);
  let record: CreditTransferRecord = {
    transfer_id: transferId,
    request_id: input.request_id,
    source_clientid: source.clientid,
    destination_clientid: destination.clientid,
    amount,
    currency: source.currency,
    reason,
    state: 'prepared',
    approval: input.approval,
    tax: { enabled: taxEnabled, approval_recommended: taxEnabled, invoice_created: false },
    ...(input.reverses_transfer_id ? { reverses_transfer_id: input.reverses_transfer_id } : {}),
    balances: { source_before: source.credit, destination_before: destination.credit },
    invoice_counts: { source_before: sourceInvoices, destination_before: destinationInvoices },
  };
  store.put(record);

  const reversalText = input.reverses_transfer_id ? `; reverses ${input.reverses_transfer_id}` : '';
  const sourceDescription = `[${transferId}] OUT client credit to Client #${destination.clientid}${reversalText}`;
  const destinationDescription = `[${transferId}] IN client credit from Client #${source.clientid}${reversalText}`;
  await whmcs.mutate('AddCredit', {
    clientid: source.clientid,
    description: sourceDescription,
    amount,
    type: 'remove',
  });
  record = { ...record, state: 'source_debited' };
  store.put(record);

  try {
    await whmcs.mutate('AddCredit', {
      clientid: destination.clientid,
      description: destinationDescription,
      amount,
      type: 'add',
    });
  } catch (error) {
    const compensationDescription = `[${transferId}] automatic source compensation after destination failure`;
    let compensated: ClientSnapshot;
    try {
      await whmcs.mutate('AddCredit', {
        clientid: source.clientid,
        description: compensationDescription,
        amount,
        type: 'add',
      });
      compensated = await clientDetails(whmcs, source.clientid);
    } catch (compensationError) {
      record = {
        ...record,
        state: 'audit_repair_required',
        failure: `destination and compensation failed: ${error instanceof Error ? error.message : String(error)}; ${compensationError instanceof Error ? compensationError.message : String(compensationError)}`,
      };
      store.put(record);
      return record;
    }
    record = {
      ...record,
      state: 'compensated',
      balances: {
        ...record.balances,
        source_after: compensated.credit,
        destination_after: destination.credit,
        conserved: compensated.credit === source.credit,
      },
      failure: `destination leg failed; source compensated: ${error instanceof Error ? error.message : String(error)}`,
    };
    store.put(record);

    try {
      const [sourceDebit, compensationCredit] = await Promise.all([
        creditByDescription(whmcs, source.clientid, sourceDescription),
        creditByDescription(whmcs, source.clientid, compensationDescription),
      ]);
      if (!sourceDebit || !compensationCredit)
        throw new Error('compensation credit read-back failed');
      const sourceCreditId = nativeId(sourceDebit.id, 'source debit credit id');
      const compensationCreditId = nativeId(compensationCredit.id, 'source compensation credit id');
      const sourceActivityDescription = `[${transferId}] client credit transfer to Client #${destination.clientid} failed; source automatically compensated ${source.currency} ${amount}; debit #${sourceCreditId}; compensation #${compensationCreditId}`;
      const destinationActivityDescription = `[${transferId}] incoming client credit from Client #${source.clientid} failed before posting; source automatically compensated ${source.currency} ${amount}`;
      await whmcs.mutate('LogActivity', {
        clientid: source.clientid,
        description: sourceActivityDescription,
      });
      await whmcs.mutate('LogActivity', {
        clientid: destination.clientid,
        description: destinationActivityDescription,
      });
      const [sourceActivity, destinationActivity] = await Promise.all([
        activityByDescription(whmcs, sourceActivityDescription),
        activityByDescription(whmcs, destinationActivityDescription),
      ]);
      if (!sourceActivity?.date || !destinationActivity?.date) {
        throw new Error('compensation activity read-back failed');
      }
      const occurredAt = scalarText(sourceActivity.date);
      const actor = safeText(input.approval.actor_consumer_id);
      const baseNote = `Attempted ${source.currency} ${amount} transfer from Client #${source.clientid} to Client #${destination.clientid}. Method: WHMCS AddCredit remove/add with automatic source compensation. Occurred: ${occurredAt} (WHMCS native). Actor: authenticated MCP consumer ${actor}. Source debit ref: #${sourceCreditId}; compensation ref: #${compensationCreditId}; source activity ref: #${nativeId(sourceActivity.id, 'source activity id')}; destination activity ref: #${nativeId(destinationActivity.id, 'destination activity id')}. Source balance ${source.credit} -> ${compensated.credit}; destination remained ${destination.credit}. Reason: ${reason}. Status: compensated; no net credit movement; no invoice created.`;
      const sourceNoteResult = await whmcs.mutate<Record<string, unknown>>('AddClientNote', {
        userid: source.clientid,
        notes: `[Credit Transfer ${transferId}] OUT failed and compensated. ${baseNote}`,
        sticky: false,
      });
      const destinationNoteResult = await whmcs.mutate<Record<string, unknown>>('AddClientNote', {
        userid: destination.clientid,
        notes: `[Credit Transfer ${transferId}] IN failed before posting; source compensated. ${baseNote}`,
        sticky: false,
      });
      const [sourceInvoicesAfter, destinationInvoicesAfter] = await Promise.all([
        invoiceCount(whmcs, source.clientid),
        invoiceCount(whmcs, destination.clientid),
      ]);
      record = {
        ...record,
        whmcs_native_occurred_at: occurredAt,
        whmcs_native_credit_date: scalarText(sourceDebit.date),
        source_credit_id: sourceCreditId,
        compensation_credit_id: compensationCreditId,
        source_activity_id: nativeId(sourceActivity.id, 'source activity id'),
        destination_activity_id: nativeId(destinationActivity.id, 'destination activity id'),
        source_note_id: nativeId(sourceNoteResult.noteid, 'source note id'),
        destination_note_id: nativeId(destinationNoteResult.noteid, 'destination note id'),
        invoice_counts: {
          ...record.invoice_counts,
          source_after: sourceInvoicesAfter,
          destination_after: destinationInvoicesAfter,
          unchanged:
            sourceInvoicesAfter === sourceInvoices &&
            destinationInvoicesAfter === destinationInvoices,
        },
      };
      store.put(record);
      return record;
    } catch (auditError) {
      record = {
        ...record,
        state: 'audit_repair_required',
        failure: `${record.failure}; compensation audit artifacts require repair: ${auditError instanceof Error ? auditError.message : String(auditError)}`,
      };
      store.put(record);
      return record;
    }
  }

  const [sourceEntry, destinationEntry, afterSource, afterDestination] = await Promise.all([
    creditByDescription(whmcs, source.clientid, sourceDescription),
    creditByDescription(whmcs, destination.clientid, destinationDescription),
    clientDetails(whmcs, source.clientid),
    clientDetails(whmcs, destination.clientid),
  ]);
  if (!sourceEntry || !destinationEntry) throw new Error('WHMCS credit ledger read-back failed');
  const sourceCreditId = nativeId(sourceEntry.id, 'source credit id');
  const destinationCreditId = nativeId(destinationEntry.id, 'destination credit id');
  const balancesCorrect =
    cents(afterSource.credit) === cents(source.credit) - cents(amount) &&
    cents(afterDestination.credit) === cents(destination.credit) + cents(amount);
  const conserved =
    cents(afterSource.credit) + cents(afterDestination.credit) ===
    cents(source.credit) + cents(destination.credit);
  record = {
    ...record,
    state: 'financially_completed',
    source_credit_id: sourceCreditId,
    destination_credit_id: destinationCreditId,
    whmcs_native_credit_date: scalarText(sourceEntry.date),
    balances: {
      ...record.balances,
      source_after: afterSource.credit,
      destination_after: afterDestination.credit,
      conserved: balancesCorrect && conserved,
    },
  };
  store.put(record);
  if (!balancesCorrect || !conserved) {
    record = {
      ...record,
      state: 'audit_repair_required',
      failure: 'post-transfer balance reconciliation failed',
    };
    store.put(record);
    return record;
  }

  const approvalText =
    input.approval.mode === 'finance-approved'
      ? `finance-approved by ${safeText(input.approval.approver_consumer_id ?? 'authorized approver')}`
      : 'self-approved';
  const actorText = safeText(input.approval.actor_consumer_id);
  const sourceActivityDescription = `[${transferId}] client credit OUT ${source.currency} ${amount} to Client #${destination.clientid}; ${approvalText}; source credit #${sourceCreditId}; destination credit #${destinationCreditId}`;
  const destinationActivityDescription = `[${transferId}] client credit IN ${source.currency} ${amount} from Client #${source.clientid}; ${approvalText}; source credit #${sourceCreditId}; destination credit #${destinationCreditId}`;
  try {
    await whmcs.mutate('LogActivity', {
      clientid: source.clientid,
      description: sourceActivityDescription,
    });
    await whmcs.mutate('LogActivity', {
      clientid: destination.clientid,
      description: destinationActivityDescription,
    });
    const [sourceActivity, destinationActivity] = await Promise.all([
      activityByDescription(whmcs, sourceActivityDescription),
      activityByDescription(whmcs, destinationActivityDescription),
    ]);
    if (!sourceActivity?.date || !destinationActivity?.date)
      throw new Error('activity log read-back failed');
    const occurredAt = scalarText(sourceActivity.date);
    const baseNote = `Method: WHMCS AddCredit remove/add. Occurred: ${occurredAt} (WHMCS native). Actor: authenticated MCP consumer ${actorText}. Approval: ${approvalText}. Source credit ref: #${sourceCreditId}; destination credit ref: #${destinationCreditId}; source activity ref: #${nativeId(sourceActivity.id, 'source activity id')}; destination activity ref: #${nativeId(destinationActivity.id, 'destination activity id')}. Source balance ${source.credit} -> ${afterSource.credit}; destination balance ${destination.credit} -> ${afterDestination.credit}. Reason: ${reason}. Tax/GST: ${taxEnabled ? 'enabled in WHMCS; approval recommended; no invoice created for this credit transfer' : 'disabled in WHMCS; no invoice created'}. Status: completed.`;
    const sourceNote = `[Credit Transfer ${transferId}] OUT ${source.currency} ${amount} to Client #${destination.clientid}${reversalText}. ${baseNote}`;
    const destinationNote = `[Credit Transfer ${transferId}] IN ${source.currency} ${amount} from Client #${source.clientid}${reversalText}. ${baseNote}`;
    const sourceNoteResult = await whmcs.mutate<Record<string, unknown>>('AddClientNote', {
      userid: source.clientid,
      notes: sourceNote,
      sticky: false,
    });
    const destinationNoteResult = await whmcs.mutate<Record<string, unknown>>('AddClientNote', {
      userid: destination.clientid,
      notes: destinationNote,
      sticky: false,
    });
    const [sourceInvoicesAfter, destinationInvoicesAfter] = await Promise.all([
      invoiceCount(whmcs, source.clientid),
      invoiceCount(whmcs, destination.clientid),
    ]);
    const invoicesUnchanged =
      sourceInvoicesAfter === sourceInvoices && destinationInvoicesAfter === destinationInvoices;
    record = {
      ...record,
      state: invoicesUnchanged ? 'completed' : 'audit_repair_required',
      whmcs_native_occurred_at: occurredAt,
      source_activity_id: nativeId(sourceActivity.id, 'source activity id'),
      destination_activity_id: nativeId(destinationActivity.id, 'destination activity id'),
      source_note_id: nativeId(sourceNoteResult.noteid, 'source note id'),
      destination_note_id: nativeId(destinationNoteResult.noteid, 'destination note id'),
      invoice_counts: {
        ...record.invoice_counts,
        source_after: sourceInvoicesAfter,
        destination_after: destinationInvoicesAfter,
        unchanged: invoicesUnchanged,
      },
      ...(invoicesUnchanged
        ? {}
        : { failure: 'invoice count changed during pure credit transfer' }),
    };
    store.put(record);
  } catch (error) {
    record = {
      ...record,
      state: 'audit_repair_required',
      failure: `financial legs completed but WHMCS audit artifacts require repair: ${error instanceof Error ? error.message : String(error)}`,
    };
    store.put(record);
    return record;
  }

  if (record.state === 'completed' && input.reverses_transfer_id) {
    const original = store.get(input.reverses_transfer_id);
    if (original) store.put({ ...original, reversed_by_transfer_id: record.transfer_id });
  }
  return record;
}
