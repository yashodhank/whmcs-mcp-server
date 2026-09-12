import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadAuditLog } from '../../src/audit/readAudit.js';

describe('ReadAuditLog', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('writes JSONL without payload fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'read-audit-'));
    dirs.push(dir);
    const file = join(dir, 'read.jsonl');
    const log = new ReadAuditLog(file);
    log.append({
      at: '2026-09-12T00:00:00.000Z',
      consumer_id: 'operator-reconcile',
      job: 'ticket_inbox',
      clientid: 42,
    });
    const line = readFileSync(file, 'utf8').trim();
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed).toEqual({
      at: '2026-09-12T00:00:00.000Z',
      consumer_id: 'operator-reconcile',
      job: 'ticket_inbox',
      clientid: 42,
    });
    expect(parsed).not.toHaveProperty('params');
    expect(parsed).not.toHaveProperty('auth_token');
  });
});
