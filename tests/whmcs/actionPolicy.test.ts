import { describe, it, expect } from 'vitest';
import { assertReadAction, WriteActionError } from '../../src/whmcs/actionPolicy.js';

describe('actionPolicy', () => {
  it('allows known read actions', () => {
    for (const a of ['GetClientsDetails','GetClientsProducts','GetClientsDomains','GetInvoices','GetTickets','GetTicket','GetOrders'])
      expect(() => { assertReadAction(a); }).not.toThrow();
  });
  it('blocks write actions by denylist prefix/name', () => {
    for (const a of ['AddClient','UpdateClient','DeleteClient','CreateInvoice','CapturePayment','ApplyCredit','AddCredit','AddInvoicePayment','OpenTicket','AddTicketReply','UpdateTicket','ModuleCreate','DomainRegister','DomainRenew','DomainTransfer','SendEmail','SendAdminEmail','TriggerNotificationEvent','SetConfigurationValue'])
      expect(() => { assertReadAction(a); }).toThrow(WriteActionError);
  });
  it('blocks unknown/non-allowlisted actions (deny by default)', () => {
    expect(() => { assertReadAction('SomeUnknownAction'); }).toThrow(WriteActionError);
  });

  it('allows the 4 Phase-H promoted read actions', () => {
    for (const a of ['GetTransactions', 'GetStats', 'GetToDoItems', 'GetAutomationLog'])
      expect(() => { assertReadAction(a); }).not.toThrow();
  });

  // Track 5 — GetUsers defense-in-depth: NOT allowlisted (probes returned
  // degraded on Dev W8/W9 + prod). The read-path guard must reject it so it
  // can never reach WHMCS even if some caller tries. See
  // docs/archive/getusers-investigation.md.
  it('blocks GetUsers — NOT in the read allowlist (deny by default)', () => {
    expect(() => { assertReadAction('GetUsers'); }).toThrow(WriteActionError);
  });
});
