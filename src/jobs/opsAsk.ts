/**
 * Staff job runners against the WHMCS 8.13 Admin External API.
 * Customer jobs never impersonate the Admin API.
 */

import type { WhmcsClient } from '../whmcs/WhmcsClient.js';
import { asRecord, isRecord, listOf, num, str } from '../canonical/_shared.js';
import { getWhmcsVersionProfile } from '../whmcs/versionProfile.js';
import { getCapability } from '../governance/capabilities.js';
import {
  requireSingleClient,
  resolvePrincipal,
  type PrincipalResolution,
} from '../identity/resolvePrincipal.js';
import type { OpsJob } from './catalog.js';

export const TICKET_INBOX_NOTE =
  'Global inbox uses GetTickets without clientid (status Awaiting Reply / All Active Tickets). GetTickets+clientid misses admin-created tickets; use get_ticket_thread for a known tid.';

export const CUSTOMER_DOOR_UNPROVEN =
  'User-delegated clientarea API reads are unproven on this WHMCS 8.13.7 install. Customer jobs return link/handoff only. Do not impersonate the Admin API.';

const CREDIT_NOTE_NOTE =
  'Credit/debit notes are WHMCS 9.x only and unverified on this build. 8.13.7 ledger is invoices + transactions + client credit.';

interface PartialError {
  section: string;
  error: string;
}

async function safe<T>(
  section: string,
  errs: PartialError[],
  fallback: T,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    errs.push({ section, error: e instanceof Error ? e.message : String(e) });
    return fallback;
  }
}

function rows(container: unknown, singular: string): Record<string, unknown>[] {
  return listOf(container, singular).filter(isRecord);
}

function mapInvoice(row: Record<string, unknown>): Record<string, unknown> {
  return {
    invoiceid: num(row, 'id'),
    status: str(row, 'status'),
    total: str(row, 'total'),
    balance: str(row, 'balance'),
    duedate: str(row, 'duedate'),
    date: str(row, 'date'),
    clientid: num(row, 'userid') ?? num(row, 'clientid'),
  };
}

function mapTicket(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ticketid: num(row, 'id'),
    tid: str(row, 'tid'),
    subject: str(row, 'subject'),
    status: str(row, 'status'),
    lastreply: str(row, 'lastreply'),
    clientid: num(row, 'userid') ?? num(row, 'clientid'),
  };
}

function mapTransaction(row: Record<string, unknown>): Record<string, unknown> {
  return {
    transactionid: str(row, 'transid'),
    invoiceid: num(row, 'invoiceid'),
    date: str(row, 'date'),
    amountin: str(row, 'amountin'),
    amountout: str(row, 'amountout'),
    gateway: str(row, 'gateway'),
  };
}

function mapCredit(row: Record<string, unknown>): Record<string, unknown> {
  return {
    creditid: num(row, 'id'),
    date: str(row, 'date'),
    amount: str(row, 'amount'),
  };
}

async function fetchInvoicePage(
  whmcs: WhmcsClient,
  status: string,
  limitnum: number,
  userid?: number
): Promise<Record<string, unknown>[]> {
  const params: Record<string, unknown> = {
    status,
    limitnum,
    orderby: 'duedate',
    order: 'desc',
  };
  if (userid !== undefined) params.userid = userid;
  const raw = asRecord(await whmcs.read('GetInvoices', params));
  return rows(raw.invoices, 'invoice').map(mapInvoice);
}

async function fetchTicketInbox(
  whmcs: WhmcsClient,
  status: string,
  limitnum: number
): Promise<Record<string, unknown>[]> {
  const raw = asRecord(
    await whmcs.read('GetTickets', {
      status,
      limitnum,
      ignore_dept_assignments: true,
    })
  );
  return rows(raw.tickets, 'ticket').map(mapTicket);
}

async function fetchTransactions(
  whmcs: WhmcsClient,
  clientid: number,
  limitnum: number
): Promise<Record<string, unknown>[]> {
  const raw = asRecord(await whmcs.read('GetTransactions', { clientid, limitnum }));
  return rows(raw.transactions, 'transaction').map(mapTransaction);
}

export function customerDoorResult(job: OpsJob): Record<string, unknown> {
  return {
    job,
    audience: 'customer',
    status: 'link_required',
    capability_unavailable: true,
    action: 'user_delegated_api',
    reason: 'user_delegated_api_unproven_on_8_13_7',
    guidance: CUSTOMER_DOOR_UNPROVEN,
    next_step:
      job === 'handoff_pack'
        ? 'Open the WHMCS Client Area in a browser to complete OpenID link (openid profile email). Staff can finish the request via ops_ask staff jobs.'
        : 'Complete WHMCS OIDC link in the browser, or ask staff to run the equivalent staff job.',
  };
}

