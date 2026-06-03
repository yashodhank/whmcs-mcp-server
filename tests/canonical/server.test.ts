/**
 * B1 — canonical WHMCS GetServers mapper. Synthetic fixtures ONLY.
 *
 * A server record is operational infrastructure data (no per-customer PII).
 * Verifies defensive parsing (string numbers, single-object lists), field
 * classification (IP → system.diagnostic, NOT pii.address; labels →
 * business.label; status flags → system.status), and classmap completeness.
 */
import { describe, it, expect } from 'vitest';
import {
  mapToCanonicalServer,
  mapToCanonicalServers,
} from '../../src/canonical/server.js';
import { assertClassmapComplete } from './_complete.js';

describe('mapToCanonicalServer (single)', () => {
  it('maps + classifies a typical server row, coercing string numbers', () => {
    const raw = {
      id: '4',
      name: 'web01',
      hostname: 'web01.example.net',
      ipaddress: '203.0.113.10',
      assignedips: '203.0.113.10\n203.0.113.11',
      active: '1',
      disabled: '0',
      type: 'cpanel',
      module: 'cpanel',
      maxallowedaccounts: '500',
      activeservices: '212',
      percentused: '42',
      statusmsg: 'OK',
    };
    const c = mapToCanonicalServer(raw);
    expect(c.entity).toBe('server');
    expect(c.data.serverId).toBe(4);
    expect(c.data.name).toBe('web01');
    expect(c.data.hostname).toBe('web01.example.net');
    expect(c.data.ipAddress).toBe('203.0.113.10');
    expect(c.data.active).toBe(true);
    expect(c.data.disabled).toBe(false);
    expect(c.data.maxAccounts).toBe(500);
    expect(c.data.activeServices).toBe(212);
    expect(c.data.loadPercent).toBe(42);

    expect(c.classes.serverId).toBe('business.identifier');
    expect(c.classes.name).toBe('business.label');
    expect(c.classes.hostname).toBe('business.label');
    // IP is an internal network detail, classified diagnostic — NOT pii.address.
    expect(c.classes.ipAddress).toBe('system.diagnostic');
    expect(c.classes.assignedIps).toBe('system.diagnostic');
    expect(c.classes.active).toBe('system.status');
    expect(c.classes.maxAccounts).toBe('public.safe');
    expect(c.classes.statusText).toBe('untrusted.free_text');
    assertClassmapComplete(c);
  });

  it('null/garbage → all-null record, complete classmap, no throw', () => {
    const c = mapToCanonicalServer(null);
    expect(c.entity).toBe('server');
    expect(c.data.serverId).toBeNull();
    expect(c.data.name).toBeNull();
    assertClassmapComplete(c);
  });

  it('falls back to servername / noofactiveaccounts / load spellings', () => {
    const c = mapToCanonicalServer({
      serverid: 9,
      servername: 'db01',
      noofactiveaccounts: 5,
      load: '7',
    });
    expect(c.data.serverId).toBe(9);
    expect(c.data.name).toBe('db01');
    expect(c.data.activeServices).toBe(5);
    expect(c.data.loadPercent).toBe(7);
  });
});

describe('mapToCanonicalServers (list)', () => {
  it('unwraps servers.server array', () => {
    const raw = {
      result: 'success',
      servers: { server: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] },
    };
    const list = mapToCanonicalServers(raw);
    expect(list.map((c) => c.data.serverId)).toEqual([1, 2]);
    list.forEach((c) => assertClassmapComplete(c));
  });

  it('tolerates a single server object (not wrapped in an array)', () => {
    const raw = { servers: { server: { id: 7, name: 'solo' } } };
    const list = mapToCanonicalServers(raw);
    expect(list).toHaveLength(1);
    expect(list[0].data.name).toBe('solo');
  });

  it('empty → empty list', () => {
    expect(mapToCanonicalServers({ servers: {} })).toEqual([]);
    expect(mapToCanonicalServers(null)).toEqual([]);
  });
});
