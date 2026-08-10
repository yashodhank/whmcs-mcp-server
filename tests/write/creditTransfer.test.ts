import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CreditTransferStore,
  executeClientCreditTransfer,
  resolveCreditTransferApprovalPolicy,
  type CreditTransferWhmcs,
} from '../../src/write/creditTransfer.js';

class FakeWhmcs implements CreditTransferWhmcs {
  clients = new Map<number, { status: string; currency_code: string; credit: number }>([
    [1, { status: 'Active', currency_code: 'INR', credit: 10 }],
    [2, { status: 'Active', currency_code: 'INR', credit: 2 }],
  ]);
  credits = new Map<number, Record<string, unknown>[]>([
    [1, []],
    [2, []],
  ]);
  activities: Record<string, unknown>[] = [];
  notes: Record<string, unknown>[] = [];
  failDestination = false;
  taxEnabled = 'on';
  nextId = 1;

  async read<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
    if (action === 'GetClientsDetails') {
      return { client: this.clients.get(Number(params.clientid)) } as T;
    }
    if (action === 'GetConfigurationValue') return { value: this.taxEnabled } as T;
    if (action === 'GetInvoices') return { totalresults: 0 } as T;
    if (action === 'GetCredits') {
      return { credits: { credit: this.credits.get(Number(params.clientid)) ?? [] } } as T;
    }
    if (action === 'GetActivityLog') {
      const search = String(params.search);
      return {
        activity: { entry: this.activities.filter((entry) => entry.description === search) },
      } as T;
    }
    throw new Error(`unexpected read ${action}`);
  }

  async mutate<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
    if (action === 'AddCredit') {
      const clientid = Number(params.clientid);
      const client = this.clients.get(clientid);
      if (!client) throw new Error('Client ID Not Found');
      if (this.failDestination && clientid === 2 && params.type === 'add') {
        this.failDestination = false;
        throw new Error('simulated destination failure');
      }
      const amount = Number(params.amount);
      if (params.type === 'remove' && client.credit < amount) {
        throw new Error('Insufficient Credit Balance');
      }
      client.credit += params.type === 'remove' ? -amount : amount;
      const id = this.nextId++;
      this.credits.get(clientid)?.push({
        id,
        clientid,
        description: params.description,
        amount: amount.toFixed(2),
        date: '2026-08-10',
      });
      return { result: 'success', newbalance: client.credit.toFixed(2) } as T;
    }
    if (action === 'LogActivity') {
      const id = this.nextId++;
      this.activities.push({
        id,
        clientid: params.clientid,
        description: params.description,
        date: '2026-08-10 18:00:00',
      });
      return { result: 'success' } as T;
    }
    if (action === 'AddClientNote') {
      const noteid = this.nextId++;
      this.notes.push({ noteid, ...params });
      return { result: 'success', noteid } as T;
    }
    throw new Error(`unexpected mutation ${action}`);
  }
}

function input(request_id = 'REQ-001') {
  return {
    source_clientid: 1,
    destination_clientid: 2,
    amount: '1.25',
    reason: 'customer-authorized balance consolidation',
    request_id,
    approval: { mode: 'self-approved' as const, actor_consumer_id: 'test-operator' },
  };
}

