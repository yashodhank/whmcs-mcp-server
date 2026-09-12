import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDraftIntent, IntentStore } from '../../src/write/intents.js';

const baseInput = {
  consumer_id: 'consumer-1',
  scope: 'client_note:write' as const,
  params: { clientid: 42, note: 'hello' },
  naturalKey: 'client:42:note:hello',
  preconditions: { client_exists: true },
  projected_effect: 'Append a private note to client 42',
};

describe('durable IntentStore', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('reloads intents from disk after a new store is constructed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'intent-store-'));
    dirs.push(dir);
    const file = join(dir, 'intents.json');
    const first = new IntentStore(Date.now, file);
    const intent = createDraftIntent(baseInput);
    first.put(intent);
    const second = new IntentStore(Date.now, file);
    expect(second.get(intent.intent_id)?.intent_id).toBe(intent.intent_id);
    expect(second.list('consumer-1')).toHaveLength(1);
    expect(second.list('other')).toHaveLength(0);
  });
});
