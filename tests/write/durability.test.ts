/**
 * Phase G+ — durable audit + idempotency + day-amounts: survive the deploy
 * restart, fail-closed audit, and byte-for-byte legacy parity when no path
 * is set.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditLog, AuditPersistError, auditEvent } from '../../src/write/audit.js';
import { IdempotencyLedger } from '../../src/write/idempotency.js';
import { DayAmountsStore } from '../../src/write/dayAmountsStore.js';
import { createDraftIntent } from '../../src/write/intents.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-dur-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function intent() {
  return createDraftIntent({
    consumer_id: 'cowork',
    scope: 'client_note:write',
    params: { clientid: 1, note: 'n' },
    naturalKey: 'nk',
    preconditions: {},
    projected_effect: 'note',
  });
}

describe('AuditLog durability', () => {
  it('no path ⇒ pure in-memory, writes no file (legacy parity)', () => {
    const a = new AuditLog();
    a.append(auditEvent('intent.drafted', intent()));
    expect(fs.readdirSync(tmp)).toHaveLength(0);
    expect(a.all()).toHaveLength(1);
  });

  it('persists JSONL and reloads on a simulated restart', () => {
    const file = path.join(tmp, 'audit.jsonl');
    const i = intent();
    const a1 = new AuditLog(file);
    a1.append(auditEvent('intent.drafted', i));
    a1.appendDurable(auditEvent('intent.executed', i, 'attempting'));

    // Simulated restart: a brand-new instance must see the prior trail.
    const a2 = new AuditLog(file);
    const trail = a2.forIntent(i.intent_id);
    expect(trail.map((e) => e.event)).toEqual(['intent.drafted', 'intent.executed']);

    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    // Never persists tokens/secrets/PII — only the modelled AuditEvent keys.
    expect(fs.readFileSync(file, 'utf8')).not.toMatch(/secret|token|password/i);
  });

  it('appendDurable throws AuditPersistError when the path is unwritable', () => {
    // Parent is a regular file ⇒ mkdir/open fails (ENOTDIR).
    const blocker = path.join(tmp, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const a = new AuditLog(path.join(blocker, 'sub', 'audit.jsonl'));
    expect(() => {
      a.appendDurable(auditEvent('intent.executed', intent()));
    }).toThrow(AuditPersistError);
  });

  it('append (best-effort) never throws even when the path is unwritable', () => {
    const blocker = path.join(tmp, 'blocker2');
    fs.writeFileSync(blocker, 'x');
    const a = new AuditLog(path.join(blocker, 'sub', 'audit.jsonl'));
    expect(() => {
      a.append(auditEvent('intent.drafted', intent()));
    }).not.toThrow();
    expect(a.all()).toHaveLength(1); // still recorded in memory
  });
});

describe('IdempotencyLedger durability', () => {
  it('no path ⇒ in-memory (legacy parity)', () => {
    const l = new IdempotencyLedger();
    l.record('k1', { x: 1 });
    expect(l.seen('k1')).toBe(true);
    expect(fs.readdirSync(tmp)).toHaveLength(0);
  });

  it('replay is denied AFTER a simulated restart', () => {
    const file = path.join(tmp, 'idem.jsonl');
    const l1 = new IdempotencyLedger(5 * 60 * 1000, Date.now, file);
    l1.record('replay-key', { executing: true });

    const l2 = new IdempotencyLedger(5 * 60 * 1000, Date.now, file);
    expect(l2.seen('replay-key')).toBe(true); // replay still caught post-restart
  });

  it('persists key+expiry ONLY — never the result payload', () => {
    const file = path.join(tmp, 'idem.jsonl');
    const l = new IdempotencyLedger(60_000, Date.now, file);
    l.record('k', { secretResult: 'do-not-persist-me' });
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).toContain('"key":"k"');
    expect(raw).toContain('expiresAt');
    expect(raw).not.toContain('secretResult');
    expect(raw).not.toContain('do-not-persist-me');
  });

  it('does not reload already-expired keys', () => {
    const file = path.join(tmp, 'idem.jsonl');
    let now = 1_000_000;
    const clock = () => now;
    const l1 = new IdempotencyLedger(1000, clock, file);
    l1.record('old', { a: 1 });
    now += 5000; // key window (1000ms) long expired

    const l2 = new IdempotencyLedger(1000, clock, file);
    expect(l2.seen('old')).toBe(false);
  });
});

describe('DayAmountsStore durability', () => {
  it('no path ⇒ in-memory, writes no file (legacy parity)', () => {
    const store = new DayAmountsStore();
    store.add('AddInvoicePayment', 50);
    expect(store.getTotal('AddInvoicePayment')).toBe(50);
    // No file should have been created in tmp
    expect(fs.readdirSync(tmp)).toHaveLength(0);
  });

  it('persists + reloads same-day total across a simulated restart', () => {
    const file = path.join(tmp, 'day.jsonl');
    const s1 = new DayAmountsStore(file);
    s1.add('AddInvoicePayment', 100);
    s1.add('AddInvoicePayment', 75);

    // Simulated restart: new instance from same file.
    const s2 = new DayAmountsStore(file);
    expect(s2.getTotal('AddInvoicePayment')).toBe(175);

    // JSONL file should exist and have two lines.
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('stale prior-day entry is ignored on reload (getTotal returns 0)', () => {
    const file = path.join(tmp, 'day-stale.jsonl');
    // Write a record with yesterday's date directly.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const staleKey = `AddInvoicePayment|${yesterday}`;
    fs.writeFileSync(
      file,
      JSON.stringify({ key: staleKey, total: 999, date: yesterday }) + '\n'
    );

    const store = new DayAmountsStore(file);
    // Stale entry must not pollute today's total.
    expect(store.getTotal('AddInvoicePayment')).toBe(0);
  });

  it('write error on unwritable path is swallowed (no throw)', () => {
    // Parent is a regular file ⇒ mkdir/open fails.
    const blocker = path.join(tmp, 'blocker3');
    fs.writeFileSync(blocker, 'x');
    const store = new DayAmountsStore(path.join(blocker, 'sub', 'day.jsonl'));
    // Must not throw; in-memory tally still increments.
    expect(() => store.add('AddInvoicePayment', 10)).not.toThrow();
    expect(store.getTotal('AddInvoicePayment')).toBe(10);
  });
});
