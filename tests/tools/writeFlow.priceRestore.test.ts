/**
 * service:price_restore end-to-end via executePriceRestoreBatch.
 *
 * Mocks WhmcsClient.read (GetClientsProducts) + WhmcsClient.mutate
 * (UpdateClientProduct). Drives full Phase 1 / dry_run / Phase 2.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executePriceRestoreBatch, registerWriteFlowTools } from '../../src/tools/writeFlow.js';
import { createDraftIntent, IntentStore } from '../../src/write/intents.js';
import { AuditLog } from '../../src/write/audit.js';
import { IdempotencyLedger } from '../../src/write/idempotency.js';
import type { WriteIntent } from '../../src/write/types.js';

function approvedBatch(
  targets: { serviceid: number; new_amount: number; expected_old_amount?: number }[],
  dry_run = false
): WriteIntent {
  const store = new IntentStore();
  const draft = createDraftIntent({
    consumer_id: 'cowork-test',
    scope: 'service:price_restore',
    params: { targets, dry_run },
    naturalKey: `restore-${String(Date.now())}-${String(Math.random()).slice(2)}`,
    preconditions: {},
    projected_effect: 'restore batch',
  });
  store.put(draft);
  store.transition(draft.intent_id, 'validated');
  return store.transition(draft.intent_id, 'approved');
}

interface Harness {
  audit: AuditLog;
  ledger: IdempotencyLedger;
  read: ReturnType<typeof vi.fn>;
  mutate: ReturnType<typeof vi.fn>;
}

function harness(): Harness {
  return {
    audit: new AuditLog(),
    ledger: new IdempotencyLedger(),
    read: vi.fn(),
    mutate: vi.fn(),
  };
}

const CAPS = { perAction: 20000, daily: 50000 };
const APPROVAL = { approver: 'ops', at: new Date().toISOString() };

describe('executePriceRestoreBatch — Phase 1 (snapshot + precondition)', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('aborts with precondition_mismatch when expected_old_amount does not match', async () => {
    const intent = approvedBatch([
      { serviceid: 555, new_amount: 31350, expected_old_amount: 45000 },
    ]);
    h.read.mockResolvedValueOnce({
      products: { product: [{ id: 555, recurringamount: '999', domainstatus: 'Active' }] },
    });
    const res = await executePriceRestoreBatch({
      intent,
      whmcs: { read: h.read, mutate: h.mutate } as never,
      audit: h.audit,
      ledger: h.ledger,
      caps: CAPS,
      approval: APPROVAL,
      dayAmounts: new Map(),
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('precondition_mismatch');
    expect(h.mutate).not.toHaveBeenCalled();
    expect(res.phase_1?.failedTargets).toEqual([555]);
  });

  it('aborts when a service is Terminated', async () => {
    const intent = approvedBatch([{ serviceid: 555, new_amount: 31350 }]);
    h.read.mockResolvedValueOnce({
      products: { product: [{ id: 555, recurringamount: '45000', domainstatus: 'Terminated' }] },
    });
    const res = await executePriceRestoreBatch({
      intent,
      whmcs: { read: h.read, mutate: h.mutate } as never,
      audit: h.audit,
      ledger: h.ledger,
      caps: CAPS,
      approval: APPROVAL,
      dayAmounts: new Map(),
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('precondition_mismatch');
    expect(h.mutate).not.toHaveBeenCalled();
  });

  it('aborts when a service is not found', async () => {
    const intent = approvedBatch([{ serviceid: 999, new_amount: 31350 }]);
    h.read.mockResolvedValueOnce({ products: { product: [] } });
    const res = await executePriceRestoreBatch({
      intent,
      whmcs: { read: h.read, mutate: h.mutate } as never,
      audit: h.audit,
      ledger: h.ledger,
      caps: CAPS,
      approval: APPROVAL,
      dayAmounts: new Map(),
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('precondition_mismatch');
  });
});

describe('executePriceRestoreBatch — dry_run', () => {
  it('returns a preview without invoking mutate', async () => {
    const h = harness();
    const intent = approvedBatch(
      [
        { serviceid: 555, new_amount: 31350, expected_old_amount: 45000 },
        { serviceid: 569, new_amount: 31350, expected_old_amount: 45000 },
      ],
      true
    );
    h.read
      .mockResolvedValueOnce({
        products: { product: [{ id: 555, recurringamount: '45000', domainstatus: 'Active' }] },
      })
      .mockResolvedValueOnce({
        products: { product: [{ id: 569, recurringamount: '45000', domainstatus: 'Active' }] },
      });
    const res = await executePriceRestoreBatch({
      intent,
      whmcs: { read: h.read, mutate: h.mutate } as never,
      audit: h.audit,
      ledger: h.ledger,
      caps: CAPS,
      approval: APPROVAL,
      dayAmounts: new Map(),
    });
    expect(res.allowed).toBe(true);
    expect(res.dry_run).toBe(true);
    expect(h.mutate).not.toHaveBeenCalled();
    expect(res.phase_1?.snapshots).toEqual([
      { serviceid: 555, current_amount: 45000 },
      { serviceid: 569, current_amount: 45000 },
    ]);
  });
});

describe('executePriceRestoreBatch — Phase 2', () => {
  it('succeeds on a single-target batch, mutates once, read-back verifies', async () => {
    const h = harness();
    const intent = approvedBatch([
      { serviceid: 555, new_amount: 31350, expected_old_amount: 45000 },
    ]);
    h.read
      .mockResolvedValueOnce({
        products: { product: [{ id: 555, recurringamount: '45000', domainstatus: 'Active' }] },
      })
      .mockResolvedValueOnce({
        products: { product: [{ id: 555, recurringamount: '31350', domainstatus: 'Active' }] },
      });
    h.mutate.mockResolvedValueOnce({ result: 'success' });

    const res = await executePriceRestoreBatch({
      intent,
      whmcs: { read: h.read, mutate: h.mutate } as never,
      audit: h.audit,
      ledger: h.ledger,
      caps: CAPS,
      approval: APPROVAL,
      dayAmounts: new Map(),
    });
    expect(res.allowed).toBe(true);
    expect(h.mutate).toHaveBeenCalledTimes(1);
    expect(h.mutate).toHaveBeenCalledWith('UpdateClientProduct', {
      serviceid: 555,
      recurringamount: 31350,
    });
    expect(res.phase_2?.outcomes).toEqual([
      { serviceid: 555, status: 'verified', old: 45000, new: 31350, delta: 13650 },
    ]);
  });

  it('cap FLOOR: unconfigured caps {0,0} block even a zero-delta target (no mutate)', async () => {
    const h = harness();
    // new_amount === current ⇒ delta 0; must STILL be blocked when caps are 0.
    const intent = approvedBatch([{ serviceid: 555, new_amount: 45000 }]);
    h.read.mockResolvedValueOnce({
      products: { product: [{ id: 555, recurringamount: '45000', domainstatus: 'Active' }] },
    });
    const res = await executePriceRestoreBatch({
      intent,
      whmcs: { read: h.read, mutate: h.mutate } as never,
      audit: h.audit,
      ledger: h.ledger,
      caps: { perAction: 0, daily: 0 },
      approval: APPROVAL,
      dayAmounts: new Map(),
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('target_amount_cap_exceeded');
    expect(h.mutate).not.toHaveBeenCalled();
  });

  it('halts mid-batch on first mutate failure; later targets untouched', async () => {
    const h = harness();
    const intent = approvedBatch([
      { serviceid: 555, new_amount: 31350 },
      { serviceid: 569, new_amount: 31350 },
      { serviceid: 586, new_amount: 31350 },
    ]);
    h.read
      .mockResolvedValueOnce({
        products: { product: [{ id: 555, recurringamount: '45000', domainstatus: 'Active' }] },
      })
      .mockResolvedValueOnce({
        products: { product: [{ id: 569, recurringamount: '45000', domainstatus: 'Active' }] },
      })
      .mockResolvedValueOnce({
        products: { product: [{ id: 586, recurringamount: '45000', domainstatus: 'Active' }] },
      })
      .mockResolvedValueOnce({
        products: { product: [{ id: 555, recurringamount: '31350', domainstatus: 'Active' }] },
      });
    h.mutate
      .mockResolvedValueOnce({ result: 'success' })
      .mockRejectedValueOnce(new Error('whmcs boom'));

    const res = await executePriceRestoreBatch({
      intent,
      whmcs: { read: h.read, mutate: h.mutate } as never,
      audit: h.audit,
      ledger: h.ledger,
      caps: CAPS,
      approval: APPROVAL,
      dayAmounts: new Map(),
    });
    expect(res.allowed).toBe(true);
    expect(res.phase_2?.halted_after).toBe(569);
    expect(h.mutate).toHaveBeenCalledTimes(2);
    expect(res.phase_2?.outcomes).toEqual([
      { serviceid: 555, status: 'verified', old: 45000, new: 31350, delta: 13650 },
      { serviceid: 569, status: 'failed', old: 45000, new: 31350, delta: 13650 },
    ]);
  });

  it('rejects a target whose per-action delta exceeds cap', async () => {
    const h = harness();
    const intent = approvedBatch([{ serviceid: 555, new_amount: 100, expected_old_amount: 45000 }]);
    h.read.mockResolvedValueOnce({
      products: { product: [{ id: 555, recurringamount: '45000', domainstatus: 'Active' }] },
    });
    const res = await executePriceRestoreBatch({
      intent,
      whmcs: { read: h.read, mutate: h.mutate } as never,
      audit: h.audit,
      ledger: h.ledger,
      caps: { perAction: 20000, daily: 50000 },
      approval: APPROVAL,
      dayAmounts: new Map(),
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('target_amount_cap_exceeded');
    expect(h.mutate).not.toHaveBeenCalled();
  });

  it('rejects when running daily delta sum would exceed daily cap', async () => {
    const h = harness();
    const intent = approvedBatch([
      { serviceid: 555, new_amount: 31350, expected_old_amount: 45000 },
    ]);
    h.read.mockResolvedValueOnce({
      products: { product: [{ id: 555, recurringamount: '45000', domainstatus: 'Active' }] },
    });
    const dayAmounts = new Map<string, number>();
    const todayKey = `UpdateClientProduct|${new Date().toISOString().slice(0, 10)}`;
    dayAmounts.set(todayKey, 40000);

    const res = await executePriceRestoreBatch({
      intent,
      whmcs: { read: h.read, mutate: h.mutate } as never,
      audit: h.audit,
      ledger: h.ledger,
      caps: { perAction: 20000, daily: 50000 },
      approval: APPROVAL,
      dayAmounts,
    });
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe('target_amount_cap_exceeded');
    expect(h.mutate).not.toHaveBeenCalled();
  });

  it('per-target idempotency: re-running the same intent skips already-done targets', async () => {
    const h = harness();
    const intent = approvedBatch([
      { serviceid: 555, new_amount: 31350, expected_old_amount: 45000 },
      { serviceid: 569, new_amount: 31350, expected_old_amount: 45000 },
    ]);
    const perTargetKey555 = `${intent.idempotency_key}|555`;
    h.ledger.record(perTargetKey555, { status: 'verified', new: 31350 });

    h.read
      .mockResolvedValueOnce({
        products: { product: [{ id: 555, recurringamount: '31350', domainstatus: 'Active' }] },
      })
      .mockResolvedValueOnce({
        products: { product: [{ id: 569, recurringamount: '45000', domainstatus: 'Active' }] },
      })
      .mockResolvedValueOnce({
        products: { product: [{ id: 569, recurringamount: '31350', domainstatus: 'Active' }] },
      });
    h.mutate.mockResolvedValueOnce({ result: 'success' });

    const res = await executePriceRestoreBatch({
      intent,
      whmcs: { read: h.read, mutate: h.mutate } as never,
      audit: h.audit,
      ledger: h.ledger,
      caps: CAPS,
      approval: APPROVAL,
      dayAmounts: new Map(),
    });
    expect(res.allowed).toBe(true);
    expect(h.mutate).toHaveBeenCalledTimes(1);
    expect(h.mutate).toHaveBeenCalledWith('UpdateClientProduct', {
      serviceid: 569,
      recurringamount: 31350,
    });
  });
});

import { createHash } from 'node:crypto';

const RAW_TOKEN = 'PRICE-RESTORE-E2E-SYNTHETIC';
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

beforeEach(() => {
  process.env.MCP_CONSUMER_REGISTRY = JSON.stringify([
    {
      id: 'pr-test',
      token_sha256: sha(RAW_TOKEN),
      allowedScopes: ['read'],
      defaultContract: 'ops_operator',
      allowedContracts: ['ops_operator'],
      allowedActions: [],
      writeCapability: 'execution_allowed',
      allowedWriteScopes: ['service:price_restore'],
      envRestrictions: [],
      anonymous: false,
    },
  ]);
});

vi.mock('../../src/config.js', () => ({
  config: {
    MCP_MODE: 'full',
    MCP_ENV: 'local',
    MCP_MAX_PAGE_SIZE: 100,
    MCP_WRITE_KILL_SWITCH: false,
    MCP_PROD_WRITE_AUTHORIZED: [],
    // Real config parses MCP_WRITE_EXECUTION_AUTHORIZED to a string[] (see
    // config.ts). It MUST be an array here so runtimeAuthorizedActions() reads
    // it directly; a bare string falls through to the unset process.env and
    // yields [] (no authorization). The batch path now enforces this allowlist
    // (steps 1–7 via preAuthorizeIntent), so the value must reflect reality.
    MCP_WRITE_EXECUTION_AUTHORIZED: ['UpdateClientProduct'],
    MCP_PROD_HIGH_RISK_PER_ACTION_CAP: 20000,
    MCP_PROD_HIGH_RISK_DAILY_CAP: 50000,
    MCP_WRITE_AUDIT_PATH: '',
    MCP_WRITE_IDEMPOTENCY_PATH: '',
  },
  isToolAllowed: () => true,
}));
vi.mock('../../src/security.js', () => ({ AUTH_SHAPE: {} }));

describe('service:price_restore end-to-end via registered handlers', () => {
  it('completes a 3-target restore on dev/staging path', async () => {
    const handlers: Record<
      string,
      (a: Record<string, unknown>) => Promise<{ content: { text: string }[] }>
    > = {};
    const server = {
      registerTool: (n: string, _c: unknown, cb: unknown) => {
        handlers[n] = cb as never;
      },
    };
    const read = vi.fn();
    const mutate = vi.fn().mockResolvedValue({ result: 'success' });
    for (const sid of [555, 569, 586]) {
      read.mockResolvedValueOnce({
        products: { product: [{ id: sid, recurringamount: '45000', domainstatus: 'Active' }] },
      });
    }
    for (const sid of [555, 569, 586]) {
      read.mockResolvedValueOnce({
        products: { product: [{ id: sid, recurringamount: '31350', domainstatus: 'Active' }] },
      });
    }
    const logger = {
      child: () => logger,
      logToolCall: vi.fn(),
      logToolResult: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    };
    registerWriteFlowTools(
      server as never,
      { mutate, read } as never,
      logger as never,
      { tryConsume: () => true } as never
    );
    const tok = { auth_token: RAW_TOKEN };
    const params = {
      targets: [
        { serviceid: 555, new_amount: 31350, expected_old_amount: 45000 },
        { serviceid: 569, new_amount: 31350, expected_old_amount: 45000 },
        { serviceid: 586, new_amount: 31350, expected_old_amount: 45000 },
      ],
    };
    const d = await handlers.draft_write_intent({
      scope: 'service:price_restore',
      params,
      naturalKey: 'e2e-3-target',
      projected_effect: 'restore 3 services',
      ...tok,
    });
    const draftBody = JSON.parse(d.content[0].text) as Record<string, unknown>;
    const id = (draftBody.intent as Record<string, unknown>).intent_id as string;
    const wouldCall = draftBody.would_call as Record<string, unknown>;
    expect(Array.isArray(wouldCall.whmcs_params)).toBe(true);
    expect(wouldCall.whmcs_params).toHaveLength(3);

    await handlers.validate_write_intent({ intent_id: id, ...tok });
    await handlers.approve_write_intent({
      intent_id: id,
      approver: 'op',
      decision: 'approved',
      ...tok,
    });
    const e = await handlers.execute_write_intent({ intent_id: id, ...tok });
    const execBody = JSON.parse(e.content[0].text) as Record<string, unknown>;
    expect(execBody.executed).toBe(true);
    expect(mutate).toHaveBeenCalledTimes(3);
  });
});
