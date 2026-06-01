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

import { asRecord, num, str } from '../canonical/_shared.js';
import { normalizeToArray } from './normalizers.js';

/** WHMCS may return numeric or string ids (e.g. replyid "0", noteid "n1"). */
function whmcsId(source: Record<string, unknown>, key: string): string | number {
  const asString = str(source, key);
  if (asString !== undefined) {
    return asString;
  }
  return num(source, key) ?? 0;
}

interface Reply {
  replyid: string | number;
  date: string;
  name: string;
  message: string;
  admin?: string;
}

interface Note {
  noteid: string | number;
  date: string;
  admin: string;
  message: string;
}

export interface TicketThread {
  ticketid: number | undefined;
  ticket_number: string | undefined;
  department: string | undefined;
  subject: string | undefined;
  status: string | undefined;
  date: string | undefined;
  initial_message: string;
  replies: {
    id: string | number;
    date: string;
    from: string;
    is_admin: boolean;
    message: string;
  }[];
  internal_notes: {
    id: string | number;
    date: string;
    admin: string;
    message: string;
  }[];
}

function parseReply(raw: unknown): Reply {
  const r = asRecord(raw);
  const admin = str(r, 'admin');
  return {
    replyid: whmcsId(r, 'replyid'),
    date: str(r, 'date') ?? '',
    name: str(r, 'name') ?? '',
    message: str(r, 'message') ?? '',
    ...(admin !== undefined ? { admin } : {}),
  };
}

function parseNote(raw: unknown): Note {
  const n = asRecord(raw);
  return {
    noteid: whmcsId(n, 'noteid'),
    date: str(n, 'date') ?? '',
    admin: str(n, 'admin') ?? '',
    message: str(n, 'message') ?? '',
  };
}

/**
 * Format a raw WHMCS GetTicket response into the public ticket-thread shape.
 */
export function formatTicketThread(ticket: unknown): TicketThread {
  const t = asRecord(ticket);
  const repliesWrap = asRecord(t.replies);
  const notesWrap = asRecord(t.notes);
  const allReplies = normalizeToArray<unknown>(repliesWrap.reply).map(parseReply);
  const notes = normalizeToArray<unknown>(notesWrap.note).map(parseNote);
  const subsequentReplies = allReplies.length > 1 ? allReplies.slice(1) : [];
  const initialMessage =
    allReplies.length > 0
      ? allReplies[0].message || str(t, 'message') || ''
      : str(t, 'message') || '';

  return {
    ticketid: num(t, 'ticketid'),
    ticket_number: str(t, 'tid'),
    department: str(t, 'deptname'),
    subject: str(t, 'subject'),
    status: str(t, 'status'),
    date: str(t, 'date'),
    initial_message: initialMessage,
    replies: subsequentReplies.map((r) => ({
      id: r.replyid,
      date: r.date,
      from: r.admin ?? r.name,
      is_admin: r.admin !== undefined && r.admin !== '',
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
