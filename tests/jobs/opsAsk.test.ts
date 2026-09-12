import { describe, it, expect, vi, beforeEach } from 'vitest';
import { customerDoorResult, runStaffJob, TICKET_INBOX_NOTE } from '../../src/jobs/opsAsk.js';
import { jobAllowedForAudience } from '../../src/jobs/catalog.js';
import { _resetVersionProfileCacheForTests } from '../../src/whmcs/versionProfile.js';

beforeEach(() => {
  _resetVersionProfileCacheForTests();
});

describe('customer door', () => {
  it('never impersonates the Admin API', () => {
    const r = customerDoorResult('billing_card');
    expect(r.status).toBe('link_required');
    expect(r.capability_unavailable).toBe(true);
    expect(String(r.reason)).toMatch(/unproven/);
    expect((r.oidc_link as { pkce: string; response_type: string }).pkce).toBe('required');
    expect((r.oidc_link as { response_type: string }).response_type).toBe('code');
    expect((r.clientarea_scopes as { status: string }).status).toBe(
      'sso_destinations_unproven_as_api'
    );
    expect(r.whatsapp_bind).toBe('outside_this_repo');
  });

  it('customer cannot run staff jobs', () => {
    expect(jobAllowedForAudience('morning_digest', 'customer')).toBe(false);
    expect(jobAllowedForAudience('ticket_inbox', 'staff')).toBe(true);
    expect(jobAllowedForAudience('handoff_pack', 'customer')).toBe(true);
  });
});

describe('runStaffJob', () => {
  it('ticket_inbox calls GetTickets without clientid', async () => {
    const read = vi.fn().mockResolvedValue({
      result: 'success',
      tickets: { ticket: [{ id: 9, tid: 'ABC', subject: 'hi', status: 'Open' }] },
    });
    const r = await runStaffJob({ job: 'ticket_inbox', whmcs: { read } as never });
    expect(read).toHaveBeenCalledWith(
      'GetTickets',
      expect.objectContaining({ status: 'Awaiting Reply', ignore_dept_assignments: true })
    );
    const awaitingCall = read.mock.calls.find(
      (c) => c[0] === 'GetTickets' && c[1].status === 'Awaiting Reply'
    );
    expect(awaitingCall?.[1]).not.toHaveProperty('clientid');
    expect(r.note).toBe(TICKET_INBOX_NOTE);
    expect(Array.isArray(r.awaiting_reply)).toBe(true);
    expect(r.awaiting_reply).toEqual([
      expect.objectContaining({ ticketid: 9, tid: 'ABC', subject: 'hi' }),
    ]);
  });

  it('billing_card uses invoices + transactions + client credit and never GetUsers', async () => {
    const read = vi.fn().mockImplementation(async (action: string) => {
      if (action === 'GetClientsDetails') {
        return {
          result: 'success',
          id: 42,
          email: 'ada@example.com',
          currency_code: 'USD',
          credit: '15.00',
          stats: { creditbalance: '15.00', numunpaidinvoices: 1, numoverdueinvoices: 0 },
        };
      }
      if (action === 'GetInvoices') {
        return { invoices: { invoice: [{ id: 7, status: 'Unpaid', total: '20.00' }] } };
      }
      if (action === 'GetCredits') {
        return { credits: { credit: [{ id: 3, date: '2026-09-01', amount: '15.00' }] } };
      }
      if (action === 'GetTransactions') {
        return {
          transactions: { transaction: [{ transid: 'TX-1', invoiceid: 7, amountin: '20.00' }] },
        };
      }
      throw new Error(`unexpected ${action}`);
    });
    const r = await runStaffJob({
      job: 'billing_card',
      whmcs: { read } as never,
      clientid: 42,
    });
    expect(read.mock.calls.some((c) => c[0] === 'GetUsers')).toBe(false);
    expect(read).toHaveBeenCalledWith('GetTransactions', expect.objectContaining({ clientid: 42 }));
    expect(r.ledger).toBe('invoices_transactions_client_credit');
    expect(r.recent_unpaid).toEqual([expect.objectContaining({ invoiceid: 7, status: 'Unpaid' })]);
    expect(r.recent_transactions).toEqual([
      expect.objectContaining({ transactionid: 'TX-1', invoiceid: 7 }),
    ]);
    expect(r.recent_credits).toEqual([expect.objectContaining({ creditid: 3, amount: '15.00' })]);
    expect(r.credit_balance).toBe('15.00');
    expect((r.tax as { gst_tds_amounts: string }).gst_tds_amounts).toBe('not_computed');
  });

  it('gdpr_export_pack includes GST/TDS identity fields without computing amounts', async () => {
    const read = vi.fn().mockImplementation(async (action: string) => {
      if (action === 'GetClientsDetails') {
        return {
          result: 'success',
          id: 42,
          email: 'ada@example.com',
          firstname: 'Ada',
          lastname: 'Lovelace',
          tax_id: '27AAAAA0000A1Z5',
          country: 'IN',
          stats: {},
        };
      }
      if (action === 'GetInvoices') return { invoices: { invoice: [] } };
      if (action === 'GetTickets') return { tickets: { ticket: [] } };
      if (action === 'GetActivityLog') return { activity: { entry: [] } };
      throw new Error(`unexpected ${action}`);
    });
    const r = await runStaffJob({
      job: 'gdpr_export_pack',
      whmcs: { read } as never,
      clientid: 42,
    });
    expect((r.tax as { tax_id: string; gst_tds_amounts: string }).tax_id).toBe('27AAAAA0000A1Z5');
    expect((r.tax as { gst_tds_amounts: string }).gst_tds_amounts).toBe('not_computed');
  });

  it('credit_notes is unavailable on 8.13', async () => {
    const read = vi.fn().mockImplementation(async (action: string) => {
      if (action === 'GetConfigurationValue')
        return { result: 'success', value: '8.13.7-release.1' };
      if (action === 'WhmcsDetails') throw new Error('denied');
      return {};
    });
    const r = await runStaffJob({ job: 'credit_notes', whmcs: { read } as never });
    expect(r.capability_unavailable).toBe(true);
    expect(r.status).toBe('unsupported');
    expect(r.whmcs_family).toBe('8.13');
  });

  it('credit_notes stays unverified on 9.x', async () => {
    const read = vi.fn().mockImplementation(async (action: string) => {
      if (action === 'GetConfigurationValue')
        return { result: 'success', value: '9.0.8-release.1' };
      if (action === 'WhmcsDetails') throw new Error('denied');
      return {};
    });
    const r = await runStaffJob({ job: 'credit_notes', whmcs: { read } as never });
    expect(r.status).toBe('unverified');
    expect(r.whmcs_family).toBe('9.x');
    expect(r.capability_unavailable).toBe(true);
  });
});
