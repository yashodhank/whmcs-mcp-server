/**
 * Action Policy Guard
 *
 * Defense-in-depth: ensures the read() path of WhmcsClient can ONLY ever
 * invoke known, allowlisted WHMCS read actions. Deny-by-default: any action
 * not explicitly allowlisted (or that matches a write denylist) is rejected.
 */

export class WriteActionError extends Error {
  constructor(action: string) {
    super(`Action '${action}' is not a permitted read-only action`);
    this.name = 'WriteActionError';
  }
}

const READ_ALLOWLIST = new Set<string>([
  'GetClients','GetClientsDetails','GetClientsProducts','GetClientsDomains',
  'GetInvoice','GetInvoices','GetTickets','GetTicket','GetSupportDepartments',
  'GetOrders','GetProducts','GetActivityLog','GetAdminDetails','GetAdminLog',
  'DomainWhois',
  // Phase H — promoted after read-only probes confirmed `supported` on
  // Dev WHMCS 8, Dev WHMCS 9 AND production. GetUsers NOT added (degraded).
  'GetTransactions','GetStats','GetToDoItems','GetAutomationLog',
]);

const WRITE_DENY_PREFIX = /^(Add|Update|Delete|Create|Module|Domain(Register|Renew|Transfer)|Send|Set)/i;

const WRITE_DENY_EXACT = new Set<string>([
  'CapturePayment','ApplyCredit','AddCredit','AddInvoicePayment','OpenTicket',
  'AddTicketReply','UpdateTicket','SendEmail','SendAdminEmail',
  'TriggerNotificationEvent','SetConfigurationValue',
]);

export function assertReadAction(action: string): void {
  if (WRITE_DENY_EXACT.has(action) || WRITE_DENY_PREFIX.test(action)) {
    throw new WriteActionError(action);
  }
  if (!READ_ALLOWLIST.has(action)) {
    throw new WriteActionError(action);
  }
}
