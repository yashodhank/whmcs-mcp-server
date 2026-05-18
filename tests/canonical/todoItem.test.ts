/**
 * B1 — canonical WHMCS GetToDoItems mapper. Synthetic fixtures ONLY.
 *
 * GetToDoItems is a GLOBAL/admin read (the staff to-do board, not
 * client-scoped). A to-do item is an admin operational record, so it maps to
 * the EXISTING frozen 'activity' entity (closest fit; the frozen
 * CanonicalEntity union is NOT extended). No real PII — synthetic ids and
 * example.com / .test only.
 */
import { describe, it, expect } from 'vitest';
import {
  mapToCanonicalToDoItem,
  mapToCanonicalToDoItems,
} from '../../src/canonical/todoItem.js';
import { assertClassmapComplete } from './_complete.js';

describe('mapToCanonicalToDoItem (single)', () => {
  it('maps a single to-do row with complete fields + classmap', () => {
    const raw = {
      id: 12,
      adminid: 3,
      date: '2026-05-18',
      title: 'Call ops@vendor.example.com re renewal',
      description: 'Follow up before noon (test note)',
      status: 'Pending',
      duedate: '2026-05-20',
    };
    const c = mapToCanonicalToDoItem(raw);
    expect(c.entity).toBe('activity');
    expect(c.data).toMatchObject({
      todoId: 12,
      adminId: 3,
      date: '2026-05-18',
      title: 'Call ops@vendor.example.com re renewal',
      description: 'Follow up before noon (test note)',
      status: 'Pending',
      dueDate: '2026-05-20',
    });
    expect(c.classes.todoId).toBe('business.identifier');
    expect(c.classes.adminId).toBe('business.identifier');
    expect(c.classes.title).toBe('untrusted.free_text');
    expect(c.classes.description).toBe('untrusted.free_text');
    expect(c.classes.date).toBe('public.safe');
    expect(c.classes.dueDate).toBe('public.safe');
    expect(c.classes.status).toBe('public.safe');
    assertClassmapComplete(c);
  });

  it('tolerates missing fields (nulls, not throws)', () => {
    const c = mapToCanonicalToDoItem({});
    expect(c.data).toMatchObject({ todoId: null, title: null, status: null });
    assertClassmapComplete(c);
  });

  it('is garbage tolerant (null / string → nulls, no throw)', () => {
    const c = mapToCanonicalToDoItem(null);
    expect(c.entity).toBe('activity');
    expect(c.data.todoId).toBeNull();
    expect(mapToCanonicalToDoItem('garbage').data.adminId).toBeNull();
    assertClassmapComplete(c);
  });
});

describe('mapToCanonicalToDoItems (list / wrapper / numeric-keyed)', () => {
  it('unwraps todoitems.todoitem numeric-keyed object', () => {
    const raw = {
      todoitems: {
        todoitem: {
          '0': { id: 1, title: 'A' },
          '1': { id: 2, title: 'B' },
        },
      },
    };
    const list = mapToCanonicalToDoItems(raw);
    expect(list).toHaveLength(2);
    expect(list[0].data.title).toBe('A');
    expect(list[1].entity).toBe('activity');
    list.forEach(assertClassmapComplete);
  });

  it('handles a single (non-array) todoitem object', () => {
    const single = mapToCanonicalToDoItems({
      todoitems: { todoitem: { id: 9, title: 'solo' } },
    });
    expect(single).toHaveLength(1);
    expect(single[0].data.title).toBe('solo');
    single.forEach(assertClassmapComplete);
  });

  it('handles a proper array under todoitem', () => {
    const arr = mapToCanonicalToDoItems({
      todoitems: { todoitem: [{ id: 11 }, { id: 12 }] },
    });
    expect(arr.map((c) => c.data.todoId)).toEqual([11, 12]);
    arr.forEach(assertClassmapComplete);
  });

  it('handles empty {} and [] without throwing', () => {
    expect(mapToCanonicalToDoItems({ todoitems: {} })).toEqual([]);
    expect(mapToCanonicalToDoItems({})).toEqual([]);
    expect(mapToCanonicalToDoItems([])).toEqual([]);
    expect(mapToCanonicalToDoItems(null)).toEqual([]);
  });
});
