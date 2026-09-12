import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EffectLedger } from '../../src/audit/effectLedger.js';

describe('EffectLedger', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('writes JSONL without payload or token fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'effect-ledger-'));
    dirs.push(dir);
    const file = join(dir, 'effects.jsonl');
    const log = new EffectLedger(file);
    log.append({
      at: '2026-09-12T00:00:00.000Z',
      consumer_id: 'operator-reconcile',
      job: 'billing_card',
      clientid: 42,
      effect: 'staff:ok',
    });
    const line = readFileSync(file, 'utf8').trim();
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed).toEqual({
      at: '2026-09-12T00:00:00.000Z',
      consumer_id: 'operator-reconcile',
      job: 'billing_card',
      clientid: 42,
      effect: 'staff:ok',
    });
    expect(parsed).not.toHaveProperty('params');
    expect(parsed).not.toHaveProperty('auth_token');
  });
});
