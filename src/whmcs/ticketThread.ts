/**
 * Shared, pure ticket-thread formatter for WHMCS MCP Server.
 *
 * Extracted verbatim (behaviour-identical) from the `ticket-thread` MCP
 * resource so both the resource and the `get_ticket_thread` tool produce
 * the exact same payload shape.
 *
 * WHMCS GetTicket returns NO reliable top-level `message`; the opening post
 * is replies.reply[0], and the remaining replies are the actual replies.
 *
 * This function performs no logging or IO — it is pure.
 */

import { normalizeToArray } from './normalizers.js';

interface Reply {
  replyid: number;
  date: string;
  name: string;
  message: string;
  admin?: string;
}

interface Note {
  noteid: number;
  date: string;
  admin: string;
  message: string;
}

export interface TicketThread {
  ticketid: any;
  ticket_number: any;
  department: any;
  subject: any;
  status: any;
  date: any;
  initial_message: string;
  replies: Array<{ id: any; date: any; from: any; is_admin: boolean; message: any }>;
  internal_notes: Array<{ id: any; date: any; admin: any; message: any }>;
}

/**
 * Format a raw WHMCS GetTicket response into the public ticket-thread shape.
 */
export function formatTicketThread(ticket: any): TicketThread {
  const allReplies = normalizeToArray<Reply>(ticket.replies?.reply);
  const notes = normalizeToArray<Note>(ticket.notes?.note);
  // WHMCS GetTicket returns NO top-level `message`; the opening post
  // is replies.reply[0], and the rest are the actual replies.
  const opening = allReplies[0];
  const subsequentReplies = allReplies.slice(1);

  return {
    ticketid: ticket.ticketid,
    ticket_number: ticket.tid,
    department: ticket.deptname,
    subject: ticket.subject,
    status: ticket.status,
    date: ticket.date,
    initial_message: opening?.message ?? ticket.message ?? '',
    replies: subsequentReplies.map((r) => ({
      id: r.replyid,
      date: r.date,
      from: r.admin || r.name,
      is_admin: !!r.admin,
      message: r.message,
    })),
    internal_notes: notes.map((n) => ({
      id: n.noteid,
      date: n.date,
      admin: n.admin,
      message: n.message,
    })),
  };
}
