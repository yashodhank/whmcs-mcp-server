/** B1 — canonical ticket mapper. Synthetic fixtures only. */
import { describe, it, expect } from 'vitest';
import { mapToCanonicalTicket } from '../../src/canonical/ticket.js';
import { assertClassmapComplete } from './_complete.js';

describe('mapToCanonicalTicket', () => {
  it('maps GetTicket with replies.reply + notes.note wrappers', () => {
    const raw = {
      result: 'success',
      id: 400,
      tid: 'ABC-123',
      deptid: 1,
      deptname: 'Support',
      userid: 42,
      name: 'John Doe',
      email: 'john@example.com',
      subject: 'Login issue',
      status: 'Open',
      priority: 'High',
      message: 'I cannot log in.',
      date: '2026-03-01',
      replies: {
        reply: {
          '0': {
            replyid: 1,
            name: 'John Doe',
            email: 'john@example.com',
            message: 'still broken',
            date: '2026-03-02',
            admin: '',
          },
          '1': {
            replyid: 2,
            name: 'Agent',
            message: 'investigating',
            date: '2026-03-02',
            admin: 'agent1',
          },
        },
      },
      notes: {
        note: [{ noteid: 9, message: 'internal: escalate', admin: 'agent1', date: '2026-03-02' }],
      },
    };
    const c = mapToCanonicalTicket(raw);
    expect(c.entity).toBe('ticket');
    expect(c.data.ticketId).toBe(400);
    expect(c.data.ticketNumber).toBe('ABC-123');
    expect(c.data.replies).toHaveLength(2);
    expect(c.data.replies[1].message).toBe('investigating');
    expect(c.data.notes[0].message).toBe('internal: escalate');
    expect(c.classes.ticketId).toBe('business.identifier');
    expect(c.classes.subject).toBe('untrusted.free_text');
    expect(c.classes.message).toBe('untrusted.free_text');
    expect(c.classes.email).toBe('pii.email');
    expect(c.classes['replies[].message']).toBe('untrusted.free_text');
    expect(c.classes['notes[].message']).toBe('internal.private_note');
    assertClassmapComplete(c);
  });

  it('handles empty replies {} and missing notes', () => {
    const raw = { id: 1, subject: 's', status: 'Closed', replies: {}, notes: [] };
    const c = mapToCanonicalTicket(raw);
    expect(c.data.replies).toEqual([]);
    expect(c.data.notes).toEqual([]);
    assertClassmapComplete(c);
  });

  it('single reply object + garbage', () => {
    const c = mapToCanonicalTicket({
      id: 2,
      replies: { reply: { replyid: 7, message: 'solo' } },
      notes: {},
    });
    expect(c.data.replies).toHaveLength(1);
    expect(c.data.replies[0].message).toBe('solo');
    const g = mapToCanonicalTicket(null);
    expect(g.data.ticketId).toBeNull();
    assertClassmapComplete(g);
  });
});
