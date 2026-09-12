/**
 * Effect ledger JSONL. Records { at, consumer_id, job, clientid, effect }
 * only — never tokens, payloads, ticket bodies, or search strings.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface EffectLedgerEvent {
  readonly at: string;
  readonly consumer_id: string;
  readonly job: string;
  readonly clientid?: number;
  readonly effect: string;
}

export class EffectLedger {
  private readonly filePath?: string;

  constructor(filePath?: string) {
    this.filePath = filePath !== undefined && filePath.trim() !== '' ? filePath : undefined;
  }

  append(event: EffectLedgerEvent): void {
    const file = this.filePath;
    if (file === undefined) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const fd = fs.openSync(file, 'a');
      try {
        fs.writeSync(fd, `${JSON.stringify(event)}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* best-effort: effect ledger must not fail the job */
    }
  }
}

let singleton: EffectLedger | undefined;

export function getEffectLedger(filePath?: string): EffectLedger {
  if (singleton === undefined) {
    singleton = new EffectLedger(filePath);
  }
  return singleton;
}

/** Test-only. */
export function __resetEffectLedgerForTests(): void {
  singleton = undefined;
}
