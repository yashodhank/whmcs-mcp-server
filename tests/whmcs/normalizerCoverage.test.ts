/**
 * Tripwire: keep READ_ALLOWLIST and NORMALIZER_PATHS in sync.
 *
 * IF THIS FAILS: a table changed — update the snapshot AND consciously check
 * whether the new action returns numeric-keyed array fields (if so add a
 * NORMALIZER_PATHS entry; if not, add a one-line comment why none is needed).
 * Do NOT blindly copy new values.
 */
import { describe, it, expect } from 'vitest';
import { READ_ALLOWLIST } from '../../src/whmcs/actionPolicy.js';
import { NORMALIZER_ACTION_KEYS } from '../../src/whmcs/normalizers.js';

const EXPECTED_ALLOWLIST = new Set<string>([
  'GetClients',
  'GetClientsDetails',
  'GetClientsProducts',
  'GetClientsDomains',
  'GetInvoice',
  'GetInvoices',
  'GetTickets',
  'GetTicket',
  'GetSupportDepartments',
  'GetOrders',
  'GetProducts',
  'GetActivityLog',
  'GetAdminDetails',
  'GetAdminLog',
  'DomainWhois',
  'GetTransactions',
  'GetStats',
  'GetToDoItems',
  'GetAutomationLog',
  'GetServers',
  'GetHealthStatus',
  'GetTLDPricing',
  'GetRegistrars',
  'GetContacts',
  'GetPayMethods',
  'GetCredits',
  'GetTicketCounts',
  'GetSupportStatuses',
  'GetQuotes',
  'GetCurrencies',
  'GetPaymentMethods',
  'WhmcsDetails',
]);

const EXPECTED_NORMALIZER_KEYS = new Set<string>([
  'GetClients',
  'GetClientsDetails',
  'GetInvoice',
  'GetInvoices',
  'GetProducts',
  'GetTickets',
  'GetTicket',
  'GetOrders',
  'GetClientsProducts',
  'GetClientsDomains',
]);

describe('normalizerCoverage tripwire', () => {
  it('READ_ALLOWLIST matches snapshot (32 actions)', () => {
    expect(READ_ALLOWLIST).toEqual(EXPECTED_ALLOWLIST);
  });

  it('NORMALIZER_ACTION_KEYS matches snapshot (10 keys)', () => {
    expect(NORMALIZER_ACTION_KEYS).toEqual(EXPECTED_NORMALIZER_KEYS);
  });

  it('every normalizer key is in the read allowlist (no orphan normalizers)', () => {
    for (const key of NORMALIZER_ACTION_KEYS) {
      expect(READ_ALLOWLIST.has(key)).toBe(true);
    }
  });
});
