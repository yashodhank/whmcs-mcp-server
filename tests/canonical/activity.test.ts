import { describe, it, expect } from 'vitest';
import {
  mapToCanonicalActivity,
  mapToCanonicalActivities,
} from '../../src/canonical/index.js';

describe('mapToCanonicalActivity', () => {
  it('maps a single activity row with complete fields + classmap', () => {
    const c = mapToCanonicalActivity({
      id: 55,
      userid: 7,
      date: '2026-05-18 09:00:00',
      user: 'admin',
      description: 'Logged In',
      ipaddr: '203.0.113.9',
    });
    expect(c.entity).toBe('activity');
    expect(c.data).toMatchObject({
      activityId: 55,
      clientId: 7,
      date: '2026-05-18 09:00:00',
      user: 'admin',
      description: 'Logged In',
      ipAddress: '203.0.113.9',
    });
    // every data path must be classified
    for (const k of Object.keys(c.data as Record<string, unknown>)) {
      expect(c.classes[k]).toBeDefined();
    }
    expect(c.classes.activityId).toBe('business.identifier');
    expect(c.classes.description).toBe('system.audit');
    expect(c.classes.ipAddress).toBe('system.audit');
  });

  it('tolerates missing fields (nulls, not throws)', () => {
    const c = mapToCanonicalActivity({});
    expect(c.data).toMatchObject({ activityId: null, description: null });
  });
});

describe('mapToCanonicalActivities', () => {
  it('unwraps activity.entry list (numeric-keyed / wrapped)', () => {
    const list = mapToCanonicalActivities({
      activity: { entry: { '0': { id: 1, description: 'A' }, '1': { id: 2, description: 'B' } } },
    });
    expect(list).toHaveLength(2);
    expect(list[0].data).toMatchObject({ activityId: 1, description: 'A' });
    expect(list[1].entity).toBe('activity');
  });

  it('empty / missing activity → empty list', () => {
    expect(mapToCanonicalActivities({})).toEqual([]);
    expect(mapToCanonicalActivities({ activity: {} })).toEqual([]);
  });
});