export async function runStaffJob(args: {
  job: OpsJob;
  whmcs: WhmcsClient;
  clientid?: number;
  email?: string;
  listDrafts?: () => Record<string, unknown>[];
}): Promise<Record<string, unknown>> {
  const errs: PartialError[] = [];
  const { job, whmcs } = args;

  if (job === 'credit_notes') {
    const profile = await getWhmcsVersionProfile(whmcs);
    return {
      job,
      audience: 'staff',
      capability_unavailable: true,
      action: 'credit_notes',
      status: profile.family === '9.x' ? 'unverified' : 'unsupported',
      whmcs_family: profile.family,
      note: CREDIT_NOTE_NOTE,
    };
  }

  if (job === 'morning_digest' || job === 'overdue_digest') {
    const overdue = await safe('overdue', errs, [], () => fetchInvoicePage(whmcs, 'Overdue', 25));
    const unpaid =
      job === 'morning_digest'
        ? await safe('unpaid', errs, [], () => fetchInvoicePage(whmcs, 'Unpaid', 15))
        : [];
    const awaiting =
      job === 'morning_digest'
        ? await safe('tickets', errs, [], () => fetchTicketInbox(whmcs, 'Awaiting Reply', 25))
        : [];
    return {
      job,
      audience: 'staff',
      ledger: 'invoices_transactions_client_credit',
      overdue,
      ...(job === 'morning_digest' ? { unpaid, awaiting_reply: awaiting } : {}),
      ticket_note: TICKET_INBOX_NOTE,
      credit_notes: CREDIT_NOTE_NOTE,
      partial_errors: errs,
    };
  }

  if (job === 'ticket_inbox') {
    const awaiting = await safe('awaiting', errs, [], () =>
      fetchTicketInbox(whmcs, 'Awaiting Reply', 25)
    );
    const active = await safe('active', errs, [], () =>
      fetchTicketInbox(whmcs, 'All Active Tickets', 25)
    );
    return {
      job,
      audience: 'staff',
      awaiting_reply: awaiting,
      all_active: active,
      note: TICKET_INBOX_NOTE,
      partial_errors: errs,
    };
  }

  if (job === 'system_health') {
    const profile = await getWhmcsVersionProfile(whmcs);
    const admin = await safe('admin', errs, {}, () => whmcs.read('GetAdminDetails', {}));
    const usersCap = getCapability('GetUsers');
    return {
      job,
      audience: 'staff',
      whmcs_version: {
        family: profile.family,
        version: profile.version,
        release: profile.release,
      },
      admin: {
        adminid: num(asRecord(admin), 'adminid'),
        name: str(asRecord(admin), 'name'),
      },
      get_users: { status: usersCap.status, capability: usersCap.capability },
      credit_notes: CREDIT_NOTE_NOTE,
      partial_errors: errs,
    };
  }

  if (job === 'draft_work') {
    const drafts = args.listDrafts === undefined ? [] : args.listDrafts();
    return {
      job,
      audience: 'staff',
      drafts,
      note: 'Write intents are process-local unless MCP_WRITE_INTENT_STORE_PATH is set. Params are never listed.',
    };
  }

  const resolution: PrincipalResolution = await resolvePrincipal(whmcs, {
    email: args.email,
    clientid: args.clientid,
  });
  const picked = requireSingleClient(resolution, args.clientid);
  if (!picked.ok) {
    return {
      job,
      audience: 'staff',
      status: 'picker_required',
      error: picked.reason,
      identity: resolution,
    };
  }
  const clientid = picked.clientid;

  if (job === 'billing_card') {
    const details = asRecord(
      await safe('client', errs, {}, () =>
        whmcs.read('GetClientsDetails', { clientid, stats: true })
      )
    );
    const st = asRecord(details.stats);
    const overdue = await safe('overdue', errs, [], () =>
      fetchInvoicePage(whmcs, 'Overdue', 5, clientid)
    );
    const unpaid = await safe('unpaid', errs, [], () =>
      fetchInvoicePage(whmcs, 'Unpaid', 5, clientid)
    );
    const credits = await safe('credits', errs, [], async () =>
      rows(asRecord(await whmcs.read('GetCredits', { clientid })).credits, 'credit').map(mapCredit)
    );
    const transactions = await safe('transactions', errs, [], () =>
      fetchTransactions(whmcs, clientid, 10)
    );
    return {
      job,
      audience: 'staff',
      clientid,
      identity: resolution,
      currency: str(details, 'currency_code'),
      credit_balance: str(st, 'creditbalance') ?? str(details, 'credit'),
      unpaid: {
        count: num(st, 'numunpaidinvoices') ?? unpaid.length,
        amount: str(st, 'unpaidinvoicesamount'),
      },
      overdue: {
        count: num(st, 'numoverdueinvoices') ?? overdue.length,
        amount: str(st, 'overdueinvoicesbalance'),
      },
      recent_unpaid: unpaid,
      recent_overdue: overdue,
      recent_transactions: transactions,
      recent_credits: credits,
      ledger: 'invoices_transactions_client_credit',
      credit_notes: CREDIT_NOTE_NOTE,
      partial_errors: errs,
    };
  }

  if (job === 'next_best_action') {
    const details = asRecord(
      await safe('client', errs, {}, () =>
        whmcs.read('GetClientsDetails', { clientid, stats: true })
      )
    );
    const st = asRecord(details.stats);
    const overdueCount = num(st, 'numoverdueinvoices') ?? 0;
    const unpaidCount = num(st, 'numunpaidinvoices') ?? 0;
    const ticketCount = num(st, 'numactivetickets') ?? 0;
    const products = await safe('services', errs, [], async () =>
      rows(
        asRecord(await whmcs.read('GetClientsProducts', { clientid, limitnum: 25 })).products,
        'product'
      )
    );
    const suspended = products.filter(
      (p) => (str(p, 'status') ?? '').toLowerCase() === 'suspended'
    );
    const actions: { rank: number; action: string; reason: string }[] = [];
    if (overdueCount > 0) {
      actions.push({
        rank: 1,
        action: 'collect_overdue',
        reason: `${overdueCount} overdue invoice(s)`,
      });
    }
    if (unpaidCount > 0 && overdueCount === 0) {
      actions.push({
        rank: 2,
        action: 'follow_up_unpaid',
        reason: `${unpaidCount} unpaid invoice(s)`,
      });
    }
    if (ticketCount > 0) {
      actions.push({
        rank: 3,
        action: 'reply_open_tickets',
        reason: `${ticketCount} active ticket(s) — confirm with ticket_inbox / get_ticket_thread`,
      });
    }
    if (suspended.length > 0) {
      actions.push({
        rank: 4,
        action: 'review_suspended_services',
        reason: `${suspended.length} suspended service(s)`,
      });
    }
    if (actions.length === 0) {
      actions.push({
        rank: 9,
        action: 'none',
        reason: 'no overdue, unpaid, ticket, or suspend signal',
      });
    }
    return {
      job,
      audience: 'staff',
      clientid,
      identity: resolution,
      actions,
      ticket_note: TICKET_INBOX_NOTE,
      partial_errors: errs,
    };
  }

  if (job === 'close_pack') {
    const details = asRecord(
      await safe('client', errs, {}, () =>
        whmcs.read('GetClientsDetails', { clientid, stats: true })
      )
    );
    const st = asRecord(details.stats);
    const invoices = await safe('invoices', errs, [], () =>
      fetchInvoicePage(whmcs, 'Unpaid', 10, clientid)
    );
    return {
      job,
      audience: 'staff',
      clientid,
      identity: resolution,
      client: {
        clientid,
        status: str(details, 'status'),
        credit_balance: str(st, 'creditbalance') ?? str(details, 'credit'),
        unpaid_invoices: num(st, 'numunpaidinvoices') ?? 0,
        overdue_invoices: num(st, 'numoverdueinvoices') ?? 0,
        active_tickets: num(st, 'numactivetickets') ?? 0,
      },
      unpaid_invoices: invoices,
      ticket_note: TICKET_INBOX_NOTE,
      credit_notes: CREDIT_NOTE_NOTE,
      partial_errors: errs,
    };
  }

  if (job === 'gdpr_export_pack') {
    const details = asRecord(
      await safe('client', errs, {}, () =>
        whmcs.read('GetClientsDetails', { clientid, stats: true })
      )
    );
    const invoices = await safe('invoices', errs, [], async () =>
      rows(
        asRecord(await whmcs.read('GetInvoices', { userid: clientid, limitnum: 50 })).invoices,
        'invoice'
      ).map(mapInvoice)
    );
    const tickets = await safe('tickets', errs, [], async () =>
      rows(
        asRecord(await whmcs.read('GetTickets', { clientid, limitnum: 50 })).tickets,
        'ticket'
      ).map(mapTicket)
    );
    const activity = await safe('activity', errs, [], async () =>
      rows(
        asRecord(await whmcs.read('GetActivityLog', { clientid, limitnum: 25 })).activity,
        'entry'
      )
    );
    return {
      job,
      audience: 'staff',
      clientid,
      identity: resolution,
      purpose: 'subject_access_export',
      erasure: 'human_only_DeleteClient_never_executable',
      client: {
        clientid,
        email: str(details, 'email'),
        firstname: str(details, 'firstname'),
        lastname: str(details, 'lastname'),
        company: str(details, 'companyname'),
        status: str(details, 'status'),
      },
      invoices,
      tickets: { items: tickets, note: TICKET_INBOX_NOTE },
      activity_count: activity.length,
      secrets: 'omitted',
      credit_notes: CREDIT_NOTE_NOTE,
      partial_errors: errs,
    };
  }

  switch (job) {
    case 'renewal_digest':
    case 'ticket_status':
    case 'handoff_pack':
      return {
        job,
        audience: 'staff',
        status: 'unsupported_job',
        error: `staff runner has no implementation for '${job}'`,
      };
    default: {
      const _exhaustive: never = job;
      return {
        job: _exhaustive,
        audience: 'staff',
        status: 'unsupported_job',
        error: `staff runner has no implementation for '${String(_exhaustive)}'`,
      };
    }
  }
}
