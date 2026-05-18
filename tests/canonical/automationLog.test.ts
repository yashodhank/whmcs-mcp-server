/**
 * B1 — canonical WHMCS GetAutomationLog mapper. Synthetic fixtures ONLY.
 *
 * GetAutomationLog is a GLOBAL/admin read (the cron automation history, not
 * client-scoped). A log entry is an admin operational/audit record, so it maps
 * to the EXISTING frozen 'activity' entity (the frozen CanonicalEntity union
 * is NOT extended). The `output` line is cron operational output → audit. No
 * real PII — synthetic ids only.
 */
import { describe, it, expect } from 'vitest';
import {
  mapToCanonicalAutomationLogEntry,
  mapToCanonicalAutomationLogEntries,
} from '../../src/canonical/automationLog.js';
import { assertClassmapComplete } from './_complete.js';

describe('mapToCanonicalAutomationLogEntry (single)', () => {
  it('maps a single automation-log entry with complete fields + classmap', () => {
    const raw = {
      id: 88,
      name: 'Process Cron',
      starttime: '2026-05-18 00:00:01',
      endtime: '2026-05-18 00:00:09',
      status: 'Success',
      output: 'Suspended 2 overdue services',
    };
    const c = mapToCanonicalAutomationLogEntry(raw);
    expect(c.entity).toBe('activity');
    expect(c.data).toMatchObject({
      entryId: 88,
      name: 'Process Cron',
      startTime: '2026-05-18 00:00:01',
      endTime: '2026-05-18 00:00:09',
      status: 'Success',
      output: 'Suspended 2 overdue services',
    });
    expect(c.classes.entryId).toBe('business.identifier');
    expect(c.classes.name).toBe('public.safe');
    expect(c.classes.status).toBe('public.safe');
    expect(c.classes.startTime).toBe('public.safe');
    expect(c.classes.endTime).toBe('public.safe');
    expect(c.classes.output).toBe('system.audit');
    assertClassmapComplete(c);
  });

  it('tolerates missing fields (nulls, not throws)', () => {
    const c = mapToCanonicalAutomationLogEntry({});
    expect(c.data).toMatchObject({ entryId: null, output: null });
    assertClassmapComplete(c);
  });

  it('is garbage tolerant (null / string → nulls, no throw)', () => {
    const c = mapToCanonicalAutomationLogEntry(null);
    expect(c.entity).toBe('activity');
    expect(c.data.entryId).toBeNull();
    expect(mapToCanonicalAutomationLogEntry('x').data.name).toBeNull();
    assertClassmapComplete(c);
  });
});

describe('mapToCanonicalAutomationLogEntries (list / wrapper / numeric-keyed)', () => {
  it('unwraps automationlog.entry numeric-keyed object', () => {
    const raw = {
      stats: { totalentries: 2 },
      automationlog: {
        entry: {
          '0': { id: 1, name: 'A' },
          '1': { id: 2, name: 'B' },
        },
      },
    };
    const list = mapToCanonicalAutomationLogEntries(raw);
    expect(list).toHaveLength(2);
    expect(list[0].data.name).toBe('A');
    expect(list[1].entity).toBe('activity');
    list.forEach(assertClassmapComplete);
  });

  it('handles a single (non-array) entry object', () => {
    const single = mapToCanonicalAutomationLogEntries({
      automationlog: { entry: { id: 9, name: 'solo' } },
    });
    expect(single).toHaveLength(1);
    expect(single[0].data.name).toBe('solo');
    single.forEach(assertClassmapComplete);
  });

  it('handles a proper array under entry', () => {
    const arr = mapToCanonicalAutomationLogEntries({
      automationlog: { entry: [{ id: 11 }, { id: 12 }] },
    });
    expect(arr.map((c) => c.data.entryId)).toEqual([11, 12]);
    arr.forEach(assertClassmapComplete);
  });

  it('handles empty {} and [] without throwing', () => {
    expect(mapToCanonicalAutomationLogEntries({ automationlog: {} })).toEqual(
      []
    );
    expect(mapToCanonicalAutomationLogEntries({})).toEqual([]);
    expect(mapToCanonicalAutomationLogEntries([])).toEqual([]);
    expect(mapToCanonicalAutomationLogEntries(null)).toEqual([]);
  });
});
