/** B1 — canonical ticket-metadata mappers. Synthetic fixtures only. */
import { describe, it, expect } from 'vitest';
import {
  mapToCanonicalTicketCounts,
  mapToCanonicalSupportStatuses,
} from '../../src/canonical/ticketMeta.js';
import { assertClassmapComplete } from './_complete.js';

describe('mapToCanonicalTicketCounts', () => {
  it('maps GetTicketCounts list shape (status[] + department[]) with numeric strings', () => {
    const raw = {
      result: 'success',
      statuses: {
        status: [
          { title: 'Open', count: '4' },
          { title: 'Answered', count: 2 },
        ],
      },
      departments: {
        department: { '0': { name: 'Support', count: '7' }, '1': { name: 'Billing', count: '1' } },
      },
      awaitingreply: '5',
      total: '13',
    };
    const c = mapToCanonicalTicketCounts(raw);
    expect(c.entity).toBe('ticket');
    expect(c.data.statuses).toHaveLength(2);
    expect(c.data.statuses[0]).toEqual({ label: 'Open', count: 4 });
    expect(c.data.statuses[1].count).toBe(2);
    expect(c.data.departments).toHaveLength(2);
    expect(c.data.departments[0]).toEqual({ label: 'Support', count: 7 });
    expect(c.data.awaitingReply).toBe(5);
    expect(c.data.total).toBe(13);
    expect(c.classes['statuses[].count']).toBe('public.safe');
    expect(c.classes['statuses[].label']).toBe('business.label');
    expect(c.classes['departments[].label']).toBe('business.label');
    expect(c.classes.awaitingReply).toBe('public.safe');
    assertClassmapComplete(c);
  });

  it('maps a flat scalar status map { Open: 4, Answered: "2" }', () => {
    const c = mapToCanonicalTicketCounts({ statuses: { Open: 4, Answered: '2' } });
    expect(c.data.statuses).toEqual([
      { label: 'Open', count: 4 },
      { label: 'Answered', count: 2 },
    ]);
    expect(c.data.departments).toEqual([]);
    assertClassmapComplete(c);
  });

  it('handles empty / missing collections and garbage input', () => {
    const c = mapToCanonicalTicketCounts({ statuses: {}, departments: [] });
    expect(c.data.statuses).toEqual([]);
    expect(c.data.departments).toEqual([]);
    expect(c.data.awaitingReply).toBeNull();
    expect(c.data.total).toBeNull();
    assertClassmapComplete(c);

    const g = mapToCanonicalTicketCounts(null);
    expect(g.data.statuses).toEqual([]);
    expect(g.data.total).toBeNull();
    assertClassmapComplete(g);
  });

  it('accepts the camelCase awaitingReply / flagged spellings', () => {
    expect(mapToCanonicalTicketCounts({ awaitingReply: '3' }).data.awaitingReply).toBe(3);
    expect(mapToCanonicalTicketCounts({ flagged: 9 }).data.awaitingReply).toBe(9);
  });
});

describe('mapToCanonicalSupportStatuses', () => {
  it('maps GetSupportStatuses (statuses.status[]) with titles + counts', () => {
    const raw = {
      result: 'success',
      statuses: {
        status: [
          { title: 'Open', count: '4' },
          { title: 'Closed', count: 0 },
        ],
      },
    };
    const c = mapToCanonicalSupportStatuses(raw);
    expect(c.entity).toBe('ticket');
    expect(c.data.statuses).toHaveLength(2);
    expect(c.data.statuses[0]).toEqual({ title: 'Open', count: 4 });
    expect(c.data.statuses[1]).toEqual({ title: 'Closed', count: 0 });
    expect(c.classes['statuses[].title']).toBe('business.label');
    expect(c.classes['statuses[].count']).toBe('public.safe');
    assertClassmapComplete(c);
  });

  it('tolerates a single status object (no array) and a flat `status` key', () => {
    const single = mapToCanonicalSupportStatuses({ statuses: { status: { title: 'Open', count: 1 } } });
    expect(single.data.statuses).toHaveLength(1);
    expect(single.data.statuses[0].title).toBe('Open');

    const flat = mapToCanonicalSupportStatuses({ status: [{ name: 'Answered', tickets: '2' }] });
    expect(flat.data.statuses[0]).toEqual({ title: 'Answered', count: 2 });
  });

  it('handles empty statuses and garbage', () => {
    const c = mapToCanonicalSupportStatuses({ statuses: {} });
    expect(c.data.statuses).toEqual([]);
    assertClassmapComplete(c);

    const g = mapToCanonicalSupportStatuses(undefined);
    expect(g.data.statuses).toEqual([]);
    assertClassmapComplete(g);
  });
});
