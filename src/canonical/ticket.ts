/**
 * Canonical mapper — WHMCS GetTicket → Canonical<CanonicalTicket>.
 * Unwraps replies.reply / notes.note. Subject + body + replies are
 * `untrusted.free_text`; admin-only notes are `internal.private_note`.
 * COMPLETE; projection happens at the output boundary.
 * See docs/design/governance.md §3.
 */
import type { Canonical } from '../governance/types.js';
import { asRecord, str, num, listOf, ClassMapBuilder } from './_shared.js';

export interface CanonicalTicketReply {
  replyId: number | null;
  name: string | null;
  email: string | null;
  admin: string | null;
  message: string | null;
  date: string | null;
}

export interface CanonicalTicketNote {
  noteId: number | null;
  admin: string | null;
  message: string | null;
  date: string | null;
}

export interface CanonicalTicket {
  ticketId: number | null;
  ticketNumber: string | null;
  departmentId: number | null;
  departmentName: string | null;
  clientId: number | null;
  name: string | null;
  email: string | null;
  cc: string | null;
  subject: string | null;
  status: string | null;
  priority: string | null;
  message: string | null;
  date: string | null;
  lastReply: string | null;
  service: string | null;
  replies: CanonicalTicketReply[];
  notes: CanonicalTicketNote[];
}

export function mapToCanonicalTicket(
  raw: unknown
): Canonical<CanonicalTicket> {
  const src = asRecord(raw);

  const replies: CanonicalTicketReply[] = listOf(src.replies, 'reply').map(
    (r) => ({
      replyId: num(r, 'replyid') ?? num(r, 'id') ?? null,
      name: str(r, 'name') ?? null,
      email: str(r, 'email') ?? null,
      admin: str(r, 'admin') ?? null,
      message: str(r, 'message') ?? null,
      date: str(r, 'date') ?? null,
    })
  );

  const notes: CanonicalTicketNote[] = listOf(src.notes, 'note').map((n) => ({
    noteId: num(n, 'noteid') ?? num(n, 'id') ?? null,
    admin: str(n, 'admin') ?? null,
    message: str(n, 'message') ?? null,
    date: str(n, 'date') ?? null,
  }));

  const data: CanonicalTicket = {
    ticketId: num(src, 'id') ?? num(src, 'ticketid') ?? null,
    ticketNumber: str(src, 'tid') ?? null,
    departmentId: num(src, 'deptid') ?? null,
    departmentName: str(src, 'deptname') ?? null,
    clientId: num(src, 'userid') ?? num(src, 'clientid') ?? null,
    name: str(src, 'name') ?? null,
    email: str(src, 'email') ?? null,
    cc: str(src, 'cc') ?? null,
    subject: str(src, 'subject') ?? null,
    status: str(src, 'status') ?? null,
    priority: str(src, 'priority') ?? null,
    message: str(src, 'message') ?? null,
    date: str(src, 'date') ?? null,
    lastReply: str(src, 'lastreply') ?? null,
    service: str(src, 'service') ?? null,
    replies,
    notes,
  };

  const classes = new ClassMapBuilder()
    .many(['ticketId', 'departmentId', 'clientId'], 'business.identifier')
    .set('ticketNumber', 'business.identifier')
    .set('name', 'pii.name')
    .set('email', 'pii.email')
    .set('cc', 'pii.email')
    // Track B: a department name is a business DISPLAY label, NOT a person
    // name and NOT generic public.safe metadata. The ticket-opener `name`
    // and reply `name` above STAY pii.name (real people).
    .set('departmentName', 'business.label')
    .set('service', 'business.label')
    .many(
      ['status', 'priority', 'date', 'lastReply'],
      'public.safe'
    )
    .set('subject', 'untrusted.free_text')
    .set('message', 'untrusted.free_text')
    .set('replies', 'untrusted.free_text')
    .set('replies[].replyId', 'business.identifier')
    .set('replies[].name', 'pii.name')
    .set('replies[].email', 'pii.email')
    .set('replies[].admin', 'system.audit')
    .set('replies[].message', 'untrusted.free_text')
    .set('replies[].date', 'public.safe')
    .set('notes', 'internal.private_note')
    .set('notes[].noteId', 'business.identifier')
    .set('notes[].admin', 'system.audit')
    .set('notes[].message', 'internal.private_note')
    .set('notes[].date', 'public.safe')
    .build();

  return { entity: 'ticket', data, classes };
}
