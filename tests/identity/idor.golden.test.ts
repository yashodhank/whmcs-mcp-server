/**
 * IDOR golden set (ADR-0002.6 / Phase 3 exit).
 *
 * Wrong-client invoice for a customer is a release blocker: customer jobs
 * must not call the Admin API. Staff may pick a clientid only when it is in
 * the resolved principal (or when staff supplies clientid alone).
 */

import { describe, it, expect, vi } from 'vitest';
import { customerDoorResult, runStaffJob } from '../../src/jobs/opsAsk.js';
import { jobAllowedForAudience } from '../../src/jobs/catalog.js';
import { requireSingleClient, resolvePrincipal } from '../../src/identity/resolvePrincipal.js';

describe('IDOR golden — customer door', () => {
  it('customer + any clientid is link_required and never reads WHMCS', () => {
    const read = vi.fn();
    const r = customerDoorResult('billing_card', { origin: 'https://my.securiace.com' });
    expect(r.status).toBe('link_required');
    expect(r.capability_unavailable).toBe(true);
    expect(r.whatsapp_bind).toBe('outside_this_repo');
    expect((r.oidc_link as { pkce: string }).pkce).toBe('required');
    expect((r.oidc_link as { user_agent: string }).user_agent).toBe('browser_not_whatsapp');
    expect(read).not.toHaveBeenCalled();
    void read;
  });

  it('customer cannot run morning_digest', () => {
    expect(jobAllowedForAudience('morning_digest', 'customer')).toBe(false);
  });
});

describe('IDOR golden — staff principal', () => {
  it('email principal + foreign clientid is picker_required (no invoice read)', async () => {
    const read = vi.fn().mockImplementation(async (action: string) => {
      if (action === 'GetClientsDetails') {
        return {
          result: 'success',
          id: 10,
          email: 'ada@example.com',
          users: { user: [{ email: 'ada@example.com', clients: { client: [{ id: 10 }] } }] },
        };
      }
      throw new Error(`unexpected ${action}`);
    });
    const r = await runStaffJob({
      job: 'billing_card',
      whmcs: { read } as never,
      email: 'ada@example.com',
      clientid: 99,
    });
    expect(r.status).toBe('picker_required');
    expect(read.mock.calls.some((c) => c[0] === 'GetInvoices')).toBe(false);
    expect(read.mock.calls.some((c) => c[0] === 'GetUsers')).toBe(false);
  });

  it('staff may pick a clientid when no email is supplied', async () => {
    const read = vi.fn().mockImplementation(async (action: string) => {
      if (action === 'GetClientsDetails') {
        return {
          result: 'success',
          id: 42,
          email: 'ada@example.com',
          tax_id: 'GSTIN',
          country: 'IN',
          stats: { creditbalance: '0.00', numunpaidinvoices: 0, numoverdueinvoices: 0 },
        };
      }
      if (action === 'GetInvoices') return { invoices: { invoice: [] } };
      if (action === 'GetCredits') return { credits: { credit: [] } };
      if (action === 'GetTransactions') return { transactions: { transaction: [] } };
      throw new Error(`unexpected ${action}`);
    });
    const r = await runStaffJob({
      job: 'billing_card',
      whmcs: { read } as never,
      clientid: 42,
    });
    expect(r.clientid).toBe(42);
    expect(r.status).not.toBe('picker_required');
    expect((r.tax as { gst_tds_amounts: string }).gst_tds_amounts).toBe('not_computed');
  });

  it('requireSingleClient denies a clientid that is not on the principal', async () => {
    const whmcs = {
      read: vi.fn().mockResolvedValue({
        result: 'success',
        id: 10,
        email: 'ada@example.com',
      }),
    };
    const resolution = await resolvePrincipal(whmcs as never, { email: 'ada@example.com' });
    expect(requireSingleClient(resolution, 99).ok).toBe(false);
    expect(requireSingleClient(resolution, 10).ok).toBe(true);
  });
});
