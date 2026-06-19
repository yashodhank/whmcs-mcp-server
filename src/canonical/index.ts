/**
 * B1 — canonical mappers barrel.
 *
 * Each mapToCanonical*() returns Canonical<T> = { entity, data, classes }:
 *   - data: a COMPLETE typed canonical object (no fields dropped — completeness
 *     is the governance contract; projection/redaction happens later at the
 *     output boundary, see docs/design/governance.md §2/§4).
 *   - classes: a FieldClassMap covering EVERY path in `data` (dot paths; array
 *     elements use `[]`). An unmapped path is RESTRICTED downstream.
 *
 * Imports the frozen seam from ../governance/types.js only.
 */
export {
  mapToCanonicalClient,
  type CanonicalClient,
  type CanonicalClientStats,
  type CanonicalCustomField,
} from './client.js';
export {
  mapToCanonicalInvoice,
  type CanonicalInvoice,
  type CanonicalInvoiceItem,
  type CanonicalInvoiceTransaction,
} from './invoice.js';
export {
  mapToCanonicalTransaction,
  mapToCanonicalTransactions,
  type CanonicalTransaction,
} from './transaction.js';
export {
  mapToCanonicalService,
  mapToCanonicalServices,
  type CanonicalService,
} from './service.js';
export {
  mapToCanonicalDomain,
  mapToCanonicalDomains,
  type CanonicalDomain,
} from './domain.js';
export {
  mapToCanonicalTicket,
  type CanonicalTicket,
  type CanonicalTicketReply,
  type CanonicalTicketNote,
} from './ticket.js';
export {
  mapToCanonicalOrder,
  mapToCanonicalOrders,
  type CanonicalOrder,
  type CanonicalOrderLineItem,
} from './order.js';
export {
  mapToCanonicalActivity,
  mapToCanonicalActivities,
  type CanonicalActivity,
} from './activity.js';
export {
  mapToCanonicalCreditNote,
  mapToCanonicalCreditNotes,
  type CanonicalCreditNote,
  type CreditNoteType,
} from './creditNote.js';
export {
  mapToCanonicalToDoItem,
  mapToCanonicalToDoItems,
  type CanonicalToDoItem,
} from './todoItem.js';
export {
  mapToCanonicalAutomationLogEntry,
  mapToCanonicalAutomationLogEntries,
  type CanonicalAutomationLogEntry,
} from './automationLog.js';
export {
  mapToCanonicalSystemStats,
  type CanonicalSystemStats,
} from './systemStats.js';
export {
  mapToCanonicalServer,
  mapToCanonicalServers,
  type CanonicalServer,
} from './server.js';
export {
  mapToCanonicalTldPricing,
  type CanonicalTldPricing,
  type CanonicalTldEntry,
  type CanonicalTldPrice,
  type CanonicalTldAddons,
} from './tldPricing.js';
