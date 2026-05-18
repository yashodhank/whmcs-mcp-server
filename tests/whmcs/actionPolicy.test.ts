import { describe, it, expect } from 'vitest';
import { assertReadAction, WriteActionError } from '../../src/whmcs/actionPolicy.js';

describe('actionPolicy', () => {
  it('allows known read actions', () => {
    for (const a of ['GetClientsDetails','GetClientsProducts','GetClientsDomains','GetInvoices','GetTickets','GetTicket','GetOrders'])
      expect(() => assertReadAction(a)).not.toThrow();
  });
  it('blocks write actions by denylist prefix/name', () => {
    for (const a of ['AddClient','UpdateClient','DeleteClient','CreateInvoice','CapturePayment','ApplyCredit','AddCredit','AddInvoicePayment','OpenTicket','AddTicketReply','UpdateTicket','ModuleCreate','DomainRegister','DomainRenew','DomainTransfer','SendEmail','SendAdminEmail','TriggerNotificationEvent','SetConfigurationValue'])
      expect(() => assertReadAction(a)).toThrow(WriteActionError);
  });
  it('blocks unknown/non-allowlisted actions (deny by default)', () => {
    expect(() => assertReadAction('SomeUnknownAction')).toThrow(WriteActionError);
  });
});
