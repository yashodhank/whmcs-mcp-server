import { describe, it, expect } from 'vitest';
import { formatTicketThread } from '../../src/whmcs/ticketThread.js';

describe('formatTicketThread', () => {
  it('opening post → initial_message; rest → replies; notes mapped', () => {
    const out = formatTicketThread({
      ticketid: 1001, tid: 'TST01', deptname: 'Help Desk', subject: 's', status: 'Answered', date: 'd',
      replies: { reply: [
        { replyid: '0', name: 'C', date: 'd1', message: 'open', admin: '' },
        { replyid: '1', name: 'S', date: 'd2', message: 'reply2', admin: 'Agent' },
      ] },
      notes: { note: [{ noteid: 'n1', date: 'dn', admin: 'A', message: 'note1' }] },
    } as any);
    expect(out).toMatchObject({
      ticketid: 1001, ticket_number: 'TST01', department: 'Help Desk', subject: 's', status: 'Answered', date: 'd',
      initial_message: 'open',
    });
    expect(out.replies).toHaveLength(1);
    expect(out.replies[0]).toMatchObject({ message: 'reply2', is_admin: true });
    expect(out.internal_notes).toEqual([{ id: 'n1', date: 'dn', admin: 'A', message: 'note1' }]);
  });
  it('single opening reply → initial_message set, replies empty, no top-level message needed', () => {
    const out = formatTicketThread({ ticketid: 2, tid: 'T2', deptname: 'D', subject: 's2', status: 'Open', date: 'd', replies: { reply: [{ replyid: '0', name: 'C', date: 'd', message: 'only' }] }, notes: [] } as any);
    expect(out.initial_message).toBe('only');
    expect(out.replies).toEqual([]);
    expect(out.internal_notes).toEqual([]);
  });
  it('numeric-keyed replies object is normalized', () => {
    const out = formatTicketThread({ ticketid: 3, tid: 'T3', deptname: 'D', subject: 's', status: 'Open', date: 'd', replies: { reply: { '0': { replyid:'0', message:'a' }, '1': { replyid:'1', message:'b', admin:'X' } } }, notes: [] } as any);
    expect(out.initial_message).toBe('a');
    expect(out.replies[0]).toMatchObject({ message: 'b', is_admin: true });
  });
});
