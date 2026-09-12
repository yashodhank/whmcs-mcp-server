/**
 * Read-side audit JSONL. Records { at, consumer_id, job, clientid } only —
 * never tokens, payloads, ticket bodies, or search strings.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface ReadAuditEvent {
  readonly at: string;
  readonly consumer_id: string;
  readonly job: string;
  readonly clientid?: number;
}

export class ReadAuditLog {
  private readonly filePath?: string;

  constructor(filePath?: string) {
    this.filePath = filePath !== undefined && filePath.trim() !== '' ? filePath : undefined;
  }

  append(event: ReadAuditEvent): void {
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
      /* best-effort: read audit must not fail the job */
    }
  }
}

let singleton: ReadAuditLog | undefined;

export function getReadAuditLog(filePath?: string): ReadAuditLog {
  if (singleton === undefined) {
    singleton = new ReadAuditLog(filePath);
  }
  return singleton;
}

/** Test-only. */
export function __resetReadAuditForTests(): void {
  singleton = undefined;
}