describe('executeClientCreditTransfer', () => {
  it('keeps finance approval disabled by default and makes tax-aware policy explicit', () => {
    expect(
      resolveCreditTransferApprovalPolicy({
        tax_enabled: false,
        require_finance_approval: false,
        require_finance_when_tax_enabled: false,
      })
    ).toEqual({ finance_required: false, finance_recommended: false });
    expect(
      resolveCreditTransferApprovalPolicy({
        tax_enabled: true,
        require_finance_approval: false,
        require_finance_when_tax_enabled: false,
      })
    ).toEqual({ finance_required: false, finance_recommended: true });
    expect(
      resolveCreditTransferApprovalPolicy({
        tax_enabled: true,
        require_finance_approval: false,
        require_finance_when_tax_enabled: true,
      })
    ).toEqual({ finance_required: true, finance_recommended: true });
  });
  it('conserves credit, uses WHMCS-native time, writes paired logs/notes, and replays safely', async () => {
    const whmcs = new FakeWhmcs();
    const store = new CreditTransferStore();
    const result = await executeClientCreditTransfer({ whmcs, store, input: input() });

    expect(result.state).toBe('completed');
    expect(result.whmcs_native_occurred_at).toBe('2026-08-10 18:00:00');
    expect(result.whmcs_native_credit_date).toBe('2026-08-10');
    expect(result.balances).toMatchObject({
      source_before: '10.00',
      destination_before: '2.00',
      source_after: '8.75',
      destination_after: '3.25',
      conserved: true,
    });
    expect(result.tax).toEqual({
      enabled: true,
      approval_recommended: true,
      invoice_created: false,
    });
    expect(result.invoice_counts.unchanged).toBe(true);
    expect(whmcs.activities).toHaveLength(2);
    expect(whmcs.notes).toHaveLength(2);
    expect(whmcs.notes.every((note) => note.sticky === false)).toBe(true);
    expect(String(whmcs.notes[0]?.notes)).toContain('2026-08-10 18:00:00 (WHMCS native)');

    const replay = await executeClientCreditTransfer({ whmcs, store, input: input() });
    expect(replay.transfer_id).toBe(result.transfer_id);
    expect(whmcs.credits.get(1)).toHaveLength(1);
    expect(whmcs.credits.get(2)).toHaveLength(1);
  });

  it('compensates the source exactly when the destination leg fails', async () => {
    const whmcs = new FakeWhmcs();
    whmcs.failDestination = true;
    const result = await executeClientCreditTransfer({
      whmcs,
      store: new CreditTransferStore(),
      input: input('REQ-COMPENSATE'),
    });

    expect(result.state).toBe('compensated');
    expect(result.balances.source_after).toBe('10.00');
    expect(result.balances.conserved).toBe(true);
    expect(whmcs.clients.get(1)?.credit).toBe(10);
    expect(whmcs.clients.get(2)?.credit).toBe(2);
    expect(result.whmcs_native_occurred_at).toBe('2026-08-10 18:00:00');
    expect(result.source_credit_id).toBeGreaterThan(0);
    expect(result.compensation_credit_id).toBeGreaterThan(0);
    expect(whmcs.activities).toHaveLength(2);
    expect(whmcs.notes).toHaveLength(2);
    expect(String(whmcs.notes[0]?.notes)).toContain('Status: compensated');
  });

  it('creates a linked reversal and prevents a second reversal', async () => {
    const whmcs = new FakeWhmcs();
    const store = new CreditTransferStore();
    const original = await executeClientCreditTransfer({ whmcs, store, input: input() });
    const reversal = await executeClientCreditTransfer({
      whmcs,
      store,
      input: {
        ...input('REQ-REVERSAL'),
        source_clientid: 2,
        destination_clientid: 1,
        reverses_transfer_id: original.transfer_id,
      },
    });

    expect(reversal.state).toBe('completed');
    expect(reversal.reverses_transfer_id).toBe(original.transfer_id);
    expect(store.get(original.transfer_id)?.reversed_by_transfer_id).toBe(reversal.transfer_id);
    expect(whmcs.clients.get(1)?.credit).toBe(10);
    expect(whmcs.clients.get(2)?.credit).toBe(2);
    await expect(
      executeClientCreditTransfer({
        whmcs,
        store,
        input: {
          ...input('REQ-REVERSAL-2'),
          source_clientid: 2,
          destination_clientid: 1,
          reverses_transfer_id: original.transfer_id,
        },
      })
    ).rejects.toThrow('already reversed');
  });

  it('serializes concurrent requests and cannot overspend the source balance', async () => {
    const whmcs = new FakeWhmcs();
    const store = new CreditTransferStore();
    const attempts = await Promise.allSettled([
      executeClientCreditTransfer({
        whmcs,
        store,
        input: { ...input('REQ-CONCURRENT-A'), amount: '6.00' },
      }),
      executeClientCreditTransfer({
        whmcs,
        store,
        input: { ...input('REQ-CONCURRENT-B'), amount: '6.00' },
      }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === 'rejected');
    expect(rejected?.status === 'rejected' ? String(rejected.reason) : '').toContain(
      'insufficient source credit balance'
    );
    expect(whmcs.clients.get(1)?.credit).toBe(4);
    expect(whmcs.clients.get(2)?.credit).toBe(8);
    expect(whmcs.credits.get(1)).toHaveLength(1);
    expect(whmcs.credits.get(2)).toHaveLength(1);
  });

  it('reloads completed reporting/idempotency state from durable JSONL', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'whmcs-credit-transfer-'));
    try {
      const path = join(directory, 'transfers.jsonl');
      const whmcs = new FakeWhmcs();
      const firstStore = new CreditTransferStore(path);
      const completed = await executeClientCreditTransfer({
        whmcs,
        store: firstStore,
        input: input('REQ-DURABLE'),
      });
      const reloaded = new CreditTransferStore(path);
      expect(reloaded.get(completed.transfer_id)).toEqual(completed);
      expect(reloaded.get('REQ-DURABLE')).toEqual(completed);
      const replay = await executeClientCreditTransfer({
        whmcs,
        store: reloaded,
        input: input('REQ-DURABLE'),
      });
      expect(replay.transfer_id).toBe(completed.transfer_id);
      expect(whmcs.credits.get(1)).toHaveLength(1);
      expect(whmcs.credits.get(2)).toHaveLength(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
