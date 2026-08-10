import type { CapabilityStatusValue } from '../governance/types.js';

export interface DeclaredWhmcsCapability {
  readonly action: string;
  readonly capability: string;
  readonly domain: string;
  readonly status: Extract<CapabilityStatusValue, 'supported' | 'unverified'>;
  readonly probe: 'read_safe' | 'external_only';
  /** Retains the legacy matrix exactly while domain packs migrate incrementally. */
  readonly exposeInLegacyMatrix: boolean;
  readonly migration: 'legacy_registrar' | 'internal_probe';
}

const supported = (
  action: string,
  capability: string,
  domain: string,
  migration: DeclaredWhmcsCapability['migration'] = 'legacy_registrar'
): DeclaredWhmcsCapability => ({
  action,
  capability,
  domain,
  status: 'supported',
  probe: 'read_safe',
  exposeInLegacyMatrix: true,
  migration,
});

const unverified = (
  action: string,
  capability: string,
  domain: string,
  probe: DeclaredWhmcsCapability['probe'] = 'read_safe'
): DeclaredWhmcsCapability => ({
  action,
  capability,
  domain,
  status: 'unverified',
  probe,
  exposeInLegacyMatrix: true,
  migration: 'legacy_registrar',
});

/**
 * Server-owned declared support for every allowlisted action. Definitions move
 * from `legacy_registrar` to catalog operations one domain at a time.
 */
const DECLARATIONS: readonly DeclaredWhmcsCapability[] = [
  supported('GetClients', 'list_clients', 'clients'),
  supported('GetClientsDetails', 'get_client_details', 'clients'),
  supported('GetClientsProducts', 'list_client_products', 'services'),
  supported('GetClientsDomains', 'list_client_domains', 'domains'),
  supported('GetInvoice', 'get_invoice', 'billing'),
  supported('GetInvoices', 'list_invoices', 'billing'),
  supported('GetTickets', 'list_tickets', 'support'),
  supported('GetTicket', 'get_ticket', 'support'),
  supported('GetSupportDepartments', 'list_support_departments', 'support'),
  supported('GetOrders', 'list_orders', 'orders'),
  supported('GetProducts', 'list_products', 'products'),
  supported('GetActivityLog', 'list_activity_log', 'system'),
  supported('GetAdminDetails', 'get_admin_details', 'system'),
  supported('GetAdminLog', 'list_admin_log', 'system'),
  supported('DomainWhois', 'domain_whois', 'domains'),
  supported('GetTransactions', 'list_client_transactions', 'billing'),
  supported('GetStats', 'get_system_stats', 'system'),
  supported('GetToDoItems', 'list_todo_items', 'system'),
  supported('GetAutomationLog', 'list_automation_log', 'system'),
  unverified('GetUsers', 'list_users', 'system', 'external_only'),
  unverified('GetServers', 'get_server_health', 'infrastructure'),
  unverified('GetTLDPricing', 'get_tld_pricing', 'domains'),
  unverified('GetContacts', 'get_client_contacts', 'contacts'),
  unverified('GetPayMethods', 'get_pay_methods', 'billing'),
  unverified('GetCredits', 'get_credits', 'billing'),
  unverified('GetTicketCounts', 'get_ticket_counts', 'support'),
  unverified('GetSupportStatuses', 'list_support_statuses', 'support'),
  unverified('GetQuotes', 'get_quotes', 'billing'),
  unverified('GetCurrencies', 'get_currencies', 'system'),
  unverified('GetPaymentMethods', 'list_payment_methods', 'billing'),
  unverified('WhmcsDetails', 'get_whmcs_details', 'system'),
  {
    ...supported('GetHealthStatus', 'get_server_health_status', 'infrastructure', 'internal_probe'),
    exposeInLegacyMatrix: false,
  },
  {
    ...supported('GetRegistrars', 'list_registrars', 'domains', 'internal_probe'),
    exposeInLegacyMatrix: false,
  },
  {
    ...supported(
      'GetConfigurationValue',
      'read_configuration_value_for_policy',
      'system',
      'internal_probe'
    ),
    exposeInLegacyMatrix: false,
  },
];

export const DECLARED_WHMCS_CAPABILITIES: readonly DeclaredWhmcsCapability[] = Object.freeze(
  DECLARATIONS.map((declaration) => Object.freeze({ ...declaration }))
);
